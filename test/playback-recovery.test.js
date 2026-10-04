'use strict';
// Synthetic fixtures and loopback only; provider transports are disabled by testHooks.offline.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { fork } = require('child_process');
const { createServer, parseSeActivity } = require('../server/server');
const activity = (id, extra = {}) => ({
  _id: id,
  type: 'tip',
  createdAt: '2026-10-03T00:00:00.000Z',
  data: { displayName: 'Synthetic viewer', message: 'Synthetic message', amount: 12.34, currency: 'EUR' },
  ...extra
});
const kbTip = id => ({ stripe_pi_id: id, tipper_name: 'Synthetic donor', amount_total: 500, tip_message: 'fixture' });
const waitFor = async check => {
  for (const end = Date.now() + 3000; Date.now() < end; await new Promise(r => setTimeout(r, 10)))
    if (await check()) return;
  assert.fail('timed out waiting for the loopback overlay');
};
async function fixture(t, config = {}, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahne-provider-queue-'));
  const probe = net.createServer();
  await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise(r => probe.close(r));
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({
      port,
      rate: { auto: false, manual: 100000 },
      kick: { enabled: false, showNewSubs: true, subValueToman: 250000, giftValueToman: 300000 },
      app: { autostart: false },
      ...config
    })
  );
  const file = path.join(dir, 'playing.json');
  if (options.record) fs.writeFileSync(file, JSON.stringify(options.record));
  if (options.waiting) fs.writeFileSync(path.join(dir, 'captured.json'), JSON.stringify(options.waiting));
  if (options.played) fs.writeFileSync(path.join(dir, 'played.json'), JSON.stringify(options.played));
  let srv;
  let running = false;
  const overlays = [];
  const captures = [],
    published = [];
  const boot = async () => {
    srv = createServer({
      dataDir: dir,
      publicDir: path.join(__dirname, '..', 'public'),
      appVersion: 'test',
      testHooks: {
        offline: true,
        playbackTimeoutMs: options.playbackTimeoutMs,
        captureTip: async tip => {
          captures.push(tip.stripe_pi_id);
          return options.capture ? options.capture(tip) : 'ok';
        },
        onPublish: (type, payload) => published.push(type + ':' + payload.stripe_pi_id)
      }
    });
    await srv.start();
    running = true;
  };
  t.after(async () => {
    overlays.forEach(o => o.req.destroy());
    if (running) await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const request = (p, body = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: p,
          method: 'POST',
          agent: false,
          headers: { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' }
        },
        res => {
          let text = '';
          res.on('data', chunk => (text += chunk));
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
        }
      );
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
  const overlay = () => {
    const o = {
      text: '',
      plays: () =>
        o.text
          .split('\n')
          .filter(l => l.startsWith('data: '))
          .map(l => JSON.parse(l.slice(6)))
          .filter(e => e.type === 'play')
          .map(e => e.tip)
    };
    o.req = http.get({ host: '127.0.0.1', port, path: '/events?role=overlay', agent: false }, res => {
      res.setEncoding('utf8');
      res.on('data', chunk => (o.text += chunk));
    });
    o.req.on('error', () => {});
    overlays.push(o);
    return o;
  };
  await boot();
  return {
    get srv() {
      return srv;
    },
    dir,
    file,
    captures,
    published,
    request,
    overlay,
    saved: () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null),
    stop: async () => {
      overlays.forEach(o => o.req.destroy());
      if (running) await srv.stop();
      running = false;
    },
    restart: async beforeBoot => {
      overlays.forEach(o => o.req.destroy());
      if (running) await srv.stop();
      running = false;
      if (beforeBoot) beforeBoot();
      await boot();
    }
  };
}

const done = (f, tip) => f.request('/api/done', { id: tip.id, playback_id: tip.playback_id });
const capturedTip = id => ({ ...kbTip(id), source: 'kickbot', captured: true });

