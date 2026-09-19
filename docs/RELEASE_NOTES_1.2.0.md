## Sahne+ 1.2.0 — live exchange rate from baha24

**Version:** 1.2.0 · **Release date:** 2026-09-18

Local, transparent WebM alerts for **KickBot donations**, **Kick subscriptions** and **Kick gifted subscriptions** on Windows. Add the Browser Source to OBS or Meld Studio, drop your media in, set a toman tier per file — done.

### Download
- `Sahne-Plus-Setup-1.2.0.exe` — installer (per-user, no admin rights needed)
- `SHA256SUMS.txt` — checksum of the installer
- `README-FA.txt` — راهنمای فارسی

**SHA-256 (installer):** `dddbaa942d715021b5636998cb2f62321127b2c031b4daee7efc840eef1bfc92`

> **Update (2026-09-19):** the source code has been public under the Apache License 2.0 since 1.3.0.
>
> **Notice (as written for this release):** The source code of Sahne+ is currently private and is planned to be made public in the future. SHA-256 checksums are provided to verify the integrity of downloaded release files and should not be interpreted as a security audit. The installer is not code-signed yet; Windows SmartScreen may warn — verify the checksum, then click **More info → Run anyway**. Download Sahne+ only from this repository's Releases page.

### Privacy
No cloud backend, no analytics, no telemetry, no auto-update. Media and settings stay in `Documents\Sahne Plus`. Network connections only to KickBot (donations), Kick's public chat feed (subscriptions) and baha24.com / bonbast.com (exchange rate). Your KickBot widget key is stored encrypted with Windows DPAPI. Details: [PRIVACY.md](https://github.com/AmirEyZed/sahne-plus/blob/main/PRIVACY.md).

### What's new
- Dollar-to-toman conversion now uses the live **baha24.com** public API (every 2 minutes by default, adjustable down to 1); bonbast.com remains only as a fallback. The current source is shown next to the rate.
- Fixed: the first-run setup card no longer stays visible after KickBot is connected.

### Hardening carried over from 1.1
See [CHANGELOG.md](https://github.com/AmirEyZed/sahne-plus/blob/main/CHANGELOG.md): loopback-only server with Host/Origin checks, strict CSP and text-only rendering of donor names and messages on the Browser Source, media content validation, sandboxed Electron with locked fuses, bundled fonts.

Sahne Plus is an independent third-party application and is not affiliated with, endorsed by, or sponsored by Kick, KickBot or Bonbast. Terms: [TERMS.md](https://github.com/AmirEyZed/sahne-plus/blob/main/TERMS.md).
