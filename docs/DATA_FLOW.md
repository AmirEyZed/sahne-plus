# Sahne Plus — Data-flow audit

Source baseline: 1.3.9 (`f6cf125`), reviewed 2026-10-02. Relevant implementation: `electron/main.js`, `electron/preload.js`, `electron/updater.js`, `electron/update-core.js`, `server/server.js`, `public/app.js`, `public/overlay.js`, and the installer configuration in `package.json` / `build/installer.nsh`.
Method: source review of application-requested network connections and local storage, cross-checked with the existing offline server, overlay and updater tests. The original audit also observed sockets and probed the LAN on an installed **1.0.1** build; those are historical observations, not runtime verification of 1.3.9. Current Electron/Chromium background traffic and live third-party services have not been exhaustively traced.

## 1. Process model

| Process | Role | Network |
|---|---|---|
| Electron main (`electron/main.js`) | window, tray, autostart, IPC, hosts the server and updater | updater uses Electron `net.request` / `net.fetch` for GitHub (§3.11–3.12); also hosts the server's connections below |
| Server module (`server/server.js`, runs inside main) | HTTP + SSE on **127.0.0.1:config.port** (default 7788), KickBot, Kick/Pusher, StreamElements, exchange rates, Meld | §3.1–3.7a, §3.10, §3.13–3.14 and the optional HTTP CONNECT proxy |
| Controller renderer (`public/app.html`, sandboxed, context-isolated) | the app UI, loads `http://127.0.0.1:7788/` | loopback only (`connect-src 'self'` CSP) |
| Browser Source (`public/overlay.html`, runs inside OBS / Meld Studio's browser) | plays alerts | loopback for events and media; external for KickBot TTS audio and KickBot-supplied tip GIFs (§3.8–3.9). The controller's preview iframe runs the same overlay code, but `/api/preview` supplies generated test tips without external TTS/GIF URLs |

## 2. Inbound / local server

- `server.listen(config.port, '127.0.0.1')` — bound to IPv4 loopback only. Never `0.0.0.0`, never `::`. The historical 1.0.1 runtime audit observed this loopback listener and a refused LAN TCP probe; the binding in current source is unchanged.
- Default port is 7788, configurable via `config.json` → `port`. The examples below use 7788; the controller URL, Browser Source URL, Host/Origin checks and Meld layer matching use the configured port. If the port is busy the app offers retry or exit; it never falls back to another port or interface (`electron/main.js`, `EADDRINUSE` branch).
- Every request: `Host` header must be `localhost`, `127.0.0.1` or `[::1]` (with or without `:port`) → otherwise 403 (DNS-rebinding defence).
- Every `POST/PUT/PATCH/DELETE`: if an `Origin` header is present it must be `http://localhost:7788` / `http://127.0.0.1:7788` / `http://[::1]:7788` → otherwise 403 (CSRF defence). Requests with no `Origin` (curl, the Electron main process) are accepted because they carry no browser ambient authority.
- No CORS headers are sent, so a cross-origin page cannot read any response.
- Responses after the Host/Origin checks carry `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: SAMEORIGIN`.

Endpoints (all under `http://127.0.0.1:7788`):

| Path | Method | Who uses it | Data |
|---|---|---|---|
| `/` | GET | controller window | app page |
| `/overlay` | GET | Browser Source | overlay page |
| `/app.css /app.js /overlay.css /overlay.js /fonts/* /brand/* /legal/*` | GET | both | static, path-traversal guarded (`servePublic`) |
| `/media/<basename>` | GET | Browser Source, controller thumbnails | alert media; only the basename is used, and only files registered in `config.files` are served (since 1.3.2) |
| `/events?role=overlay` | GET (SSE) | Browser Source | receives **only** `{type:'config', appearance}`, `{type:'play', tip}`, `{type:'stop'}`; since 1.3.2 a request with a foreign `Origin` or `Sec-Fetch-Site: cross-site` is refused and the number of streams per role is capped (overlay 8, preview 4, admin 4) |
| `/events?role=preview` | GET (SSE) | controller preview iframe | same as overlay, but preview plays only |
| `/events?role=admin` | GET (SSE) | controller | appearance config, state, log lines, rate updates |
| `/api/config` | GET | controller | config **without the KickBot secret or StreamElements token** (including their encrypted fields; `publicConfig()`), connection metadata, state, in-memory log, paths |
| `/api/config` | POST | controller | appearance / files / mode / kick / rate / app — each field validated (`sanitizeAppearance`, `sanitizeFile`, enums, numeric bounds) |
| `/api/file` | PATCH / DELETE | controller | one media entry |
| `/api/upload` | PUT / POST | controller (browser fallback uses PUT) | media body ≤ 512 MB, extension + content sniff |
| `/api/scan` | POST | controller | registers files already in the media folder |
| `/api/setup` | POST | controller | the KickBot widget URL → parsed, secret kept in memory and saved with DPAPI or plaintext fallback (§4) |
| `/api/se/setup` | POST | controller | validates the JWT, resolves the channel through §3.13, keeps the token in memory and saves it with DPAPI or plaintext fallback (§4) |
| `/api/se/disconnect` | POST | controller | disconnects StreamElements, clears its token and account metadata, removes its waiting tips and saves config |
| `/api/disconnect-kickbot` | POST | controller | wipes the secret and streamer id and removes KickBot's tips (including its dashboard test tips) from the queue; Kick subs, StreamElements tips and the app's own test alerts stay queued |
| `/api/reset-settings` | POST | controller | defaults for appearance / rate / kick / mode |
| `/api/test`, `/api/test-sub`, `/api/preview`, `/api/simulate` | POST / GET | controller | simulated events (see §7) |
| `/api/rate`, `/api/meld-reload`, `/api/skip`, `/api/clear-queue`, `/api/open-media-folder`, `/api/logs` | POST / GET | controller | actions |
| `/api/analytics` | GET | controller | read-only aggregation of the recorded donation history (`range=today\|week\|month\|custom`, `from`/`to`, `tz` = minutes east of UTC, `includeTests=1`). Computed by `server/analytics.js` from `analytics-*.ndjson`; never mutates anything. A malformed, reversed or out-of-range custom `from`/`to` is answered with **400**, never silently replaced by today |
| `/api/done` | POST | Browser Source | `{id}` — tells the queue the alert finished |

The Browser Source therefore has access to: the overlay page, static assets, media files, the overlay SSE feed and `/api/done`. It can also technically reach the controller endpoints (same origin), which is inherent to a loopback web UI; the controller endpoints are protected against *other* origins, not against the overlay page itself. Neither provider credential is retrievable from an endpoint. The configured proxy URL is part of the public config and may contain user-entered proxy credentials (§5).

## 3. Outbound network connections (complete list)

| # | Destination | Protocol | When | Data sent | Data received | Code |
|---|---|---|---|---|---|---|
| 3.1 | `wss://kickbot.live/ws` | WebSocket | while a KickBot widget URL is configured; reconnects every 5–10 s | subscribe message `{channel:'tipping_<streamer_id>', authorization:<secret>}`; `pulse` every 3 s; `tip_play` / `tip_end` with the tip id | tip events (`tip_initiated`, `tip_approved`, `tip_rejected`, `tip_play`, `tip_end`, queue config) containing donor name, amount, message, gif/audio URLs | `connect()`, `publish()` |
| 3.2 | `https://widgets.kickbot.com/api/tip_queue_sync?secret_id=<secret>` | HTTPS GET | on connect and every 60 s; 15 s timeout. Responses apply only to the setup/disconnect generation that started the request and only while the server is running; disconnect or successful setup (even with the same key) invalidates older responses. In-flight requests are not cancelled | the secret **in the query string** (KickBot's API design; unavoidable) | current tip queue | `syncQueue()` |
| 3.3 | `https://widgets.kickbot.com/api/capture_tip` | HTTPS POST | before an uncaptured real tip plays with a Browser Source connected (standalone mode only); up to 3 attempts per queue cycle, 15 s between retries for network/timeout/non-JSON failures or HTTP 429/5xx. A later queue sync can start another cycle | `stripe_pi_id`, `secret_id`, `streamer_id`, `is_replay`, `is_test` | `{success, payment_success}` | `captureTip()`, `tryNext()` |
| 3.4 | `https://widgets.kickbot.com/external/tipping/<secret>/__data.json` | HTTPS GET | once, when the user pastes the widget URL | the secret in the path | the streamer id | `/api/setup` |
| 3.5 | `https://kick.com/api/v2/channels/<slug>` | HTTPS GET | once per configured channel name (cached in config) | channel slug | chatroom id, channel id | `resolveKickChannel()` — **undocumented Kick web endpoint** |
| 3.6 | `wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679` | WebSocket | while a Kick channel is configured and enabled | `pusher:subscribe` for the public channels `chatrooms.<id>.v2`, `chatroom_<id>`, `channel.<id>` (auth string empty, public channels) and pings | Kick chat events; only `*GiftedSubscriptionsEvent` and `*SubscriptionEvent` are used | `kickConnect()` — **Kick's public chat feed via Pusher; undocumented, not the official Kick API** |
| 3.7a | `https://baha24.com/api/v1/price` | HTTPS GET (JSON) | at start and every N minutes (N ≥ 1, default 2) while auto-rate is on; also on manual refresh; direct first, proxy as retry | `Accept: application/json`, desktop User-Agent | array of {symbol, sell, last_update}; the `sell` values of USD and (1.3.5+) of the common currencies a StreamElements tip may use | `fetchBaha24()` — public API, no key |
| 3.7 | `https://www.bonbast.com/` then `https://www.bonbast.com/json` | HTTPS GET + POST | **fallback only** when baha24 fails, at most every 5 minutes | a token scraped from the page (`param`), page cookies, a desktop User-Agent | the USD sell rate (`usd1`) | `fetchBonbast()` — **scraping of a public page; no official API** |
| 3.8 | KickBot TTS audio (`audio_url` from the tip event, sent as `tts_url` to the overlay; fallbacks `https://ttsaudio.kickbot.com/…`, `https://tts.kickbotcdn.com/…`) | HTTPS GET | from the **Browser Source**, per tip that has TTS | URL and normal browser request metadata | audio | `overlay.js playTts()` |
| 3.9 | KickBot tip GIF (`gif_url` from the tip event) | HTTPS GET | from the Browser Source, when the tip carries one and no local video/image is used | URL and normal browser request metadata | image | `overlay.js addImg()`, `safeUrl()` (server forwards HTTPS URLs only) |
| 3.10 | `ws://127.0.0.1:13376` (Meld Studio local API) | WebSocket, loopback | when no Browser Source has been connected for 20 s (at most every 2 min) or on demand; disabled in isolated `SAHNE_PLUS_DATA_DIR` instances | asks Meld to reload layers whose URL is HTTP, host is `localhost` / `127.0.0.1`, port matches `config.port` and path is `/overlay` | layer list | `meldReloadLayers()`, `electron/main.js` `meldSelfHeal` option |
| 3.11 | `https://github.com/AmirEyZed/sahne-plus/releases/latest` (the redirect is read, not followed) | HTTPS HEAD (Chromium network stack, system proxy honoured) | 30 s after start and every 6 hours while «بررسی خودکار نسخه‌ی جدید» is on; on demand from the About page | `User-Agent: SahnePlus/<version>` | the redirect target `…/releases/tag/vX.Y.Z`; only the version is used | `electron/updater.js` `latestReleaseUrl()` |
| 3.12 | `https://github.com/AmirEyZed/sahne-plus/releases/download/vX.Y.Z/SHA256SUMS.txt` and `…/Sahne-Plus-Setup-X.Y.Z.exe` (GitHub redirects to its release-asset storage) | HTTPS GET | **only after the user clicks «آپدیت»**; the checksum file must arrive within 30 s and the installer's response headers within 30 s; the installer download stops when a read, write or the final close makes no progress for 60 s (a write error stops it at once), and the partial file is then deleted if possible | `User-Agent: SahnePlus/<version>` | the checksum file and the installer; the installer runs only if its SHA-256 matches | `electron/updater.js` `download()` |
| 3.13 | `https://api.streamelements.com/kappa/v2/channels/me` | HTTPS GET | during StreamElements token setup (1.3.4+); direct first, proxies as retries | `Authorization: Bearer <JWT>`, desktop User-Agent | channel id, username, provider | `/api/se/setup` |
| 3.14 | `wss://astro.streamelements.com` | WebSocket | while a StreamElements account is connected; normal retry after 5 s (10 s watchdog), service-requested reconnect after 0.5 s, rejected subscription retry after 5 min | JWT, channel id and nonce in `subscribe` to `channel.activities`; service-issued reconnect token in the URL when reconnecting | activity events (only `tip` is used), subscription responses and reconnect token | `seConnect()`, `parseSeActivity()` |
| — | optional HTTP CONNECT proxy: `rate.proxy` (user-configured) and, since 1.3.1, the Windows system proxy (resolved by Electron, plain HTTP proxies only) | HTTP | 3.5 and 3.7 (manual proxy, system proxy, direct); 3.7a and 3.13 (direct, manual proxy, system proxy) | CONNECT target host/port; `httpsRequest()` does not send a `Proxy-Authorization` header | tunneled responses | `httpsRequest()`, `routesFor()`, `routeOrder()` |

Not present in the code: telemetry, crash reporting, advertising, silent or automatic installation of updates, any Sahne Plus server, Google Fonts (removed in 1.1.0; all fonts are bundled). The Analytics page is entirely **local**: it aggregates the app's own recorded donation history, on the machine, and never phones home; the recording can be switched off in Settings. Since 1.3.1 the only contact with GitHub at runtime is the update check (3.11) and, after a click, the update download (3.12).

Electron/Chromium platform traffic: the app does not set Google API keys or enable the Chromium component updater. The controller's top-level page is local; the preview iframe shares the overlay CSP (which permits HTTPS image/audio assets), although current preview tips have no external TTS/GIF URLs. The original 1.0.1 audit observed two established external connections (an AWS host and another host attributed to Pusher/KickBot); this is not an exhaustive or current connection count. Platform background traffic (e.g. certificate revocation checks) remains unverified. HTTPS links opened with `shell.openExternal` run in the user's default browser, outside this application's request table.

## 4. Files

| Path | Read / write | Content | Sensitivity |
|---|---|---|---|
| `Documents\Sahne Plus\config.json` | R/W (atomic write via `.tmp` + rename) | settings, file tiers, Kick channel, rate, `secret_id_enc`, optional `se_token_enc` | KickBot key and StreamElements token use DPAPI independently; if unavailable or encryption fails, the corresponding `secret_id` / `se_token` field is plaintext. Each connection's `secretStorage` in `/api/config` reports its own loaded or successfully saved credential (`os`, `plain`, or `none` when no usable credential is loaded); the legacy state-level field describes KickBot only. Startup retries encryption for legacy plaintext credentials when DPAPI is available. A failed atomic save leaves the reported storage status unchanged. Credential fields are removed from the in-memory config exposed to the controller (`loadConfig()`, `publicConfig()`). |
| `Documents\Sahne Plus\config.json.corrupt-<ts>`, `config.json.tmp` | W | backup of an unparsable config; temporary atomic-save file (may remain after a failed save) | same as config.json |
| `Documents\Sahne Plus\media\*` | R/W | imported alert media (copied; the source file is never touched) | user content |
| `Documents\Sahne Plus\played.json` | R/W | last 1000 played tip ids | low |
| `Documents\Sahne Plus\analytics-<YYYY-MM>.ndjson` | R/W (append; the current month is rewritten only to patch one line's `played` outcome) | one JSON line per donation whose alert was shown: id, instant, local day, tipster name, amount + currency, Toman value at that instant, rate, kind, source, gift count, tags, test flag, played flag. Capped at 5000 lines/day and 20000 lines total. A timestamp outside 2020…tomorrow is rejected instead of creating an unreadable month file. Not written at all while «ثبت تاریخچه‌ی دونیت‌ها» is off in Settings (`app.recordHistory = false`) | donor names and amounts (third-party personal data, local only) |
| `Documents\Sahne Plus\analytics-rollup\<YYYY-MM>.json` | W (temp file + atomic rename) | per-month summary (count, sums, donors, per-day, kinds, sources, plus the folded record ids) for months older than the 3 newest; the detail file is then deleted. A late record for a month that was already summarised is merged into the existing summary, and a future month is never rolled up | aggregate only, no individual records |
| `Documents\Sahne Plus\analytics-donors.json` | R/W (temp file + atomic rename) | name → first-seen instant, so "new vs returning donor" survives a rollup | donor names (local only) |
| `Documents\Sahne Plus\sahne-plus.log` (+ `.1`) | W, rotates at 5 MB | log lines: connection state, tip name / amount / message / media, errors. Secrets are redacted by `safe()` | donor names and messages (personal data of third parties, local only) |
| `Documents\Sahne Plus\captured.json` (and `.tmp` while writing) | R/W (atomic write via `.tmp` + rename) | First 500 eligible waiting alerts in FIFO order: captured KickBot tips (legacy files remain readable), real StreamElements tips and real Kick sub/gift events. Whitelisted fields: id, name, message, amount, source, timestamp; KickBot approval/replay flags and GIF/TTS URLs; StreamElements currency; Kick kind/count/tags/toman override. Test alerts and uncaptured KickBot tips are excluded. Restored local alerts retain `is_local:true` and never call KickBot capture or publish. Snapshot updates when serialized content changes; deleted when empty | plaintext viewer names/messages, including gift recipient names (third-party personal data, local only); no provider credentials |
| `%APPDATA%\SahnePlus\` | R/W by Chromium | Electron userData: cache, `Local Storage` (only `sp.page`), GPU cache, single-instance lock | low |
| `Documents\KickAlerts\config.json`, `media\` | **R only, once** | legacy import on first run (copy) | — |
| `%TEMP%\SahnePlus-update\` (Electron `app.getPath('temp')`) | R/W | installer downloaded after the user's update click; SHA-256 checked before execution. The folder is removed before another download and on download/verification failure where possible; a successful install/dry run does not remove it (`electron/updater.js`) | program binary, no application config or media |

Waiting-alert retention: `saveCaptured()` snapshots at most 500 eligible entries in their current order and logs a warning when additional eligible alerts remain only in memory. Entries leave the snapshot when playback starts, on rejection/removal, or on queue clearing. KickBot and StreamElements disconnects remove only their own waiting entries; changing Kick settings does not clear waiting subs/gifts. `clearData()` deletes both `captured.json` and its `.tmp` and prevents late events from writing them again. There is no time-based expiry. The last successful file survives write/rename failures; the next state update retries. A failed deletion can leave the old snapshot until a successful retry or manual deletion.

Boundary: this restores waiting alerts after a restart, not an alert already playing. Writes use rename without fsync; interrupted playback/power-loss recovery and exactly-once delivery are not guaranteed. Kick assigns local random ids and suppresses duplicate chat deliveries only in memory (2.5 seconds), so a provider echo across restarts can still produce a new alert. No network destination or provider protocol changes.

`SAHNE_PLUS_DATA_DIR` overrides the application data folder and puts the Chromium profile in `<dataDir>\.electron` (`electron/main.js`); the updater still uses Electron's temporary folder.

The NSIS configuration sets `deleteAppDataOnUninstall: false` (`package.json`), so a normal uninstall removes program files while preserving the Chromium profile and `Documents\Sahne Plus`. The uninstall hook removes the autostart registry entry except during an update (`build/installer.nsh`). "Clear application data" removes settings, media, played/captured records and logs (`server.clearData()`, `data:clear` IPC); it does not clear the Chromium profile or updater temporary folder.

## 5. Credentials and identifiers

| Item | Class | Where | Notes |
|---|---|---|---|
| KickBot widget secret (`<32hex>:<32hex>`) | **SECRET / bearer-like** | memory; `config.json` as `secret_id_enc` (DPAPI), or plaintext `secret_id` on fallback | possession lets anyone subscribe to the tipping channel, read the queue and call `capture_tip` for that streamer. Credential fields are redacted by `safe()`, never returned by an endpoint, masked in the UI, sent only to KickBot (3.1–3.4) |
| StreamElements JWT (optional) | **SECRET / account-wide** | memory; `config.json` as `se_token_enc` (DPAPI), or plaintext `se_token` on fallback | it grants full API access to the StreamElements account; the app resolves the channel at setup and subscribes to its activity feed (§3.13–3.14). Credential fields are redacted by `safe()` and excluded from the public config |
| StreamElements reconnect token | **SECRET / session** | memory only (`seReconnectToken`) | issued by the service and used only for reconnecting to §3.14; not written to config or returned by an endpoint |
| `streamer_id` | public identifier | config.json | numeric KickBot id |
| Kick channel slug / chatroom id / channel id | public identifiers | config.json | public |
| `rate.proxy` | medium (may embed proxy credentials if the user types them) | config.json plaintext | user-provided |
| Tip ids (`stripe_pi_id`) | identifiers | memory, played.json, captured.json, log | KickBot/Stripe payment-intent ids, prefixed StreamElements activity ids, and locally generated Kick sub/gift ids; not credentials |
| Donor names / messages / usernames | third-party personal data | memory (last 30), log file, overlay, captured.json (eligible waiting alerts, including Kick gift recipient names) | shown on stream by design |

## 6. Data classes

- **LOCAL-ONLY**: appearance settings, file tiers/keywords, media files, played ids, logs, window state.
- **NETWORK-PROCESSED**: KickBot secret, streamer id and tip ids (KickBot); Kick channel slug / chat identifiers (Kick/Pusher); StreamElements JWT, channel id and reconnect token (StreamElements); TTS/GIF asset URLs and browser request metadata (asset hosts); app version in the User-Agent (GitHub). HTTP CONNECT proxies receive destination host/port. All external servers also receive normal connection metadata such as the public IP address.
- **PERSISTENT**: config.json, media, played.json, captured.json (eligible alerts waiting for playback, no time-based expiry), analytics history (month files, rollups, donor index), log, Electron userData; a downloaded updater installer can remain in the temporary folder (§4).
- **TEMPORARY**: in-memory queues (`pending`, `approved`; KickBot events trim them to 500, local arrivals can exceed that; pending, uncaptured and test alerts have no restart snapshot), last-30 recent list, in-memory log (300 lines), Kick duplicate keys (2.5-second matching window; keys older than 60 s pruned on the next event), StreamElements reconnect token, atomic-save files.
- **CREDENTIAL/SENSITIVE**: KickBot secret, optional StreamElements JWT (DPAPI or plaintext fallback), StreamElements reconnect token, optional proxy URL.
- **THIRD-PARTY DATA**: donor names/amounts/messages and TTS/GIF URLs from KickBot; subscriber/gifter usernames from Kick chat; donor names/amounts/currencies/messages from StreamElements; exchange rates from baha24 and Bonbast.

## 7. Simulated events

`/api/test`, `/api/test-sub` and `/api/preview` create tips with `is_test:true` / `is_local:true`. Code paths that touch KickBot (`captureTip`, `publish('tip_play')`, `publish('tip_end')`) are guarded by `!t.is_test && !t.is_local`, so simulated events never reach KickBot. They are shown with a `TEST` badge on the overlay and flagged `test:true` in the recent list and log.

## 8. Accurate privacy wording

The sentence "no information leaves the computer" is **false** for this application and must not be used. Wording consistent with the application-requested connections above and the services in [PRIVACY.md](../PRIVACY.md) §4:

> Sahne Plus has no cloud backend. Your imported alert media, settings, donation history and logs stay on your computer. It connects to KickBot for donations and payment capture, Kick/Pusher for subscriptions, optional StreamElements for tips, and baha24 or Bonbast for exchange rates. It checks GitHub for new versions when automatic checks are enabled or you request a check, and downloads an update only after your click. The Browser Source can load donation TTS/GIF assets from external hosts. These requests expose normal connection metadata to the services. Its analytics page is computed locally from your own recorded donations and sends nothing anywhere. There is no telemetry, crash reporting or advertising.