test('an interrupted captured donation resumes before waiting alerts, bypassing only its played id', async t => {
  const f = await fixture(t);
  const first = f.overlay();
  await waitFor(() => f.srv.state().overlays === 1);
  f.srv.testHooks.injectTip(kbTip('pi_synthetic_active'));
  await waitFor(() => first.plays().length === 1);
  const old = first.plays()[0];
  assert.equal(f.saved().tip.captured, true);
  assert.equal(f.srv.testHooks.isPlayed(old.id), true);
  await f.restart(() =>
    fs.writeFileSync(
      path.join(f.dir, 'captured.json'),
      JSON.stringify([capturedTip(old.id), capturedTip('pi_synthetic_waiting')])
    )
  );
  assert.deepEqual(f.srv.testHooks.queueIds(), [old.id, 'pi_synthetic_waiting']);
  f.srv.testHooks.kickbotSync([]);
  assert.deepEqual(f.srv.testHooks.queueIds(), [old.id, 'pi_synthetic_waiting']);
  await f.restart();
  f.srv.testHooks.kickbotEvent('tip_queue_config_updated', { queue_delay: 0 });
  const resumed = f.overlay();
  await waitFor(() => resumed.plays().length === 1);
  const fresh = resumed.plays()[0];
  assert.equal(fresh.id, old.id);
  assert.notEqual(fresh.playback_id, old.playback_id, 'a restart creates a new completion token');
  assert.equal((await done(f, old)).body.ignored, true, 'the previous attempt cannot finish this one');
  assert.equal(
    (await f.request('/api/done', { id: fresh.id })).body.ignored,
    true,
    'legacy stale completion is ignored on recovery'
  );
  assert.equal(f.saved().tip.stripe_pi_id, fresh.id);
  assert.equal((await done(f, fresh)).status, 200);
  await waitFor(() => resumed.plays().length === 2);
  assert.equal(resumed.plays()[1].id, 'pi_synthetic_waiting');
  await done(f, resumed.plays()[1]);
  assert.equal(f.saved(), null);
  assert.deepEqual(f.captures, [old.id], 'recovery never captures the already-paid donation again');
  assert.equal(
    f.published.filter(x => x === 'tip_play:' + old.id).length,
    2,
    'each actual display publishes playback, including recovery'
  );
  await f.restart();
  assert.deepEqual(f.srv.testHooks.queueIds(), []);
  f.srv.testHooks.kickbotSync([kbTip(old.id)]);
  assert.deepEqual(f.srv.testHooks.queueIds(), [], 'ordinary played-id dedupe still applies after completion');
});

test('real StreamElements, subscription and gift playback recovers provider details and local-only behavior', async t => {
  for (const kind of ['tip', 'sub', 'gift'])
    await t.test(kind, async t => {
      const files =
        kind === 'tip'
          ? []
          : [
              {
                id: 'synthetic_media',
                file: 'synthetic.wav',
                name: 'Synthetic subscription media',
                type: 'audio',
                enabled: true,
                minAmount: 0,
                keywords: [kind === 'gift' ? 'giftsub' : 'newsub']
              }
            ];
      const f = await fixture(t, { files });
      for (const media of files) fs.writeFileSync(path.join(f.srv.mediaDir, media.file), Buffer.from('RIFFsynthetic'));
      const o = f.overlay();
      await waitFor(() => f.srv.state().overlays === 1);
      if (kind === 'tip') f.srv.testHooks.streamElementsActivity(activity('synthetic_interrupted'));
      if (kind === 'sub') f.srv.testHooks.kickSubscription('Synthetic subscriber', 3);
      if (kind === 'gift') f.srv.testHooks.kickGifts('Synthetic gifter', ['Synthetic A', 'Synthetic B']);
      await waitFor(() => o.plays().length === 1);
      const original = o.plays()[0];
      const record = f.saved();
      assert.equal(record.tip.is_local, true);
      await f.restart();
      assert.deepEqual(f.srv.testHooks.queueIds(), [original.id]);
      await f.restart();
      const recovered = f.overlay();
      await waitFor(() => recovered.plays().length === 1);
      const fresh = recovered.plays()[0];
      for (const key of ['id', 'name', 'amount', 'currency', 'toman', 'kind', 'count', 'message', 'media'])
        assert.deepEqual(fresh[key], original[key], key + ' survives');
      assert.equal(f.saved().tip.created_at, record.tip.created_at);
      assert.equal(f.saved().tip.captured, undefined);
      assert.equal((await done(f, fresh)).status, 200);
      assert.deepEqual(f.captures, []);
      assert.deepEqual(f.published, [], 'local recovery never publishes KickBot events');
      await f.restart();
      assert.deepEqual(f.srv.testHooks.queueIds(), []);
    });
});

