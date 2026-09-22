# Changelog — Sahne Plus

All notable changes to the public builds. Versions follow semantic versioning.

## 1.3.3 — 2026-09-22

- Hardening: the installed app ignores Chromium's remote-debugging switches (`--remote-debugging-port`, `--remote-debugging-pipe`, `--remote-debugging-address`), so it can no longer be started with the DevTools protocol open; the ignored switch is noted in the log. Development runs (`electron .`) are unchanged. Defence in depth — starting the app with arguments already requires access to the Windows account.

## 1.3.5 — 2026-09-22

- Fixed: a StreamElements tip in euro (or GBP, AED, TRY, CAD, CHF and other common currencies) showed only "5 EUR" and matched no tier, so no file played. The rates baha24/bonbast publish next to the dollar are now stored with the dollar rate; such tips are converted to toman, use the same tiers, and the card shows for example "5 EUR = 1,338,900 تومان". A currency without a published rate is still shown as amount + code.
- Fixed: the "طلایی کلاسیک" preset wrote "{name} tip {amount}"; it now reads "{name} tipped {amount}" (existing custom templates are not changed).

## 1.3.4 — 2026-09-22

- New: **StreamElements tips**. Paste the JWT token of your StreamElements account in Settings and tips from your StreamElements tipping page enter the same queue as KickBot donations, with the same files and tiers. The token is stored encrypted like the KickBot key, never shown or logged, and removed with one click. Tips in a currency other than USD are shown with their amount and currency code (no toman conversion). New network destinations are documented in PRIVACY.md and docs/DATA_FLOW.md.

## 1.3.2 — 2026-09-21

