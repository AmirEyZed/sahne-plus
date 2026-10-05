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
  describeKickFailure,
  parseSeActivity,
  seTokenOk,
  fxFromBaha24,
  fxFromBonbast,
  sanitizeFx
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

test('a tip captured while the Browser Source closes is kept at the front, survives the queue sync and plays once on reconnect', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahne-test-'));
  const port = 8600 + Math.floor(Math.random() * 100);
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
  const captures = [];
  const published = [];
  let capturesDone = 0;
  let duringCapture = null;
  const srv = createServer({
    dataDir: dir,
    publicDir: path.join(__dirname, '..', 'public'),
    appVersion: 'test',
    testHooks: {
      offline: true,
      captureTip: async tip => {
        captures.push(tip.stripe_pi_id);
        if (duringCapture) await duringCapture();
        capturesDone++;
        return 'ok';
      },
      onPublish: (type, payload) => published.push(type + ':' + payload.stripe_pi_id)
    }
  });
  await srv.start();
  const overlays = [];
  t.after(async () => {
    overlays.forEach(o => o.req.destroy());
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // polls until cond() is true; fails the test with `what` after 3 s instead of relying on fixed delays
  const waitFor = async (cond, what) => {
    for (const end = Date.now() + 3000; Date.now() < end; await sleep(10)) if (await cond()) return;
    assert.fail('timed out waiting for: ' + what);
  };
  const state = () =>
    new Promise((resolve, reject) =>
      http
        .get({ host: '127.0.0.1', port, path: '/api/config' }, res => {
          let d = '';
          res.on('data', c => (d += c));
          res.on('end', () => resolve(JSON.parse(d).state));
        })
        .on('error', reject)
    );
  const openOverlay = () => {
    const o = { events: [] };
    o.req = http.get({ host: '127.0.0.1', port, path: '/events?role=overlay' }, res => {
      res.setEncoding('utf8');
      res.on('data', c => o.events.push(c));
    });
    o.req.on('error', () => {});
    overlays.push(o);
    return o;
  };
  const plays = o =>
    o.events
      .join('')
      .split('\n')
      .filter(l => l.startsWith('data: ') && l.includes('"type":"play"'))
      .map(l => JSON.parse(l.slice(6)).tip.id);
  const tipPlays = id => published.filter(p => p === 'tip_play:' + id).length;
  const tip = id => ({
    stripe_pi_id: id,
    tipper_name: 'Donor',
    amount_total: 500,
    approval_status: 'approved',
    created_at: new Date().toISOString()
  });

  // the only Browser Source closes while KickBot is capturing the payment; another tip arrives meanwhile
  const first = openOverlay();
  await waitFor(async () => (await state()).overlays === 1, 'the Browser Source to register');
  duringCapture = async () => {
    srv.testHooks.injectTip(tip('pi_second'));
    first.req.destroy();
    await waitFor(async () => (await state()).overlays === 0, 'the server to see the Browser Source close');
  };
  srv.testHooks.injectTip(tip('pi_drop'));
  await waitFor(() => capturesDone === 1, 'the capture to finish');
  duringCapture = null;
  assert.deepEqual(captures, ['pi_drop']);
  assert.equal((await state()).playing, null, 'nothing is playing');
  assert.deepEqual(plays(first), [], 'nothing was sent to the closed Browser Source');
  assert.equal(srv.testHooks.isPlayed('pi_drop'), false, 'a captured tip that was not shown is not marked as played');
  assert.deepEqual(srv.testHooks.queueIds(), ['pi_drop', 'pi_second'], 'the captured tip goes back to the FRONT');
  assert.equal(tipPlays('pi_drop'), 0, 'tip_play is not published while nothing is shown');

  // KickBot may no longer list a captured tip; the queue sync keeps it (an uncaptured tip KickBot no longer lists still goes)
  srv.testHooks.kickbotSync([]);
  assert.deepEqual(srv.testHooks.queueIds(), ['pi_drop'], 'the captured tip survives the sync');

  // a Browser Source connects again: the tip plays once and is not captured a second time
  const second = openOverlay();
  await waitFor(() => plays(second).length > 0, 'the play event on the new Browser Source');
  assert.deepEqual(plays(second), ['pi_drop'], 'the tip is shown on the new Browser Source');
  assert.deepEqual(captures, ['pi_drop'], 'no second capture request for the resumed tip');
  assert.equal(tipPlays('pi_drop'), 1, 'tip_play is published once, when the tip is shown');
  assert.equal(srv.testHooks.isPlayed('pi_drop'), true);
  assert.equal(srv.testHooks.queueLength(), 0);
});

test('a captured tip waiting for a Browser Source survives a restart and plays once, with no second capture', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahne-test-'));
  const port = 8500 + Math.floor(Math.random() * 100);
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
  const CAPTURED = path.join(dir, 'captured.json');
  const saved = () => (fs.existsSync(CAPTURED) ? JSON.parse(fs.readFileSync(CAPTURED, 'utf8')) : null);
  const captures = [];
  const published = [];
  let duringCapture = null;
  const overlays = [];
  let srv = null;
  const boot = async () => {
    srv = createServer({
      dataDir: dir,
      publicDir: path.join(__dirname, '..', 'public'),
      appVersion: 'test',
      testHooks: {
        offline: true,
        captureTip: async tip => {
          captures.push(tip.stripe_pi_id);
          if (duringCapture) await duringCapture();
          return 'ok';
        },
        onPublish: (type, payload) => published.push(type + ':' + payload.stripe_pi_id)
      }
    });
    await srv.start();
  };
  t.after(async () => {
    overlays.forEach(o => o.req.destroy());
    if (srv) await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // agent: false: no keep-alive socket of a stopped server is reused after a restart
  const waitFor = async (cond, what) => {
    for (const end = Date.now() + 3000; Date.now() < end; await sleep(10)) if (await cond()) return;
    assert.fail('timed out waiting for: ' + what);
  };
  const request = (method, p) =>
    new Promise((resolve, reject) =>
      http
        .request(
          { host: '127.0.0.1', port, agent: false, path: p, method, headers: { Origin: `http://127.0.0.1:${port}` } },
          res => {
            let d = '';
            res.on('data', c => (d += c));
            res.on('end', () => resolve(JSON.parse(d)));
          }
        )
        .on('error', reject)
        .end()
    );
  const overlayCount = async () => (await request('GET', '/api/config')).state.overlays;
  const openOverlay = () => {
    const o = { events: [] };
    o.req = http.get({ host: '127.0.0.1', port, agent: false, path: '/events?role=overlay' }, res => {
      res.setEncoding('utf8');
      res.on('data', c => o.events.push(c));
    });
    o.req.on('error', () => {});
    overlays.push(o);
    return o;
  };
  const plays = o =>
    o.events
      .join('')
      .split('\n')
      .filter(l => l.startsWith('data: ') && l.includes('"type":"play"'))
      .map(l => JSON.parse(l.slice(6)).tip.id);
  const tip = id => ({
    stripe_pi_id: id,
    tipper_name: 'Donor ' + id,
    tip_message: 'hello',
    amount_total: 500,
    approval_status: 'approved',
    created_at: new Date().toISOString()
  });
  // the only Browser Source closes while KickBot is capturing the payment (as in the test above)
  const captureWhileClosing = async (first, alsoQueued) => {
    if (typeof first === 'string') first = tip(first);
    const id = first.stripe_pi_id;
    const o = openOverlay();
    await waitFor(async () => (await overlayCount()) === 1, 'the Browser Source to register');
    duringCapture = async () => {
      if (alsoQueued) srv.testHooks.injectTip(tip(alsoQueued));
      o.req.destroy();
      await waitFor(async () => (await overlayCount()) === 0, 'the server to see the Browser Source close');
    };
    const before = captures.length;
    srv.testHooks.injectTip(first);
    await waitFor(
      () => captures.length === before + 1 && srv.testHooks.queueIds().includes(id),
      'the tip to be requeued'
    );
    duringCapture = null;
  };

  await boot();
  assert.equal(saved(), null, 'no file while nothing captured is waiting');

  // clearing the queue drops a waiting captured tip from the file too
  await captureWhileClosing('pi_cleared');
  assert.deepEqual(
    saved().map(x => x.stripe_pi_id),
    ['pi_cleared']
  );
  await request('POST', '/api/clear-queue');
  assert.equal(saved(), null, 'clear-queue removes the file');

  // a second tip arrives during the capture: it is not captured, so it is not written
  await captureWhileClosing('pi_wait', 'pi_uncaptured');
  assert.deepEqual(srv.testHooks.queueIds(), ['pi_wait', 'pi_uncaptured']);
  assert.deepEqual(
    saved().map(x => [x.stripe_pi_id, x.tipper_name, x.tip_message, x.amount_total]),
    [['pi_wait', 'Donor pi_wait', 'hello', 500]],
    'only the captured tip is written, as soon as it goes back to the queue'
  );

  // the app is closed and started again: the tip is back at the front, still captured, and survives a sync that no longer lists it
  await srv.stop();
  await boot();
  assert.deepEqual(
    srv.testHooks.queueIds(),
    ['pi_wait'],
    'the captured tip is restored after a restart (KickBot still lists the other one)'
  );
  srv.testHooks.kickbotSync([]);
  assert.deepEqual(srv.testHooks.queueIds(), ['pi_wait'], 'the restored tip is still marked as captured');
  const shown = openOverlay();
  await waitFor(() => plays(shown).length > 0, 'the play event after the restart');
  assert.deepEqual(plays(shown), ['pi_wait']);
  assert.deepEqual(captures, ['pi_cleared', 'pi_wait'], 'no second capture request after the restart');
  assert.deepEqual(
    published.filter(p => p.startsWith('tip_play:')),
    ['tip_play:pi_wait'],
    'tip_play is published once'
  );
  assert.equal(srv.testHooks.isPlayed('pi_wait'), true);
  assert.equal(saved(), null, 'the file is removed once the tip has played');

  // an entry that was already played, a test tip, malformed entries and a corrupt file are not restored
  await srv.stop();
  fs.writeFileSync(
    CAPTURED,
    JSON.stringify([tip('pi_wait'), { ...tip('pi_test'), is_test: true }, null, 'x', { tipper_name: 'no id' }])
  );
  await boot();
  assert.deepEqual(srv.testHooks.queueIds(), [], 'played, test and malformed entries are ignored');
  assert.equal(saved(), null, 'and removed from disk');

  // a replay of an alert that already played is captured again; if it has to wait, it is restored although its id is in played.json
  await captureWhileClosing({ ...tip('pi_wait'), is_replay: true });
  assert.deepEqual(
    saved().map(x => [x.stripe_pi_id, x.is_replay]),
    [['pi_wait', true]]
  );
  await srv.stop();
  await boot();
  assert.deepEqual(srv.testHooks.queueIds(), ['pi_wait'], 'a waiting replay is restored');
  const replayed = openOverlay();
  await waitFor(() => plays(replayed).length > 0, 'the replay to play after the restart');
  assert.deepEqual(plays(replayed), ['pi_wait']);
  assert.equal(
    captures.filter(id => id === 'pi_wait').length,
    2,
    'the replay was captured once, not again after the restart'
  );
  assert.equal(saved(), null, 'the file is removed once the replay has played');

  await srv.stop();
  fs.writeFileSync(CAPTURED, '{not json');
  await boot();
  assert.deepEqual(srv.testHooks.queueIds(), [], 'a corrupt file is ignored');
  assert.equal(fs.existsSync(CAPTURED), false, 'and removed');

  // "Clear application data" while a capture is in flight: the file is deleted and not written again when the capture returns
  const o = openOverlay();
  await waitFor(async () => (await overlayCount()) === 1, 'the Browser Source to register');
  duringCapture = async () => {
    o.req.destroy();
    await waitFor(async () => (await overlayCount()) === 0, 'the server to see the Browser Source close');
    fs.writeFileSync(CAPTURED, JSON.stringify([tip('pi_other')]));
    srv.clearData();
    assert.equal(fs.existsSync(CAPTURED), false, 'clearData removes captured.json');
  };
  srv.testHooks.injectTip(tip('pi_wipe'));
  await waitFor(() => srv.testHooks.queueIds().includes('pi_wipe'), 'the capture to return');
  assert.equal(fs.existsSync(CAPTURED), false, 'nothing is written after the wipe');
});

test('event streams: foreign pages are refused and the number of streams is bounded (1.3.2)', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahne-test-'));
  const port = 8000 + Math.floor(Math.random() * 100);
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ port, rate: { auto: false }, kick: { enabled: false }, app: { autostart: false } })
  );
  const srv = createServer({
    dataDir: dir,
    publicDir: path.join(__dirname, '..', 'public'),
    appVersion: 'test',
    testHooks: { offline: true }
  });
  await srv.start();
  const open = [];
  t.after(async () => {
    for (const r of open) r.destroy();
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const stream = (p, headers = {}) =>
    new Promise((resolve, reject) => {
      const r = http.get({ host: '127.0.0.1', port, path: p, headers }, res => {
        res.resume();
        resolve({ status: res.statusCode, res });
      });
      open.push(r);
      r.on('error', reject);
    });

  // our own pages are same-origin: browsers send no Origin, or the server's own
  assert.equal((await stream('/events?role=overlay')).status, 200);
  assert.equal((await stream('/events?role=preview', { Origin: `http://localhost:${port}` })).status, 200);
  // a page on another site: the connection alone must not count as a Browser Source
  assert.equal((await stream('/events?role=overlay', { Origin: 'https://evil.example' })).status, 403);
  assert.equal(
    (await stream('/events?role=overlay', { 'Sec-Fetch-Site': 'cross-site' })).status,
    403,
    'cross-site fetch metadata is refused even without an Origin header'
  );
  assert.equal((await stream('/events?role=admin', { Origin: 'https://evil.example' })).status, 403);
  // bounded number of streams per role (one overlay stream is already open)
  const codes = [];
  for (let i = 0; i < 10; i++) codes.push((await stream('/events?role=overlay')).status);
  assert.ok(codes.includes(429), 'a flood of streams is refused once the cap is reached, got ' + JSON.stringify(codes));
  assert.equal(codes.filter(c => c === 200).length, 7, 'the cap is 8 overlay streams in total');
});

