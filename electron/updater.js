// Sahne Plus — update check and one-click update from this repository's GitHub Releases.
// Nothing is downloaded or installed without the user's click. The installer is verified against the release's
// SHA256SUMS.txt before it runs. Network requests go through Electron's `net` (Chromium stack), so the Windows
// system proxy of a VPN app is used automatically.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const core = require('./update-core');

// testHooks (tests only): electron (a stand-in { app, net }), responseMs / stallMs (shorter limits), open (file stream)
function createUpdater({ version, canInstall, dryRun, log, onChange, testHooks = {} }) {
  const { app, net } = testHooks.electron || require('electron');
  const responseMs = testHooks.responseMs || core.RESPONSE_TIMEOUT_MS;
  const stallMs = testHooks.stallMs || core.STALL_TIMEOUT_MS;
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
  const dir = path.join(testHooks.tempDir || app.getPath('temp'), 'SahnePlus-update');
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

  // the checksum file, body included, must arrive within responseMs
  async function fetchText(url) {
    const ac = new AbortController();
    const text = await core
      .withTimeout(
        (async () => {
          const r = await net.fetch(url, { headers, cache: 'no-store', signal: ac.signal });
          if (!r.ok) {
            if (r.body) r.body.cancel().catch(() => {}); // the error page is not read
            throw new Error('HTTP ' + r.status + ' for ' + path.basename(url));
          }
          return r.text();
        })(),
        responseMs,
        path.basename(url)
      )
      .catch(e => {
        ac.abort(); // releases the request whatever failed (a timeout, an error status)
        throw e;
      });
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
    // the response headers must arrive within responseMs; after that only a stall (stallMs without progress) fails
    // the download, so a slow but moving connection (a VPN) can take as long as it needs
    const ac = new AbortController();
    const r = await core.withTimeout(
      net.fetch(core.assetUrl(latest, file), { headers, cache: 'no-store', signal: ac.signal }),
      responseMs,
      file,
      () => ac.abort()
    );
    let lastPct = -1,
      sha;
    try {
      if (!r.ok || !r.body) throw new Error('HTTP ' + r.status + ' for ' + file);
      const total = Number(r.headers.get('content-length')) || 0;
      if (total > core.MAX_INSTALLER_BYTES) throw new Error('installer too large');
      sha = await core.saveStream(r.body, dest, {
        stallMs,
        open: testHooks.open,
        onData: got => {
          const pct = total ? Math.min(99, Math.floor((got / total) * 100)) : 0;
          if (pct !== lastPct) {
            lastPct = pct;
            set({ progress: pct });
          }
        }
      });
    } catch (e) {
      // an error response or a refused size leaves the body unread; saveStream has already cancelled its own
      if (r.body && !r.body.locked) r.body.cancel(e).catch(() => {});
      ac.abort();
      throw e;
    }
    if (sha !== expected) throw new Error('checksum: SHA-256 of the download does not match SHA256SUMS.txt');
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
      if (fs.existsSync(dir)) log('warn', 'فایل ناقص آپدیت پاک نشد', dir);
      set({
        status: 'available',
        progress: 0,
        error: /^checksum/.test(e.message)
          ? 'فایل دانلودشده با چک‌سام رسمی جور نبود و نصب نشد.'
          : core.isDiskError(e)
            ? 'ذخیره‌ی فایل آپدیت ناموفق بود؛ فضای خالی دیسک یا آنتی‌ویروس را بررسی کنید و دوباره امتحان کنید.'
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
