# Sahne Plus 1.1.0 — Release readiness report

> Historical snapshot (2026-09-18, version 1.1.0), kept for transparency. The current state — public source, CI builds, attestation, tests — is described in README.md, SECURITY.md and CHANGELOG.md.

Scope: audit of the actual implementation in `Documents\SahnePlus` (Electron 43.2.0, zero runtime npm dependencies), the production build `dist\Sahne-Plus-Setup-1.1.0.exe` (SHA-256 in `release\Sahne-Plus-1.1.0\SHA256SUMS.txt`) and the installed copy running on this machine. "Verified" means I ran it or read the exact code path; "reviewed" means code inspection only.

Status 2026-09-18: a private source repository (tag v1.1.0) and the public documentation repository https://github.com/AmirEyZed/sahne-plus were created and pushed. GitHub Release v1.1.0 (installer, SHA256SUMS.txt, README-FA.txt) was published on 2026-09-18: https://github.com/AmirEyZed/sahne-plus/releases/tag/v1.1.0

---

## RELEASE BLOCKERS

Problems that make the current build unsafe, non-compliant or unsuitable for public distribution.

### B1. Legal placeholders are not filled in — RESOLVED 2026-09-18
- **Check:** TERMS.md, PRIVACY.md, SECURITY.md, `electron/main.js` (`SECURITY_CONTACT`).
- **Problem:** owner legal name, contact e-mail, security e-mail, governing law and venue are placeholders (`security@example.com`, `[jurisdiction placeholder]`).
- **Reason:** a public EULA/privacy policy without a real contact and jurisdiction is not usable and misleads users.
- **Fix applied:** contact and security reporting now go through the public GitHub repository (issues + GitHub private vulnerability reporting), so no personal e-mail is published; governing law = the Licensor's country of residence at the time of a dispute (generic, lawful formulation for an individual developer). Rebuilt as 1.1.0 with the new About-page contact.
- **Verification:** `grep -rn "placeholder\|example.com" docs public/legal electron/main.js` must return nothing.

### B2. Kick subscription feed relies on undocumented Kick infrastructure — DECISION: ship with disclosure (owner, 2026-09-18)
- **Check:** `server/server.js` `resolveKickChannel()` (`https://kick.com/api/v2/channels/<slug>`) and `kickConnect()` (Pusher app key `32cbd69e4b950bf97679`, public channels `chatrooms.<id>.v2`, `chatroom_<id>`, `channel.<id>`).
- **Finding (verified against docs.kick.com on 2026-09-18):** Kick's *official* developer API delivers `channel.subscription.new`, `channel.subscription.renewal` and `channel.subscription.gifts` **only as webhooks** to an app registered with OAuth 2.0 (Client ID/Secret, redirect URL) and a public callback endpoint. Sahne Plus does not use that; it reads Kick's website chat feed through its public Pusher key, the same data the kick.com web page receives, without authentication. Kick's developer documentation requires reviewing the "Developer Terms and Conditions"; whether reading the public chat feed from a desktop app is permitted under Kick's current terms was **not verified** and cannot be verified from the code.
- **Why a blocker:** shipping publicly with an undocumented integration is a legal/compliance risk (terms of service) and a maintenance risk (event names such as `*GiftedSubscriptionsEvent` can change without notice). It must not be marketed as an official Kick integration.
- **Fix applied:** README, PRIVACY and TERMS describe it truthfully ("Kick's public chat feed", "not documented for third-party use", "may stop working"); the app never claims Kick affiliation; the About page carries the disclaimer.
- **Decision required from the owner:** (a) accept and ship with the disclosure, (b) read Kick's Developer Terms and confirm, or (c) move to the official webhook API (needs a hosted relay — out of scope for a local-only app).
- **Verification:** WebFetch of `docs.kick.com/events/event-types` and `docs.kick.com/getting-started/kick-apps-setup`.

