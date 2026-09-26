## Sahne+ 1.3.6

**Version:** 1.3.6 · **Release date:** 2026-09-26

### What's new
- **Disconnecting KickBot keeps your other alerts.** Kick subscription / gift-sub alerts and StreamElements tips that were waiting in the queue were removed together with KickBot's donations. Now only KickBot's own donations are removed. Thanks @SoroushRF (#4).
- **The playing alert on the Home page shows its real amount.** The «در حال پخش» chip always showed a dollar sign ("$5" for a 5 EUR tip); it now shows toman, or the amount with its currency code, like the recent list. Thanks @SoroushRF (#5).
- Verify this installer: `gh attestation verify .\Sahne-Plus-Setup-1.3.6.exe --repo AmirEyZed/sahne-plus`

### How to update
Sahne+ 1.3.1 and later show a notice inside the app: click **آپدیت**. From 1.3.0 or older, install this file manually once.

### Files in this release
- `Sahne-Plus-Setup-1.3.6.exe` — Windows installer (per-user, no admin rights needed)
- `SHA256SUMS.txt` — SHA-256 checksum of the installer (generated in the release workflow)
- `README-FA.txt` — راهنمای فارسی

### Notice
SHA-256 checksums verify the integrity of downloaded files; the provenance attestation proves the file was built by this repository's workflow from the public source. Neither is a security audit. The installer is not code-signed yet; Windows SmartScreen may warn — verify, then choose **More info → Run anyway**. Download Sahne+ only from this repository's Releases page.

Sahne+ is an independent third-party application and is not affiliated with, endorsed by, or sponsored by Kick, KickBot, StreamElements, baha24 or Bonbast. Privacy: [PRIVACY.md](https://github.com/AmirEyZed/sahne-plus/blob/main/PRIVACY.md) · Terms: [TERMS.md](https://github.com/AmirEyZed/sahne-plus/blob/main/TERMS.md) · Security: [SECURITY.md](https://github.com/AmirEyZed/sahne-plus/blob/main/SECURITY.md)