test('a forcibly killed server restores its active payment even after played.json reached disk', async t => {
  const f = await fixture(t);
  await f.stop();
  const child = fork(path.join(__dirname, 'playback-worker.js'), [f.dir], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  });
  const messages = [];
  child.on('message', m => messages.push(m));
  child.on('error', e => messages.push({ error: e.message }));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = new Promise(r => child.once('exit', r));
      child.kill('SIGKILL');
      await exit;
    }
  });
  await waitFor(() => messages.some(m => m.type === 'ready'));
  const o = f.overlay();
  await waitFor(() => messages.some(m => m.type === 'overlay'));
  child.send({ type: 'inject', tip: kbTip('pi_synthetic_killed') });
  await waitFor(() => o.plays().length === 1);
  const playedFile = path.join(f.dir, 'played.json');
  await waitFor(
    () => fs.existsSync(playedFile) && JSON.parse(fs.readFileSync(playedFile)).includes('pi_synthetic_killed')
  );
  assert.equal(f.saved().tip.stripe_pi_id, 'pi_synthetic_killed');
  const exited = new Promise(r => child.once('exit', r));
  child.kill('SIGKILL');
  await exited;
  assert.equal(messages.filter(m => m.type === 'capture').length, 1);
  await f.restart();
  assert.deepEqual(f.srv.testHooks.queueIds(), ['pi_synthetic_killed']);
  const recovered = f.overlay();
  await waitFor(() => recovered.plays().length === 1);
  assert.equal((await done(f, recovered.plays()[0])).status, 200);
  assert.deepEqual(f.captures, [], 'no capture request is made in the restarted process');
  assert.equal(f.saved(), null);
});

test('completion, skip, rejection, timeout and no-media suppression retire the active record', async t => {
  for (const action of ['done', 'skip', 'reject', 'timeout', 'no-media'])
    await t.test(action, async t => {
      const f = await fixture(
        t,
        { showAlertWithoutMedia: action !== 'no-media' },
        { playbackTimeoutMs: action === 'timeout' ? 60 : undefined }
      );
      f.srv.testHooks.kickbotEvent('tip_queue_config_updated', { queue_delay: 0 });
      const o = f.overlay();
      await waitFor(() => f.srv.state().overlays === 1);
      f.srv.testHooks.injectTip(kbTip('pi_synthetic_' + action));
      if (action === 'no-media') {
        await waitFor(() => f.srv.testHooks.isPlayed('pi_synthetic_' + action) && f.srv.state().playing === null);
        assert.deepEqual(o.plays(), []);
        f.srv.testHooks.injectTip(kbTip('pi_synthetic_no_media_next'));
        await waitFor(() => f.srv.testHooks.isPlayed('pi_synthetic_no_media_next'));
      } else {
        await waitFor(() => o.plays().length === 1);
        assert.ok(f.saved().tip);
        if (action === 'done') await done(f, o.plays()[0]);
        if (action === 'skip') await f.request('/api/skip');
        if (action === 'reject') f.srv.testHooks.kickbotEvent('tip_rejected', kbTip(o.plays()[0].id));
        if (action === 'timeout') await waitFor(() => f.srv.state().playing === null);
      }
      assert.equal(f.saved(), null);
      if (action === 'reject') assert.equal(f.published.filter(x => x.startsWith('tip_end:')).length, 0);
      await f.restart();
      assert.deepEqual(f.srv.testHooks.queueIds(), []);
    });
});

test('simulated alerts and companion mode never create active recovery records', async t => {
  const f = await fixture(t);
  const o = f.overlay();
  await waitFor(() => f.srv.state().overlays === 1);
  await f.request('/api/test');
  await waitFor(() => o.plays().length === 1);
  assert.equal(f.saved(), null);
  await f.restart();
  assert.deepEqual(f.srv.testHooks.queueIds(), []);
  const companion = await fixture(t, { mode: 'companion' });
  companion.srv.testHooks.streamElementsActivity(activity('synthetic_companion'));
  companion.srv.testHooks.kickSubscription('Synthetic companion subscriber', 1);
  assert.equal(companion.saved(), null);
});

