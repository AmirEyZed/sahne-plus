## Sahne+ 1.3.3

**Version:** 1.3.3 · **Release date:** 2026-09-22

### What's new
- **Hardening:** the installed app ignores Chromium's remote-debugging switches (`--remote-debugging-port`, `--remote-debugging-pipe`, `--remote-debugging-address`), so it can no longer be started with the DevTools protocol open. Defence in depth: starting the app with arguments already requires access to the Windows account. No other changes to how the app behaves.
- Verify this installer: `gh attestation verify .\Sahne-Plus-Setup-1.3.3.exe --repo AmirEyZed/sahne-plus`

### How to update
Sahne+ 1.3.1 and later show a notice inside the app: click **آپدیت** and the rest happens by itself. From 1.3.0 or older, install this file manually once.

### Files in this release
- `Sahne-Plus-Setup-1.3.3.exe` — Windows installer (per-user, no admin rights needed)
- `SHA256SUMS.txt` — SHA-256 checksum of the installer (generated in the release workflow)
- `README-FA.txt` — راهنمای فارسی

### Notice
SHA-256 checksums verify the integrity of downloaded files; the provenance attestation proves the file was built by this repository's workflow from the public source. Neither is a security audit. The installer is not code-signed yet; Windows SmartScreen may warn — verify, then choose **More info → Run anyway**. Download Sahne+ only from this repository's Releases page.

Sahne+ is an independent third-party application and is not affiliated with, endorsed by, or sponsored by Kick, KickBot, baha24 or Bonbast. Privacy: [PRIVACY.md](https://github.com/AmirEyZed/sahne-plus/blob/main/PRIVACY.md) · Terms: [TERMS.md](https://github.com/AmirEyZed/sahne-plus/blob/main/TERMS.md) · Security: [SECURITY.md](https://github.com/AmirEyZed/sahne-plus/blob/main/SECURITY.md)