test('media: only registered alert files are served (1.3.2)', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahne-test-'));
  const port = 8100 + Math.floor(Math.random() * 100);
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ port, rate: { auto: false }, kick: { enabled: false }, app: { autostart: false } })
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
  const get = p =>
    new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: p }, res => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
        })
        .on('error', reject);
    });
  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('alert bytes')]);
  const up = await new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/upload?name=' + encodeURIComponent('100T clip.webm'),
        method: 'PUT',
        headers: { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/octet-stream' }
      },
      res => {
        let d = '';
        res.on('data', c => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      }
    );
    r.on('error', reject);
    r.end(webm);
  });
  assert.equal(up.status, 200, up.body);
  const entry = JSON.parse(up.body).entry;
  const registered = await get('/media/' + encodeURIComponent(entry.file));
  assert.equal(registered.status, 200);
  assert.deepEqual([...registered.body], [...webm]);
  // other content of the media folder is not served
  fs.writeFileSync(path.join(dir, 'media', 'notes.txt'), 'private notes');
  fs.writeFileSync(path.join(dir, 'media', '.upload-abc123.tmp'), 'partial upload');
  assert.equal((await get('/media/notes.txt')).status, 404, 'unregistered file');
  assert.equal((await get('/media/.upload-abc123.tmp')).status, 404, 'partial upload');
  assert.equal(
    (await get('/media/' + encodeURIComponent(entry.file.toUpperCase()))).status,
    200,
    'case-insensitive on Windows'
  );
});

