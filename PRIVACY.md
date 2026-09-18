# Sahne Plus — Privacy Policy

_Last updated: 2026-09-18 · Applies to Sahne Plus 1.1.0 and later_

**خلاصه‌ی فارسی:** Sahne Plus هیچ سرور ابری ندارد. فایل‌های الرت، تنظیمات و لاگ‌ها فقط روی کامپیوتر شما (پوشه‌ی `Documents\Sahne Plus`) ذخیره می‌شوند. برنامه فقط به سه سرویس شخص ثالث وصل می‌شود که برای کارکردش لازم‌اند: کیک‌بات (دونیت‌ها)، فید چت عمومی کیک (ساب‌ها) و bonbast.com (نرخ دلار). آنالیتیکس، ردیابی، تبلیغات، گزارش خطای خودکار و به‌روزرسانی خودکار وجود ندارد. ما هیچ داده‌ای از شما دریافت یا فروش نمی‌کنیم، چون اصلاً به ما نمی‌رسد.

## 1. Who we are

Sahne Plus is a Windows desktop application published by **AmirEyZed** ("we"). Contact: through the project's GitHub page (https://github.com/AmirEyZed/sahne-plus) — issues for questions, private vulnerability reporting for security matters.

## 2. The short version

- Sahne Plus does **not** operate a cloud backend. Nothing you configure and none of your media is uploaded to us.
- The application makes network requests **only** to the third-party services required for its features (section 4). Those services receive only what is technically needed.
- The application contains **no** analytics, telemetry, crash reporting, advertising, tracking or update checks. This was verified against the source code (see `DATA_FLOW.md`).

## 3. What Sahne Plus stores on your computer

All application data lives in `Documents\Sahne Plus`:

| Data | File | Notes |
|---|---|---|
| Appearance settings, alert tiers and keywords, Kick channel name, exchange-rate settings, app options | `config.json` | plain JSON |
| Your KickBot widget key (the secret part of the widget URL) | `config.json` → `secret_id_enc` | **encrypted with Windows Data Protection (DPAPI)** through Electron `safeStorage`, bound to your Windows account. If DPAPI is unavailable the app tells you in Settings and stores it unencrypted. |
| Alert media you import (videos, images, sounds) | `media\` | copied into this folder; your original files are never modified or deleted |
| Ids of the last 1000 alerts already shown | `played.json` | prevents replaying a donation after a restart |
| Diagnostic log | `sahne-plus.log` | connection status, errors, and for each alert: donor/subscriber name, amount, message and the media used. The KickBot key is never written to the log. Rotates at 5 MB. |

Electron (the runtime) keeps its own browser profile in `%APPDATA%\SahnePlus` (cache, the last opened page).

## 4. Network connections and why they exist

| Service | Purpose | What is sent | What is received |
|---|---|---|---|
| **KickBot** (`kickbot.live`, `widgets.kickbot.com`) | receive your donation events in real time; confirm ("capture") each donation when its alert starts, exactly as the official KickBot widget does; play KickBot's text-to-speech audio | your widget key and streamer id, the id of the donation being shown, a keep-alive ping | donation events (donor name, amount, message, optional GIF/TTS URLs) |
| **Kick** (`kick.com` once, then Kick's public chat feed hosted on `pusher.com`) | show subscriptions and gifted subscriptions | your channel name; a subscription to the public chat channels of your Kick channel (no login, no password) | subscription and gift events (usernames, counts) |
| **bonbast.com** | convert dollar donation amounts to toman | a page request with a normal desktop browser identity | the current USD sell rate |
| **Meld Studio** on your own computer (`127.0.0.1:13376`) | reload the Browser Source layer if it lost the connection | the layer URL | layer list |

If you configure a proxy in Settings, the kick.com and bonbast.com requests go through it. The KickBot connection does not use the proxy.

These third parties process the data they receive under **their own** privacy policies. Sahne Plus cannot control what KickBot, Kick, Pusher or Bonbast do with a request once it reaches them.

The Browser Source page (the page you add to OBS / Meld Studio) additionally loads KickBot TTS audio and, when a donation carries one, the GIF URL supplied by KickBot. All fonts are bundled; the Browser Source loads nothing from Google or any CDN.

## 5. Data about other people

Donation and subscription events contain the names and messages of your viewers. Sahne Plus shows them on your stream (that is its purpose), keeps the last 30 in memory for the "recent alerts" list, and writes them to the local log file. This data stays on your computer. You are responsible for how you use it in your broadcast.

## 6. What we do not do

- We do not collect, receive, sell, share or monetise any data — no data reaches us.
- No analytics or telemetry SDKs are included.
- No crash reports are sent anywhere; errors go to the local log only.
- No advertising.
- No automatic updates or update checks. New versions are published manually on GitHub Releases; you decide whether to download them.

## 7. Deleting your data

- **In the app:** Settings → "Clear application data" deletes `config.json`, `played.json` and everything in `media\` (after a confirmation), then restarts the app. Settings → "Disconnect KickBot" removes only the widget key. "Reset settings" restores defaults without touching media.
- **Manually:** delete the folder `Documents\Sahne Plus`.
- **Uninstalling** the application removes the program files and Electron's profile folder (`%APPDATA%\SahnePlus`) but **does not** delete `Documents\Sahne Plus`, so your media survives a reinstall.
- **Autostart:** uninstalling removes the program, but the "run at Windows login" registry entry (`HKCU\Software\Microsoft\Windows\CurrentVersion\Run\SahnePlus`) may remain and simply points to a missing file; turn the option off in Settings before uninstalling to keep the registry clean.

## 8. Security of the local server

Sahne Plus runs a small web server on `127.0.0.1:7788` for the app window and the Browser Source. It is bound to the loopback interface only and is not reachable from other computers. Requests from web pages of other origins are rejected. See `SECURITY.md` for reporting issues.

## 9. Children

Sahne Plus is a tool for streamers and is not directed at children.

## 10. Changes

We will update this document when the application's behaviour changes. The version at the top tells you which release it describes.

## 11. Third-party disclaimer

Sahne Plus is an independent third-party application and is not affiliated with, endorsed by, or sponsored by Kick, KickBot, Bonbast or Pusher. All product names are trademarks of their respective owners.
