## Sahne Plus 1.1.0 — first public release

Local, transparent WebM alerts for **KickBot donations**, **Kick subscriptions** and **Kick gifted subscriptions** on Windows. Add the Browser Source to OBS or Meld Studio, drop your media in, set a toman tier per file — done.

### Download
- `Sahne-Plus-Setup-1.1.0.exe` — installer (per-user, no admin rights needed)
- `SHA256SUMS.txt` — checksum of the installer
- `README-FA.txt` — راهنمای فارسی

**SHA-256 (installer):** `4c74c37476b745a51bb670533355ca190a3134940580af056698090de73da37f`

> The installer is not code-signed yet. Windows SmartScreen will show "Windows protected your PC": verify the checksum, then click **More info → Run anyway**.

### Privacy
No cloud backend, no analytics, no telemetry, no auto-update. Media and settings stay in `Documents\Sahne Plus`. Network connections only to KickBot (donations), Kick's public chat feed (subscriptions) and bonbast.com (exchange rate). Your KickBot widget key is stored encrypted with Windows DPAPI. Details: [PRIVACY.md](https://github.com/AmirEyZed/sahne-plus/blob/main/PRIVACY.md).

### Highlights of the hardening in this build
See [CHANGELOG.md](https://github.com/AmirEyZed/sahne-plus/blob/main/CHANGELOG.md): loopback-only server with Host/Origin checks, strict CSP and text-only rendering of donor names and messages on the Browser Source, media content validation, sandboxed Electron with locked fuses, bundled fonts.

Sahne Plus is an independent third-party application and is not affiliated with, endorsed by, or sponsored by Kick, KickBot or Bonbast. Terms: [TERMS.md](https://github.com/AmirEyZed/sahne-plus/blob/main/TERMS.md).
