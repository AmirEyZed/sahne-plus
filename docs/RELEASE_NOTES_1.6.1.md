## Sahne+ 1.6.1 — updates you can find, Vazirmatn everywhere

**Version:** 1.6.1 · **Release date:** 2026-10-20

### Files in this release
- `Sahne-Plus-Setup-1.6.1.exe` — Windows installer (per-user, no admin rights needed)
- `SHA256SUMS.txt` — SHA-256 checksums of the files above
- `README-FA.txt` — راهنمای فارسی

### Changes
- Fixed: **a new version was easy to miss.** The update notice sat at the top of the page and scrolled away with it, and «بررسی آپدیت» only answered with a two-second toast, so in a window that was not maximised the update could not be found. Now: the notice stays pinned at the top while the page scrolls; a green **«نسخه‌ی جدید آمده»** button sits in the sidebar on every page (it stays after «بعداً» on the top bar, and shows the download progress); the About card shows **«نصب نسخه‌ی …»** right next to «بررسی آپدیت»; the check button says «در حال بررسی…» while it works; toasts stay up long enough to read.
- Fixed: **fonts.** Numbers and Latin text used Inter, which has no Persian letters, so a Persian digit or word inside a number (Analytics «۲٫۸۸ میلیون», counts) fell back to a different Windows font. The whole app now uses Vazirmatn, Latin letters and digits included; the stream alert keeps the font you pick for it.
- Fixed: Analytics showed «میلیون ۲٫۸۸» in the wrong order; each value now reads in its own direction and sits under its label.
- Fixed: counters (queue, Browser Sources, the Files badge, the rate) used English digits next to Persian text; they use Persian digits now. Versions, links and dollar amounts stay in Latin digits.
- Fixed: in the default 1240 × 800 window the sidebar did not fit and «خروج» was cut off; at the 640 px minimum the rows tighten and the status pills go two by two.
- Includes everything from **1.6.0** (the Donofa bridge: Kick subs, gift subs and KICKs in your Donofa goal and timer).

### Notice
Sahne+ is open source (Apache-2.0). This installer was built by the repository's GitHub Actions workflow from the tagged source; verify with `gh attestation verify <file> --repo AmirEyZed/sahne-plus`. SHA-256 checksums verify the integrity of downloaded files and, like the attestation, are not a security audit. The installer is not code-signed yet; Windows SmartScreen may warn — verify the checksum, then choose **More info → Run anyway**. Download Sahne+ only from this repository's Releases page.

Sahne+ is an independent third-party application and is not affiliated with, endorsed by, or sponsored by Kick, KickBot, StreamElements, Donofa, baha24 or Bonbast. Privacy: [PRIVACY.md](https://github.com/AmirEyZed/sahne-plus/blob/main/PRIVACY.md) · Terms: [TERMS.md](https://github.com/AmirEyZed/sahne-plus/blob/main/TERMS.md) · Security: [SECURITY.md](https://github.com/AmirEyZed/sahne-plus/blob/main/SECURITY.md)
