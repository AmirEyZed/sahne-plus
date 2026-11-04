'use strict';
// Synthetic fixtures and loopback only; provider transports are disabled by testHooks.offline.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { createServer } = require('../server/server');
const activity = (id, extra = {}) => ({
  _id: id,
  type: 'tip',
  createdAt: '2026-10-03T00:00:00.000Z',
  data: { displayName: 'Synthetic viewer', message: 'Synthetic message', amount: 12.34, currency: 'EUR' },
  ...extra
});
const kbTip = id => ({ stripe_pi_id: id, tipper_name: 'Synthetic donor', amount_total: 500, tip_message: 'fixture' });
const waitFor = async check => {
  for (const end = Date.now() + 3000; Date.now() < end; await new Promise(r => setTimeout(r, 10))) if (check()) return;
  assert.fail('timed out waiting for the loopback overlay');
};
async function fixture(t, config = {}, initial = [], serverOpts = {}) {
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
  const file = path.join(dir, 'captured.json');
  if (initial.length) fs.writeFileSync(file, JSON.stringify(initial));
  let srv;
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
        captureTip: async tip => {
          captures.push(tip.stripe_pi_id);
          return 'ok';
        },
        onPublish: (type, payload) => published.push(type + ':' + payload.stripe_pi_id)
      },
      ...serverOpts
    });
    await srv.start();
  };
  t.after(async () => {
    overlays.forEach(o => o.req.destroy());
    if (srv) await srv.stop();
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
    port,
    file,
    captures,
    published,
    request,
    overlay,
    saved: () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []),
    restart: async beforeBoot => {
      overlays.forEach(o => o.req.destroy());
      await srv.stop();
      if (beforeBoot) beforeBoot();
      await boot();
    }
  };
}

test('real provider alerts restore mixed FIFO order and metadata without KickBot capture or local publishes', async t => {
  const files = ['newsub', 'giftsub'].map(keyword => ({
    id: 'synthetic_' + keyword,
    file: keyword + '.wav',
    name: 'Synthetic ' + keyword,
    type: 'audio',
    keywords: [keyword],
    enabled: true,
    minAmount: 0
  }));
  const f = await fixture(t, { files }, [kbTip('pi_synthetic_legacy')]);
  for (const media of files) fs.writeFileSync(path.join(f.srv.mediaDir, media.file), Buffer.from('RIFFsynthetic'));

  f.srv.testHooks.streamElementsActivity(activity('synthetic_tip'));
  f.srv.testHooks.kickSubscription('Synthetic subscriber', 3);
  f.srv.testHooks.kickGifts('Synthetic gifter', ['Synthetic recipient A', 'Synthetic recipient B']);
  const saved = f.saved();
  const ids = saved.map(x => x.stripe_pi_id);
  assert.equal(ids.length, 4);
  assert.equal(saved[1].currency, 'EUR');
  assert.equal(saved[1].amount_total, 1234);
  assert.equal(saved[1].created_at, activity('').createdAt);
  assert.equal(saved[2].toman_override, 250000);
  assert.equal(saved[3].toman_override, 600000);
  await f.restart();
  assert.deepEqual(f.srv.testHooks.queueIds(), ids);
  f.srv.testHooks.streamElementsActivity(activity('synthetic_tip'));
  f.srv.testHooks.kickbotSync([]);
  assert.deepEqual(f.srv.testHooks.queueIds(), ids, 'sync and duplicate SE delivery retain one copy in order');
  f.srv.testHooks.kickbotEvent('tip_queue_config_updated', { queue_delay: 0 });
  const overlay = f.overlay();
  for (let i = 0; i < ids.length; i++) {
    await waitFor(() => overlay.plays().length === i + 1);
    assert.deepEqual(
      f.saved().map(x => [x.stripe_pi_id, !!x.active]),
      ids.slice(i).map((id, j) => [id, j === 0]),
      'the playing alert stays first, marked active, until it ends'
    );
    assert.equal((await f.request('/api/done', { id: ids[i] })).status, 200);
  }
  const plays = overlay.plays();
  assert.deepEqual(
    plays.map(x => x.id),
    ids
  );
  assert.equal(plays[1].currency, 'EUR');
  assert.equal(plays[1].amount, 12.34);
  assert.equal(plays[1].message, 'Synthetic message');
  assert.deepEqual(
    plays.slice(2).map(x => [x.kind, x.count, x.toman]),
    [
      ['sub', 3, 250000],
      ['gift', 2, 600000]
    ]
  );
  assert.deepEqual(
    plays.slice(2).map(x => x.media.name),
    files.map(x => x.name),
    'restored tags still select subscription media'
  );
  assert.deepEqual(f.captures, [], 'legacy captured donation is not captured twice; local alerts are never captured');
  assert.deepEqual(f.published, ['tip_play:' + ids[0], 'tip_end:' + ids[0]]);
  assert.equal(fs.existsSync(f.file), false);
  await f.restart();
  assert.deepEqual(f.srv.testHooks.queueIds(), [], 'completed alerts do not return');
  f.srv.testHooks.streamElementsActivity(activity('synthetic_tip'));
  assert.deepEqual(f.srv.testHooks.queueIds(), [], 'played SE id remains deduplicated after restart');
});

