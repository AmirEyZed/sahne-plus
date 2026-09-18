# Sahne+ (Sahne Plus)

**Local, transparent WebM alerts for Kick streamers on Windows.**

Sahne+ shows your own animated alerts on stream for **KickBot donations**, **Kick subscriptions** and **Kick gifted subscriptions**. Each alert plays a transparent WebM (or GIF / image / sound) that lives on your computer, with a customizable card showing the sender, the amount and the message.

> Sahne+ is an independent third-party application and is not affiliated with, endorsed by, or sponsored by Kick, KickBot, baha24 or Bonbast.

## Source code status

**Sahne+ is not open-source yet. The source code is currently private and is planned to be made public in the future.**

This repository is used for:

- **Official releases** (installers) on the [Releases](https://github.com/AmirEyZed/sahne-plus/releases) page
- **Public documentation** (this README and the documents linked below)
- **Changelog** — [CHANGELOG.md](CHANGELOG.md)
- **Security information** — [SECURITY.md](SECURITY.md)
- **Third-party licenses and notices** — [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

Hosting files on GitHub does **not** mean that GitHub has reviewed, audited or security-approved the application. GitHub is only the place where the files are published.

## Download

Get Sahne+ **only** from the official Releases page of this repository:

**https://github.com/AmirEyZed/sahne-plus/releases/latest**

Each release provides the installer (`Sahne-Plus-Setup-<version>.exe`), `SHA256SUMS.txt`, the Persian quick guide (`README-FA.txt`) and release notes.

Windows SmartScreen note: the installer is currently not code-signed, so Windows may show "Windows protected your PC". Verify the checksum (below), then click **More info → Run anyway**.

## Security & verification

Every release ships a `SHA256SUMS.txt` file containing the SHA-256 checksum of the installer.

What the checksum **does**:

- It lets you verify **file integrity**: that the file you downloaded is byte-for-byte the file that was uploaded to the release, and was not corrupted or swapped in transit.

What the checksum **does not** do:

- It does **not** prove that the application is safe or free of vulnerabilities.
- It does **not** prove that the binary was built from any particular public source code. The source is currently private and the installer is built by the maintainer on a local machine, not by a public CI system.
- It is **not** a security audit, a code review or an endorsement by anyone.

To verify the installer on Windows, open PowerShell in your Downloads folder and run:

```powershell
Get-FileHash .\Sahne-Plus-Setup-1.2.0.exe -Algorithm SHA256
```

Compare the printed hash with the value in `SHA256SUMS.txt` of the same release (letter case does not matter). If they differ, delete the file and download it again from the official Releases page.

## Trust & transparency

- Do not assume any executable is safe merely because it is hosted on GitHub. This applies to Sahne+ as well.
- Download Sahne+ only from the official Releases of this repository (`github.com/AmirEyZed/sahne-plus`). Copies hosted elsewhere, re-uploads and "modified" builds are not official and cannot be verified by us.
- What the application does on your computer and on the network is documented in [PRIVACY.md](PRIVACY.md): no cloud backend, no analytics, no telemetry, no automatic updates; connections only to KickBot, Kick's public chat feed and the exchange-rate services.
- Security reports are handled privately as described in [SECURITY.md](SECURITY.md).
- Code signing, signed checksums and build attestations are planned improvements; the current status of each is listed in [SECURITY.md](SECURITY.md#supply-chain-status).

## How it works

1. Paste your **KickBot widget URL** into Sahne+ (Home page). Sahne+ connects to the same KickBot event source the official widget uses and receives donations in real time. When an alert starts, Sahne+ performs the same "capture" call the official widget performs; KickBot and its payment provider decide the outcome — Sahne+ does not process payments itself.
2. Enter your **Kick channel name** (Settings). Subscriptions and gifted subscriptions are read from Kick's public chat feed. No Kick login is needed. This uses Kick's public chat infrastructure, which Kick has not documented for third-party use; if Kick changes it, this feature may stop working until an update is released.
3. Add the **Browser Source** URL (`http://localhost:7788/overlay`, 1920×1080) to **OBS Studio** or **Meld Studio**.
4. Drop your media files into the **Files** page and give each one a **minimum amount** in toman. Files must already be transparent (WebM with alpha) if you want them to play without a background; Sahne+ plays files as they are.

### Alert selection

- Donation amounts in USD are converted to toman with the live rate from **baha24.com** (public JSON API, refreshed every few minutes; **bonbast.com** is used only as a fallback; you can also set a fixed manual rate).
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

Sahne+ has **no cloud backend**. Your media, settings and logs stay in `Documents\Sahne Plus`. The application connects only to the third-party services it needs: KickBot (donations), Kick's public chat feed (subscriptions) and baha24.com / bonbast.com (exchange rate). There are no analytics, telemetry, crash reports, ads or automatic updates. Your KickBot widget key is stored encrypted with Windows DPAPI and is never shown or logged. Full details: [PRIVACY.md](PRIVACY.md).

## Documents

| Document | What it covers |
|---|---|
| [PRIVACY.md](PRIVACY.md) | what is stored locally, every network connection and why, deletion |
| [TERMS.md](TERMS.md) | terms of use / end-user license for the application |
| [SECURITY.md](SECURITY.md) | reporting vulnerabilities, supported versions, supply-chain status |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | bundled third-party components and fonts with their licenses |
| [CHANGELOG.md](CHANGELOG.md) | changes in each release |
| [LICENSE.txt](LICENSE.txt) | copyright and license notice for the application |

## License

Sahne+ is free to use under the [Terms of Use](TERMS.md). The application is currently proprietary: the source code is private and no open-source license applies to it at this time. The maintainer plans to publish the source code in the future; the license for that release will be announced when it happens. See [LICENSE.txt](LICENSE.txt).

© 2026 AmirEyZed. Kick, KickBot, baha24 and Bonbast are trademarks of their respective owners.
