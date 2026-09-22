# Sahne Plus — Privacy Policy

_Last updated: 2026-09-19 · Applies to Sahne Plus 1.1.0 and later (the update check exists since 1.3.1)_

**خلاصه‌ی فارسی:** Sahne Plus هیچ سرور ابری ندارد. فایل‌های الرت، تنظیمات و لاگ‌ها فقط روی کامپیوتر شما (پوشه‌ی `Documents\Sahne Plus`) ذخیره می‌شوند. برنامه فقط به سرویس‌هایی وصل می‌شود که برای کارکردش لازم‌اند: کیک‌بات (دونیت‌ها)، فید چت عمومی کیک (ساب‌ها)، baha24.com یا bonbast.com (نرخ دلار) و از نسخه‌ی ۱.۳.۱ گیت‌هاب، فقط برای دیدن شماره‌ی آخرین نسخه (از «تنظیمات» قابل خاموش کردن است). هیچ آپدیتی بدون کلیک شما دانلود یا نصب نمی‌شود. آنالیتیکس، ردیابی، تبلیغات و گزارش خطای خودکار وجود ندارد. ما هیچ داده‌ای از شما دریافت یا فروش نمی‌کنیم، چون اصلاً به ما نمی‌رسد.

## 1. Who we are

Sahne Plus is a Windows desktop application published by **AmirEyZed** ("we"). Contact: through the project's GitHub page (https://github.com/AmirEyZed/sahne-plus) — issues for questions, private vulnerability reporting for security matters.

## 2. The short version

- Sahne Plus does **not** operate a cloud backend. Nothing you configure and none of your media is uploaded to us.
- The application makes network requests **only** to the third-party services required for its features (section 4). Those services receive only what is technically needed.
- The application contains **no** analytics, telemetry, crash reporting, advertising or tracking, and it never installs anything on its own. Since 1.3.1 it asks GitHub which version is the latest (can be turned off, see section 4). This was verified against the source code (see `docs/DATA_FLOW.md`), which is public in this repository under the Apache License 2.0 so anyone can check these statements.

## 3. What Sahne Plus stores on your computer

All application data lives in `Documents\Sahne Plus`:

| Data | File | Notes |
|---|---|---|
| Appearance settings, alert tiers and keywords, Kick channel name, exchange-rate settings, app options | `config.json` | plain JSON |
| Your KickBot widget key (the secret part of the widget URL) | `config.json` → `secret_id_enc` | **encrypted with Windows Data Protection (DPAPI)** through Electron `safeStorage`, bound to your Windows account. If DPAPI is unavailable the app tells you in Settings and stores it unencrypted. |
| Your StreamElements JWT token (optional, 1.3.4+) | `config.json` → `se_token_enc` | same protection as the KickBot key (DPAPI). This token controls your whole StreamElements account; the app only reads the tipping feed with it. Removed by «قطع اتصال و حذف توکن». |
| Alert media you import (videos, images, sounds) | `media\` | copied into this folder; your original files are never modified or deleted |
| Ids of the last 1000 alerts already shown | `played.json` | prevents replaying a donation after a restart |
| Diagnostic log | `sahne-plus.log` | connection status, errors, and for each alert: donor/subscriber name, amount, message and the media used. The KickBot key is never written to the log. Rotates at 5 MB. |

Electron (the runtime) keeps its own browser profile in `%APPDATA%\SahnePlus` (cache, the last opened page).

## 4. Network connections and why they exist

| Service | Purpose | What is sent | What is received |
|---|---|---|---|
| **KickBot** (`kickbot.live`, `widgets.kickbot.com`) | receive your donation events in real time; confirm ("capture") each donation when its alert starts, exactly as the official KickBot widget does; play KickBot's text-to-speech audio | your widget key and streamer id, the id of the donation being shown, a keep-alive ping | donation events (donor name, amount, message, optional GIF/TTS URLs) |
| **Kick** (`kick.com` once, then Kick's public chat feed hosted on `pusher.com`) | show subscriptions and gifted subscriptions | your channel name; a subscription to the public chat channels of your Kick channel (no login, no password) | subscription and gift events (usernames, counts) |
| **baha24.com** (`/api/v1/price`, public JSON API) | convert dollar donation amounts to toman | a plain GET request, no account, no key | the current sell rates of USD and, for StreamElements tips in other currencies, of EUR, GBP, AED, TRY and other common currencies |
| **bonbast.com** (fallback only, when baha24 fails) | same | a page request with a normal desktop browser identity | the current USD sell rate |
| **Meld Studio** on your own computer (`127.0.0.1:13376`) | reload the Browser Source layer if it lost the connection | the layer URL | layer list |
| **StreamElements** (`api.streamelements.com` once at setup, then `astro.streamelements.com`), **only if you connect a StreamElements account** (1.3.4+) | receive the tips from your StreamElements tipping page | your StreamElements JWT token, to subscribe to your own channel's activity feed; at setup, one request for your channel id | tip events: name, amount, currency, message |
| **GitHub** (`github.com`; release files are served from GitHub's release-asset storage), since 1.3.1 | tell you when a new Sahne Plus version exists; download it when you click «آپدیت» | a HEAD request for `github.com/AmirEyZed/sahne-plus/releases/latest` 30 s after start and every 6 hours, with the app version in the User-Agent; after your click, downloads of the installer and `SHA256SUMS.txt` | the latest version number; the installer |

If you configure a proxy in Settings, or Windows has a system proxy (for example a VPN app in "system proxy" mode), the kick.com and bonbast.com requests go through it — the manual proxy first, then the system proxy, then a direct connection — and baha24.com is retried through them if the direct request fails. Only plain HTTP proxies are used. The KickBot connection and Kick's chat feed do not use a proxy.

The update check can be turned off in Settings → «بررسی خودکار نسخه‌ی جدید». An update is downloaded only when you click «آپدیت»; the installer is verified against the release's `SHA256SUMS.txt` before it runs and replaces the program files only — your data in `Documents\Sahne Plus` stays. Update requests use Chromium's network stack, so a Windows system proxy is used automatically.

These third parties process the data they receive under **their own** privacy policies. Sahne Plus cannot control what KickBot, Kick, Pusher, baha24, Bonbast or GitHub do with a request once it reaches them.

The Browser Source page (the page you add to OBS / Meld Studio) additionally loads KickBot TTS audio and, when a donation carries one, the GIF URL supplied by KickBot. All fonts are bundled; the Browser Source loads nothing from Google or any CDN.

## 5. Data about other people

Donation and subscription events contain the names and messages of your viewers. Sahne Plus shows them on your stream (that is its purpose), keeps the last 30 in memory for the "recent alerts" list, and writes them to the local log file. This data stays on your computer. You are responsible for how you use it in your broadcast.

## 6. What we do not do

- We do not collect, receive, sell, share or monetise any data — no data reaches us.
- No analytics or telemetry SDKs are included.
- No crash reports are sent anywhere; errors go to the local log only.
- No advertising.
- No automatic installs. Since 1.3.1 the app checks GitHub for a newer version (can be turned off) and shows a notice; an update is downloaded and installed only after you click «آپدیت».

## 7. Deleting your data

- **In the app:** Settings → "Clear application data" deletes `config.json`, `played.json` and everything in `media\` (after a confirmation), then restarts the app. Settings → "Disconnect KickBot" removes only the widget key. "Reset settings" restores defaults without touching media.
- **Manually:** delete the folder `Documents\Sahne Plus`.
- **Uninstalling** the application removes the program files and Electron's profile folder (`%APPDATA%\SahnePlus`) but **does not** delete `Documents\Sahne Plus`, so your media survives a reinstall.
- **Autostart:** the uninstaller also removes the "run at Windows login" registry entry (`HKCU\Software\Microsoft\Windows\CurrentVersion\Run\SahnePlus`), so nothing of the program is left in the registry.

## 8. Security of the local server

Sahne Plus runs a small web server on `127.0.0.1:7788` for the app window and the Browser Source. It is bound to the loopback interface only and is not reachable from other computers. Requests from web pages of other origins are rejected. See `SECURITY.md` for reporting issues.

## 9. Children

Sahne Plus is a tool for streamers and is not directed at children.

## 10. Changes

We will update this document when the application's behaviour changes. The version at the top tells you which release it describes.

## 11. Third-party disclaimer

Sahne Plus is an independent third-party application and is not affiliated with, endorsed by, or sponsored by Kick, KickBot, baha24, Bonbast or Pusher. All product names are trademarks of their respective owners.
