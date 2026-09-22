# Sahne Plus — Data-flow audit

Version audited: 1.1.0 (network table updated for 1.2.0; unchanged in 1.3.0) (build from `Documents\SahnePlus`, files `electron/main.js`, `electron/preload.js`, `server/server.js`, `public/app.js`, `public/overlay.js`).
Method: line-by-line review of the actual implementation plus runtime observation of the installed 1.0.1 build (listening sockets, established connections, LAN probe). Every statement below points at the code that produces it.

## 1. Process model

| Process | Role | Network |
|---|---|---|
| Electron main (`electron/main.js`) | window, tray, autostart, IPC, hosts the server | none of its own (only through the server module) |
| Server module (`server/server.js`, runs inside main) | HTTP + SSE on **127.0.0.1:7788**, KickBot WebSocket, Kick Pusher WebSocket, Bonbast HTTPS, Meld loopback WebSocket | all outbound traffic listed in §3 |
| Controller renderer (`public/app.html`, sandboxed, context-isolated) | the app UI, loads `http://127.0.0.1:7788/` | loopback only (`connect-src 'self'` CSP) |
| Browser Source (`public/overlay.html`, runs inside OBS / Meld Studio's browser) | plays alerts | loopback for events and media; external only for KickBot TTS audio and KickBot-supplied tip GIFs (§3.6) |

## 2. Inbound / local server

- `server.listen(config.port, '127.0.0.1')` — bound to IPv4 loopback only. Never `0.0.0.0`, never `::`. Verified at runtime: `Get-NetTCPConnection` shows `127.0.0.1:7788` only; a TCP probe to the machine's LAN address `192.168.1.33:7788` is refused.
- Port is fixed (7788, configurable via `config.json` → `port`). If the port is busy the app shows an error dialog and exits; it never falls back to another interface (`electron/main.js`, `EADDRINUSE` branch).
- Every request: `Host` header must be `localhost`, `127.0.0.1` or `[::1]` (with or without `:port`) → otherwise 403 (DNS-rebinding defence).
- Every `POST/PUT/PATCH/DELETE`: if an `Origin` header is present it must be `http://localhost:7788` / `http://127.0.0.1:7788` / `http://[::1]:7788` → otherwise 403 (CSRF defence). Requests with no `Origin` (curl, the Electron main process) are accepted because they carry no browser ambient authority.
- No CORS headers are sent, so a cross-origin page cannot read any response.
- Headers on every response: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: SAMEORIGIN`.

Endpoints (all under `http://127.0.0.1:7788`):

| Path | Method | Who uses it | Data |
|---|---|---|---|
| `/` | GET | controller window | app page |
| `/overlay` | GET | Browser Source | overlay page |
| `/app.css /app.js /overlay.css /overlay.js /fonts/* /brand/* /legal/*` | GET | both | static, path-traversal guarded (`servePublic`) |
| `/media/<basename>` | GET | Browser Source, controller thumbnails | alert media; only the basename is used, and only files registered in `config.files` are served (since 1.3.2) |
| `/events?role=overlay` | GET (SSE) | Browser Source | receives **only** `{type:'config', appearance}`, `{type:'play', tip}`, `{type:'stop'}`; since 1.3.2 a request with a foreign `Origin` or `Sec-Fetch-Site: cross-site` is refused and the number of streams per role is capped (overlay 8, preview 4, admin 4) |
| `/events?role=preview` | GET (SSE) | controller preview iframe | same as overlay, but preview plays only |
| `/events?role=admin` | GET (SSE) | controller | state, log lines, rate updates |
| `/api/config` | GET | controller | full config **without the KickBot secret** (`publicConfig()`), state, in-memory log, paths |
| `/api/config` | POST | controller | appearance / files / mode / kick / rate / app — each field validated (`sanitizeAppearance`, `sanitizeFile`, enums, numeric bounds) |
| `/api/file` | PATCH / DELETE | controller | one media entry |
| `/api/upload` | PUT | controller (browser fallback) | media body ≤ 512 MB, extension + content sniff |
| `/api/scan` | POST | controller | registers files already in the media folder |
| `/api/setup` | POST | controller | the KickBot widget URL → parsed, secret kept in memory + encrypted store |
| `/api/disconnect-kickbot` | POST | controller | wipes the secret and streamer id |
| `/api/reset-settings` | POST | controller | defaults for appearance / rate / kick / mode |
| `/api/test`, `/api/test-sub`, `/api/preview`, `/api/simulate` | POST / GET | controller | simulated events (see §7) |
| `/api/rate`, `/api/meld-reload`, `/api/skip`, `/api/clear-queue`, `/api/open-media-folder`, `/api/logs` | POST / GET | controller | actions |
| `/api/done` | POST | Browser Source | `{id}` — tells the queue the alert finished |

The Browser Source therefore has access to: the overlay page, static assets, media files, the overlay SSE feed and `/api/done`. It can also technically reach the controller endpoints (same origin), which is inherent to a loopback web UI; the controller endpoints are protected against *other* origins, not against the overlay page itself. No secret is retrievable from any endpoint.

## 3. Outbound network connections (complete list)

| # | Destination | Protocol | When | Data sent | Data received | Code |
|---|---|---|---|---|---|---|
| 3.1 | `wss://kickbot.live/ws` | WebSocket | while a KickBot widget URL is configured; reconnects every 5–10 s | subscribe message `{channel:'tipping_<streamer_id>', authorization:<secret>}`; `pulse` every 3 s; `tip_play` / `tip_end` with the tip id | tip events (`tip_initiated`, `tip_approved`, `tip_rejected`, `tip_play`, `tip_end`, queue config) containing donor name, amount, message, gif/audio URLs | `connect()`, `publish()` |
| 3.2 | `https://widgets.kickbot.com/api/tip_queue_sync?secret_id=<secret>` | HTTPS GET | on connect and every 60 s | the secret **in the query string** (KickBot's API design; unavoidable) | current tip queue | `syncQueue()` |
| 3.3 | `https://widgets.kickbot.com/api/capture_tip` | HTTPS POST | once per real tip when its alert starts (standalone mode only); retried up to 3 times, 15 s apart, if the request fails for a network reason | `stripe_pi_id`, `secret_id`, `streamer_id`, `is_replay`, `is_test` | `{success, payment_success}` | `captureTip()` |
| 3.4 | `https://widgets.kickbot.com/external/tipping/<secret>/__data.json` | HTTPS GET | once, when the user pastes the widget URL | the secret in the path | the streamer id | `/api/setup` |
| 3.5 | `https://kick.com/api/v2/channels/<slug>` | HTTPS GET | once per configured channel name (cached in config) | channel slug | chatroom id, channel id | `resolveKickChannel()` — **undocumented Kick web endpoint** |
| 3.6 | `wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679` | WebSocket | while a Kick channel is configured and enabled | `pusher:subscribe` for the public channels `chatrooms.<id>.v2`, `chatroom_<id>`, `channel.<id>` (auth string empty, public channels) and pings | Kick chat events; only `*GiftedSubscriptionsEvent` and `*SubscriptionEvent` are used | `kickConnect()` — **Kick's public chat feed via Pusher; undocumented, not the official Kick API** |
| 3.7a | `https://baha24.com/api/v1/price` | HTTPS GET (JSON) | at start and every N minutes (N ≥ 1, default 2) while auto-rate is on; also on manual refresh; direct first, proxy as retry | `Accept: application/json`, desktop User-Agent | array of {symbol, sell, last_update}; the `sell` values of USD and (1.3.5+) of the common currencies a StreamElements tip may use | `fetchBaha24()` — public API, no key |
| 3.7 | `https://www.bonbast.com/` then `https://www.bonbast.com/json` | HTTPS GET + POST | **fallback only** when baha24 fails, at most every 5 minutes | a token scraped from the page (`param`), page cookies, a desktop User-Agent | the USD sell rate (`usd1`) | `fetchBonbast()` — **scraping of a public page; no official API** |
| 3.8 | KickBot TTS audio (`audio_url` from the tip event; fallbacks `https://ttsaudio.kickbot.com/…`, `https://tts.kickbotcdn.com/…`) | HTTPS GET | from the **Browser Source**, per tip that has TTS | nothing but the URL | audio | `overlay.js playTts()` |
| 3.9 | KickBot tip GIF (`gif_url` from the tip event) | HTTPS GET | from the Browser Source, when the tip carries one and no local video/image is used | nothing but the URL | image | `overlay.js addImg()` (https only) |
| 3.10 | `ws://127.0.0.1:13376` (Meld Studio local API) | WebSocket, loopback | when no Browser Source has been connected for 20 s (at most every 2 min) or on demand | asks Meld to reload the Browser layer whose URL contains `localhost:7788/overlay` | layer list | `meldReloadLayers()` |
| 3.11 | `https://github.com/AmirEyZed/sahne-plus/releases/latest` (the redirect is read, not followed) | HTTPS HEAD (Chromium network stack, system proxy honoured) | 30 s after start and every 6 hours while «بررسی خودکار نسخه‌ی جدید» is on; on demand from the About page | `User-Agent: SahnePlus/<version>` | the redirect target `…/releases/tag/vX.Y.Z`; only the version is used | `electron/updater.js` `latestReleaseUrl()` |
| 3.12 | `https://github.com/AmirEyZed/sahne-plus/releases/download/vX.Y.Z/SHA256SUMS.txt` and `…/Sahne-Plus-Setup-X.Y.Z.exe` (GitHub redirects to its release-asset storage) | HTTPS GET | **only after the user clicks «آپدیت»** | `User-Agent: SahnePlus/<version>` | the checksum file and the installer; the installer runs only if its SHA-256 matches | `electron/updater.js` `download()` |
| 3.13 | `https://api.streamelements.com/kappa/v2/channels/me` | HTTPS GET | once, when a StreamElements token is entered (1.3.4+) | `Authorization: Bearer <JWT>` | channel id, username, provider | `/api/se/setup` |
| 3.14 | `wss://astro.streamelements.com` | WebSocket | while a StreamElements account is connected; reconnects every 5–10 s | `subscribe` to `channel.activities` for the own channel with the JWT | activity events; only `tip` is used | `seConnect()`, `parseSeActivity()` |
| — | optional HTTP CONNECT proxy: `rate.proxy` (user-configured) and, since 1.3.1, the Windows system proxy (resolved by Electron, plain HTTP proxies only) | HTTP | 3.5 and 3.7 (proxies first, direct last); 3.7a only as a retry after a failed direct request | the destinations above pass through it | — | `httpsRequest()`, `routeOrder()` |

Not present in the code: analytics, telemetry, crash reporting, advertising, silent or automatic installation of updates, any Sahne Plus server, Google Fonts (removed in 1.1.0; all fonts are bundled). Since 1.3.1 the only contact with GitHub at runtime is the update check (3.11) and, after a click, the update download (3.12).

Electron/Chromium platform traffic: the app does not set Google API keys, does not enable the Chromium component updater and does not load remote content in the controller window. Observed established connections of the running 1.0.1 build were exactly two: an AWS host (KickBot) and one other host (Pusher/KickBot). Chromium-level background requests (e.g. certificate revocation checks) were not exhaustively traced and are documented as "not expected, not fully verified".

## 4. Files

| Path | Read / write | Content | Sensitivity |
|---|---|---|---|
| `Documents\Sahne Plus\config.json` | R/W (atomic write via `.tmp` + rename) | settings, file tiers, Kick channel, rate, `secret_id_enc` | contains the **encrypted** KickBot secret (DPAPI); plaintext only if DPAPI is unavailable (`secretStorage:'plain'`, shown in the UI) |
| `Documents\Sahne Plus\config.json.corrupt-<ts>` | W | copy of an unparsable config | same as above |
| `Documents\Sahne Plus\media\*` | R/W | imported alert media (copied; the source file is never touched) | user content |
| `Documents\Sahne Plus\played.json` | R/W | last 1000 played tip ids | low |
| `Documents\Sahne Plus\sahne-plus.log` (+ `.1`) | W, rotates at 5 MB | log lines: connection state, tip name / amount / message / media, errors. Secrets are redacted by `safe()` | donor names and messages (personal data of third parties, local only) |
| `%APPDATA%\SahnePlus\` | R/W by Chromium | Electron userData: cache, `Local Storage` (only `sp.page`), GPU cache, single-instance lock | low |
| `Documents\KickAlerts\config.json`, `media\` | **R only, once** | legacy import on first run (copy) | — |
| `%TEMP%` | — | not used by the app (only by the build script) | — |

Uninstalling removes the program folder and (by default) `%APPDATA%\SahnePlus`. It does **not** delete `Documents\Sahne Plus` — the user does that via "Clear application data" or manually.

## 5. Credentials and identifiers

| Item | Class | Where | Notes |
|---|---|---|---|
| KickBot widget secret (`<32hex>:<32hex>`) | **SECRET / bearer-like** | memory; `config.json` as `secret_id_enc` (DPAPI) | possession lets anyone subscribe to the tipping channel, read the queue and call `capture_tip` for that streamer. Never logged (`safe()` redacts `secret_id`/`authorization`), never returned by any endpoint, masked in the UI, sent only to KickBot (3.1–3.4) |
| StreamElements JWT (optional) | **SECRET / account-wide** | memory; `config.json` as `se_token_enc` (DPAPI) | it grants full API access to the StreamElements account; the app only subscribes to the activity feed with it |
| `streamer_id` | public identifier | config.json | numeric KickBot id |
| Kick channel slug / chatroom id / channel id | public identifiers | config.json | public |
| `rate.proxy` | medium (may embed proxy credentials if the user types them) | config.json plaintext | user-provided |
| Tip ids (`stripe_pi_id`) | identifiers | memory, played.json, log | KickBot/Stripe payment-intent ids; not usable without the secret |
| Donor names / messages / usernames | third-party personal data | memory (last 30), log file, overlay | shown on stream by design |

## 6. Data classes

- **LOCAL-ONLY**: appearance settings, file tiers/keywords, media files, played ids, logs, window state.
- **NETWORK-PROCESSED**: the KickBot secret + streamer id (to KickBot), tip ids (to KickBot), Kick channel slug (to kick.com), nothing to anyone else.
- **PERSISTENT**: config.json, media, played.json, log, Electron userData.
- **TEMPORARY**: in-memory queues (`pending`, `approved`, capped at 500), last-30 recent list, in-memory log (300 lines), 15-second duplicate keys for Kick events.
- **CREDENTIAL/SENSITIVE**: KickBot secret (encrypted), optional proxy URL.
- **THIRD-PARTY DATA**: donor names/amounts/messages and TTS/GIF URLs from KickBot; subscriber/gifter usernames from Kick chat; exchange rate from Bonbast.

## 7. Simulated events

`/api/test`, `/api/test-sub` and `/api/preview` create tips with `is_test:true` / `is_local:true`. Code paths that touch KickBot (`captureTip`, `publish('tip_play')`, `publish('tip_end')`) are guarded by `!t.is_test && !t.is_local`, so simulated events never reach KickBot. They are shown with a `TEST` badge on the overlay and flagged `test:true` in the recent list and log.

## 8. Accurate privacy wording

The sentence "no information leaves the computer" is **false** for this application and must not be used. Verified wording:

> Sahne Plus has no cloud backend. Your alert media, settings and logs stay on your computer. The application connects only to the third-party services it needs to work: KickBot (donation events and payment capture), Kick's public chat feed (subscriptions), and bonbast.com (exchange rate). It contains no analytics, telemetry, crash reporting or advertising.