### B3. KickBot integration reuses the private widget API — DECISION: ship with disclosure (owner, 2026-09-18)
- **Check:** `connect()` → `wss://kickbot.live/ws`, `syncQueue()` → `GET /api/tip_queue_sync?secret_id=…`, `captureTip()` → `POST /api/capture_tip`, `/api/setup` → `GET /external/tipping/<secret>/__data.json`.
- **Finding:** these are the endpoints KickBot's own browser widget calls; there is no published third-party API. The widget URL contains a **secret** (`<32 hex>:<32 hex>`) that authorises subscribing to the streamer's tipping channel, reading the queue and capturing tips — it is a bearer-like credential, classified SECRET.
- **What "payment verification" really is (accurate wording):** Sahne Plus does *not* verify payments. When an alert starts it sends the same `capture_tip` request the official widget sends; KickBot/Stripe decide the outcome and return `payment_success`. Docs now say exactly this.
- **Fix applied:** secret stored with DPAPI, never logged/returned/shown (see V-items). KickBot's terms for third-party use were **not** verifiable from code.
- **Decision required from the owner:** confirm KickBot allows a replacement widget, or obtain permission.

### B4. No code signing — ACCEPTED FOR 1.1.0 (checksum + SmartScreen note); certificate recommended for the next release
- **Check:** `Get-AuthenticodeSignature` on the installer and `Sahne Plus.exe` → `NotSigned`; no code-signing certificate in the user store.
- **Reason:** every recipient gets Windows SmartScreen "Windows protected your PC"; antivirus heuristics flag unsigned Electron apps more often; users cannot distinguish a tampered installer from the real one except by checksum.
- **Fix:** obtain an OV or EV code-signing certificate (EV gives immediate SmartScreen reputation; OV builds reputation over time), sign with electron-builder (`win.certificateSubjectName` / `signtoolOptions`, secrets via GitHub Actions secrets, never committed). Until then the README and README-FA explain the warning and the SHA-256 checksum.
- **Verification:** after signing, `Get-AuthenticodeSignature` must return `Valid` with the publisher name.

---

## HIGH PRIORITY

### H1. Source control does not exist yet
- **Check:** `git rev-parse` in `Documents\SahnePlus` → not a repository.
- **Problem:** no history, no way to tag the release, no branch protection. Because there is no history, there is also **no leaked credential in Git history** (verified by absence), so no rotation is required today.
- **Fix:** `git init` a **private** repository; `.gitignore` already excludes `node_modules/`, `dist/`, `release/`, logs, `config.json*`, `played.json`, `.env*`. Run the secret scan (below) as a pre-commit check.
- **Verification:** `grep -rnE "[0-9a-f]{32}(:|%3A)[0-9a-f]{32}|widgets\.kickbot\.com/external/tipping/[0-9a-f]" --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=release .` → no matches (run 2026-09-18, clean).

### H2. Bonbast scraping has no permission and no API
- **Check:** `fetchBonbast()`: fetches the HTML home page, extracts a `param:"…"` token, POSTs it to `/json`, reads `usd1`. `robots.txt` only disallows `/pagead`; no terms page was reviewed (none found from the code). Requests every ≥5 min with a desktop User-Agent.
- **Risk:** page format changes break the rate (handled safely: error logged, previous rate kept, UI shows "آخرین تلاش ناموفق"); bonbast may block or object to automated access.
- **Fix applied:** strict validation (`Number.isFinite`, 1 000 ≤ rate ≤ 1 000 000 000, JSON parse guarded), 15 s timeouts, `rateBusy` guard, minimum interval raised to 5 minutes, manual rate option remains. 
- **Recommended:** ask bonbast for permission or offer a second source; document in TERMS (done, §5).

### H3. Kick event de-duplication is heuristic
- **Check:** `seenRecently('gift:<gifter>:<count>')` / `seenRecently('sub:<name>')`, 15 s window. Kick chat events carry no stable event id; the same event can arrive on more than one subscribed channel.
- **Consequence:** two identical gift batches from the same gifter within 15 s collapse into one alert; a second real sub from the same user within 15 s is dropped.
- **Fix:** documented in code and DATA_FLOW; acceptable for launch. Improvement: key on `(gifter, sorted recipient list)` for gifts.
- **Verification:** code review.