- Security (reported by [KernelDotDLL](https://github.com/KernelDotDLL), thank you): a page on another website that the streamer had open could connect to the alert event stream. It could not read anything, but the connection alone counted as a Browser Source, so an alert could be consumed while OBS was closed, and the number of connections was unbounded. The event stream now refuses requests from another site and caps the number of connections per role.
- Security (same report): `/media/…` served every file in the media folder, including notes or a partial upload. Only files registered as alerts are served now.
- Fixed: the first-run setup card on the Home page had no gap below it (first outside contribution, thanks [TikTaak](https://github.com/TikTaak)).
- Project: bilingual issue forms for bug reports, problems with outside services and feature requests, with a warning not to post the KickBot widget key or donor names (thanks [shahriaarrr](https://github.com/shahriaarrr)).
- Fixed: in the file editor the header icon was oversized and the preview collapsed to a thin strip when the window was short (present since 1.0, more visible since 1.3.1 added a field). The panel now scrolls instead of squashing its parts.

## 1.3.1 — 2026-09-19

- Kick subscriptions behind a filter: Sahne+ now uses the Windows system proxy automatically (for example v2rayN or another VPN app in "system proxy" mode) for kick.com and bonbast.com — after a manually entered proxy and before a direct connection. Only plain HTTP proxies are used; a SOCKS-only setup needs the VPN's TUN mode or a manual HTTP proxy. The detected proxy is shown under the proxy field in Settings.
- Readable Kick errors: instead of raw codes such as `read ECONNRESET`, the Kick card says what happened (kick.com filtered, channel not found, request refused by Kick, …) and what to do. A "channel not found" answer is no longer hidden by a later network error.
- Card delay: the name/amount card (and the KickBot TTS) can appear a few seconds after the alert media starts — a global setting on the Look page and an optional per-file value in the file editor. A delayed card always stays up for a few seconds.
- Updates inside the app: 30 s after start and every 6 hours the app checks this repository's latest GitHub release (can be turned off in Settings) and shows a banner and a Windows notification when a newer version exists. «آپدیت» downloads the official installer, verifies it against the release's `SHA256SUMS.txt`, closes the app and installs it; the new version starts by itself, settings and media stay. Nothing is downloaded or installed without a click. Users of 1.3.0 and older install 1.3.1 manually once.
- The uninstaller removes the autostart entry only on a real uninstall, not while updating.
- The in-app copy of PRIVACY.md (About page) was out of date in 1.3.0; it is synced again and a test keeps the in-app legal documents identical to the repository copies.
- Tests for proxy parsing, route order, the new Kick messages and the card delay.

## 1.3.0 — 2026-09-19 (open source)

- Sahne+ is now open source under the Apache License 2.0 (names and icons excluded, see BRANDING.md). Source: https://github.com/AmirEyZed/sahne-plus
- Official installers are built by GitHub Actions from the tagged source and published with a build provenance attestation (`gh attestation verify`).
- Unit tests (`npm test`): server validation, loopback hardening, overlay XSS.
- About page: license and NOTICE tabs.
- Clearer error when a Kick channel name is not found (was "kick api HTTP 404").
- Fixed (found by an independent code audit by [B3hnamR](https://github.com/B3hnamR), thank you): imported **image** alerts (PNG/JPG/GIF/WebP) did not render in the Browser Source since 1.1.0 because the same-origin check rejected the relative `/media/…` URL. Video and audio alerts were not affected.
- Fixed (same audit): a donation whose payment capture failed for a transient reason (network drop, KickBot 5xx, timeout) was marked as played and never retried. Capture is now retried (3 attempts, 15 s apart) and an uncaptured tip is never marked as played; only a definitive "declined" answer from KickBot ends it.
- Fixed: the "text-only alert when no file matches" option was accepted by the API but ignored; it now works and has a switch on the Settings page.
- Fixed: Persian/Arabic-Indic digits in file names (`۱۵۰T`) and donor messages are recognised for thresholds and keywords.
- Fixed: HTTP suffix Range requests (`bytes=-500`) returned the first bytes instead of the last; sub alerts received before the first exchange rate showed 0 instead of the USD price; the autostart switch is saved immediately.
- Changed: duplicate detection for Kick chat events is 2.5 s and keyed by gifter + recipients (identical back-to-back gift batches are no longer merged); the rate-interval field defaults to 2 minutes like the server.
- Hardening: Content-Security-Policy is also sent as an HTTP header (so `frame-ancestors` applies), the app accepts `cardpos` messages only from its own origin, uploads stream to disk instead of being buffered in RAM, oversized third-party responses fail instead of being silently truncated, `POST /api/config` can no longer drop file entries (use `DELETE /api/file`), "clear application data" also removes the log and config backups, and Meld self-heal is opt-in (only the installed app enables it).
- Fixed: launching the app while it is already running now only brings the existing window to the front; it could briefly start a second server and show a "port in use" error.
- Electron updated to 43.7.3 (Chromium security fixes).
- The uninstaller now removes the "run at Windows login" registry entry; test instances started with `SAHNE_PLUS_DATA_DIR` never register themselves for login.
- Code formatted with Prettier (120 columns); `npm run format:check` runs in CI. `engines` declares Node 22+.
- Tests: regression tests for the image-alert and capture-retry fixes, upload / Range / config handling and digit normalisation.

## 1.2.0 — 2026-09-18

- Exchange rate now comes from the baha24.com public JSON API (live sell rate, refreshed every 2 minutes by default, minimum 1). bonbast.com is only used as a fallback, at most every 5 minutes. The rate source is shown next to the rate in the app.
- Fixed: the first-run setup card stayed visible after the KickBot link was configured.

## 1.1.1 — 2026-09-18

- Removed an unnecessary mention of an unrelated third-party product from the About page and documents. No functional change.

## 1.1.0 — 2026-09-18 (release-readiness hardening)

Security
- KickBot widget key is now stored encrypted with Windows DPAPI (`secret_id_enc`); existing plaintext keys are migrated on first start and the plaintext field is removed. The key is no longer returned by any API, masked in the UI and redacted from logs.
- Local server: `Host` validation (DNS rebinding) and `Origin` validation for state-changing requests (CSRF); `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options` headers.
- Browser Source: strict Content-Security-Policy, scripts and styles moved to files, single-pass safe template rendering for donor names/messages (all values escaped), only `https:` GIF/TTS URLs and same-origin media URLs are loaded, `postMessage` restricted to the app origin.
- Imported media: content sniffing (a `.webm` must really be a WebM, etc.), 512 MB limit, Windows reserved names and Unicode control characters stripped from file names, symlinks resolved, sources never modified.
- Every field accepted by the API is validated (numeric bounds, enums, colour format, font allow-list, text length limits). Third-party text (names, messages, usernames) is stripped of control and bidi-override characters and length-limited.
- Electron: `sandbox: true`, DevTools disabled in packaged builds, permission requests denied, IPC calls accepted only from the app window, external links limited to an allow-list, Electron fuses (RunAsNode / NODE_OPTIONS / inspect off, ASAR integrity on).

Privacy
- Google Fonts removed from the Browser Source; all fonts are bundled locally.
- New in-app About page with privacy policy, terms, third-party notices, data location and security contact.

Reliability
- Played-alert ids are persisted (`played.json`) so a donation is not replayed after a restart.
- Corrupted `config.json` is preserved as `config.json.corrupt-<timestamp>` instead of being overwritten; config writes are atomic.
- Bonbast: malformed or out-of-range responses are rejected and the previous rate is kept; the failure is shown in the UI; minimum refresh interval 5 minutes; requests have timeouts.
- Kick chat reconnect uses exponential back-off (5 s → 60 s).
- Queue advance is guarded against re-entrancy; in-memory queues are capped.

Data controls
- Disconnect KickBot, Reset settings, Clear application data (with confirmation dialogs).

## 1.0.1 — 2026-09-18

- First hardening pass: loopback Host/Origin checks, sandboxed renderer, Electron fuses.

## 1.0.0 — 2026-09-18

- Initial desktop release: Electron shell around the KickAlerts engine, SAHNE-style UI, NSIS installer.
