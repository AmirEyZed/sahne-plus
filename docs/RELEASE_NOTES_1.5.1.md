## Sahne+ 1.5.1

**Version:** 1.5.1 · **Release date:** 2026-10-18

### What's new
- **A failed settings save is now reported.** Editing settings, the appearance autosave, a file's properties and «بازگشت به پیش‌فرض» could show «ذخیره شد» even when `config.json` could not be written (disk full, file locked, folder read-only); the edit then lived only until the next restart. Now the previous settings stay active, the controller shows an error and keeps your draft so you can retry, and desktop autostart restores its previous state if persisting fails. The «ثبت تاریخچه‌ی دونیت‌ها» switch got the same treatment (thanks [SoroushRF](https://github.com/SoroushRF), [#19](https://github.com/AmirEyZed/sahne-plus/pull/19)).
- Everything from **1.5.0** (the new «Mint stage» look) and **1.4.2** (Kick subs back after Kick rotated its chat-feed key) is included.
- Verify this installer: `gh attestation verify .\Sahne-Plus-Setup-1.5.1.exe --repo AmirEyZed/sahne-plus`

### How to update
Sahne+ 1.3.1 and later show a notice inside the app: click **آپدیت**. From 1.3.0 or older, install this file manually once.

### Files in this release
- `Sahne-Plus-Setup-1.5.1.exe` — Windows installer (per-user, no admin rights needed)
- `SHA256SUMS.txt` — SHA-256 checksum of the installer (generated in the release workflow)
- `README-FA.txt` — راهنمای فارسی

### Notice
SHA-256 checksums verify the integrity of downloaded files; the provenance attestation proves the file was built by this repository's workflow from the public source. Neither is a security audit. The installer is not code-signed yet; Windows SmartScreen may warn — verify, then choose **More info → Run anyway**. Download Sahne+ only from this repository's Releases page.

Sahne+ is an independent third-party application and is not affiliated with, endorsed by, or sponsored by Kick, KickBot, StreamElements, baha24 or Bonbast. Privacy: [PRIVACY.md](https://github.com/AmirEyZed/sahne-plus/blob/main/PRIVACY.md) · Terms: [TERMS.md](https://github.com/AmirEyZed/sahne-plus/blob/main/TERMS.md) · Security: [SECURITY.md](https://github.com/AmirEyZed/sahne-plus/blob/main/SECURITY.md)
