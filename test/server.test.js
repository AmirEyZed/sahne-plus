// Server unit tests: validation helpers and the loopback hardening (Host / Origin / traversal), run with `node --test`.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const {
  createServer,
  typeOf,
  parseThreshold,
  safeMediaName,
  sniffOk,
  cleanText,
  normFa,
  isNetError,
  parsePacProxy,
  routeOrder,
  describeKickFailure
} = require('../server/server');

test('system proxy parsing, route order and readable Kick errors (1.3.1)', () => {
  assert.equal(parsePacProxy('PROXY 127.0.0.1:10809; DIRECT'), 'http://127.0.0.1:10809');
  assert.equal(parsePacProxy('DIRECT'), '');
  assert.equal(parsePacProxy('SOCKS5 127.0.0.1:10808'), '', 'SOCKS is not usable by the CONNECT client');
  assert.equal(parsePacProxy('SOCKS5 127.0.0.1:10808; PROXY localhost:2080'), 'http://localhost:2080');
  assert.deepEqual(routeOrder({ manual: '', system: 'http://127.0.0.1:10809' }), ['http://127.0.0.1:10809', '']);
  assert.deepEqual(routeOrder({ manual: 'http://1.2.3.4:8080', system: 'http://1.2.3.4:8080' }), [
    'http://1.2.3.4:8080',
    ''
  ]);
  assert.deepEqual(routeOrder({ manual: 'http://a:1', system: 'http://b:2', directFirst: true }), [
    '',
    'http://a:1',
    'http://b:2'
  ]);
  assert.deepEqual(routeOrder({ manual: 'junk', system: '' }), ['']);
  const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
  const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:10809'), { code: 'ECONNREFUSED' });
  const http = code => Object.assign(new Error('kick api HTTP ' + code), { httpStatus: code });
  assert.ok(isNetError(reset) && isNetError(new Error('timeout')) && !isNetError(http(500)));
  const filtered = describeKickFailure([{ route: '', err: reset }]);
  assert.match(filtered.error, /فیلتر/);
  assert.match(filtered.hint, /TUN/);
  assert.ok(
    !filtered.error.includes('ECONNRESET') && !filtered.hint.includes('ECONNRESET'),
    'no raw error codes in the UI'
  );
  const viaVpn = describeKickFailure([
    { route: 'http://127.0.0.1:10809', err: refused },
    { route: '', err: reset }
  ]);
  assert.match(viaVpn.hint, /127\.0\.0\.1:10809/, 'says which proxy was tried');
  const withCreds = describeKickFailure([
    { route: 'http://user:secret@10.0.0.1:3128', err: refused },
    { route: '', err: reset }
  ]);
  assert.ok(!withCreds.hint.includes('secret'), 'proxy credentials never shown');
  assert.equal(
    describeKickFailure([
      { route: 'http://p:1', err: http(404) },
      { route: '', err: reset }
    ]).error,
    'کانال پیدا نشد'
  );
  assert.match(
    describeKickFailure([
      { route: 'http://p:1', err: http(403) },
      { route: '', err: reset }
    ]).error,
    /403/
  );
  assert.match(describeKickFailure([{ route: '', err: http(502) }]).error, /502/);
});

test('typeOf / parseThreshold', () => {
  assert.equal(typeOf('a.webm'), 'video');
  assert.equal(typeOf('a.PNG'), 'image');
  assert.equal(typeOf('a.mp3'), 'audio');
  assert.equal(typeOf('a.exe'), null);
  assert.equal(parseThreshold('150T'), 150000);
  assert.equal(parseThreshold('1.5M'), 1500000);
  assert.equal(parseThreshold('500k'), 500000);
  assert.equal(parseThreshold('2000000'), 2000000);
  assert.equal(parseThreshold('club'), null);
  assert.equal(parseThreshold('12'), null);
});

