# Changelog — Sahne Plus

All notable changes to the public builds. Versions follow semantic versioning.

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