### H4. The Browser Source can call controller endpoints
- **Check:** same-origin design; the overlay page (`/overlay`) can reach `/api/*` because it is served from the same origin. Other origins are blocked (Host/Origin checks verified with 403s).
- **Risk:** only if the overlay page itself were compromised (it renders untrusted text only — verified below), so this is defence-in-depth, not an active hole.
- **Recommended:** split roles by port or a capability token in the overlay URL in a later release.

### H5. Uninstall leaves the autostart registry value
- **Check:** `HKCU\...\Run\SahnePlus` is written by `app.setLoginItemSettings`; the NSIS uninstaller does not remove it.
- **Fix:** add an NSIS `customUnInstall` macro that deletes the value, or clear it in `will-quit` when launched with `--uninstall`. Documented in PRIVACY §7 meanwhile.

### H6. Public screenshots
- **Problem:** the only screenshot taken so far shows the owner's own channel name; no clean screenshot exists for the public README.
- **Fix:** run the app with a fresh `SAHNE_PLUS_DATA_DIR`, import sample media, capture Home/Files/Look.

---

## RECOMMENDED

- R1. Capability-token separation between overlay and controller (see H4).
- R2. Second exchange-rate source or manual-only mode when bonbast fails for > 24 h (currently the stale rate is used silently after the first warning; the UI shows the last-update time).
- R3. Log viewer redaction option (donor names in `sahne-plus.log` are third-party personal data — local only, but streamers sharing logs for support should be able to strip names). Add "copy log without names".
- R4. Move the Kick integration to the official webhook API if a hosted relay ever becomes acceptable.
- R5. Reproducible builds and GitHub Actions with least-privilege permissions (`contents: write` only for the release job) once a repository exists; no auto-updater (none exists today — GitHub Releases are manual, which is the safest option right now).
- R6. Localised NSIS installer strings (installer is English; the app is Persian).
- R7. Unit tests for `sanitizeFile`, `sanitizeAppearance`, `pickMedia` edge cases (negative/NaN/huge, Persian keyword normalisation) — the behaviour was verified manually via the API (see V-items) but is not covered by automated tests except the overlay XSS test (`scripts/test-overlay-xss.js`).
- R8. `maxToman` below `minToman` is accepted (file then never plays); add a UI warning.

---

## VERIFIED / PASSED

Each item was inspected in code **and** exercised on the running build unless marked "code review".