test('mock and app test alerts, pending and uncaptured donations never enter the snapshot', async t => {
  const f = await fixture(t);
  for (const mock of [
    { isMock: true },
    { mock: true },
    { test: true },
    { data: { ...activity('').data, isMock: true } }
  ])
    f.srv.testHooks.streamElementsActivity(activity('mock_' + f.srv.testHooks.queueLength(), mock));
  assert.equal((await f.request('/api/test-sub', { kind: 'sub' })).status, 200);
  assert.equal((await f.request('/api/test-sub', { kind: 'gift', count: 2 })).status, 200);
  assert.equal((await f.request('/api/test')).status, 200);
  f.srv.testHooks.kickbotEvent('tip_pending', kbTip('pi_synthetic_pending'));
  f.srv.testHooks.kickbotEvent('tip_approved', kbTip('pi_synthetic_uncaptured'));
  f.srv.testHooks.streamElementsActivity(activity('synthetic_real'));
  assert.deepEqual(
    f.saved().map(x => x.stripe_pi_id),
    ['se_synthetic_real']
  );
  await f.restart();
  assert.deepEqual(f.srv.testHooks.queueIds(), ['se_synthetic_real']);
});

test('restore rejects invalid, duplicate, played and test entries and keeps only bounded local fields', async t => {
  const local = {
    stripe_pi_id: 'se_synthetic_valid',
    is_local: true,
    source: 'streamelements',
    kind: 'tip',
    amount_total: 1234,
    currency: 'EUR',
    tipper_name: 'x'.repeat(200),
    tip_message: 'm'.repeat(800),
    created_at: '2026-10-03T00:00:00Z',
    authorization: 'synthetic-do-not-store',
    captured: true,
    gif_url: 'https://example.invalid/fixture.gif',
    tags: ['unexpected'],
    toman_override: 999
  };
  const f = await fixture(t, {}, [
    local,
    local,
    null,
    [],
    'invalid',
    { ...local, stripe_pi_id: 'invalid' },
    { ...local, stripe_pi_id: 'se_synthetic_test', is_test: true },
    { ...local, stripe_pi_id: 'se_synthetic_foreign', source: 'unknown' },
    { ...local, stripe_pi_id: 'se_synthetic_nonlocal', is_local: false }
  ]);
  assert.deepEqual(f.srv.testHooks.queueIds(), [local.stripe_pi_id]);
  const saved = f.saved()[0];
  assert.equal(saved.tipper_name.length, 80);
  assert.equal(saved.tip_message.length, 500);
  assert.equal(saved.is_local, true);
  assert.equal(saved.captured, undefined);
  assert.equal(saved.authorization, undefined);
  assert.equal(saved.gif_url, undefined);
  assert.deepEqual(saved.tags, []);
  assert.equal(saved.toman_override, null);
  await f.restart(() => fs.writeFileSync(path.join(f.dir, 'played.json'), JSON.stringify([local.stripe_pi_id])));
  assert.deepEqual(f.srv.testHooks.queueIds(), []);
  assert.equal(fs.existsSync(f.file), false);
});