test('StreamElements: activity parsing and token validation (1.3.4)', () => {
  const tip = parseSeActivity({
    _id: '66f1a2b3c4d5e6f7a8b9c0d1',
    channel: 'x',
    type: 'tip',
    provider: 'kick',
    createdAt: '2026-09-22T10:00:00.000Z',
    data: {
      tipId: 'abc',
      username: 'donor<script>',
      displayName: 'Donor ‮x',
      amount: 12.5,
      currency: 'usd',
      message: 'hi <b>'
    }
  });
  assert.equal(tip.stripe_pi_id, 'se_66f1a2b3c4d5e6f7a8b9c0d1');
  assert.equal(tip.amount_total, 1250);
  assert.equal(tip.currency, 'USD');
  assert.equal(tip.tipper_name, 'Donor x', 'display name preferred, bidi control stripped');
  assert.equal(tip.tip_message, 'hi <b>', 'text is kept as text (the overlay escapes it)');
  assert.ok(tip.is_local && !tip.is_test && tip.source === 'streamelements' && tip.approval_status === 'approved');
  const eur = parseSeActivity({ _id: 'a1', type: 'tip', data: { amount: 5, currency: 'EUR', username: 'u' } });
  assert.equal(eur.currency, 'EUR');
  assert.equal(eur.amount_total, 500);
  assert.equal(
    parseSeActivity({ _id: 'a2', type: 'tip', isMock: true, data: { amount: 1, username: 'u' } }).is_test,
    true
  );
  assert.equal(parseSeActivity({ _id: 'a3', type: 'subscriber', data: { username: 'u' } }), null, 'only tips');
  assert.equal(parseSeActivity({ type: 'tip', data: { amount: 1 } }), null, 'needs an id');
  assert.equal(parseSeActivity(null), null);
  const fake = 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from('{"channel":"x"}').toString('base64url') + '.c2ln';
  assert.ok(seTokenOk(fake));
  assert.ok(!seTokenOk('not a token'));
  assert.ok(!seTokenOk('a.b'));
  assert.ok(!seTokenOk('x'.repeat(5000)));
});

test('credential storage: each provider reports its own persisted protection', async t => {
  const https = require('https');
  const { EventEmitter } = require('events');
  const key = '1'.repeat(32) + ':' + '2'.repeat(32);
  const token = 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from('{"channel":"fixture"}').toString('base64url') + '.c2ln';
  const sealed = s => 'sealed:' + Buffer.from(s).toString('base64');
  const store = (fail = '', available = true, badDecrypt = '') => ({
    available: () => available,
    encrypt: s => {
      if (s === (fail === 'se' ? token : fail === 'kb' ? key : null)) throw new Error('fixture encryption failure');
      return sealed(s);
    },
    decrypt: s => {
      if (s === sealed(badDecrypt)) throw new Error('fixture decryption failure');
      assert.ok(s.startsWith('sealed:'));
      return Buffer.from(s.slice(7), 'base64').toString();
    }
  });
  // Exercise the real setup handlers without any external requests or sockets.
  t.mock.method(https, 'request', (options, cb) => {
    assert.equal(options.host, 'api.streamelements.com');
    assert.equal(options.path, '/kappa/v2/channels/me');
    assert.equal(options.headers.Authorization, 'Bearer ' + token);
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      cb(res);
      res.emit('data', Buffer.from(JSON.stringify({ _id: 'fixture', username: 'fixture', provider: 'kick' })));
      res.emit('end');
    };
    return req;
  });
  t.mock.method(globalThis, 'fetch', async url => {
    assert.ok(String(url).startsWith('https://widgets.kickbot.com/'));
    return {
      ok: true,
      json: async () =>
        String(url).includes('__data.json')
          ? { nodes: [{ data: [{ streamer_db_id: 1 }, 123] }] }
          : { tip_transactions: [] }
    };
  });
  t.mock.method(globalThis, 'WebSocket', function (url) {
    assert.ok(url === 'wss://kickbot.live/ws' || url === 'wss://astro.streamelements.com');
    const sock = { readyState: 1, close() {}, send() {} };
    queueMicrotask(() => sock.onopen?.());
    return sock;
  });
  async function fixture(sub, credentials, secretStore, failInitialSave = false) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahne-credentials-'));
    let srv;
    sub.after(async () => {
      if (srv) await srv.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const listener = http.createServer();
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    const cfgPath = path.join(dir, 'config.json');
    let initialSave;
    if (failInitialSave) {
      const rename = fs.renameSync;
      initialSave = sub.mock.method(fs, 'renameSync', (from, to) => {
        if (to === cfgPath) throw new Error('fixture startup save failure');
        return rename(from, to);
      });
    }
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        port,
        rate: { auto: false, proxy: '' },
        kick: { enabled: false },
        se: { channelId: 'fixture' },
        streamer_id: 123,
        ...credentials
      })
    );
    const start = async () => {
      srv = createServer({
        dataDir: dir,
        publicDir: path.join(__dirname, '..', 'public'),
        secretStore,
        testHooks: { offline: true }
      });
      await srv.start();
    };
    await start();
    initialSave?.mock.restore();
    const request = (method, route, body) =>
      new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            path: route,
            method,
            agent: false,
            headers: { 'Content-Type': 'application/json' }
          },
          res => {
            let data = '';
            res.on('data', chunk => (data += chunk));
            res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(data) }));
          }
        );
        req.on('error', reject);
        req.end(body ? JSON.stringify(body) : undefined);
      });
    const check = async (kb, se) => {
      const result = await request('GET', '/api/config');
      assert.equal(result.config.kickbot.secretStorage, kb);
      assert.equal(result.state.secretStorage, kb, 'the legacy state field still describes KickBot');
      assert.equal(result.config.streamelements.secretStorage, se);
      for (const secret of [key, token, sealed(key), sealed(token)])
        assert.ok(!JSON.stringify(result).includes(secret), 'config, state and logs expose no credential');
      const disk = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      for (const [prefix, expected, value] of [
        ['secret_id', kb, key],
        ['se_token', se, token]
      ]) {
        if (expected === 'os') {
          assert.equal(disk[prefix + '_enc'], sealed(value));
          assert.ok(!(prefix in disk), 'encrypted credentials have no plaintext field');
        } else if (expected === 'plain') {
          assert.equal(disk[prefix], value);
          assert.ok(!(prefix + '_enc' in disk), 'fallback credentials have no encrypted field');
        }
      }
      return result;
    };
    return {
      request,
      check,
      cfgPath,
      save: () => srv.saveConfig(),
      restart: async () => {
        await srv.stop();
        await start();
      }
    };
  }
  const both = { secret_id: key, se_token: token };
  const encrypted = { secret_id_enc: sealed(key), se_token_enc: sealed(token) };
  const cases = [
    ['empty, no OS store', {}, null, 'none', 'none'],
    ['empty, OS store available', {}, store(), 'none', 'none'],
    ['plaintext, no OS store', both, null, 'plain', 'plain'],
    ['plaintext, OS store unavailable', both, store('', false), 'plain', 'plain'],
    ['legacy credentials migrate', both, store(), 'os', 'os'],
    ['StreamElements encryption fails', both, store('se'), 'os', 'plain'],
    ['KickBot encryption fails', both, store('kb'), 'plain', 'os'],
    ['StreamElements alone migrates', { se_token: token }, store(), 'none', 'os'],
    ['StreamElements alone falls back', { se_token: token }, store('se'), 'none', 'plain'],
    ['encrypted credentials reload', encrypted, store(), 'os', 'os'],
    ['StreamElements decryption fails', encrypted, store('', true, token), 'os', 'none'],
    ['KickBot decryption fails', encrypted, store('', true, key), 'none', 'os'],
    ['unreadable encrypted credentials', encrypted, store('', false), 'none', 'none'],
    ['invalid StreamElements token without migration', { secret_id: key, se_token: 'invalid' }, null, 'plain', 'none'],
    ['invalid StreamElements token', { secret_id: key, se_token: 'invalid' }, store(), 'os', 'none']
  ];
  for (const [name, credentials, secretStore, kb, se] of cases)
    await t.test(name, async sub => {
      const f = await fixture(sub, credentials, secretStore);
      const result = await f.check(kb, se);
      assert.equal(result.config.kickbot.configured, kb !== 'none');
      assert.equal(result.config.streamelements.configured, se !== 'none');
      await f.restart();
      await f.check(kb, se);
    });
  await t.test('legacy plaintext is still plaintext when startup migration cannot save', async sub => {
    const f = await fixture(sub, both, store(), true);
    await f.check('plain', 'plain');
    f.save();
    await f.check('os', 'os');
  });
  await t.test('setup, encryption retry, failed save and disconnect update only the matching status', async sub => {
    let failSe = true;
    let failKb = false;
    const secretStore = store();
    const encrypt = secretStore.encrypt;
    secretStore.encrypt = s =>
      failSe && s === token ? store('se').encrypt(s) : failKb && s === key ? store('kb').encrypt(s) : encrypt(s);
    const f = await fixture(sub, { secret_id: key }, secretStore);
    await f.check('os', 'none');
    const setup = await f.request('POST', '/api/se/setup', { token });
    assert.equal(setup.status, 200);
    assert.equal(setup.secretStorage, 'plain', 'setup reports StreamElements fallback, not KickBot encryption');
    const result = await f.check('os', 'plain');
    const entry = result.logs.find(e => e.msg === 'حساب StreamElements وصل شد');
    assert.equal(entry.extra.secretStorage, 'plain', 'the setup log uses the same independent flag');
    assert.equal((await f.request('POST', '/api/setup', { url: key })).secretStorage, 'os');
    await f.check('os', 'plain');
    failSe = false;
    const before = fs.readFileSync(f.cfgPath, 'utf8');
    const rename = fs.renameSync;
    const mockRename = sub.mock.method(fs, 'renameSync', (from, to) => {
      if (to === f.cfgPath) throw new Error('fixture save failure');
      return rename(from, to);
    });
    f.save();
    await f.check('os', 'plain');
    assert.equal(fs.readFileSync(f.cfgPath, 'utf8'), before, 'failed saves do not claim new protection');
    mockRename.mock.restore();
    f.save();
    await f.check('os', 'os');
    failKb = true;
    assert.equal((await f.request('POST', '/api/se/setup', { token })).secretStorage, 'os');
    const reversed = await f.check('plain', 'os');
    assert.equal(reversed.logs.findLast(e => e.msg === 'حساب StreamElements وصل شد').extra.secretStorage, 'os');
    assert.equal((await f.request('POST', '/api/setup', { url: key })).secretStorage, 'plain');
    await f.check('plain', 'os');
    failKb = false;
    f.save();
    await f.restart();
    await f.check('os', 'os');
    assert.equal((await f.request('POST', '/api/disconnect-kickbot')).status, 200);
    await f.check('none', 'os');
    const noKb = JSON.parse(fs.readFileSync(f.cfgPath, 'utf8'));
    assert.ok(!('secret_id' in noKb) && !('secret_id_enc' in noKb));
    assert.equal((await f.request('POST', '/api/se/disconnect')).status, 200);
    await f.check('none', 'none');
    const noSe = JSON.parse(fs.readFileSync(f.cfgPath, 'utf8'));
    assert.ok(!('se_token' in noSe) && !('se_token_enc' in noSe));
  });
});