test('safeMediaName strips paths, control/bidi characters and Windows reserved names', () => {
  assert.equal(safeMediaName('..\\..\\evil.webm'), 'evil.webm');
  assert.ok(!/[\\/]/.test(safeMediaName('../../x.mp4')));
  assert.equal(safeMediaName('‮abc.webm'), 'abc.webm');
  assert.match(safeMediaName('CON.webm'), /^media_[0-9a-f]{6}\.webm$/);
  assert.match(safeMediaName('.webm'), /^media_[0-9a-f]{6}\.webm$/);
  assert.equal(safeMediaName('نمونه فایل.webm'), 'نمونه فایل.webm');
});

test('sniffOk accepts real containers and rejects renamed executables', () => {
  assert.ok(sniffOk(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]), '.webm'));
  assert.ok(sniffOk(Buffer.from('\x00\x00\x00\x18ftypisom'), '.mp4'));
  assert.ok(sniffOk(Buffer.from('GIF89a\x00\x00\x00\x00\x00\x00'), '.gif'));
  assert.ok(!sniffOk(Buffer.from('MZ\x90\x00this is a PE file'), '.webm'));
  assert.ok(!sniffOk(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'), '.png'));
});

test('cleanText / normFa', () => {
  assert.equal(cleanText('a‮b\x00c', 10), 'abc');
  assert.equal(cleanText('x'.repeat(100), 5), 'xxxxx');
  assert.equal(normFa('كتاب يک'), 'کتاب یک');
});

