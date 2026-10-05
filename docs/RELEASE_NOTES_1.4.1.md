## Sahne+ 1.4.1

**Version:** 1.4.1 · **Release date:** 2026-10-06

### What's new
- **Long alerts play to the end.** A video or audio alert longer than «حداکثر مدت» (90 seconds by default) stopped in the middle — reported by a streamer whose sub alert ran over three minutes. It now plays to its end, or to the file's own «قطع بعد از». «حداکثر مدت» still limits alerts whose length is unknown (an image without its own duration, a KickBot GIF) and ends a stuck file; a file without a stored length keeps playing while it actually advances. The queue waits for the end (at most one hour per alert).
- For an animated GIF image the browser cannot tell the length: set its «قطع بعد از» in the file editor, and that value is now honoured even past «حداکثر مدت».
- Verify this installer: `gh attestation verify .\Sahne-Plus-Setup-1.4.1.exe --repo AmirEyZed/sahne-plus`

### How to update
Sahne+ 1.3.1 and later show a notice inside the app: click **آپدیت**. From 1.3.0 or older, install this file manually once.

### Files in this release
- `Sahne-Plus-Setup-1.4.1.exe` — Windows installer (per-user, no admin rights needed)
- `SHA256SUMS.txt` — SHA-256 checksum of the installer (generated in the release workflow)
- `README-FA.txt` — راهنمای فارسی

### Notice
SHA-256 checksums verify the integrity of downloaded files; the provenance attestation proves the file was built by this repository's workflow from the public source. Neither is a security audit. The installer is not code-signed yet; Windows SmartScreen may warn — verify, then choose **More info → Run anyway**. Download Sahne+ only from this repository's Releases page.

Sahne+ is an independent third-party application and is not affiliated with, endorsed by, or sponsored by Kick, KickBot, StreamElements, baha24 or Bonbast. Privacy: [PRIVACY.md](https://github.com/AmirEyZed/sahne-plus/blob/main/PRIVACY.md) · Terms: [TERMS.md](https://github.com/AmirEyZed/sahne-plus/blob/main/TERMS.md) · Security: [SECURITY.md](https://github.com/AmirEyZed/sahne-plus/blob/main/SECURITY.md)
