## Sahne+ 1.3.1

**Version:** 1.3.1 · **Release date:** 2026-09-19

### What's new
- **Updates inside the app:** from now on Sahne+ shows a notice when a new version is out, and one click downloads, verifies and installs it — never without your click, and the check can be turned off in Settings. This version itself has to be installed manually once.
- **Kick subs with a VPN, no extra setup:** if kick.com is filtered on your network, Sahne+ now uses your VPN app's Windows system proxy automatically (for example v2rayN in "system proxy" mode). The detected proxy is shown in Settings; a manually entered proxy still comes first. SOCKS-only setups: turn on the VPN's TUN mode or enter its HTTP proxy.
- **Readable Kick errors:** the Kick card now explains the problem in Persian — kick.com filtered, channel not found, request refused by Kick — and what to do, instead of codes like `read ECONNRESET`.
- **Card delay:** the name and amount card (and the KickBot TTS) can appear a few seconds after the animation starts — globally on the Look page, or per file in the file editor.
- This installer was built by GitHub Actions from the tagged source and carries a build provenance attestation: `gh attestation verify .\Sahne-Plus-Setup-1.3.1.exe --repo AmirEyZed/sahne-plus`

### Files in this release
- `Sahne-Plus-Setup-1.3.1.exe` — Windows installer (per-user, no admin rights needed)
- `SHA256SUMS.txt` — SHA-256 checksum of the installer (generated in the release workflow)
- `README-FA.txt` — راهنمای فارسی

### Notice
SHA-256 checksums verify the integrity of downloaded files; the provenance attestation proves the file was built by this repository's workflow from the public source. Neither is a security audit. The installer is not code-signed yet; Windows SmartScreen may warn — verify, then choose **More info → Run anyway**. Download Sahne+ only from this repository's Releases page.

Sahne+ is an independent third-party application and is not affiliated with, endorsed by, or sponsored by Kick, KickBot, baha24 or Bonbast. Privacy: [PRIVACY.md](https://github.com/AmirEyZed/sahne-plus/blob/main/PRIVACY.md) · Terms: [TERMS.md](https://github.com/AmirEyZed/sahne-plus/blob/main/TERMS.md) · Security: [SECURITY.md](https://github.com/AmirEyZed/sahne-plus/blob/main/SECURITY.md)