test('invalid recovery records cannot become payments, and valid local fields are bounded and whitelisted', async t => {
  const local = {
    stripe_pi_id: 'se_synthetic_valid',
    source: 'streamelements',
    kind: 'tip',
    is_local: true,
    amount_total: 1234,
    currency: 'EUR',
    tipper_name: 'n'.repeat(150),
    tip_message: 'm'.repeat(700),
    created_at: '2026-10-04T00:00:00Z',
    captured: true,
    authorization: 'synthetic-unwanted',
    tags: ['unwanted'],
    gif_url: 'https://example.invalid/synthetic.gif',
    toman_override: 999
  };
  for (const record of [
    { version: 2, tip: local },
    { version: 1, tip: null },
    { version: 1, tip: [] },
    { version: 1, tip: { ...local, is_test: true } },
    { version: 1, tip: { ...local, is_local: false } },
    { version: 1, tip: { ...local, source: 'unknown' } },
    { version: 1, tip: kbTip('pi_synthetic_uncaptured') }
  ]) {
    const f = await fixture(t, {}, { record });
    assert.deepEqual(f.srv.testHooks.queueIds(), []);
    await f.stop();
  }
  const f = await fixture(t, {}, { record: { version: 1, tip: local }, played: [local.stripe_pi_id] });
  const o = f.overlay();
  await waitFor(() => o.plays().length === 1);
  const saved = f.saved().tip;
  assert.equal(saved.tipper_name.length, 80);
  assert.equal(saved.tip_message.length, 500);
  assert.equal(saved.authorization, undefined);
  assert.equal(saved.gif_url, undefined);
  assert.equal(saved.captured, undefined);
  assert.equal(saved.is_local, true);
  assert.deepEqual(saved.tags, []);
  assert.equal(saved.toman_override, null);
  assert.deepEqual(f.captures, []);
  await done(f, o.plays()[0]);
  await f.restart(() => fs.writeFileSync(f.file, '{synthetic invalid json'));
  assert.deepEqual(f.srv.testHooks.queueIds(), [], 'corrupt journal is ignored without a capture request');
});

test('write and rename failures block playback and retry captured payments without a second capture', async t => {
  for (const operation of ['write', 'rename'])
    await t.test(operation, async t => {
      const f = await fixture(t);
      const write = fs.writeFileSync,
        rename = fs.renameSync;
      t.after(() => {
        fs.writeFileSync = write;
        fs.renameSync = rename;
      });
      fs.writeFileSync = (p, ...args) => {
        if (operation === 'write' && p === f.file + '.tmp') throw new Error('synthetic ENOSPC');
        return write(p, ...args);
      };
      fs.renameSync = (p, ...args) => {
        if (operation === 'rename' && p === f.file + '.tmp') throw new Error('synthetic EBUSY');
        return rename(p, ...args);
      };
      const o = f.overlay();
      await waitFor(() => f.srv.state().overlays === 1);
      f.srv.testHooks.injectTip(kbTip('pi_synthetic_retry'));
      await waitFor(() => f.captures.length === 1 && f.srv.state().playing === null);
      assert.deepEqual(o.plays(), []);
      assert.equal(f.saved(), null);
      assert.deepEqual(f.srv.testHooks.queueIds(), ['pi_synthetic_retry']);
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(f.dir, 'captured.json')))[0].stripe_pi_id,
        'pi_synthetic_retry'
      );
      fs.writeFileSync = write;
      fs.renameSync = rename;
      await waitFor(() => o.plays().length === 1);
      assert.deepEqual(f.captures, ['pi_synthetic_retry']);
      assert.equal(f.saved().tip.captured, true);
      await done(f, o.plays()[0]);
    });
});

test('failed completion checkpoint blocks the next alert and retries without overwriting the previous record', async t => {
  const f = await fixture(t);
  f.srv.testHooks.kickbotEvent('tip_queue_config_updated', { queue_delay: 0 });
  const o = f.overlay();
  await waitFor(() => f.srv.state().overlays === 1);
  f.srv.testHooks.streamElementsActivity(activity('synthetic_complete_retry'));
  await waitFor(() => o.plays().length === 1);
  f.srv.testHooks.kickSubscription('Synthetic next subscriber', 1);
  const before = fs.readFileSync(f.file, 'utf8');
  const rename = fs.renameSync;
  t.after(() => (fs.renameSync = rename));
  fs.renameSync = (p, ...args) => {
    if (p === f.file + '.tmp') throw new Error('synthetic completion EBUSY');
    return rename(p, ...args);
  };
  assert.equal((await done(f, o.plays()[0])).status, 503);
  assert.equal((await done(f, o.plays()[0])).status, 503);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  assert.equal(o.plays().length, 1);
  assert.equal(f.srv.testHooks.queueLength(), 1);
  fs.renameSync = rename;
  await waitFor(() => o.plays().length === 2);
  assert.equal(f.saved().tip.stripe_pi_id, o.plays()[1].id);
  await done(f, o.plays()[1]);
  await f.restart();
  assert.deepEqual(f.srv.testHooks.queueIds(), []);
});

