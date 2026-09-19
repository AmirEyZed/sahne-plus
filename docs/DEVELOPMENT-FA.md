# Sahne Plus — صحنه پلاس

اپ دسکتاپ ویندوز برای الرت دونیت کیک‌بات، ساب و ساب‌گیفت کیک با فایل‌های لوکال و ترنسپرنت.
همان موتور KickAlerts، داخل یک اپ نصبی با رابط کاربری به سبک SAHNE.

## اجرا و ساخت

```bash
npm install            # Electron 43 + electron-builder
npm start              # اجرای توسعه
npm run icons          # ساخت PNG آیکون‌ها از build/icon.svg و build/tray.svg
npm run dist           # نصب‌کننده NSIS در dist/Sahne-Plus-Setup-<version>.exe
```

## ساختار

```
electron/main.js     پروسه اصلی: پنجره بدون فریم، Tray، اجرای خودکار، IPC، اجرای سرور
electron/preload.js  پل محدود بین صفحه و پوسته (کنترل پنجره، انتخاب فایل، اجرای خودکار)
server/server.js     سرور لوکال (HTTP + SSE) — کیک‌بات، چت کیک، نرخ دلار (baha24 / بن‌بست)، صف پخش، Meld self-heal
public/app.html      رابط کنترلر (صفحه اصلی، فایل‌ها، ظاهر الرت، تنظیمات، لاگ)
public/overlay.html  Browser Source (http://localhost:7788/overlay)
build/               آیکون‌ها
```

## داده‌ها

- پوشه‌ی داده: `Documents\Sahne Plus` (config.json + media\ + sahne-plus.log)
- اولین اجرا: اگر `Documents\KickAlerts\config.json` وجود داشته باشد، تنظیمات و فایل‌ها کپی می‌شوند.
- پورت پیش‌فرض ۷۷۸۸ است تا لینک Browser Source قدیمی بدون تغییر کار کند.

## رفتار اپ

- بستن پنجره = ادامه در پس‌زمینه (آیکون کنار ساعت). «خروج» در نوار کناری = توقف کامل.
- اجرای خودکار هنگام ورود به ویندوز به‌صورت پیش‌فرض فعال است (`--hidden`) و از تنظیمات قابل خاموش کردن است.
- اگر پورت ۷۷۸۸ مشغول باشد (مثلاً KickAlerts قدیمی باز باشد)، پیام خطا نمایش داده می‌شود.