test('snapshot failures preserve the prior file and retry; same-id content changes are saved', async t => {
  const f = await fixture(t);
  f.srv.testHooks.streamElementsActivity(activity('synthetic_first'));
  const before = fs.readFileSync(f.file, 'utf8');
  const rename = fs.renameSync,
    write = fs.writeFileSync,
    rm = fs.rmSync;
  t.after(() => {
    fs.renameSync = rename;
    fs.writeFileSync = write;
    fs.rmSync = rm;
  });
  for (const operation of ['write', 'rename']) {
    fs.writeFileSync = (p, ...args) => {
      if (operation === 'write' && p === f.file + '.tmp') throw new Error('synthetic write failure');
      return write(p, ...args);
    };
    fs.renameSync = (p, ...args) => {
      if (operation === 'rename' && p === f.file + '.tmp') throw new Error('synthetic rename failure');
      return rename(p, ...args);
    };
    f.srv.testHooks.streamElementsActivity(activity('synthetic_' + operation));
    assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  }
  fs.writeFileSync = write;
  fs.renameSync = rename;
  f.srv.testHooks.kickbotEvent('queue_pause', {});
  assert.equal(f.saved().length, 3, 'failed writes did not update the successful-save cache');
  const tip = { ...kbTip('pi_synthetic_mutable'), captured: true };
  f.srv.testHooks.injectTip(tip);
  f.srv.testHooks.kickbotEvent('queue_pause', {});
  tip.tip_message = 'Synthetic updated message';
  f.srv.testHooks.kickbotEvent('queue_pause', {});
  assert.equal(f.saved().at(-1).tip_message, tip.tip_message);
  fs.rmSync = (p, ...args) => {
    if (p === f.file) throw new Error('synthetic removal failure');
    return rm(p, ...args);
  };
  await f.request('/api/clear-queue');
  assert.equal(fs.existsSync(f.file), true);
  fs.rmSync = rm;
  f.srv.testHooks.kickbotEvent('queue_pause', {});
  assert.equal(fs.existsSync(f.file), false, 'failed removal retries on the next state update');
});

test('provider disconnects, queue clear and application-data deletion remove the appropriate saved alerts', async t => {
  const f = await fixture(t, {}, [kbTip('pi_synthetic_disconnect')]);
  f.srv.testHooks.streamElementsActivity(activity('synthetic_disconnect'));
  f.srv.testHooks.kickSubscription('Synthetic retained subscriber', 1);
  const sub = f.saved().at(-1).stripe_pi_id;
  await f.request('/api/disconnect-kickbot');
  assert.deepEqual(
    f.saved().map(x => x.stripe_pi_id),
    ['se_synthetic_disconnect', sub]
  );
  await f.restart();
  await f.request('/api/se/disconnect');
  assert.deepEqual(
    f.saved().map(x => x.stripe_pi_id),
    [sub]
  );
  await f.restart();
  assert.deepEqual(f.srv.testHooks.queueIds(), [sub]);
  await f.request('/api/clear-queue');
  await f.restart();
  assert.deepEqual(f.srv.testHooks.queueIds(), []);
  f.srv.testHooks.streamElementsActivity(activity('synthetic_wipe'));
  fs.writeFileSync(f.file + '.tmp', 'synthetic temporary snapshot');
  f.srv.clearData();
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(fs.existsSync(f.file + '.tmp'), false);
  f.srv.testHooks.streamElementsActivity(activity('synthetic_after_wipe'));
  assert.equal(fs.existsSync(f.file), false, 'late events cannot recreate the snapshot after stop');
});

