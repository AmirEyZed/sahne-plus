# Sahne+ (Sahne Plus)

**Local, transparent WebM alerts for Kick streamers on Windows.** Open source under Apache-2.0.

Sahne+ shows your own animated alerts on stream for **KickBot donations**, **Kick subscriptions** and **Kick gifted subscriptions**. Each alert plays a transparent WebM (or GIF / image / sound) that lives on your computer, with a customizable card showing the sender, the amount and the message.

> Sahne+ is an independent third-party application and is not affiliated with, endorsed by, or sponsored by Kick, KickBot, baha24 or Bonbast.

![Files page](docs/screenshots/files.png)

## Status

- **Source code:** public in this repository, licensed under the [Apache License 2.0](LICENSE). The names and icons are not part of the license — see [BRANDING.md](BRANDING.md).
- **Official builds:** published on the [Releases](https://github.com/AmirEyZed/sahne-plus/releases) page. Starting with 1.3.0 they are built by the GitHub Actions workflow in this repository from the tagged source and published with a build provenance attestation. Earlier releases were built locally by the maintainer.
- Hosting on GitHub does not mean GitHub has reviewed, audited or approved the application.

## Download

**https://github.com/AmirEyZed/sahne-plus/releases/latest**

Each release provides the installer (`Sahne-Plus-Setup-<version>.exe`), `SHA256SUMS.txt`, the Persian quick guide (`README-FA.txt`) and release notes.

Windows SmartScreen note: the installer is not code-signed yet, so Windows may show "Windows protected your PC". Verify the download (below), then click **More info → Run anyway**.

## Security & verification

**Checksum (file integrity).** Every release ships `SHA256SUMS.txt`. On Windows:

```powershell
Get-FileHash .\Sahne-Plus-Setup-1.3.0.exe -Algorithm SHA256
```

Compare the printed hash with `SHA256SUMS.txt` of the same release. A matching checksum proves the file is byte-for-byte what was uploaded; it does not prove the software is free of vulnerabilities.

**Provenance (where the file came from).** From 1.3.0 on, each installer carries a GitHub build provenance attestation. With the [GitHub CLI](https://cli.github.com/):

```powershell
gh attestation verify .\Sahne-Plus-Setup-1.3.0.exe --repo AmirEyZed/sahne-plus
```

A successful verification proves the file was produced by this repository's `build-release` workflow from the commit tagged for that version — i.e. from the public source you can read here.

Current supply-chain status (code signing, signed checksums, CI) is kept honest in [SECURITY.md](SECURITY.md#supply-chain-status).

## Trust & transparency

- Do not assume any executable is safe merely because it is hosted on GitHub; verify checksum and provenance, and download only from this repository's Releases.
- Everything the application stores and every network connection it makes is documented in [PRIVACY.md](PRIVACY.md) and, in more detail, in [docs/DATA_FLOW.md](docs/DATA_FLOW.md): no cloud backend, no analytics, no telemetry; connections only to KickBot, Kick's public chat feed, the exchange-rate services and — for the update check, which can be turned off — GitHub. Updates are installed only after you click.
- Independent third-party review of 1.2.0: [B3hnamR/SahnePlusReview](https://github.com/B3hnamR/SahnePlusReview) (an independent review, not an official audit; read its scope notes).
- A second independent code audit of the 1.3.0 source by the same reviewer found two real bugs (image alerts not rendering, a capture failure dropping a donation); both were fixed before release, see [CHANGELOG.md](CHANGELOG.md). Sahne+ has not had a professional security audit.
- Security reports are handled privately as described in [SECURITY.md](SECURITY.md).

## How it works

1. Paste your **KickBot widget URL** into Sahne+ (Home page). Sahne+ connects to the same KickBot event source the official widget uses and receives donations in real time. When an alert starts, Sahne+ performs the same "capture" call the official widget performs; KickBot and its payment provider decide the outcome — Sahne+ does not process payments itself. If you also take tips through **StreamElements**, paste your StreamElements JWT token in Settings; those tips enter the same queue (Sahne+ only reads the tipping feed with it).
2. Enter your **Kick channel name** (Settings). Subscriptions and gifted subscriptions are read from Kick's public chat feed. No Kick login is needed. This uses Kick's public chat infrastructure, which Kick has not documented for third-party use; if Kick changes it, this feature may stop working until an update is released. If kick.com is filtered on your network, Sahne+ reaches it through your VPN app's Windows system proxy automatically, or through a proxy you enter in Settings.
3. Add the **Browser Source** URL (`http://localhost:7788/overlay`, 1920×1080) to **OBS Studio** or **Meld Studio**.
4. Drop your media files into the **Files** page and give each one a **minimum amount** in toman. Files must already be transparent (WebM with alpha) if you want them to play without a background; Sahne+ plays files as they are.

![Appearance editor with live preview](docs/screenshots/look.png)

### Alert selection

- Donation amounts in USD are converted to toman with the live rate from **baha24.com** (public JSON API, refreshed every few minutes; **bonbast.com** is used only as a fallback; you can also set a fixed manual rate).
- The alert with the **highest tier** the donation reaches is played (a 700,000 toman donation plays the 500,000 tier, not the 1,000,000 one).
- Several files on the same tier → one is picked at random.
- A file with **keywords** is played only when the donation message contains one of them (e.g. `!dance`).
- Subscriptions count as 4.99 USD × rate (or a fixed toman value you choose); gifted subscriptions multiply by the number of gifts. Keywords `sub` / `giftsub` let you dedicate files to subscriptions.
- File names like `150T` or `1.5M` are recognised as tiers automatically.

### Alert queue

Alerts play one at a time with a configurable gap. If the Browser Source is closed, alerts wait in the queue. Each donation plays once, also across restarts.

![Alert on a transparent Browser Source](docs/screenshots/overlay-alert.png)

## Features

- Transparent WebM / MP4 / GIF / image / audio alerts, fullscreen or boxed above the card
- Live preview with drag-and-drop card positioning; fonts, colours, animations, amount formats, Persian digits
- Optional delay before the name/amount card appears, globally or per file
- Optional StreamElements tips next to KickBot (one token, same files and tiers)
- Test donation / subscription / gift buttons (never touch KickBot)
- Runs in the system tray; optional start with Windows
- New-version notice inside the app and a one-click update, verified against the release checksum — never automatic
- All fonts bundled; nothing is loaded from CDNs; zero runtime npm dependencies

## Privacy

Sahne+ has **no cloud backend**. Your media, settings and logs stay in `Documents\Sahne Plus`. The application connects only to the third-party services it needs: KickBot (donations), Kick's public chat feed (subscriptions) and baha24.com / bonbast.com (exchange rate), plus github.com to check for a new version (can be turned off). There are no analytics, telemetry, crash reports or ads, and updates are installed only when you click «آپدیت». Your KickBot widget key is stored encrypted with Windows DPAPI and is never shown or logged. Full details: [PRIVACY.md](PRIVACY.md).

## Build from source

Requirements: Windows, Node.js 22+, npm.

```bash
git clone https://github.com/AmirEyZed/sahne-plus.git
cd sahne-plus
npm ci          # Electron 43 + electron-builder (dev only)
npm test        # unit tests
npm run format  # Prettier (checked in CI)
npm start       # run from source
npm run dist    # Windows installer in dist/
```

Details, project layout and the rules for pull requests are in [CONTRIBUTING.md](CONTRIBUTING.md). Persian developer notes: [docs/DEVELOPMENT-FA.md](docs/DEVELOPMENT-FA.md).

## Documents

| Document | What it covers |
|---|---|
| [PRIVACY.md](PRIVACY.md) | what is stored locally, every network connection and why, deletion |
| [TERMS.md](TERMS.md) | terms of use for the official builds (third-party services, your content, warranty) |
| [SECURITY.md](SECURITY.md) | reporting vulnerabilities, supported versions, supply-chain status |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | bundled third-party components and fonts with their licenses |
| [CHANGELOG.md](CHANGELOG.md) | changes in each release |
| [LICENSE](LICENSE) · [NOTICE](NOTICE) · [BRANDING.md](BRANDING.md) | Apache-2.0 license, attribution notice, brand/name restrictions |
| [docs/DATA_FLOW.md](docs/DATA_FLOW.md) | the data-flow and security audit of the implementation |

## License

Copyright © 2026 AmirEyZed. Licensed under the [Apache License, Version 2.0](LICENSE). The Sahne / Sahne+ names, symbol and icons are not covered by the license ([BRANDING.md](BRANDING.md)). Bundled fonts are under the SIL Open Font License 1.1. Kick, KickBot, baha24 and Bonbast are trademarks of their respective owners.
