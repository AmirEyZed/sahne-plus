# Security Policy — Sahne+

## Source code and builds

The source code of Sahne+ is public in this repository under the Apache License 2.0. Starting with 1.3.0, official installers are built by the `build-release` GitHub Actions workflow from the tagged source and published with a build provenance attestation (`gh attestation verify <file> --repo AmirEyZed/sahne-plus`). Releases before 1.3.0 were built locally by the maintainer.

## Supported versions

| Version | Supported |
|---|---|
| 1.3.x (current) | yes — security fixes |
| 1.2.x and older | no — please upgrade |

Only the latest release on the [Releases](https://github.com/AmirEyZed/sahne-plus/releases) page receives fixes.

## Reporting a vulnerability

Please report security issues **privately**. Do not open a public GitHub issue and do not post details publicly before a fix is available.

- **Preferred:** GitHub private vulnerability reporting — https://github.com/AmirEyZed/sahne-plus/security/advisories/new (only the maintainer can read it).
- **Security contact (e-mail):** Eyzedam@gmail.com
- **Alternative:** open a GitHub issue titled `security contact request` **without any details**; the maintainer will reply with a private channel.

Please include:

- the Sahne+ version (About page) and Windows version;
- a description of the issue and its impact: what an attacker can do, and from where (another program on the PC, a web page in the streamer's browser, the local network, a viewer through a donation message, a malicious media file, etc.);
- steps to reproduce, a proof of concept if you have one, and the affected file/line in the source when you know it;
- relevant lines from `Documents\Sahne Plus\sahne-plus.log` with **donation names removed**;
- never include your own KickBot widget key.

## Responsible disclosure

- We acknowledge reports within **7 days**.
- Confirmed issues are fixed in the next release; we will tell you when the fix is published and credit you in `CHANGELOG.md` if you wish.
- We ask for a **90-day** disclosure window from the report date (or until a fix is released, whichever comes first) before any public disclosure. If we need more time we will say so and explain why.
- We do not take legal action against good-faith research that respects this policy, avoids privacy violations and does not disrupt other people's streams or third-party services.
- Sahne+ does not offer a bug bounty at this time.

## Acknowledgements

- [B3hnamR](https://github.com/B3hnamR) — independent review of 1.2.0 ([SahnePlusReview](https://github.com/B3hnamR/SahnePlusReview)) and a code audit of the 1.3.0 source that found the image-alert and capture-retry bugs fixed in 1.3.0.

- [KernelDotDLL](https://github.com/KernelDotDLL) — reported (with reproductions) that any web page could open the Browser Source event stream and consume alerts, and that the media route served every file in the media folder; both fixed in 1.3.2.

## Scope

In scope:

- the local server on `127.0.0.1:7788` being reachable from another machine, from another origin in the browser (CSRF, DNS rebinding) or leaking the KickBot widget key or the StreamElements token;
- the Browser Source executing injected content from a donation name or message;
- imported media files causing code execution or path traversal;
- the Electron shell (IPC, preload bridge, navigation, permissions) and the installer doing anything not described in [PRIVACY.md](PRIVACY.md);
- the in-app updater (`electron/updater.js`): downloading from anywhere but this repository's Releases, running a file that does not match the release's `SHA256SUMS.txt`, or installing without the user's click;
- the release workflow (a way to get an unofficial binary attested or published as official).

Out of scope: KickBot, Kick, Pusher, baha24 and Bonbast themselves (report issues in those services to their owners); social engineering; issues that require a compromised Windows account.

## Supply-chain status

Honest current state, so nobody over-trusts a release:

| Measure | Status |
|---|---|
| Public source code | **yes** (Apache-2.0), this repository |
| Builds by public CI | **yes from 1.3.0** — `.github/workflows/build-release.yml` on GitHub-hosted Windows runners; earlier releases were built locally |
| Build provenance attestation | **yes from 1.3.0** — verify with `gh attestation verify` |
| SHA-256 checksums (`SHA256SUMS.txt`) | **yes**, generated in the release workflow; verify integrity only |
| Windows code signing (Authenticode) | **not yet** — installers are unsigned; SmartScreen warns |
| Signed checksums (GPG / minisign) | **not yet** |
| Reproducible builds | **not verified** — electron-builder output is not guaranteed bit-for-bit reproducible |
| Updates | **update check + one-click update since 1.3.1** — the app checks this repository's latest release (can be turned off); an update is downloaded only after the user clicks, verified against the release's `SHA256SUMS.txt` and installed with the official installer. Never silent or automatic. The checksum comes from the same release, so authenticity rests on this GitHub account (protected with two-factor authentication); the installer is not code-signed |
| Electron fuses / debug switches | **locked down** — `RunAsNode`, `NODE_OPTIONS` and `--inspect` are disabled by fuses, the asar archive is integrity-checked, and since 1.3.3 the installed app strips Chromium's `--remote-debugging-*` switches at startup, so it cannot be driven over the DevTools protocol |
| Runtime npm dependencies | **none** — only Node built-ins and Electron |
