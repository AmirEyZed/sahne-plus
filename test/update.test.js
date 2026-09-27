// Update check helpers: version parsing, the GitHub redirect, asset URLs, checksum lookup and the installer download
// (run with `node --test`).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');
const core = require('../electron/update-core');
const { createUpdater } = require('../electron/updater');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sahne-update-test-'));
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
// a response body that sends `chunks`, then either ends or (stall) sends nothing more; `cancelled` records cancel()
function body(chunks, { stall = false, endless = false } = {}) {
  const src = { cancelled: null };
  let i = 0;
  src.stream = new ReadableStream({
    pull(c) {
      if (endless) return c.enqueue(new Uint8Array(1024).fill(7));
      if (i < chunks.length) return c.enqueue(chunks[i++]);
      if (!stall) return c.close();
      return new Promise(() => {}); // the connection stays open but no more data comes
    },
    cancel(reason) {
      src.cancelled = reason;
    }
  });
  return src;
}

test('versions: only plain x.y.z, compared numerically', () => {
  assert.deepEqual(core.parseVersion('v1.3.10'), [1, 3, 10]);
  assert.equal(core.parseVersion('1.4.0-beta.1'), null);
  assert.equal(core.parseVersion('latest'), null);
  assert.ok(core.isNewer('1.3.10', '1.3.9'), '10 > 9, not a string compare');
  assert.ok(core.isNewer('2.0.0', '1.99.99'));
  assert.ok(!core.isNewer('1.3.1', '1.3.1'));
  assert.ok(!core.isNewer('1.3.0', '1.3.1'), 'never offers a downgrade');
  assert.ok(!core.isNewer('junk', '1.0.0'));
});

test('the release redirect is accepted only for this repository', () => {
  assert.equal(core.versionFromReleaseUrl('https://github.com/AmirEyZed/sahne-plus/releases/tag/v1.3.1'), '1.3.1');
  assert.equal(core.versionFromReleaseUrl('https://github.com/AmirEyZed/sahne-plus/releases'), null, 'no releases yet');
  assert.equal(core.versionFromReleaseUrl('https://github.com/someone/sahne-plus/releases/tag/v9.9.9'), null);
  assert.equal(core.versionFromReleaseUrl('https://evil.example/AmirEyZed/sahne-plus/releases/tag/v9.9.9'), null);
  assert.equal(core.versionFromReleaseUrl('https://github.com/AmirEyZed/sahne-plus/releases/tag/v2.0.0-rc1'), null);
});

test('asset URLs point at this repository and the checksum file is parsed strictly', () => {
  assert.equal(
    core.assetUrl('1.3.1', core.installerName('1.3.1')),
    'https://github.com/AmirEyZed/sahne-plus/releases/download/v1.3.1/Sahne-Plus-Setup-1.3.1.exe'
  );
  const h = 'a'.repeat(64);
  assert.equal(core.checksumFor(h + ' *Sahne-Plus-Setup-1.3.1.exe\n', 'Sahne-Plus-Setup-1.3.1.exe'), h);
  assert.equal(core.checksumFor(h.toUpperCase() + '  Sahne-Plus-Setup-1.3.1.exe\r\n', 'Sahne-Plus-Setup-1.3.1.exe'), h);
  assert.equal(core.checksumFor(h + ' *Sahne-Plus-Setup-1.3.0.exe\n', 'Sahne-Plus-Setup-1.3.1.exe'), null);
  assert.equal(core.checksumFor('abc *Sahne-Plus-Setup-1.3.1.exe', 'Sahne-Plus-Setup-1.3.1.exe'), null);
});

