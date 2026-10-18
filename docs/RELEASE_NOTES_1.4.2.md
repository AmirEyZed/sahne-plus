## Sahne+ 1.4.2

**Version:** 1.4.2 · **Release date:** 2026-10-18

### What's new
- **Kick subs and gift subs work again.** On 2026-10-13 Kick retired the key of its public chat feed. Every Sahne+ up to 1.4.1 kept reconnecting with the old key, Kick's feed refused it every few seconds (Pusher error 4001, visible in the log page), and the Kick chip in Settings showed «قطع شده، تلاش مجدد…» forever — no sub or gift alert arrived. 1.4.2 connects with the current key.
- **Self-healing from now on.** When Kick rotates the key again, Sahne+ asks kick.com which key its own page uses (through your VPN's system proxy or the proxy entered in Settings, like the channel lookup) and keeps the answer. If that lookup fails too (kick.com filtered, VPN off), the chip says «کلید چت کیک عوض شده…» with what to do, and the app retries every 5 minutes and right after «ذخیره».
- Privacy: this adds one request to `web.kick.com`, made only when Kick's feed rejects the key; it carries a random identifier generated per request and nothing else. Documented in [PRIVACY.md](https://github.com/AmirEyZed/sahne-plus/blob/main/PRIVACY.md) and docs/DATA_FLOW.md (3.6a).
- Verify this installer: `gh attestation verify .\Sahne-Plus-Setup-1.4.2.exe --repo AmirEyZed/sahne-plus`

### How to update
Sahne+ 1.3.1 and later show a notice inside the app: click **آپدیت**. From 1.3.0 or older, install this file manually once.

### Files in this release
- `Sahne-Plus-Setup-1.4.2.exe` — Windows installer (per-user, no admin rights needed)
- `SHA256SUMS.txt` — SHA-256 checksum of the installer (generated in the release workflow)
- `README-FA.txt` — راهنمای فارسی

### Notice
SHA-256 checksums verify the integrity of downloaded files; the provenance attestation proves the file was built by this repository's workflow from the public source. Neither is a security audit. The installer is not code-signed yet; Windows SmartScreen may warn — verify, then choose **More info → Run anyway**. Download Sahne+ only from this repository's Releases page.

Sahne+ is an independent third-party application and is not affiliated with, endorsed by, or sponsored by Kick, KickBot, StreamElements, baha24 or Bonbast. Privacy: [PRIVACY.md](https://github.com/AmirEyZed/sahne-plus/blob/main/PRIVACY.md) · Terms: [TERMS.md](https://github.com/AmirEyZed/sahne-plus/blob/main/TERMS.md) · Security: [SECURITY.md](https://github.com/AmirEyZed/sahne-plus/blob/main/SECURITY.md)