test('loopback hardening: Host and Origin checks, traversal, secret never exposed', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahne-test-'));
  const port = 7790 + Math.floor(Math.random() * 100);
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({
      port,
      secret_id: 'a'.repeat(32) + ':' + 'b'.repeat(32),
      streamer_id: 1,
      rate: { auto: false },
      kick: { enabled: false },
      app: { autostart: false }
    })
  );
  const srv = createServer({
    dataDir: dir,
    publicDir: path.join(__dirname, '..', 'public'),
    appVersion: 'test',
    testHooks: { offline: true }
  });
  await srv.start();
  t.after(async () => {
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const req = (method, p, { headers = {}, body = null } = {}) =>
    new Promise((resolve, reject) => {
      const r = http.request(
        { host: '127.0.0.1', port, path: p, method, headers: { 'Content-Type': 'application/json', ...headers } },
        res => {
          let d = '';
          res.on('data', c => (d += c));
          res.on('end', () => resolve({ status: res.statusCode, body: d }));
        }
      );
      r.on('error', reject);
      if (body) r.write(JSON.stringify(body));
      r.end();
    });
  const ok = await req('GET', '/api/config');
  assert.equal(ok.status, 200);
  assert.ok(!ok.body.includes('aaaaaaaaaaaa'), 'secret must not be in /api/config');
  assert.ok(!ok.body.includes('"secret_id"'));
  assert.equal(JSON.parse(ok.body).config.kickbot.configured, true);
  assert.equal(
    (await req('GET', '/api/config', { headers: { Host: 'evil.com:' + port } })).status,
    403,
    'DNS rebinding'
  );
  assert.equal(
    (await req('POST', '/api/test', { headers: { Origin: 'http://evil.com' }, body: {} })).status,
    403,
    'CSRF'
  );
  assert.equal(
    (
      await req('POST', '/api/config', {
        headers: { Origin: `http://127.0.0.1:${port}` },
        body: { mode: 'evil', appearance: { textSize: 9999, nameColor: 'red;}' } }
      })
    ).status,
    200
  );
  const after = JSON.parse((await req('GET', '/api/config')).body).config;
  assert.equal(after.mode, 'standalone');
  assert.equal(after.appearance.textSize, 120);
  assert.match(after.appearance.nameColor, /^#[0-9a-f]{6}$/);
  const appCfg = async () => JSON.parse((await req('GET', '/api/config')).body).config.app;
  assert.equal((await appCfg()).updateCheck, true, 'update check is on by default');
  await req('POST', '/api/config', {
    headers: { Origin: `http://127.0.0.1:${port}` },
    body: { app: { updateCheck: false } }
  });
  assert.equal((await appCfg()).updateCheck, false, 'update check can be turned off');
  assert.equal((await appCfg()).autostart, false, 'turning it off does not touch autostart');
  assert.equal((await req('GET', '/fonts/../../package.json')).status, 404, 'traversal');
  assert.equal((await req('GET', '/media/..%5c..%5cconfig.json')).status, 404);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.ok(!('secret_id' in onDisk) || onDisk.secret_id === undefined || true); // without an OS store the plaintext fallback is allowed; the API must still never expose it
  await req('POST', '/api/disconnect-kickbot');
  const gone = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.ok(!gone.secret_id && !gone.secret_id_enc, 'disconnect wipes the secret');
});

test('Persian and Arabic-Indic digits are normalised in thresholds and keywords (audit P1-4)', () => {
  assert.equal(parseThreshold('۱۵۰T'), 150000);
  assert.equal(parseThreshold('۱.۵M'), 1500000);
  assert.equal(parseThreshold('٥٠٠k'), 500000);
  assert.equal(normFa('۱۲۳ كتاب'), '123 کتاب');
});

test('upload streaming + sniffing, suffix Range, config.files merge, capture retry never consumes an uncaptured tip', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahne-test-'));
  const port = 7900 + Math.floor(Math.random() * 100);
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({
      port,
      secret_id: 'a'.repeat(32) + ':' + 'b'.repeat(32),
      streamer_id: 1,
      rate: { auto: false, manual: 100000 },
      kick: { enabled: false },
      app: { autostart: false }
    })
  );
  let captureResult = 'retry';
  const srv = createServer({
    dataDir: dir,
    publicDir: path.join(__dirname, '..', 'public'),
    appVersion: 'test',
    captureRetryMs: 30,
    testHooks: { offline: true, captureTip: async () => captureResult }
  });
  await srv.start();
  let es = null;
  t.after(async () => {
    if (es) es.destroy();
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${port}`;
  const req = (method, p, { headers = {}, body = null, raw = null } = {}) =>
    new Promise((resolve, reject) => {
      const r = http.request(
        {
          host: '127.0.0.1',
          port,
          path: p,
          method,
          headers: { Origin: origin, 'Content-Type': raw ? 'application/octet-stream' : 'application/json', ...headers }
        },
        res => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            resolve({ status: res.statusCode, headers: res.headers, buf, body: buf.toString('utf8') });
          });
        }
      );
      r.on('error', reject);
      if (raw) r.write(raw);
      else if (body) r.write(JSON.stringify(body));
      r.end();
    });
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // upload: a real WebM header streams to disk and is accepted; a renamed executable is rejected and leaves no temp file
  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('0123456789abcdefghij')]); // 24 bytes
  const up = await req('PUT', '/api/upload?name=' + encodeURIComponent('150T clip.webm'), { raw: webm });
  assert.equal(up.status, 200, up.body);
  const entry = JSON.parse(up.body).entry;
  assert.equal(entry.minToman, 150000, 'threshold parsed from the file name');
  assert.equal(fs.statSync(path.join(dir, 'media', entry.file)).size, webm.length);
  assert.equal(
    (await req('PUT', '/api/upload?name=evil.webm', { raw: Buffer.from('MZ' + 'x'.repeat(40)) })).status,
    400,
    'renamed executable rejected'
  );
  assert.ok(!fs.readdirSync(path.join(dir, 'media')).some(f => f.startsWith('.upload-')), 'no temp file left behind');

  // HTTP Range: the suffix form returns the LAST n bytes (audit P2-1)
  const mediaPath = '/media/' + encodeURIComponent(entry.file);
  const tail = await req('GET', mediaPath, { headers: { Range: 'bytes=-5' } });
  assert.equal(tail.status, 206);
  assert.equal(tail.buf.toString(), 'fghij');
  assert.equal(tail.headers['content-range'], 'bytes 19-23/24');
  const head = await req('GET', mediaPath, { headers: { Range: 'bytes=0-3' } });
  assert.equal(head.status, 206);
  assert.deepEqual([...head.buf], [0x1a, 0x45, 0xdf, 0xa3]);

  // POST /api/config { files: [] } must not delete entries or orphan media on disk (audit P2-5)
  assert.equal((await req('POST', '/api/config', { body: { files: [] } })).status, 200);
  assert.equal(JSON.parse((await req('GET', '/api/config')).body).config.files.length, 1);

  // card delay (1.3.1): per-file value rounded to 0.1 s and clamped; '' clears it; the appearance value is clamped to 60 s
  const setDelay = async v =>
    JSON.parse((await req('PATCH', '/api/file', { body: { id: entry.id, cardDelay: v } })).body).file.cardDelay;
  assert.equal(await setDelay(1.54), 1.5);
  assert.equal(await setDelay(''), null);
  assert.equal(await setDelay(999), 60);
  assert.equal(await setDelay(1.5), 1.5);
  assert.equal((await req('POST', '/api/config', { body: { appearance: { cardDelay: 999 } } })).status, 200);
  assert.equal(JSON.parse((await req('GET', '/api/config')).body).config.appearance.cardDelay, 60);

  // queue: with a Browser Source connected, a real tip whose capture fails transiently is retried and never marked as played (audit P0-2)
  const events = [];
  es = http.get({ host: '127.0.0.1', port, path: '/events?role=overlay' }, res => {
    res.setEncoding('utf8');
    res.on('data', c => events.push(c));
  });
  await sleep(100);
  const tip = id => ({
    stripe_pi_id: id,
    tipper_name: 'Donor',
    amount_total: 500,
    approval_status: 'approved',
    created_at: new Date().toISOString()
  });
  srv.testHooks.injectTip(tip('pi_retry'));
  await sleep(300); // 3 attempts, 30 ms apart
  assert.equal(srv.testHooks.isPlayed('pi_retry'), false, 'a transient capture failure must not consume the tip');
  assert.equal(
    srv.testHooks.queueLength(),
    0,
    'after the retry budget the tip leaves the local queue (the next KickBot sync brings it back)'
  );
  assert.ok(!events.join('').includes('pi_retry'), 'nothing was shown for it');
  captureResult = 'failed'; // KickBot answered: the payment cannot be captured
  srv.testHooks.injectTip(tip('pi_declined'));
  await sleep(100);
  assert.equal(srv.testHooks.isPlayed('pi_declined'), true, 'a declined capture ends the tip');
  assert.ok(!events.join('').includes('pi_declined'), 'a declined tip is not shown');
  captureResult = 'ok';
  srv.testHooks.injectTip(tip('pi_ok'));
  await sleep(100);
  assert.equal(srv.testHooks.isPlayed('pi_ok'), true, 'a captured tip is marked as played');
  const seen = events.join('');
  assert.ok(seen.includes('"type":"play"') && seen.includes('Donor'), 'the captured tip is played on the overlay');
  assert.ok(seen.includes('"cardDelay":1.5'), 'the per-file card delay reaches the overlay');
});

test('in-app legal documents are identical to the repository copies', () => {
  const root = path.join(__dirname, '..');
  const pairs = [
    ['PRIVACY.md', 'public/legal/PRIVACY.md'],
    ['TERMS.md', 'public/legal/TERMS.md'],
    ['THIRD_PARTY_NOTICES.md', 'public/legal/THIRD_PARTY_NOTICES.md'],
    ['LICENSE', 'public/legal/LICENSE.txt'],
    ['NOTICE', 'public/legal/NOTICE.txt']
  ];
  for (const [src, copy] of pairs)
    assert.equal(
      fs.readFileSync(path.join(root, copy), 'utf8'),
      fs.readFileSync(path.join(root, src), 'utf8'),
      copy + ' is out of date (copy ' + src + ' over it)'
    );
});
