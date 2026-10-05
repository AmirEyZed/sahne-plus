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
async function fixture(t, config = {}, initial = []) {
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
      }
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
      f.saved().map(x => x.stripe_pi_id),
      ids.slice(i + 1),
      'playback removes only the active entry'
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
