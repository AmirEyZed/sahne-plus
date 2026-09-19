## Sahne+ 1.3.0 — open source

**Version:** 1.3.0 · **Release date:** 2026-09-19

### What's new
- Sahne+ is now **open source** under the Apache License 2.0 — source, tests and the release workflow are in this repository. Names and icons are not part of the license (BRANDING.md).
- This installer was **built by GitHub Actions from the tagged source** and carries a build provenance attestation. Verify it with: `gh attestation verify .\Sahne-Plus-Setup-1.3.0.exe --repo AmirEyZed/sahne-plus`
- Electron 43.7.3; the uninstaller now also removes the "run at Windows login" entry.
- Clearer error when a Kick channel name is not found.
- Fixes from an independent code audit by [B3hnamR](https://github.com/B3hnamR) (thank you): imported **image** alerts render again in the Browser Source (broken since 1.1.0; videos were fine), and a donation whose payment capture fails for a network reason is retried instead of being silently dropped. Also: the "text-only alert when no file matches" switch works, Persian digits in file names and messages are recognised, and several smaller hardening items — full list in CHANGELOG.md.

### Files in this release
- `Sahne-Plus-Setup-1.3.0.exe` — Windows installer (per-user, no admin rights needed)
- `SHA256SUMS.txt` — SHA-256 checksum of the installer (generated in the release workflow)
- `README-FA.txt` — راهنمای فارسی

### Notice
SHA-256 checksums verify the integrity of downloaded files; the provenance attestation proves the file was built by this repository's workflow from the public source. Neither is a security audit. The installer is not code-signed yet; Windows SmartScreen may warn — verify, then choose **More info → Run anyway**. Download Sahne+ only from this repository's Releases page.

Sahne+ is an independent third-party application and is not affiliated with, endorsed by, or sponsored by Kick, KickBot, baha24 or Bonbast. Privacy: [PRIVACY.md](https://github.com/AmirEyZed/sahne-plus/blob/main/PRIVACY.md) · Terms: [TERMS.md](https://github.com/AmirEyZed/sahne-plus/blob/main/TERMS.md) · Security: [SECURITY.md](https://github.com/AmirEyZed/sahne-plus/blob/main/SECURITY.md)