| # | Check | Files | How verified |
|---|---|---|---|
| V1 | Server binds `127.0.0.1` only | `server.js` `server.listen(config.port, '127.0.0.1')` | `Get-NetTCPConnection` on the installed app: only `127.0.0.1:7788`; TCP connect to `192.168.1.33:7788` refused, to `127.0.0.1:7788` succeeds |
| V2 | DNS rebinding blocked | `hostAllowed()` | `GET /api/config` with `Host: evil.com:7799` → 403; `Host: localhost:7799` / `127.0.0.1` → 200 |
| V3 | CSRF blocked | `originAllowed()`, `MUTATING` | `POST /api/config` with `Origin: http://evil.com` → 403 (secret unchanged afterwards); `DELETE` with `Origin: null` → 403; `POST /api/done` from `http://localhost:7799` → 200; no-Origin curl → 200 |
| V4 | Path traversal | `servePublic()`, `/media/` basename | `/fonts/../../package.json` → 404; `/media/..%5c..%5cconfig.json` → 404 |
| V5 | KickBot secret never leaves the process except to KickBot | `publicConfig()`, `safe()` redaction, `serializedConfig()` | live `/api/config` body does not contain `secret_id`; `sahne-plus.log` has no `<32hex>:<32hex>`; config.json has `secret_id_enc` only |
| V6 | Secret encrypted at rest with DPAPI; legacy plaintext migrated | `secretStore` (`safeStorage`), `loadConfig()` | isolated instance seeded with plaintext `secret_id` → after start: `secret_id` absent, `secret_id_enc` present (128 chars); installed app: same result on the owner's real config; `secretStorage:"os"` reported |
| V7 | "Disconnect KickBot" wipes the secret | `/api/disconnect-kickbot` | after call: `secret_id_enc` absent, `streamer_id` null, queues cleared |
| V8 | Browser Source renders untrusted text safely | `overlay.js` `esc()`, single-pass `headline()`, `safeUrl()`/`localUrl()`, CSP in `overlay.html` | `scripts/test-overlay-xss.js`: `<script>`, `<img onerror>`, `<style>`, `<a>`, `$&`, `` $` ``, `{amount}` inside the name, quotes — all rendered as escaped text; `javascript:` gif URL and foreign `http://evil.example` media/TTS refused. CSP: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https:; media-src 'self' https:; connect-src 'self'` |
| V9 | Third-party text cleaned server-side | `cleanText()` (control + bidi-override chars stripped, name ≤ 80, message ≤ 500), `normalizeTip()` | PATCH with `‮` keyword → stored as `evil` without the override char; 200-char name → 80 |
| V10 | API input validation | `sanitizeAppearance()`, `sanitizeFile()`, enums, `finite()` | POST with font `Comic Sans`, textSize 9999, colour `red;}body{`, animation `evil`, mode `evil`, interval 0, proxy `javascript:` → stored: Vazirmatn / 120 / `#53fc18` / pop / standalone / 5 / `""`; malicious `file:"..\\..\\config.json"` entry dropped; `minToman:-5` → 0; keyword truncated to 50; volume 500 → 100 |
| V11 | Media import is validated | `sniffOk()`, `safeMediaName()`, `LIMITS.upload`, `realpathSync` | `MZ…` bytes uploaded as `CON.webm` → rejected ("محتوای فایل با پسوندش نمی‌خواند"); real WebM uploaded as `..\..\<U+202E>COM1.webm` → stored as `media_<hex>.webm`; imports copy the file, never delete the source |
| V12 | Simulated events never reach KickBot | `tryNext()` guard `!t.is_test && !t.is_local`, `finishPlaying()` | code review; test tips carry `is_test:true`, `TEST` badge on overlay, `test:true` in recent list |
| V13 | Play-once guarantee | `playedIds` + `played.json` (last 1000), `advancing` re-entrancy guard, `stripe_pi_id` de-dup in `syncQueue()` | code review; `played.json` written on the installed app |
| V14 | Corrupted config is preserved, not overwritten | `loadConfig()` | unit run with `{ this is not json` → `config.json.corrupt-<ts>` created, defaults written |
| V15 | Electron hardening | `main.js` | `sandbox:true` + `webUtils` confirmed by `preload ready {"sandboxed":true,"webUtils":true}` in the live log; `contextIsolation:true`, `nodeIntegration:false`, `webviewTag:false`, `devTools:!app.isPackaged`, permission requests denied, `setWindowOpenHandler` deny, `will-navigate` guard, IPC accepted only from the app window (`fromMain`), `openExternal` allow-listed, `openPath` fixed targets, no `remote`, no `eval`/`new Function`, no `child_process` (grep clean) |
| V16 | Electron fuses | `package.json` `build.electronFuses` | fuse wire bytes on the built exe `0,1,0,0,1,1,0,0` → RunAsNode off, cookie encryption on, NODE_OPTIONS off, inspect off, ASAR integrity on, only-load-from-ASAR on |
| V17 | Package contains no personal data | asar extracted | 28 files; grep for secret pattern, streamer id, local paths, channel name → none (only brand/author strings) |
| V18 | No CDN / Google Fonts | `overlay.html`, `overlay.css`, `app.html` | `googleapis` count 0 in all three; five OFL fonts bundled with license texts |
| V19 | Licensing | `package.json` `"license":"UNLICENSED"`, `LICENSE.txt`, `THIRD_PARTY_NOTICES.md` | no copyleft component; Electron/Chromium/Node MIT/BSD notices shipped by electron-builder (`LICENSE.electron.txt`, `LICENSES.chromium.html`); fonts OFL 1.1 |
| V20 | No analytics / telemetry / crash reporting / auto-update | whole tree | grep for `sentry`, `analytics`, `autoUpdater`, `crashReporter`, `gtag` → none; runtime connections of the installed app: KickBot + Pusher only |
| V21 | Build identity | `dist\win-unpacked\Sahne Plus.exe` | ProductName `Sahne Plus`, CompanyName `AmirEyZed`, version 1.1.0.0, appId `com.amireyzed.sahneplus`, NSIS per-user, `Uninstall Sahne Plus.exe` |
| V22 | Port collision behaviour | `main.js` `EADDRINUSE` branch | code review: modal error, "retry" relaunches, never rebinds elsewhere |
| V23 | Meld self-heal touches only our own layers | `isOurs()` (host localhost/127.0.0.1, port equal, path `/overlay`), disabled for test instances | code review + `scripts/meld-layers.js` listing |
| V24 | Data controls | `/api/reset-settings`, `/api/disconnect-kickbot`, IPC `data:clear` with native confirmation dialog, Open Data Folder / Log | reset + disconnect exercised on the isolated instance; clear-data dialog reviewed |
| V25 | About page | `app.html` About section | version, data path, local server, secret storage mode, security contact, disclaimer, documents rendered from `/legal/*.md` |

