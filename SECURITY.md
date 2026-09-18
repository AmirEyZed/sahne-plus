# Security Policy — Sahne Plus

## Supported versions

| Version | Supported |
|---|---|
| 1.1.x (current) | yes — security fixes |
| 1.0.x | no — please upgrade |

## Reporting a vulnerability

Please report security issues **privately**. Do not open a public GitHub issue and do not post details publicly before a fix is available.

- Preferred: **GitHub private vulnerability report** — https://github.com/AmirEyZed/sahne-plus/security/advisories/new (only the maintainer can read it).
- Alternative: open a GitHub issue titled `security contact request` **without details**, and the maintainer will reply with a private channel.

Please include:

- the Sahne Plus version (About page) and Windows version;
- a description of the issue and its impact (what an attacker can do, and from where: another program on the PC, a web page in the streamer's browser, the local network, a viewer via a donation message, etc.);
- steps to reproduce, a proof of concept if you have one, and the relevant lines from `Documents\Sahne Plus\sahne-plus.log` with **any donation names removed**;
- whether the issue involves the KickBot widget key (never include your own key in the report).

What you can expect:

- acknowledgement within 7 days;
- a fix or mitigation for confirmed issues in the next release, with credit in `CHANGELOG.md` if you wish;
- we ask for a reasonable disclosure window (90 days) before public disclosure of an unpatched issue.

## Scope notes

- The local server on `127.0.0.1:7788` is intended to be reachable only from the same computer. Reports that it can be reached from another machine, from another origin in the browser (CSRF / DNS rebinding), or that the Browser Source can be made to execute injected content from a donation message, are in scope.
- Third-party services (KickBot, Kick, Bonbast, Pusher) are out of scope; report issues in those services to their owners.
- Sahne Plus does not offer a bug bounty at this time.
