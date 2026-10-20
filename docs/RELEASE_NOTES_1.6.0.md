## Sahne+ 1.6.0 — Donofa bridge: Kick subs, gift subs and KICKs in your Donofa goal and timer

**Version:** 1.6.0 · **Release date:** 2026-10-20

### Files in this release
- `Sahne-Plus-Setup-1.6.0.exe` — Windows installer (per-user, no admin rights needed)
- `SHA256SUMS.txt` — SHA-256 checksums of the files above
- `README-FA.txt` — راهنمای فارسی

### Changes
- **Donofa bridge** (Settings → «دونوفا: هدف و تایمر»). Donofa's goal and timer widgets stay on stream exactly as you designed them on donofa.com. Sahne+ adds what Donofa never sees — Kick subs, gift subs, KICKs, KickBot and StreamElements donations — to that same goal and timer through Donofa's documented API. Time is converted with your Donofa timer's own rate («هر N تومان = S ثانیه»); a sub is worth the toman value from your Kick card (or $4.99 at the current rate), a KICK $0.0105. Donofa's own donations are left to Donofa. Only numbers are sent: no supporter names or messages.
- Kick subs are always counted by Sahne+ (it sees every sub in Kick chat). Turn Donofa's own «ساب کیک» switch off on the goal and the timer so a sub is never counted twice; the card tells you while it is on.
- The Settings card shows your goal and timer, two switches (timer / goal), the last pushes and the API key field. The key is encrypted like the other credentials and never shown or logged. There are no appearance settings: the Donofa panel stays the only place where the goal and timer are designed.
- How the goal is moved, for the curious: Donofa has no "add to goal" call. Sahne+ raises the goal's start value to progress + amount, resets the goal (progress becomes the start value) and puts the start value back, right after reading the goal and never within 3 s of a Donofa donation. Interrupted updates are repaired on the next start; nothing is ever pushed twice.
- Why only Donofa: this needs an API that can **add** to a goal and a timer. Donofa's can. Reymit's public API (reymit.ir/APIs) is read-only, so Reymit cannot be bridged without replacing its widgets with our own — which this feature deliberately does not do.
- New: KICKs (Kick's gift currency) are read from Kick chat. They have no alert; they only count toward the Donofa goal and timer.
- Docs: PRIVACY.md and docs/DATA_FLOW.md list the Donofa requests, the key and the new `donofa.json`.

### Notice
Sahne+ is open source (Apache-2.0). This installer was built by the repository's GitHub Actions workflow from the tagged source; verify with `gh attestation verify <file> --repo AmirEyZed/sahne-plus`. SHA-256 checksums verify the integrity of downloaded files and, like the attestation, are not a security audit. The installer is not code-signed yet; Windows SmartScreen may warn — verify the checksum, then choose **More info → Run anyway**. Download Sahne+ only from this repository's Releases page.

Sahne+ is an independent third-party application and is not affiliated with, endorsed by, or sponsored by Kick, KickBot, StreamElements, Donofa, baha24 or Bonbast. Privacy: [PRIVACY.md](https://github.com/AmirEyZed/sahne-plus/blob/main/PRIVACY.md) · Terms: [TERMS.md](https://github.com/AmirEyZed/sahne-plus/blob/main/TERMS.md) · Security: [SECURITY.md](https://github.com/AmirEyZed/sahne-plus/blob/main/SECURITY.md)