### Failure modes exercised or reviewed

| Case | Result |
|---|---|
| corrupted `config.json` | verified (V14) |
| KickBot unreachable | code: 10 s connect timeout, reconnect every 5–10 s, status `reconnecting` in UI |
| Kick unreachable / Pusher loop | code: back-off 5 s → 60 s, status `reconnecting`/`error` |
| bonbast malformed / unavailable | code: validation rejects, previous rate kept, `rateError` shown, timeouts 15 s |
| port busy | code (V22) |
| Browser Source disconnected | verified: alerts wait (`clients.overlay.size === 0`), reconnect shows nothing twice (`playedIds`) |
| deleted media file | code: `pickMedia` filters `existsSync`, `/api/scan` prunes entries |
| invalid WebM | overlay: `error` event ends the alert after `minDuration`; import rejects non-WebM content |
| huge message / thousands of events | server caps message 500 chars, queues 500, recent 30, logs 300, played 1000 |
| missing Documents dir / read-only | `mkdirSync` recursive at start with error dialog; `saveConfig` catches and logs |

---

## Release checklist (what remains before the owner's go-ahead)

1. Fill in B1 placeholders; rebuild; re-run `scripts/test-overlay-xss.js` and the API test battery.
2. Decide B2/B3 (third-party terms) and, if accepted, keep the disclosures.
3. Obtain a code-signing certificate (B4) — or accept SmartScreen warnings for the first releases.
4. ~~git init (private), first commit, tag v1.1.0~~ — done (private repository, v1.1.0).
5. ~~Create the public repository~~ — done. ~~Publish the release~~ — done (v1.1.0). Remaining: confirm private vulnerability reporting is enabled (Settings → Security).


---

## Open-source readiness (1.3.0, 2026-09-19)

| Check | Result |
|---|---|
| License | Apache-2.0 (`LICENSE`, `NOTICE`); brand excluded via `BRANDING.md`; `package.json` license Apache-2.0; TERMS rewritten so it no longer restricts modification/redistribution |
| Secrets / personal data in the tree | none — scan for KickBot keys, streamer id, local paths, channel names clean; CI secret-scan step added |
| Git history of the repository that goes public | the public repo's history is docs-only; the source arrives in a single commit — no proprietary-era secrets exist in either history |
| Third-party licenses | Electron MIT, Chromium BSD, fonts OFL 1.1 with license files bundled; no copyleft |
| Tests | `npm test`: server validation + loopback hardening (node:test) and overlay XSS test |
| CI | `ci.yml` (tests + secret scan on push/PR), `build-release.yml` (Windows build on tag, SHA256SUMS, provenance attestation, release publish), `release-checksums.yml` (verifies uploaded checksums) |
| Undocumented third-party integrations | unchanged; already documented publicly; exposure risk accepted by the owner |
| One-off scripts removed | patch-*.js deleted; remaining scripts are dev tools (icons, screenshots, Meld diagnostic) |
| In-app | About page shows the Apache license and NOTICE; DEVELOPMENT-FA.md holds the Persian dev notes |