test('a locked journal remains as a completed marker and cannot resurrect an alert', async t => {
  const f = await fixture(t);
  const o = f.overlay();
  await waitFor(() => f.srv.state().overlays === 1);
  f.srv.testHooks.streamElementsActivity(activity('synthetic_locked_delete'));
  await waitFor(() => o.plays().length === 1);
  const rm = fs.rmSync;
  t.after(() => (fs.rmSync = rm));
  fs.rmSync = (p, ...args) => {
    if (p === f.file) throw new Error('synthetic locked journal');
    return rm(p, ...args);
  };
  assert.equal((await done(f, o.plays()[0])).status, 200);
  assert.deepEqual(f.saved(), { version: 1, tip: null });
  await f.restart();
  assert.deepEqual(f.srv.testHooks.queueIds(), []);
  fs.rmSync = rm;
  f.srv.testHooks.streamElementsActivity(activity('synthetic_after_lock'));
  const next = f.overlay();
  await waitFor(() => next.plays().length === 1);
  await done(f, next.plays()[0]);
  assert.equal(f.saved(), null);
});

test('clearing or rejecting queued recovery and selective disconnects retire only the intended record', async t => {
  for (const action of ['clear-api', 'clear-provider', 'reject', 'disconnect'])
    await t.test(action, async t => {
      const tip = capturedTip('pi_synthetic_queued_recovery');
      const f = await fixture(t, {}, { record: { version: 1, tip }, played: [tip.stripe_pi_id] });
      assert.deepEqual(f.srv.testHooks.queueIds(), [tip.stripe_pi_id]);
      if (action === 'clear-api') await f.request('/api/clear-queue');
      if (action === 'clear-provider') f.srv.testHooks.kickbotEvent('queue_clear', {});
      if (action === 'reject') f.srv.testHooks.kickbotEvent('tip_rejected', tip);
      if (action === 'disconnect') {
        await f.request('/api/se/disconnect');
        assert.equal(f.saved().tip.stripe_pi_id, tip.stripe_pi_id, 'another provider cannot erase the recovery');
        await f.request('/api/disconnect-kickbot');
      }
      assert.equal(f.saved(), null);
      await f.restart();
      assert.deepEqual(f.srv.testHooks.queueIds(), []);
    });
  const f = await fixture(t);
  const o = f.overlay();
  await waitFor(() => f.srv.state().overlays === 1);
  f.srv.testHooks.streamElementsActivity(activity('synthetic_disconnect_active'));
  await waitFor(() => o.plays().length === 1);
  await f.request('/api/se/disconnect');
  assert.ok(f.saved().tip, 'disconnect removes waiting provider entries, while active playback continues');
  await done(f, o.plays()[0]);
});

test('application-data deletion removes both journal files and late capture callbacks cannot recreate them', async t => {
  const f = await fixture(t);
  const o = f.overlay();
  await waitFor(() => f.srv.state().overlays === 1);
  f.srv.testHooks.streamElementsActivity(activity('synthetic_wipe_active'));
  await waitFor(() => o.plays().length === 1);
  fs.writeFileSync(f.file + '.tmp', 'synthetic temporary checkpoint');
  f.srv.clearData();
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(fs.existsSync(f.file + '.tmp'), false);
  let release;
  const gate = new Promise(r => (release = r));
  const inFlight = await fixture(t, {}, { capture: () => gate });
  const second = inFlight.overlay();
  await waitFor(() => inFlight.srv.state().overlays === 1);
  inFlight.srv.testHooks.injectTip(kbTip('pi_synthetic_late_capture'));
  await waitFor(() => inFlight.captures.length === 1);
  fs.writeFileSync(inFlight.file, JSON.stringify({ version: 1, tip: capturedTip('pi_synthetic_wiped') }));
  inFlight.srv.clearData();
  release('ok');
  await new Promise(r => setImmediate(r));
  assert.equal(fs.existsSync(inFlight.file), false);
  assert.equal(fs.existsSync(inFlight.file + '.tmp'), false);
  assert.deepEqual(inFlight.published, []);
  assert.deepEqual(second.plays(), []);
});