test('installer download: streams to the file, hashes it and reports progress', async () => {
  const dir = tmpDir();
  const dest = path.join(dir, 'setup.exe');
  const chunks = [Buffer.from('MZ header'), Buffer.from('-'.repeat(70000)), Buffer.from('end')];
  const seen = [];
  const sha = await core.saveStream(body(chunks).stream, dest, { onData: n => seen.push(n) });
  const all = Buffer.concat(chunks);
  assert.equal(sha, sha256(all));
  assert.deepEqual(fs.readFileSync(dest), all, 'the file is complete and closed');
  assert.deepEqual(seen, [9, 70009, 70012]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('installer download: a slow download that keeps moving is not cut off, however long it takes', async () => {
  const dir = tmpDir();
  const dest = path.join(dir, 'setup.exe');
  let i = 0;
  const stream = new ReadableStream({
    async pull(c) {
      if (i++ === 8) return c.close();
      await new Promise(res => setTimeout(res, 60)); // each chunk well within the limit, the total well beyond it
      c.enqueue(Buffer.from('chunk ' + i));
    }
  });
  const t0 = Date.now();
  const sha = await core.saveStream(stream, dest, { stallMs: 150 });
  assert.ok(Date.now() - t0 > 300, 'the whole download took longer than the stall limit');
  assert.equal(sha, sha256(fs.readFileSync(dest)));
  assert.equal(fs.readFileSync(dest, 'latin1'), 'chunk 1chunk 2chunk 3chunk 4chunk 5chunk 6chunk 7chunk 8');
  fs.rmSync(dir, { recursive: true, force: true });
});

test(
  'installer download: a write that never completes fails instead of waiting for drain forever',
  { timeout: 5000 },
  async () => {
    const dir = tmpDir();
    const src = body([], { endless: true });
    const out = new Writable({ highWaterMark: 1, write() {} }); // the callback never comes: a hung disk or file lock
    await assert.rejects(
      core.saveStream(src.stream, path.join(dir, 'setup.exe'), { stallMs: 150, open: () => out }),
      /download: writing to disk timed out/
    );
    assert.ok(src.cancelled, 'the request body is cancelled');
    fs.rmSync(dir, { recursive: true, force: true });
  }
);

test('installer download: a final close that never completes fails', { timeout: 5000 }, async () => {
  const dir = tmpDir();
  const src = body([Buffer.from('MZ all data')]);
  const out = new Writable({
    write(chunk, enc, cb) {
      cb();
    },
    final() {} // flushing the file never finishes, so 'close' never comes
  });
  await assert.rejects(
    core.saveStream(src.stream, path.join(dir, 'setup.exe'), { stallMs: 150, open: () => out }),
    /download: closing the file timed out/
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test(
  'installer download: a stalled connection fails, is cancelled and leaves no partial file',
  { timeout: 5000 },
  async () => {
    const dir = tmpDir();
    const dest = path.join(dir, 'setup.exe');
    const src = body([Buffer.from('MZ partial')], { stall: true });
    const t0 = Date.now();
    await assert.rejects(core.saveStream(src.stream, dest, { stallMs: 150 }), /download: waiting for data timed out/);
    assert.ok(Date.now() - t0 < 2000, 'fails after the stall time, not never');
    assert.ok(src.cancelled instanceof Error, 'the request body is cancelled');
    assert.ok(!fs.existsSync(dest), 'the partial file is deleted');
    fs.rmSync(dir, { recursive: true, force: true });
  }
);

test(
  'installer download: a write error fails the download instead of hanging or escaping as an uncaught error',
  { timeout: 5000 },
  async () => {
    // the disk fills up while a write is still pending: 'drain' never comes and the only signal is the 'error' event
    const uncaught = [];
    const onUncaught = e => uncaught.push(e);
    process.on('uncaughtException', onUncaught);
    const dir = tmpDir();
    const src = body([], { endless: true });
    let writes = 0;
    const out = new Writable({
      highWaterMark: 1,
      write(chunk, enc, cb) {
        writes++;
        setTimeout(
          () =>
            cb(writes >= 3 ? Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }) : null),
          5
        );
      }
    });
    try {
      await assert.rejects(
        core.saveStream(src.stream, path.join(dir, 'setup.exe'), { stallMs: 3000, open: () => out }),
        {
          code: 'ENOSPC'
        }
      );
      await new Promise(res => setImmediate(res));
      assert.equal(uncaught.length, 0, 'no uncaught exception in the main process');
      assert.ok(src.cancelled, 'the request body is cancelled');
    } finally {
      process.off('uncaughtException', onUncaught);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);

test('installer download: a file that cannot be opened fails the download', { timeout: 5000 }, async () => {
  const dir = tmpDir();
  const dest = path.join(dir, 'missing-folder', 'setup.exe');
  const src = body([Buffer.from('MZ')], { stall: true });
  await assert.rejects(core.saveStream(src.stream, dest, { stallMs: 3000 }), { code: 'ENOENT' });
  assert.ok(src.cancelled, 'the request body is cancelled');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('installer download: more than the size limit fails and leaves no partial file', { timeout: 5000 }, async () => {
  const dir = tmpDir();
  const dest = path.join(dir, 'setup.exe');
  const src = body([], { endless: true });
  await assert.rejects(core.saveStream(src.stream, dest, { maxBytes: 10 * 1024 }), /installer too large/);
  assert.ok(src.cancelled, 'the request body is cancelled');
  assert.ok(!fs.existsSync(dest), 'the partial file is deleted');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('response timeout: aborts the request and releases the caller even if the request ignores the abort', async () => {
  assert.equal(await core.withTimeout(Promise.resolve('ok'), 1000, 'x'), 'ok');
  let aborted = false;
  const never = new Promise(() => {});
  const t0 = Date.now();
  await assert.rejects(
    core.withTimeout(never, 100, 'Sahne-Plus-Setup-1.3.7.exe', () => (aborted = true)),
    /Sahne-Plus-Setup-1\.3\.7\.exe timed out/
  );
  assert.ok(aborted, 'onTimeout aborts the request');
  assert.ok(Date.now() - t0 < 1000);
  await assert.rejects(core.withTimeout(Promise.reject(new Error('HTTP 404')), 1000, 'x'), /HTTP 404/);
});

test('response timeout: the timeout is reported even when aborting rejects the request synchronously', async () => {
  // Electron's net.fetch rejects with "This operation was aborted" inside abort(); the log must still say what timed out
  let rejectRequest;
  const request = new Promise((_, reject) => (rejectRequest = reject));
  await assert.rejects(
    core.withTimeout(request, 50, 'SHA256SUMS.txt', () => rejectRequest(new Error('This operation was aborted'))),
    /SHA256SUMS\.txt timed out/
  );
});

// electron/updater.js with a stand-in for Electron's `app` and `net`: GitHub's release redirect, SHA256SUMS.txt and the
// installer are answered by `plan`, one entry per install attempt
function fakeElectron(tmp, installer) {
  const sums = sha256(installer) + ' *Sahne-Plus-Setup-9.9.9.exe\n';
  const fetches = [];
  const net = {
    request() {
      const req = new (require('events').EventEmitter)();
      req.setHeader = () => {};
      req.abort = () => {};
      req.end = () =>
        setImmediate(() =>
          req.emit('redirect', 302, 'HEAD', 'https://github.com/AmirEyZed/sahne-plus/releases/tag/v9.9.9')
        );
      return req;
    },
    async fetch(url, init) {
      const rec = { file: url.split('/').pop(), signal: init.signal, cancelled: false };
      fetches.push(rec);
      const how = net.plan[rec.file] || 'ok';
      if (how === 'no response') return new Promise(() => {});
      let sent = 0;
      const data = rec.file === 'SHA256SUMS.txt' ? Buffer.from(sums) : installer;
      const stream = new ReadableStream({
        pull(c) {
          if (how === 'stall' && sent > 0) return new Promise(() => {});
          if (sent >= data.length) return c.close();
          c.enqueue(data.subarray(sent, (sent += 32768)));
        },
        cancel() {
          rec.cancelled = true;
        }
      });
      const headers = { 'content-length': String(how === 'huge' ? core.MAX_INSTALLER_BYTES + 1 : data.length) };
      return new Response(stream, { status: how === 'http 503' ? 503 : 200, headers });
    },
    plan: {}
  };
  return { electron: { app: { getPath: () => tmp }, net }, fetches };
}

test(
  'updater: each failed download returns to "available" with the request released, and a retry succeeds',
  { timeout: 10000 },
  async () => {
    const tmp = tmpDir();
    const installer = Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(200000)]);
    const { electron, fetches } = fakeElectron(tmp, installer);
    const logs = [];
    let failWrites = false;
    const u = createUpdater({
      version: '1.0.0',
      canInstall: true,
      dryRun: true, // downloads and verifies, never runs the installer
      log: (level, msg) => logs.push(level + ' ' + msg),
      onChange: () => {},
      testHooks: {
        electron,
        tempDir: tmp,
        responseMs: 150,
        stallMs: 150,
        open: dest =>
          failWrites
            ? new Writable({
                write(chunk, enc, cb) {
                  cb(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }));
                }
              })
            : fs.createWriteStream(dest)
      }
    });
    assert.equal((await u.check()).status, 'available');
    const updateDir = path.join(tmp, 'SahnePlus-update');
    const attempts = [
      ['SHA256SUMS.txt no response', { 'SHA256SUMS.txt': 'no response' }, /اینترنت یا VPN/],
      ['SHA256SUMS.txt http 503', { 'SHA256SUMS.txt': 'http 503' }, /اینترنت یا VPN/],
      ['installer no response', { 'Sahne-Plus-Setup-9.9.9.exe': 'no response' }, /اینترنت یا VPN/],
      ['installer http 503', { 'Sahne-Plus-Setup-9.9.9.exe': 'http 503' }, /اینترنت یا VPN/],
      ['installer too large', { 'Sahne-Plus-Setup-9.9.9.exe': 'huge' }, /اینترنت یا VPN/],
      ['installer stalls', { 'Sahne-Plus-Setup-9.9.9.exe': 'stall' }, /اینترنت یا VPN/],
      ['disk full', {}, /فضای خالی دیسک/]
    ];
    for (const [name, plan, message] of attempts) {
      electron.net.plan = plan;
      failWrites = name === 'disk full';
      fetches.length = 0;
      const s = await u.install(() => {});
      assert.equal(s.status, 'available', name + ': back to "available", so the user can retry');
      assert.equal(s.progress, 0, name);
      assert.match(s.error, message, name + ': the matching message');
      const last = fetches[fetches.length - 1];
      assert.ok(last.signal.aborted, name + ': the failed request is aborted');
      if (!/no response/.test(name)) assert.ok(last.cancelled, name + ': its response body is cancelled');
      assert.ok(!fs.existsSync(updateDir), name + ': no partial file is left');
    }
    electron.net.plan = {};
    failWrites = false;
    const ok = await u.install(() => {});
    assert.equal(ok.status, 'ready', 'the retry downloads and verifies the installer');
    assert.equal(ok.progress, 100);
    assert.deepEqual(fs.readFileSync(path.join(updateDir, 'Sahne-Plus-Setup-9.9.9.exe')), installer);
    assert.ok(!logs.some(l => l.startsWith('warn فایل ناقص')), 'cleanup never failed');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
);
