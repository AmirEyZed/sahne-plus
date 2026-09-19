# Contributing to Sahne+

Thanks for helping. Sahne+ is a small, dependency-free Electron app; please keep it that way.

## Ground rules

- **Security issues are never reported in public issues.** Use GitHub private vulnerability reporting or the contact in [SECURITY.md](SECURITY.md).
- **No new runtime dependencies** without a discussion first. The application deliberately uses only Node built-ins and Electron; the zero-dependency design is part of its security posture.
- **Never commit secrets or personal data**: no KickBot widget URLs, `config.json`, media files, logs, or channel names in code, tests, fixtures or screenshots. `.gitignore` blocks the usual files; check `git diff --cached` before committing.
- Keep user-facing text in Persian consistent with the existing UI wording; code, comments and commit messages are in English.

## Development setup

```bash
npm ci            # installs Electron 43 and electron-builder (dev only)
npm start         # runs the app from source
npm test          # unit tests (server validation + overlay XSS test)
npm run dist      # builds the Windows installer into dist/
```

To run a second instance without touching your real data, point it at an empty folder with its own port:

```bash
set SAHNE_PLUS_DATA_DIR=C:\path\to\test-data
# put {"port":7799,"app":{"autostart":false}} into C:\path\to\test-data\config.json first
npm start
```

Test instances do not touch Meld Studio layers and do not register autostart.

## Project layout

| Path | What |
|---|---|
| `electron/main.js` | Electron main process: window, tray, autostart, IPC, DPAPI secret store, hosts the server |
| `electron/preload.js` | the only bridge exposed to the page (`window.sahne`) |
| `server/server.js` | loopback HTTP + SSE server, KickBot / Kick / exchange-rate clients, alert queue |
| `public/app.*` | controller UI |
| `public/overlay.*` | Browser Source page (OBS / Meld Studio) |
| `public/legal/` | documents shown on the About page |
| `test/` | tests run by `npm test` |
| `docs/` | data-flow audit, release readiness, release notes, Persian guide |
| `build/` | icon sources and rendered icons |

## Code style

JavaScript is formatted with [Prettier](https://prettier.io) (settings in `.prettierrc`, 120 columns, single quotes). Run `npm run format` before committing; CI runs `npm run format:check`. There is no runtime dependency and none should be added.

## Pull requests

1. Open an issue first for anything bigger than a bug fix, so the design can be discussed.
2. One change per PR; describe what changed and why, and how you tested it.
3. `npm test` must pass. If you touch `server.js` validation or the overlay renderer, add a test.
4. Do not change the security defaults (`contextIsolation`, `sandbox`, fuses, Host/Origin checks, CSP) without explaining the threat model.
5. Do not add analytics, telemetry, crash reporting, auto-update or any new network destination without a discussion; [PRIVACY.md](PRIVACY.md) and [docs/DATA_FLOW.md](docs/DATA_FLOW.md) must be updated in the same PR when network behaviour changes.

## Licensing of contributions

By submitting a contribution you agree that it is licensed under the Apache License 2.0, the same license as the project, and that you have the right to license it that way. Brand assets are excluded from the license — see [BRANDING.md](BRANDING.md).