test('a waiting captured snapshot is retained until the active journal commit succeeds', async t => {
  const tip = capturedTip('pi_synthetic_handoff');
  const f = await fixture(t, {}, { waiting: [tip, capturedTip('pi_synthetic_handoff_next')] });
  const waiting = path.join(f.dir, 'captured.json');
  const before = fs.readFileSync(waiting, 'utf8');
  const rename = fs.renameSync;
  t.after(() => (fs.renameSync = rename));
  fs.renameSync = (p, ...args) => {
    if (p === f.file + '.tmp') throw new Error('synthetic handoff EBUSY');
    return rename(p, ...args);
  };
  const o = f.overlay();
  await waitFor(() => f.srv.state().overlays === 1);
  assert.equal(fs.readFileSync(waiting, 'utf8'), before);
  assert.equal(f.srv.state().playing, null);
  assert.deepEqual(o.plays(), []);
  fs.renameSync = rename;
  await waitFor(() => o.plays().length === 1);
  assert.equal(f.saved().tip.stripe_pi_id, tip.stripe_pi_id);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(waiting)).map(x => x.stripe_pi_id),
    ['pi_synthetic_handoff_next']
  );
  await f.restart();
  assert.deepEqual(f.srv.testHooks.queueIds(), [tip.stripe_pi_id, 'pi_synthetic_handoff_next']);
  assert.deepEqual(f.captures, []);
});

test('queued recovery stays pinned under the queue cap and honors pause and companion mode', async t => {
  const tip = capturedTip('pi_synthetic_pinned');
  const f = await fixture(t, {}, { record: { version: 1, tip }, played: [tip.stripe_pi_id] });
  for (let i = 0; i < 501; i++)
    f.srv.testHooks.kickbotEvent('tip_initiated', {
      ...kbTip('pi_synthetic_cap_' + i),
      approval_status: 'approved'
    });
  assert.equal(f.srv.testHooks.queueLength(), 500);
  assert.equal(f.srv.testHooks.queueIds()[0], tip.stripe_pi_id);
  f.srv.testHooks.kickbotEvent('queue_pause', {});
  const o = f.overlay();
  await waitFor(() => f.srv.state().overlays === 1);
  assert.deepEqual(o.plays(), []);
  f.srv.testHooks.kickbotEvent('queue_play', {});
  await waitFor(() => o.plays().length === 1);
  assert.equal(o.plays()[0].id, tip.stripe_pi_id);
  await done(f, o.plays()[0]);
  const local = parseSeActivity(activity('synthetic_companion_recovery'));
  const companion = await fixture(t, { mode: 'companion' }, { record: { version: 1, tip: local } });
  const overlay = companion.overlay();
  await waitFor(() => companion.srv.state().overlays === 1);
  assert.deepEqual(overlay.plays(), []);
  assert.equal(companion.saved().tip.stripe_pi_id, local.stripe_pi_id);
  assert.equal((await companion.request('/api/config', { mode: 'standalone' })).status, 200);
  await waitFor(() => overlay.plays().length === 1);
  await done(companion, overlay.plays()[0]);
  assert.equal(companion.saved(), null);
});

test('failed queued-recovery removal reports failure and retries before another alert can start', async t => {
  for (const endpoint of ['/api/clear-queue', '/api/disconnect-kickbot'])
    await t.test(endpoint, async t => {
      const tip = capturedTip('pi_synthetic_remove_retry');
      const f = await fixture(t, {}, { record: { version: 1, tip }, played: [tip.stripe_pi_id] });
      const before = fs.readFileSync(f.file, 'utf8');
      const rename = fs.renameSync;
      t.after(() => (fs.renameSync = rename));
      fs.renameSync = (p, ...args) => {
        if (p === f.file + '.tmp') throw new Error('synthetic removal EBUSY');
        return rename(p, ...args);
      };
      assert.equal((await f.request(endpoint)).status, 503);
      assert.equal(fs.readFileSync(f.file, 'utf8'), before);
      assert.deepEqual(f.srv.testHooks.queueIds(), []);
      f.srv.testHooks.streamElementsActivity(activity('synthetic_after_failed_remove'));
      const o = f.overlay();
      await waitFor(() => f.srv.state().overlays === 1);
      assert.deepEqual(o.plays(), []);
      fs.renameSync = rename;
      await waitFor(() => o.plays().length === 1);
      assert.equal(o.plays()[0].id, 'se_synthetic_after_failed_remove');
      await done(f, o.plays()[0]);
      await f.restart();
      assert.deepEqual(f.srv.testHooks.queueIds(), []);
    });
});
