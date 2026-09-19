// Sahne Plus — update check and one-click update from this repository's GitHub Releases.
// Nothing is downloaded or installed without the user's click. The installer is verified against the release's
// SHA256SUMS.txt before it runs. Network requests go through Electron's `net` (Chromium stack), so the Windows
// system proxy of a VPN app is used automatically.
'use strict';
const { app, net } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const core = require('./update-core');

function createUpdater({ version, canInstall, dryRun, log, onChange }) {
  let st = {
    status: 'idle', // idle | checking | uptodate | available | downloading | ready (dry run) | installing | error
    current: version,
    latest: null,
    page: null,
    progress: 0,
    error: null,
    checkedAt: null,
    canInstall: !!canInstall
  };
  const set = patch => {
    st = { ...st, ...patch };
    try {
      onChange({ ...st });
    } catch {}
  };
  const headers = { 'User-Agent': 'SahnePlus/' + version };
  const dir = path.join(app.getPath('temp'), 'SahnePlus-update');
  const busy = () => ['checking', 'downloading', 'installing'].includes(st.status);

  // GitHub answers /releases/latest with a redirect to /releases/tag/vX.Y.Z. Only that redirect target is needed, so the
  // request is not followed (net.fetch does not expose the final URL; net.request reports it in the 'redirect' event).
  function latestReleaseUrl() {
    return new Promise((resolve, reject) => {
      const req = net.request({ url: core.LATEST_URL, method: 'HEAD', redirect: 'manual' });
      req.setHeader('User-Agent', headers['User-Agent']);
      let done = false;
      const finish = (err, url) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          req.abort();
        } catch {}
        if (err) reject(err);
        else resolve(url);
      };
      const timer = setTimeout(() => finish(new Error('timeout')), 20000);
      req.on('redirect', (status, method, url) => finish(null, url));
      req.on('response', res => finish(new Error('no redirect from GitHub (HTTP ' + res.statusCode + ')')));
      req.on('error', e => finish(e));
      req.end();
    });
  }

  // A manual check that arrives while the periodic one is still running gets the same answer, not a "checking" state.
  let inflight = null;
  function check() {
    if (inflight) return inflight;
    if (busy()) return Promise.resolve({ ...st });
    inflight = doCheck().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  async function doCheck() {
    const before = st.status;
    set({ status: 'checking', error: null });
    try {
      const url = await latestReleaseUrl();
      const latest = core.versionFromReleaseUrl(url);
      if (!latest) throw new Error('unexpected release URL: ' + String(url).slice(0, 120));
      const newer = core.isNewer(latest, version);
      set({ status: newer ? 'available' : 'uptodate', latest, page: core.releasePage(latest), checkedAt: Date.now() });
      if (newer && before !== 'available')
        log('info', 'نسخه‌ی جدید Sahne Plus منتشر شده', { current: version, latest });
    } catch (e) {
      // a failed re-check (network down) must not hide an update that is already known
      const known = before === 'available' && st.latest && core.isNewer(st.latest, version);
      set(
        known
          ? { status: 'available', checkedAt: Date.now() }
          : { status: 'error', error: 'بررسی آپدیت ناموفق بود؛ اینترنت را بررسی کنید', checkedAt: Date.now() }
      );
      log('warn', 'بررسی آپدیت ناموفق بود', e.message);
    }
    return { ...st };
  }

  async function fetchText(url) {
    const r = await net.fetch(url, { headers, cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + path.basename(url));
    const text = await r.text();
    if (text.length > core.MAX_SUMS_BYTES) throw new Error('checksum file too large');
    return text;
  }

  async function download(latest) {
    const file = core.installerName(latest);
    const expected = core.checksumFor(await fetchText(core.assetUrl(latest, 'SHA256SUMS.txt')), file);
    if (!expected) throw new Error('checksum: ' + file + ' is not listed in SHA256SUMS.txt');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, file);
    const r = await net.fetch(core.assetUrl(latest, file), { headers, cache: 'no-store' });
    if (!r.ok || !r.body) throw new Error('HTTP ' + r.status + ' for ' + file);
    const total = Number(r.headers.get('content-length')) || 0;
    if (total > core.MAX_INSTALLER_BYTES) throw new Error('installer too large');
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(dest);
    let got = 0,
      lastPct = -1;
    try {
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        if (got > core.MAX_INSTALLER_BYTES) throw new Error('installer too large');
        hash.update(value);
        if (!out.write(value)) await new Promise(res => out.once('drain', res));
        const pct = total ? Math.min(99, Math.floor((got / total) * 100)) : 0;
        if (pct !== lastPct) {
          lastPct = pct;
          set({ progress: pct });
        }
      }
      await new Promise((res, rej) => {
        out.once('error', rej);
        out.end(res);
      });
    } catch (e) {
      out.destroy();
      throw e;
    }
    if (hash.digest('hex') !== expected)
      throw new Error('checksum: SHA-256 of the download does not match SHA256SUMS.txt');
    const head = Buffer.alloc(2);
    const fd = fs.openSync(dest, 'r');
    try {
      fs.readSync(fd, head, 0, 2, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (head.toString('latin1') !== 'MZ') throw new Error('checksum: the download is not a Windows program');
    return dest;
  }

  // quit: closes the app (the installer waits for it, replaces the files and starts the new version)
  async function install(quit) {
    if (busy() || st.status !== 'available' || !st.latest || !st.canInstall) return { ...st };
    set({ status: 'downloading', progress: 0, error: null });
    let dest;
    try {
      dest = await download(st.latest);
    } catch (e) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
      log('error', 'دانلود آپدیت ناموفق بود', e.message);
      set({
        status: 'available',
        progress: 0,
        error: /^checksum/.test(e.message)
          ? 'فایل دانلودشده با چک‌سام رسمی جور نبود و نصب نشد.'
          : 'دانلود ناموفق بود؛ اینترنت یا VPN را بررسی کنید و دوباره امتحان کنید.'
      });
      return { ...st };
    }
    log('info', 'آپدیت دانلود شد و SHA-256 آن با چک‌سام رسمی یکی است', { version: st.latest });
    if (dryRun) {
      set({ status: 'ready', progress: 100 });
      return { ...st };
    }
    set({ status: 'installing', progress: 100 });
    try {
      // electron-builder's per-user NSIS installer: /S silent; --updated waits for this app to exit and keeps the
      // user's data; --force-run starts the new version when the installation is done
      const child = spawn(dest, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' });
      await new Promise((res, rej) => {
        child.once('spawn', res);
        child.once('error', rej);
      });
      child.unref();
    } catch (e) {
      log('error', 'اجرای نصب‌کننده‌ی آپدیت ناموفق بود', e.message);
      set({ status: 'available', error: 'اجرای نصب‌کننده ناموفق بود؛ از صفحه‌ی ریلیز دستی دانلود کنید.' });
      return { ...st };
    }
    setTimeout(quit, 600);
    return { ...st };
  }

  return { check, install, get: () => ({ ...st }) };
}

module.exports = { createUpdater };