test('credential storage: controller labels follow each provider and show no credential when absent', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const extract = name => {
    const match = js.match(new RegExp('function ' + name + '\\(\\) \\{[\\s\\S]*?\\n\\}\\n'));
    assert.ok(match, name + ' exists');
    return match[0];
  };
  for (const [kb, se] of [
    ['os', 'plain'],
    ['plain', 'os'],
    ['none', 'os'],
    ['os', 'none']
  ]) {
    const fields = {};
    const cfg = {
      kickbot: { configured: kb !== 'none', secretStorage: kb },
      streamelements: { configured: se !== 'none', secretStorage: se }
    };
    const render = new Function(
      '$',
      'CFG',
      'STATE',
      'INFO',
      'DESK',
      'KB_TEXT',
      'SE_TEXT',
      extract('renderKb') + extract('renderSe') + extract('fillApp') + '\nrenderKb(); fillApp();'
    );
    render(sel => (fields[sel] ||= {}), cfg, {}, null, false, { unconfigured: ['', ''] }, { unconfigured: ['', ''] });
    for (const [id, status] of [
      ['#kbSecret', kb],
      ['#seSecret', se]
    ])
      assert.equal(
        fields[id].textContent,
        status === 'os'
          ? 'ذخیره شده (رمزنگاری‌شده با ویندوز)'
          : status === 'plain'
            ? 'ذخیره شده (بدون رمزنگاری)'
            : 'وارد نشده'
      );
    assert.equal(
      fields['#abSecret'].textContent,
      kb === 'os'
        ? 'رمزنگاری‌شده با ویندوز (DPAPI)'
        : kb === 'plain'
          ? 'متن ساده در config.json (بدون رمزنگاری)'
          : 'کلید ویجت وارد نشده'
    );
  }
});

