// A video/audio alert longer than the maximum duration: the Browser Source reports its length through /api/extend and
// the server's safety timer follows it, only for the alert that is playing, bounded, and never shorter.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createServer } = require('../server/server');

test('/api/extend moves the safety timer of the playing alert behind its media length (bounded, never shorter)', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahne-test-'));
  const port = 9100 + Math.floor(Math.random() * 100);
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ port, rate: { auto: false, manual: 100000 }, kick: { enabled: false }, app: { autostart: false } })
  );
  const srv = createServer({
    dataDir: dir,
    publicDir: path.join(__dirname, '..', 'public'),
    appVersion: 'test',
    testHooks: { offline: true }
  });
  await srv.start();
  let overlay = null;
  t.after(async () => {
    if (overlay) overlay.destroy();
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
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
          res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }));
        }
      );
      r.on('error', reject);
      if (body) r.write(JSON.stringify(body));
      r.end();
    });
  const state = async () => (await req('GET', '/api/config')).body.state;
  const waitFor = async (cond, what) => {
    for (const end = Date.now() + 3000; Date.now() < end; await sleep(10)) if (await cond()) return;
    assert.fail('timed out waiting for: ' + what);
  };

  overlay = http.get({ host: '127.0.0.1', port, path: '/events?role=overlay' }, res => res.resume());
  overlay.on('error', () => {});
  await waitFor(async () => (await state()).overlays === 1, 'the Browser Source to register');
  assert.equal(srv.testHooks.playTimeoutLeft(), null, 'no timer while nothing plays');

  assert.equal((await req('POST', '/api/test', { name: 'Long', amount: 5 })).status, 200);
  await waitFor(async () => !!(await state()).playing, 'the test alert to start');
  const id = (await state()).playing.id;
  const near = (ms, expected) => ms > expected - 2000 && ms <= expected;
  assert.ok(near(srv.testHooks.playTimeoutLeft(), (90 + 15) * 1000), 'default: maximum duration + 15 s');

  // another alert's id changes nothing
  assert.equal((await req('POST', '/api/extend', { id: 'test_other', seconds: 300 })).status, 200);
  assert.ok(near(srv.testHooks.playTimeoutLeft(), 105000), 'only the playing alert can be extended');

  // the real length of the video: the timer follows it
  assert.equal((await req('POST', '/api/extend', { id, seconds: 200 })).status, 200);
  assert.ok(near(srv.testHooks.playTimeoutLeft(), 215000), 'media length + 15 s');

  // a shorter value never shortens the timer
  await req('POST', '/api/extend', { id, seconds: 10 });
  assert.ok(near(srv.testHooks.playTimeoutLeft(), 215000), 'never shorter');

  // junk and absurd values: ignored or bounded to an hour, like a file's own duration
  await req('POST', '/api/extend', { id, seconds: 'soon' });
  assert.ok(near(srv.testHooks.playTimeoutLeft(), 215000), 'a non-number changes nothing');
  await req('POST', '/api/extend', { id, seconds: 1e9 });
  assert.ok(near(srv.testHooks.playTimeoutLeft(), (3600 + 15) * 1000), 'bounded to one hour');

  // the Browser Source reports the end: the alert is over and the timer is gone
  assert.equal((await req('POST', '/api/done', { id })).status, 200);
  await waitFor(async () => !(await state()).playing, 'the alert to finish');
  assert.equal(srv.testHooks.playTimeoutLeft(), null);
});