test('only the first 500 eligible waiting alerts are retained; companion alerts are immediate', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 501; i++) f.srv.testHooks.streamElementsActivity(activity('synthetic_limit_' + i));
  assert.equal(f.srv.testHooks.queueLength(), 501);
  assert.equal(f.saved().length, 500);
  assert.equal(f.saved()[0].stripe_pi_id, 'se_synthetic_limit_0');
  assert.equal(f.saved().at(-1).stripe_pi_id, 'se_synthetic_limit_499');
  await f.restart();
  assert.equal(f.srv.testHooks.queueLength(), 500);
  const companion = await fixture(t, { mode: 'companion' });
  companion.srv.testHooks.streamElementsActivity(activity('synthetic_companion'));
  companion.srv.testHooks.kickSubscription('Synthetic immediate subscriber', 1);
  assert.deepEqual(companion.srv.testHooks.queueIds(), []);
  assert.equal(fs.existsSync(companion.file), false);
});

test('an alert on screen when the app closes plays again from the start after a restart, once and without a second capture', async t => {
  const f = await fixture(t);
  f.srv.testHooks.setQueueDelay(0);
  const first = f.overlay();
  f.srv.testHooks.injectTip({ ...kbTip('pi_synthetic_interrupted'), captured: true });
  f.srv.testHooks.streamElementsActivity(activity('synthetic_behind'));
  await waitFor(() => first.plays().length === 1);
  assert.deepEqual(
    f.saved().map(x => [x.stripe_pi_id, !!x.active]),
    [
      ['pi_synthetic_interrupted', true],
      ['se_synthetic_behind', false]
    ],
    'the alert on screen is written first, marked active, ahead of the waiting one'
  );

  // closed mid-alert: no /api/done, so the id is in played.json but the alert never finished
  await f.restart();
  assert.equal(f.srv.testHooks.isPlayed('pi_synthetic_interrupted'), true);
  assert.deepEqual(f.srv.testHooks.queueIds(), ['pi_synthetic_interrupted', 'se_synthetic_behind']);
  f.srv.testHooks.kickbotSync([{ ...kbTip('pi_synthetic_interrupted'), approval_status: 'approved' }]);
  f.srv.testHooks.kickbotEvent('tip_approved', kbTip('pi_synthetic_interrupted'));
  assert.deepEqual(
    f.srv.testHooks.queueIds(),
    ['pi_synthetic_interrupted', 'se_synthetic_behind'],
    'KickBot listing the tip again adds no second copy'
  );

  // a second restart before it plays keeps it recoverable
  await f.restart();
  assert.equal(f.saved()[0].active, true);
  assert.deepEqual(f.srv.testHooks.queueIds(), ['pi_synthetic_interrupted', 'se_synthetic_behind']);

  f.srv.testHooks.setQueueDelay(0);
  const second = f.overlay();
  await waitFor(() => second.plays().length === 1);
  assert.equal(second.plays()[0].id, 'pi_synthetic_interrupted');
  assert.equal((await f.request('/api/done', { id: 'pi_synthetic_interrupted' })).status, 200);
  await waitFor(() => second.plays().length === 2);
  assert.deepEqual(
    f.saved().map(x => [x.stripe_pi_id, !!x.active]),
    [['se_synthetic_behind', true]],
    'a finished alert leaves the snapshot'
  );
  assert.equal((await f.request('/api/done', { id: 'se_synthetic_behind' })).status, 200);
  assert.equal(fs.existsSync(f.file), false);
  assert.deepEqual(f.captures, [], 'the captured payment is never captured again');
  assert.deepEqual(
    f.published.filter(p => p.startsWith('tip_play:')),
    ['tip_play:pi_synthetic_interrupted', 'tip_play:pi_synthetic_interrupted'],
    'one tip_play per display'
  );
  await f.restart();
  assert.deepEqual(f.srv.testHooks.queueIds(), [], 'finished alerts do not return');
});

