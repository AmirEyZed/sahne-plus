## Sahne+ 1.3.2

**Version:** 1.3.2 · **Release date:** 2026-09-21

### What's new
- **Two security fixes** reported by [KernelDotDLL](https://github.com/KernelDotDLL) (thank you). A web page open in the streamer's browser could connect to the alert event stream: it could not read anything, but the connection counted as a Browser Source, so an alert could be consumed while OBS was closed. The stream now refuses connections from other sites and limits how many connections each role may open. The media route also served every file in the media folder; only registered alert files are served now.
- Fixed: in the file editor the header icon was oversized and the preview collapsed when the window was short; the setup card on the Home page has a proper gap below it (thanks [TikTaak](https://github.com/TikTaak)).
- New issue forms in the repository, in Persian and English (thanks [shahriaarrr](https://github.com/shahriaarrr)).
- Verify this installer: `gh attestation verify .\Sahne-Plus-Setup-1.3.2.exe --repo AmirEyZed/sahne-plus`

### How to update
Sahne+ 1.3.1 and later show a notice inside the app: click **آپدیت** and the rest happens by itself. From 1.3.0 or older, install this file manually once.

### Files in this release
- `Sahne-Plus-Setup-1.3.2.exe` — Windows installer (per-user, no admin rights needed)
- `SHA256SUMS.txt` — SHA-256 checksum of the installer (generated in the release workflow)
- `README-FA.txt` — راهنمای فارسی

### Notice
SHA-256 checksums verify the integrity of downloaded files; the provenance attestation proves the file was built by this repository's workflow from the public source. Neither is a security audit. The installer is not code-signed yet; Windows SmartScreen may warn — verify, then choose **More info → Run anyway**. Download Sahne+ only from this repository's Releases page.

Sahne+ is an independent third-party application and is not affiliated with, endorsed by, or sponsored by Kick, KickBot, baha24 or Bonbast. Privacy: [PRIVACY.md](https://github.com/AmirEyZed/sahne-plus/blob/main/PRIVACY.md) · Terms: [TERMS.md](https://github.com/AmirEyZed/sahne-plus/blob/main/TERMS.md) · Security: [SECURITY.md](https://github.com/AmirEyZed/sahne-plus/blob/main/SECURITY.md)
