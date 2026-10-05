## Sahne+ 1.4.0

**Version:** 1.4.0 · **Release date:** 2026-10-05

### What's new
- **New: the «آمار» page.** A summary of the donations whose alerts play from this version on: totals in dollars and toman, count, top donors, trend charts and an activity map, with Persian-calendar ranges. It is computed and stored only on your computer, sends nothing anywhere, and recording can be switched off in Settings → «برنامه». Thanks @1tzArad (#6).
- **Waiting alerts survive a restart.** StreamElements tips and Kick subs/gifts that were waiting in the queue (paused, or no Browser Source open) are now kept like captured KickBot donations and play after Sahne+ starts again. Thanks @SoroushRF (#20).
- **Fixes:** an old KickBot queue sync can no longer refill the queue after disconnecting (#13); the StreamElements token no longer shows as encrypted when only the KickBot key was (#14); the file editor rejects a minimum amount above the maximum, which could never match an alert (#15). Thanks @SoroushRF.
- **Privacy policy corrected:** uninstalling keeps Electron's profile folder (`%APPDATA%\SahnePlus`) as well as `Documents\Sahne Plus`; PRIVACY.md said otherwise and now explains how to remove both. The data-flow audit was refreshed against the current source (#16).
- Project: tests also run on Windows in CI (#17); the screenshot script takes a port (#18).
- Verify this installer: `gh attestation verify .\Sahne-Plus-Setup-1.4.0.exe --repo AmirEyZed/sahne-plus`

### How to update
Sahne+ 1.3.1 and later show a notice inside the app: click **آپدیت**. From 1.3.0 or older, install this file manually once.

### Files in this release
- `Sahne-Plus-Setup-1.4.0.exe` — Windows installer (per-user, no admin rights needed)
- `SHA256SUMS.txt` — SHA-256 checksum of the installer (generated in the release workflow)
- `README-FA.txt` — راهنمای فارسی

### Notice
SHA-256 checksums verify the integrity of downloaded files; the provenance attestation proves the file was built by this repository's workflow from the public source. Neither is a security audit. The installer is not code-signed yet; Windows SmartScreen may warn — verify, then choose **More info → Run anyway**. Download Sahne+ only from this repository's Releases page.

Sahne+ is an independent third-party application and is not affiliated with, endorsed by, or sponsored by Kick, KickBot, StreamElements, baha24 or Bonbast. Privacy: [PRIVACY.md](https://github.com/AmirEyZed/sahne-plus/blob/main/PRIVACY.md) · Terms: [TERMS.md](https://github.com/AmirEyZed/sahne-plus/blob/main/TERMS.md) · Security: [SECURITY.md](https://github.com/AmirEyZed/sahne-plus/blob/main/SECURITY.md)