test('a replayed interrupted alert counts once toward Donofa and in Analytics', async t => {
  // Donofa is never reached: the stubbed API fails, so the support stays queued in donofa.json across the restart
  const f = await fixture(t, { donofa_key: '00000000-0000-4000-8000-00000000c0de' }, [], {
    donofaRequest: async () => {
      throw new Error('synthetic offline Donofa');
    },
    donofaPollMs: 3600000
  });
  f.srv.testHooks.setQueueDelay(0);
  const first = f.overlay();
  f.srv.testHooks.injectTip({ ...kbTip('pi_synthetic_counted'), captured: true });
  await waitFor(() => first.plays().length === 1);
  await f.restart(); // closed mid-alert
  f.srv.testHooks.setQueueDelay(0);
  const second = f.overlay();
  await waitFor(() => second.plays().length === 1);
  assert.equal(second.plays()[0].id, 'pi_synthetic_counted', 'the interrupted alert played again');
  assert.equal((await f.request('/api/done', { id: 'pi_synthetic_counted' })).status, 200);

  const bridge = JSON.parse(fs.readFileSync(path.join(f.dir, 'donofa.json'), 'utf8'));
  const supports = [...bridge.queue.map(x => x.id), ...bridge.sent].filter(id => id === 'pi_synthetic_counted');
  assert.equal(supports.length, 1, 'one Donofa support for two displays');

  const analytics = await new Promise((resolve, reject) =>
    http
      .get({ host: '127.0.0.1', port: f.port, path: '/api/analytics?range=today', agent: false }, res => {
        let text = '';
        res.on('data', chunk => (text += chunk));
        res.on('end', () => resolve(JSON.parse(text)));
      })
      .on('error', reject)
  );
  assert.equal(analytics.totals.count, 1, 'one donation in Analytics for two displays');
  assert.equal(analytics.totals.amountUsd, 5);
});

test('skip, rejection and a suppressed alert without media end the active entry like /api/done', async t => {
  const f = await fixture(t);
  f.srv.testHooks.setQueueDelay(0);
  const o = f.overlay();
  f.srv.testHooks.injectTip({ ...kbTip('pi_synthetic_skipped'), captured: true });
  await waitFor(() => o.plays().length === 1);
  assert.equal(f.saved()[0].active, true);
  assert.equal((await f.request('/api/skip')).status, 200);
  assert.equal(fs.existsSync(f.file), false, 'skip');

  f.srv.testHooks.injectTip({ ...kbTip('pi_synthetic_rejected'), captured: true });
  await waitFor(() => o.plays().length === 2);
  assert.equal(f.saved()[0].active, true);
  f.srv.testHooks.kickbotEvent('tip_rejected', kbTip('pi_synthetic_rejected'));
  assert.equal(fs.existsSync(f.file), false, 'rejection');

  assert.equal((await f.request('/api/config', { showAlertWithoutMedia: false })).status, 200);
  f.srv.testHooks.streamElementsActivity(activity('synthetic_no_media'));
  await waitFor(() => f.srv.testHooks.isPlayed('se_synthetic_no_media'));
  assert.equal(fs.existsSync(f.file), false, 'an alert that is not shown is not kept');
  await f.restart();
  assert.deepEqual(f.srv.testHooks.queueIds(), []);
});

test('a snapshot that cannot be written never blocks playback', async t => {
  const f = await fixture(t);
  f.srv.testHooks.setQueueDelay(0);
  const write = fs.writeFileSync;
  t.after(() => (fs.writeFileSync = write));
  fs.writeFileSync = (p, ...args) => {
    if (p === f.file + '.tmp') throw new Error('synthetic full disk');
    return write(p, ...args);
  };
  const o = f.overlay();
  f.srv.testHooks.streamElementsActivity(activity('synthetic_unsaved_1'));
  f.srv.testHooks.streamElementsActivity(activity('synthetic_unsaved_2'));
  await waitFor(() => o.plays().length === 1);
  assert.equal((await f.request('/api/done', { id: 'se_synthetic_unsaved_1' })).status, 200);
  await waitFor(() => o.plays().length === 2);
  assert.equal((await f.request('/api/done', { id: 'se_synthetic_unsaved_2' })).status, 200);
  assert.deepEqual(
    o.plays().map(x => x.id),
    ['se_synthetic_unsaved_1', 'se_synthetic_unsaved_2']
  );
  assert.equal(fs.existsSync(f.file), false, 'nothing was written, and nothing stopped');
});