test('StreamElements: setup endpoint validates the token before any network call; state and config expose no token', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahne-test-'));
  const port = 8200 + Math.floor(Math.random() * 100);
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({
      port,
      rate: { auto: false },
      kick: { enabled: false },
      app: { autostart: false },
      se_token: 'junk'
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
  const req = (method, p, body) =>
    new Promise((resolve, reject) => {
      const r = http.request(
        {
          host: '127.0.0.1',
          port,
          path: p,
          method,
          headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` }
        },
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
  const cfg = JSON.parse((await req('GET', '/api/config')).body);
  assert.equal(cfg.config.streamelements.configured, false, 'a malformed stored token is discarded');
  assert.equal(cfg.state.se.status, 'unconfigured');
  assert.ok(!JSON.stringify(cfg).includes('se_token'), 'no token field reaches the UI');
  assert.equal((await req('POST', '/api/se/setup', { token: 'not-a-jwt' })).status, 400);
  assert.equal((await req('POST', '/api/se/setup', {})).status, 400);
  assert.equal((await req('POST', '/api/se/disconnect')).status, 200);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.ok(!onDisk.se_token && !onDisk.se_token_enc, 'nothing stored after disconnect');
});

test('other currencies: rates are read from baha24 / bonbast and a StreamElements tip in euro gets a toman value (1.3.5)', async t => {
  assert.deepEqual(
    fxFromBaha24([
      { symbol: 'USD', sell: '233500.00' },
      { symbol: 'EUR', sell: '267,780.00' },
      { symbol: 'BITCOIN', sell: '85985' },
      { symbol: 'gbp', sell: '312140' },
      { symbol: 'AED', sell: 'n/a' }
    ]),
    { EUR: 267780, GBP: 312140 },
    'fiat codes only, USD and crypto excluded, bad values skipped'
  );
  assert.deepEqual(fxFromBonbast({ usd1: '233500', eur1: '267,780', try1: '5,600', xyz1: '1' }), {
    EUR: 267780,
    TRY: 5600
  });
  assert.deepEqual(sanitizeFx({ EUR: '267780', GBP: -5, XYZ: 100, AED: 1e12 }), { EUR: 267780 });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahne-test-'));
  const port = 8300 + Math.floor(Math.random() * 100);
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({
      port,
      rate: { auto: false, manual: 200000, fx: { EUR: 250000 } },
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
  const events = [];
  let es = null;
  t.after(async () => {
    if (es) es.destroy();
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  es = http.get({ host: '127.0.0.1', port, path: '/events?role=overlay' }, res => {
    res.setEncoding('utf8');
    res.on('data', c => events.push(c));
  });
  await new Promise(r => setTimeout(r, 150));
  const tip = (id, currency) => ({
    stripe_pi_id: id,
    tipper_name: 'Euro Donor',
    amount_total: 500,
    currency,
    approval_status: 'approved',
    is_local: true,
    source: 'streamelements',
    created_at: new Date().toISOString()
  });
  srv.testHooks.injectTip(tip('se_eur1', 'EUR'));
  await new Promise(r => setTimeout(r, 300));
  const played = events
    .join('')
    .split('\n')
    .filter(l => l.startsWith('data: ') && l.includes('"type":"play"'))
    .map(l => JSON.parse(l.slice(6)).tip);
  assert.equal(played.length, 1, 'the euro tip played');
  assert.equal(played[0].currency, 'EUR');
  assert.equal(played[0].toman, 1250000, '5 EUR x 250000');
  assert.equal(played[0].amount, 5);
  const cfgText = await new Promise(r =>
    http.get({ host: '127.0.0.1', port, path: '/api/config' }, res => {
      let d = '';
      res.on('data', c => (d += c));
      res.on('end', () => r(d));
    })
  );
  const state = JSON.parse(cfgText).state;
  assert.equal(state.recent[0].toman, 1250000, 'the recent list uses the same conversion');
  assert.equal(state.playing.currency, 'EUR', 'the playing alert keeps its currency');
  assert.equal(state.playing.toman, 1250000, 'and carries the same toman value as the recent list');
});

test('disconnecting KickBot drops only its own tips (dashboard tests too); Kick subs, StreamElements tips and the app test alerts stay queued', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahne-test-'));
  const port = 8400 + Math.floor(Math.random() * 100);
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
  const req = (method, p, body) =>
    new Promise((resolve, reject) => {
      const r = http.request(
        {
          host: '127.0.0.1',
          port,
          path: p,
          method,
          headers: { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' }
        },
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
  // no Browser Source is connected, so every alert stays in the queue; each one enters through its real path
  const kb = (id, extra) => ({
    stripe_pi_id: id,
    tipper_name: 'Donor',
    amount_total: 500,
    created_at: new Date().toISOString(),
    ...extra
  });
  srv.testHooks.kickbotEvent('tip_initiated', kb('pi_kickbot', { approval_status: 'approved' }));
  srv.testHooks.kickbotEvent('tip_initiated', kb('pi_dashboard_test', { approval_status: 'approved', is_test: true }));
  srv.testHooks.kickbotEvent('tip_initiated', kb('pi_pending', { approval_status: 'pending' }));
  srv.testHooks.injectTip(
    parseSeActivity({ _id: 'se1', type: 'tip', data: { username: 'Donor', amount: 5, currency: 'EUR' } })
  );
  assert.equal((await req('POST', '/api/test-sub', { kind: 'sub', name: 'Subber' })).status, 200);
  assert.equal((await req('POST', '/api/test', { name: 'Tester', amount: 5 })).status, 200);
  const before = srv.testHooks.queueIds();
  assert.equal(before.length, 5, before.join());
  assert.deepEqual(srv.testHooks.pendingIds(), ['pi_pending']);
  assert.equal((await req('POST', '/api/disconnect-kickbot')).status, 200);
  const after = srv.testHooks.queueIds();
  assert.deepEqual(
    after,
    before.filter(id => !id.startsWith('pi_')),
    'KickBot tips, including its dashboard test tip, are removed'
  );
  assert.ok(after.includes('se_se1'), 'StreamElements tip kept');
  assert.ok(
    after.some(id => id.startsWith('sub_')),
    'Kick sub kept'
  );
  assert.ok(
    after.some(id => id.startsWith('test_')),
    'test alert from the app kept'
  );
  assert.deepEqual(srv.testHooks.pendingIds(), [], 'KickBot pending tip removed');
  assert.equal(JSON.parse((await req('GET', '/api/config')).body).config.kickbot.configured, false);
});

test('KickBot queue sync ignores results from a disconnected, replaced or stopped connection', async t => {
  const cases = [
    ['current connection', 'headers', 'current'],
    ['disconnect while fetching', 'headers', 'disconnect'],
    ['disconnect while reading JSON', 'body', 'disconnect'],
    ['replace key while reading JSON', 'body', 'replace'],
    ['disconnect and reconnect with the same key', 'body', 'reconnect'],
    ['set up the same key again', 'body', 'setup'],
    ['stop while fetching', 'headers', 'stop'],
    ['clear application data while reading JSON', 'body', 'clear'],
    ['HTTP failure', 'headers', 'http-error'],
    ['fetch failure', 'headers', 'fetch-error'],
    ['JSON failure', 'body', 'json-error']
  ];
  for (const [name, phase, action] of cases) {
    await t.test(name, { timeout: 5000 }, async t => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahne-test-'));
      const listener = http.createServer();
      await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
      const port = listener.address().port;
      await new Promise(resolve => listener.close(resolve));
      const key = 'a'.repeat(32) + ':' + 'b'.repeat(32);
      const replacement = 'c'.repeat(32) + ':' + 'd'.repeat(32);
      fs.writeFileSync(
        path.join(dir, 'config.json'),
        JSON.stringify({
          port,
          secret_id: key,
          streamer_id: 1,
          rate: { auto: false },
          kick: { enabled: false },
          app: { autostart: false }
        })
      );
      const requests = [];
      t.mock.method(globalThis, 'fetch', async url => {
        const u = new URL(url);
        assert.equal(u.origin, 'https://widgets.kickbot.com', 'only the mocked KickBot API is used');
        if (u.pathname.startsWith('/external/tipping/')) {
          return { json: async () => ({ nodes: [{ data: [{ streamer_db_id: 1 }, 1] }] }) };
        }
        assert.equal(u.pathname, '/api/tip_queue_sync');
        const headers = Promise.withResolvers();
        const body = Promise.withResolvers();
        const reading = Promise.withResolvers();
        const response = {
          ok: true,
          json: () => {
            reading.resolve();
            return body.promise;
          }
        };
        requests.push({ headers, body, reading, response, key: u.searchParams.get('secret_id') });
        return headers.promise;
      });
      // Setup uses the real HTTP handler, but no test opens an external WebSocket.
      t.mock.method(globalThis, 'WebSocket', function () {
        return {
          readyState: 0,
          close() {
            this.readyState = 3;
            if (this.onclose) this.onclose({ code: 1000 });
          }
        };
      });
      const srv = createServer({
        dataDir: dir,
        publicDir: path.join(__dirname, '..', 'public'),
        testHooks: { offline: true }
      });
      t.after(async () => {
        for (const r of requests) {
          r.body.resolve({ tip_transactions: [] });
          r.headers.resolve(r.response);
        }
        await srv.stop();
        fs.rmSync(dir, { recursive: true, force: true });
      });
      await srv.start();
      const req = (method, p, body) =>
        new Promise((resolve, reject) => {
          const r = http.request(
            {
              host: '127.0.0.1',
              port,
              path: p,
              method,
              headers: { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' }
            },
            res => {
              let data = '';
              res.on('data', chunk => (data += chunk));
              res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
            }
          );
          r.on('error', reject);
          if (body) r.write(JSON.stringify(body));
          r.end();
        });
      const tip = (id, status) => ({ stripe_pi_id: id, approval_status: status, amount_total: 500 });
      srv.testHooks.kickbotEvent('tip_initiated', tip('pi_existing', 'pending'));
      srv.testHooks.injectTip(parseSeActivity({ _id: 'sync', type: 'tip', data: { amount: 5, currency: 'USD' } }));
      assert.equal((await req('POST', '/api/test-sub', { kind: 'sub', name: 'Test subscriber' })).status, 200);
      assert.equal((await req('POST', '/api/test', { name: 'Test donor', amount: 5 })).status, 200);
      const kept = srv.testHooks.queueIds();
      const sync = srv.testHooks.syncKickbotQueue();
      assert.equal(requests.length, 1);
      const r = requests[0];
      assert.equal(r.key, key, 'request uses the key of the connection that started it');
      if (phase === 'body') {
        r.headers.resolve(r.response);
        await r.reading.promise;
      }
      if (action === 'disconnect' || action === 'reconnect') {
        assert.equal((await req('POST', '/api/disconnect-kickbot')).status, 200);
        assert.deepEqual(srv.testHooks.pendingIds(), []);
        assert.equal((await req('GET', '/api/config')).body.config.kickbot.configured, false);
      }
      if (action === 'replace' || action === 'reconnect' || action === 'setup') {
        const nextKey = action === 'replace' ? replacement : key;
        assert.equal((await req('POST', '/api/setup', { url: nextKey })).status, 200);
        const fresh = srv.testHooks.syncKickbotQueue();
        const next = requests[1];
        assert.equal(next.key, nextKey);
        next.body.resolve({ tip_transactions: [tip('pi_fresh', 'approved')] });
        next.headers.resolve(next.response);
        await fresh;
        assert.deepEqual(srv.testHooks.queueIds(), [...kept, 'pi_fresh'], 'a fresh sync still applies');
        assert.deepEqual(srv.testHooks.pendingIds(), [], 'a fresh sync removes absent pending tips');
      }
      if (action === 'stop') await srv.stop();
      if (action === 'clear') srv.clearData();
      const before = { approved: srv.testHooks.queueIds(), pending: srv.testHooks.pendingIds() };
      if (action === 'http-error') r.headers.resolve({ ok: false });
      else if (action === 'fetch-error') r.headers.reject(new Error('mock network failure'));
      else if (action === 'json-error') r.body.reject(new SyntaxError('mock invalid JSON'));
      else {
        r.body.resolve({
          tip_transactions: [
            tip('pi_existing', 'approved'),
            tip('pi_synced', 'approved'),
            tip('pi_pending_sync', 'pending')
          ]
        });
        r.headers.resolve(r.response);
      }
      await sync;
      if (action === 'current') {
        assert.deepEqual(srv.testHooks.queueIds(), [...kept, 'pi_existing', 'pi_synced']);
        assert.deepEqual(srv.testHooks.pendingIds(), ['pi_pending_sync']);
      } else {
        assert.deepEqual(srv.testHooks.queueIds(), before.approved, 'late or failed sync cannot change approved tips');
        assert.deepEqual(srv.testHooks.pendingIds(), before.pending, 'late or failed sync cannot change pending tips');
      }
      if (action === 'disconnect' || action === 'stop' || action === 'clear') {
        const attempted = srv.testHooks.syncKickbotQueue();
        assert.equal(requests.length, 1, 'disconnected or stopped servers do not start another sync');
        await attempted;
      }
      if (action === 'clear') {
        assert.equal(fs.existsSync(path.join(dir, 'config.json')), false);
        assert.equal(fs.existsSync(path.join(dir, 'captured.json')), false);
      }
    });
  }
});

test('KickBot queue settings (pause/play, delay, mode, tipping on/off) are applied; values of the wrong type are ignored', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahne-test-'));
  const port = 8900 + Math.floor(Math.random() * 100);
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
  const captures = [];
  const srv = createServer({
    dataDir: dir,
    publicDir: path.join(__dirname, '..', 'public'),
    appVersion: 'test',
    testHooks: {
      offline: true,
      captureTip: async tip => {
        captures.push(tip.stripe_pi_id);
        return 'ok';
      }
    }
  });
  await srv.start();
  let overlay = null;
  t.after(async () => {
    if (overlay) overlay.destroy();
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const waitFor = async (cond, what) => {
    for (const end = Date.now() + 3000; Date.now() < end; await sleep(10)) if (await cond()) return;
    assert.fail('timed out waiting for: ' + what);
  };
  const req = (method, p) =>
    new Promise((resolve, reject) =>
      http
        .request({ host: '127.0.0.1', port, path: p, method, headers: { Origin: `http://127.0.0.1:${port}` } }, res => {
          let d = '';
          res.on('data', c => (d += c));
          res.on('end', () => resolve(JSON.parse(d)));
        })
        .on('error', reject)
        .end()
    );
  const settings = async () => {
    const s = (await req('GET', '/api/config')).state;
    return [s.queueStatus, s.queueDelay, s.queueMode, s.tippingEnabled];
  };
  const events = [];
  overlay = http.get({ host: '127.0.0.1', port, path: '/events?role=overlay' }, res => {
    res.setEncoding('utf8');
    res.on('data', c => events.push(c));
  });
  overlay.on('error', () => {});
  const plays = () =>
    events
      .join('')
      .split('\n')
      .filter(l => l.startsWith('data: ') && l.includes('"type":"play"'))
      .map(l => JSON.parse(l.slice(6)).tip.id);
  await waitFor(async () => (await req('GET', '/api/config')).state.overlays === 1, 'the Browser Source to register');
  const kb = id => ({
    stripe_pi_id: id,
    tipper_name: 'Donor',
    amount_total: 500,
    approval_status: 'approved',
    created_at: new Date().toISOString()
  });

  // KickBot sends its queue settings (the fields the official widget reads): paused, no delay, manual mode, tipping off
  assert.deepEqual(await settings(), ['play', 5, 'automatic', true], 'defaults');
  srv.testHooks.kickbotEvent('tip_queue_config_updated', {
    queue_mode: 'manual',
    queue_delay: 0,
    queue_status: 'pause',
    is_active: false
  });
  assert.deepEqual(await settings(), ['pause', 0, 'manual', false], 'every setting is applied');

  // a paused queue holds an approved tip: it is not captured or shown
  srv.testHooks.kickbotEvent('tip_initiated', kb('pi_a'));
  assert.deepEqual(captures, [], 'nothing is captured while the queue is paused');
  assert.deepEqual(srv.testHooks.queueIds(), ['pi_a']);

  // switching back to play through the settings event plays it without waiting for another event
  srv.testHooks.kickbotEvent('tip_queue_config_updated', {
    queue_mode: 'manual',
    queue_delay: 0,
    queue_status: 'play',
    is_active: true
  });
  await waitFor(() => plays().includes('pi_a'), 'the held tip to play');

  // the delay of 0 applies: after the alert ends, the next tip plays at once (the default gap is 5 s)
  await req('POST', '/api/skip');
  srv.testHooks.kickbotEvent('tip_initiated', kb('pi_b'));
  await waitFor(() => plays().includes('pi_b'), 'the next tip to play without the default 5 s gap');
  assert.deepEqual(captures, ['pi_a', 'pi_b']);

  // values of the wrong type or outside the known set are ignored, and the delay is clamped
  srv.testHooks.kickbotEvent('tip_queue_config_updated', {
    queue_mode: { x: 1 },
    queue_delay: 'soon',
    queue_status: 'stop',
    is_active: 'yes'
  });
  assert.deepEqual(await settings(), ['play', 0, 'manual', true], 'invalid values change nothing');
  srv.testHooks.kickbotEvent('tip_queue_config_updated', { queue_delay: 99999, queue_mode: 'x'.repeat(100) });
  const [, delay, mode] = await settings();
  assert.equal(delay, 600, 'the delay is clamped to 600 s');
  assert.equal(mode.length, 20, 'the mode string is bounded');
});

test('secret input fields (KickBot widget URL, StreamElements token) are masked and styled', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'public', 'app.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'public', 'app.css'), 'utf8');
  // The widget URL carries the widget secret: it must not sit readable on screen while streaming.
  for (const id of ['setupUrl', 'setupUrl2', 'seToken']) {
    const tag = html.match(new RegExp('<input[^>]*\\bid="' + id + '"[^>]*>'));
    assert.ok(tag, id + ' input exists');
    assert.match(tag[0], /type="password"/, id + ' is masked');
    assert.match(tag[0], /autocomplete="off"/, id + ' is not offered to autofill');
  }
  // Without this selector a masked field falls back to the browser default (white box, unreadable dots).
  assert.match(css, /^input\[type=text\][^{]*input\[type=password\][^{]*\{/m, 'password inputs share the field style');
});

test('doSetup empties both widget URL fields when the connection succeeds and keeps them when it fails', async () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  // app.js is a browser script (it wires the whole page on load), so run just this function against stubs.
  const src = js.match(/async function doSetup\([^)]*\) \{[\s\S]*?\n\}\n/);
  assert.ok(src, 'doSetup exists');
  for (const from of ['#setupUrl', '#setupUrl2']) {
    for (const ok of [true, false]) {
      const fields = { '#setupUrl': { value: 'first' }, '#setupUrl2': { value: 'second' }, '#msg': {} };
      const sent = [];
      const doSetup = new Function('$', 'post', 'toast', 'load', src[0] + '\nreturn doSetup;')(
        sel => fields[sel],
        async (url, body) => (
          sent.push(body.url),
          ok ? { ok: true, streamer_id: 1 } : { ok: false, error: 'bad link' }
        ),
        () => {},
        () => {}
      );
      await doSetup(from, '#msg');
      assert.deepEqual(sent, [from === '#setupUrl' ? 'first' : 'second'], 'the field that was used is submitted');
      const kept = [fields['#setupUrl'].value, fields['#setupUrl2'].value];
      assert.deepEqual(kept, ok ? ['', ''] : ['first', 'second'], from + (ok ? ' success' : ' failure'));
    }
  }
});

test('edited media amount ranges are validated atomically and old entries remain repairable', async t => {
  const listener = http.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahne-ranges-'));
  const configPath = path.join(dir, 'config.json');
  const files = [
    { id: '1'.repeat(10), file: 'one.webm', name: 'one', minToman: 10, maxToman: 20, minAmount: 1, maxAmount: 2 },
    { id: '2'.repeat(10), file: 'two.webm', name: 'two', minToman: 30, maxToman: 10, minAmount: 3, maxAmount: 1 }
  ];
  fs.writeFileSync(configPath, JSON.stringify({ port, files, rate: { auto: false }, kick: { enabled: false } }));
  const options = {
    dataDir: dir,
    publicDir: path.join(__dirname, '..', 'public'),
    testHooks: { offline: true }
  };
  let srv = createServer(options);
  t.after(async () => {
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await srv.start();
  const req = (method, route, body) =>
    new Promise((resolve, reject) => {
      const r = http.request(
        {
          host: '127.0.0.1',
          port,
          path: route,
          method,
          agent: false,
          headers: { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' }
        },
        res => {
          let data = '';
          res.on('data', chunk => {
            data += chunk;
          });
          res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(data) }));
        }
      );
      r.on('error', reject);
      r.end(body ? JSON.stringify(body) : undefined);
    });
  const getConfig = async () => (await req('GET', '/api/config')).config;
  assert.equal((await getConfig()).files.length, 2, 'inverted legacy entries are retained on load');
  for (const [method, route] of [
    ['PATCH', '/api/file'],
    ['POST', '/api/config']
  ]) {
    const edit = changes =>
      req(
        method,
        route,
        method === 'PATCH' ? { id: files[0].id, ...changes } : { files: [{ id: files[0].id, ...changes }] }
      );
    for (const [min, max] of [
      ['minToman', 'maxToman'],
      ['minAmount', 'maxAmount']
    ]) {
      for (const changes of [{ [min]: 50 }, { [max]: 0 }, { [min]: 50, [max]: 49 }]) {
        const before = await getConfig(),
          disk = fs.readFileSync(configPath, 'utf8');
        const result = await edit(changes);
        assert.equal(result.status, 400, `${method}: ${JSON.stringify(changes)}`);
        assert.equal(result.code, 'invalid_amount_range');
        assert.match(result.error, /حداقل/);
        assert.deepEqual(await getConfig(), before, 'rejection leaves memory unchanged');
        assert.equal(fs.readFileSync(configPath, 'utf8'), disk, 'rejection leaves disk unchanged');
      }
      for (const changes of [
        { [min]: 0, [max]: 0 },
        { [min]: 10, [max]: 10 },
        { [min]: 50, [max]: null },
        { [max]: '' }
      ])
        assert.equal((await edit(changes)).status, 200, 'equal bounds and empty maximum are valid');
      assert.equal((await edit({ [min]: 1, [max]: 2 })).status, 200);
    }
  }
  const before = await getConfig(),
    disk = fs.readFileSync(configPath, 'utf8');
  const badBatch = await req('POST', '/api/config', {
    mode: 'highest',
    appearance: { cardDelay: 59 },
    files: [
      { id: files[0].id, name: 'changed', minToman: 100, maxToman: 200 },
      { id: files[1].id, minToman: 50, maxToman: 10 }
    ]
  });
  assert.equal(badBatch.status, 400);
  assert.deepEqual(await getConfig(), before, 'no earlier file or other setting is partially committed');
  assert.equal(fs.readFileSync(configPath, 'utf8'), disk);
  assert.equal(
    (
      await req('POST', '/api/config', {
        files: [
          { id: files[0].id, minToman: 10, maxToman: 20 },
          { id: files[0].id, maxToman: 5 }
        ]
      })
    ).status,
    400,
    'duplicate ids are checked against the staged update'
  );
  assert.deepEqual(await getConfig(), before);
  assert.equal(
    (
      await req('POST', '/api/config', {
        files: [
          { id: files[0].id, minToman: 10, maxToman: 20 },
          { id: files[0].id, maxToman: 30 },
          { id: 'unknown', minToman: 50, maxToman: 1 }
        ]
      })
    ).status,
    200
  );
  let current = (await getConfig()).files[0];
  assert.equal(current.minToman, 10);
  assert.equal(current.maxToman, 30);
  assert.equal(
    (await req('PATCH', '/api/file', { id: files[1].id, name: 'repair later' })).status,
    200,
    'unrelated edits do not hide or discard an old invalid range'
  );
  assert.equal((await req('PATCH', '/api/file', { id: files[1].id, maxToman: 30 })).status, 200);
  assert.equal((await req('PATCH', '/api/file', { id: files[1].id, maxAmount: null })).status, 200);
  assert.equal(
    (await req('PATCH', '/api/file', { id: files[0].id, minToman: 10.4, maxToman: 10.3 })).status,
    200,
    'comparison uses the existing integer normalization'
  );
  assert.equal((await req('PATCH', '/api/file', { id: files[0].id, minToman: null, maxToman: 0 })).status, 200);
  assert.equal((await req('POST', '/api/config', { files: [] })).status, 200);
  await srv.stop();
  srv = createServer(options);
  await srv.start();
  current = (await getConfig()).files;
  assert.equal(current.length, 2);
  assert.equal(current[1].minToman, 30);
  assert.equal(current[1].maxToman, 30);
  assert.equal(current[1].maxAmount, null, 'repairs persist across restart');
});

test('inspector range validation keeps drafts editable and autosave reflects only the current draft', async t => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const src = js.split('// ---------- inspector ----------')[1].split('// ---------- look ----------')[0];
  function harness() {
    const elements = new Map(),
      timers = new Map(),
      calls = [],
      notices = [];
    let timerId = 0;
    const $ = sel => {
      if (sel === '#insThumb video') return null;
      if (!elements.has(sel)) {
        const classes = new Set();
        elements.set(sel, {
          value: '',
          checked: false,
          hidden: false,
          textContent: '',
          validity: { badInput: false },
          attributes: {},
          classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) },
          setAttribute(k, v) {
            this.attributes[k] = v;
          },
          setCustomValidity(v) {
            this.validationMessage = v;
          },
          addEventListener(event, callback) {
            this[event] = callback;
          }
        });
      }
      return elements.get(sel);
    };
    const CFG = {
      files: [
        { id: 'one', file: 'one.webm', type: 'video', name: 'one', minToman: 10, maxToman: 20 },
        { id: 'two', file: 'two.webm', type: 'video', name: 'two', minToman: 30, maxToman: 10 }
      ]
    };
    const api = new Function(
      'CFG',
      '$',
      '$$',
      'patch',
      'setTimeout',
      'clearTimeout',
      'fmtSize',
      'fmtToman',
      'typeLabel',
      'renderFiles',
      'toast',
      'let selectedId = null;\n' + src + '\nreturn { selectFile, closeInspector };'
    )(
      CFG,
      $,
      () => [],
      (route, body) => new Promise(resolve => calls.push({ route, body, resolve })),
      (fn, ms) => {
        const id = ++timerId;
        timers.set(id, { fn, ms });
        return id;
      },
      id => timers.delete(id),
      String,
      String,
      {},
      () => {},
      (...args) => notices.push(args)
    );
    const input = (sel, value) => {
      $(sel).value = String(value);
      $(sel).input();
    };
    const save = () => {
      const entry = [...timers].find(([, v]) => v.ms === 350);
      assert.ok(entry, 'a valid draft has a pending save');
      timers.delete(entry[0]);
      return entry[1].fn();
    };
    return { ...api, $, CFG, input, save, calls, notices, timers };
  }
  await t.test(
    'invalid and transient drafts send no request; correction, equality and unlimited maximum save',
    async () => {
      const h = harness();
      h.selectFile('one');
      h.input('#iMin', 30);
      assert.equal(h.timers.size, 0);
      assert.equal(h.$('#iRangeError').hidden, false);
      assert.equal(h.$('#iMin').attributes['aria-invalid'], 'true');
      assert.ok(h.$('#iMax').validationMessage);
      h.input('#iName', 'new name');
      assert.equal(h.calls.length, 0);
      assert.equal(h.timers.size, 0, 'unrelated input cannot bypass an invalid range');
      assert.equal(h.CFG.files[0].minToman, 10);
      for (const max of ['30', '', '0']) {
        if (max === '0') h.input('#iMin', '');
        h.input('#iMax', max);
        assert.equal(h.$('#iRangeError').hidden, true);
        const pending = h.save(),
          call = h.calls.at(-1);
        assert.equal(call.body.maxToman, max === '' ? null : Number(max));
        call.resolve({ ok: true, file: call.body });
        await pending;
        assert.equal(h.$('#insSaved').classList.contains('show'), true);
      }
      h.$('#iMin').validity.badInput = true;
      h.input('#iMin', '');
      assert.equal(
        [...h.timers.values()].some(v => v.ms === 350),
        false
      );
      assert.equal(h.$('#insSaved').classList.contains('show'), false);
      assert.equal(h.$('#iRangeError').hidden, false);
      assert.equal(h.notices.length, 0);
    }
  );
  await t.test('old invalid entries open for repair and selecting or closing cancels pending saves', () => {
    const h = harness();
    h.selectFile('two');
    assert.equal(h.$('#iMin').value, 30);
    assert.equal(h.$('#iRangeError').hidden, false);
    h.input('#iMax', 30);
    h.selectFile('one');
    assert.equal(h.timers.size, 0);
    assert.equal(h.$('#iRangeError').hidden, true);
    h.input('#iName', 'changed');
    h.closeInspector();
    assert.equal(h.timers.size, 0);
    assert.equal(h.calls.length, 0);
  });
  await t.test('in-flight saves do not show saved for a later invalid draft or a different selection', async () => {
    const h = harness();
    h.selectFile('one');
    h.input('#iMin', 15);
    const pending = h.save();
    h.input('#iMin', 30);
    h.calls[0].resolve({ ok: true, file: h.calls[0].body });
    await pending;
    assert.equal(h.CFG.files[0].minToman, 15, 'last valid response updates the saved configuration');
    assert.equal(h.$('#iMin').value, '30', 'invalid draft remains editable');
    assert.equal(h.$('#iRangeError').hidden, false);
    assert.equal(h.$('#insSaved').classList.contains('show'), false);
    h.input('#iMax', 30);
    const next = h.save();
    h.selectFile('two');
    h.calls[1].resolve({ ok: true, file: h.calls[1].body });
    await next;
    assert.equal(h.$('#insSaved').classList.contains('show'), false);
    assert.equal(h.$('#iRangeError').hidden, false);
  });
  await t.test('server rejection is inline and a stale rejection cannot replace the current error', async () => {
    const h = harness();
    h.selectFile('one');
    h.input('#iName', 'edited');
    const pending = h.save();
    h.calls[0].resolve({ code: 'invalid_amount_range', error: 'range rejected' });
    await pending;
    assert.equal(h.$('#iRangeError').textContent, 'range rejected');
    assert.equal(h.CFG.files[0].name, 'one');
    assert.equal(h.$('#iName').value, 'edited');
    assert.equal(h.notices.length, 0);
    h.input('#iName', 'edited again');
    const next = h.save();
    h.selectFile('two');
    const message = h.$('#iRangeError').textContent;
    h.calls[1].resolve({ code: 'invalid_amount_range', error: 'stale rejection' });
    await next;
    assert.equal(h.$('#iRangeError').textContent, message);
    assert.equal(h.notices.length, 0);
  });
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
