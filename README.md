# Sahne Plus

**Local, transparent WebM alerts for Kick streamers.**
Sahne Plus is a free Windows desktop application that shows your own animated alerts on stream for:

- **KickBot donations**
- **Kick subscriptions**
- **Kick gifted subscriptions**

Each alert plays a transparent WebM (or GIF / image / sound) that lives on your computer, with a customizable card showing the sender, the amount and the message.

> Sahne Plus is an independent third-party application and is not affiliated with, endorsed by, or sponsored by Kick, KickBot or Bonbast.

## Download

Installers are published on the **[Releases](https://github.com/AmirEyZed/sahne-plus/releases)** page of this repository. Each release lists the SHA-256 checksum of the installer (`SHA256SUMS.txt`).

Windows SmartScreen note: the installer is currently not code-signed, so Windows may show "Windows protected your PC". Click **More info → Run anyway** after verifying the checksum. See `SECURITY.md` for how to report problems.

## How it works

1. Paste your **KickBot widget URL** into Sahne Plus (Home page). Sahne Plus connects to the same KickBot event source the official widget uses and receives donations in real time. When an alert starts, Sahne Plus performs the same "capture" call the official widget performs; KickBot and its payment provider decide the outcome — Sahne Plus does not process payments itself.
2. Enter your **Kick channel name** (Settings). Subscriptions and gifted subscriptions are read from Kick's public chat feed. No Kick login is needed. This uses Kick's public chat infrastructure, which Kick has not documented for third-party use; if Kick changes it, this feature may stop working until an update is released.
3. Add the **Browser Source** URL (`http://localhost:7788/overlay`, 1920×1080) to **OBS Studio** or **Meld Studio**.
4. Drop your media files into the **Files** page and give each one a **minimum amount** in toman.

### Alert selection

- Donation amounts in USD are converted to toman with the current rate from **bonbast.com** (refreshed automatically; you can also set a fixed manual rate).
- The alert with the **highest tier** the donation reaches is played (e.g. a 700,000 toman donation plays the 500,000 tier, not the 1,000,000 one).
- Several files on the same tier → one is picked at random.
- A file with **keywords** is played only when the donation message contains one of them (e.g. `!dance`).
- Subscriptions count as 4.99 USD × rate (or a fixed toman value you choose); gifted subscriptions multiply by the number of gifts. Keywords `sub` / `giftsub` let you dedicate files to subscriptions.
- File names like `150T` or `1.5M` are recognised as tiers automatically.

### Alert queue

Alerts play one at a time with a configurable gap. If the Browser Source is closed, alerts wait in the queue. Each donation plays once, also across restarts.

## Features

- Transparent WebM / MP4 / GIF / image / audio alerts, fullscreen or boxed above the card
- Live preview with drag-and-drop card positioning; fonts, colours, animations, amount formats, Persian digits
- Test donation / subscription / gift buttons (never touch KickBot)
- Runs in the system tray; optional start with Windows
- All fonts bundled; nothing is loaded from CDNs

## Privacy

Sahne Plus has **no cloud backend**. Your media, settings and logs stay in `Documents\Sahne Plus`. The application connects only to the third-party services it needs: KickBot (donations), Kick's public chat feed (subscriptions) and bonbast.com (exchange rate). There are no analytics, telemetry, crash reports, ads or automatic updates. Your KickBot widget key is stored encrypted with Windows DPAPI and is never shown or logged. Full details: `PRIVACY.md` and, for the technically curious, the Data-flow audit shipped with the source.

## Documents

- [Privacy Policy](PRIVACY.md)
- [Terms of Use](TERMS.md)
- [Security Policy](SECURITY.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)
- [Changelog](CHANGELOG.md)

## License

Sahne Plus is proprietary software, free to use under the [Terms of Use](TERMS.md). The source code is not public. © 2026 AmirEyZed. Kick, KickBot and Bonbast are trademarks of their respective owners.
