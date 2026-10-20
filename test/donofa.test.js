// Donofa bridge: Kick subs / gift subs / KICKs and KickBot / StreamElements tips into the streamer's Donofa goal and
// timer. The fake below behaves like Donofa's API v2 did against a real account on 2026-10-20: changing a goal's
// `initial` never moves its progress, reset sets progress to `initial`, extend works on a running or paused timer only.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createDonofaBridge, readGoal, readTimer } = require('../server/donofa');
const { createServer } = require('../server/server');

const KEY = '0f3e2a10-1b2c-4d5e-8f90-a1b2c3d4e5f6';

function fakeDonofa(over = {}) {
  const d = {
    goal: {
      id: 12,
      title: 'بازی بخرم',
      unit: 'IRT',
      initial: 0,
      progress: 1000000,
      total: 100000000,
      is_active: true,
      sources: { sub: { kick: false }, donation: { irt: true } },
      ...over.goal
    },
    timer: {
      status: 'running',
      remaining: 3600,
      rates: {
        donation: { amount: 10000, seconds: 1, enabled: true },
        'sub:kick': { amount: 1, seconds: 10, enabled: false }
      },
      ...over.timer
    },
    calls: [],
    fail: {}, // "METHOD path" -> status or 'throw' / 'lost' (applied, then the answer is lost)
    key: KEY
  };
  d.request = async (method, p, body, key = d.key) => {
    d.calls.push(method + ' ' + p);
    if (key !== KEY) return { status: 401, json: { message: 'Unauthenticated.' } };
    const f = d.fail[method + ' ' + p];
    if (f === 'throw') throw new Error('timeout');
    if (typeof f === 'number') return { status: f, json: {} };
    const g = d.goal;
    let out;
    if (method === 'GET' && p === '/api/v2/goals') out = { status: 200, json: { goals: [g] } };
    else if (method === 'GET' && p === '/api/v2/goals/default') out = { status: 200, json: { goal: { ...g } } };
    else if (method === 'GET' && p === '/api/v2/timer') out = { status: 200, json: { timer: { ...d.timer } } };
    else if (method === 'POST' && p === '/api/v2/goals/' + g.id) {
      if (body && 'initial' in body) g.initial = Number(body.initial); // progress stays where it is
      out = { status: 200, json: { goal: { ...g, initial: String(g.initial) } } };
    } else if (method === 'POST' && p === '/api/v2/goals/' + g.id + '/reset') {
      g.progress = g.initial;
      out = { status: 200, json: { goal: { ...g } } };
    } else if (method === 'POST' && p === '/api/v2/timer/extend') {
      if (['running', 'paused'].includes(d.timer.status)) d.timer.remaining += body.seconds;
      out = { status: 200, json: { message: 'ok' } };
    } else out = { status: 404, json: {} };
    if (f === 'lost') throw new Error('timeout');
    return out;
  };
  return d;
}
function bridge(d, extra = {}) {
  const dir = extra.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'sahne-donofa-'));
  const logs = [];
  const b = createDonofaBridge({
    dataDir: dir,
    getKey: () => extra.key || KEY,
    getSettings: () => extra.settings || { timer: true, goal: true },
    getRate: () => (extra.rate === undefined ? 100000 : extra.rate),
    request: (...a) => d.request(...a), // late-bound: a test may swap d.request after the bridge exists
    log: (lvl, msg, x) => logs.push([lvl, msg, x]),
    WebSocket: null,
    pollMs: 3600000
  });
  return { b, dir, logs };
}
const posts = d => d.calls.filter(c => c.startsWith('POST'));

test('readGoal / readTimer keep only what the bridge and the app use', () => {
  const g = readGoal({
    id: 7,
    title: 'x',
    unit: 'irt',
    initial: '1000',
    progress: 5,
    total: 9,
    sources: { sub: { kick: true } }
  });
  assert.deepEqual([g.unit, g.initial, g.subKick, g.active], ['IRT', 1000, true, true]);
  assert.equal(readGoal(null), null);
  const t = readTimer({
    status: 'paused',
    remaining: 10,
    rates: { donation: { amount: 10000, seconds: 1 }, 'sub:kick': { enabled: true } }
  });
  assert.deepEqual(t.rate, { amount: 10000, seconds: 1 });
  assert.equal(t.subKick, true);
  assert.equal(readTimer({ rates: { donation: { amount: 0, seconds: 1 } } }).rate, null);
});

test("a tip goes to the timer at the timer's own rate and to the goal, and the goal keeps its initial", async t => {
  const d = fakeDonofa();
  const { b, dir } = bridge(d);
  t.after(() => {
    b.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(b.add({ id: 'pi_1', kind: 'tip', name: 'Ali', toman: 300000 }), true);
  assert.equal(b.add({ id: 'pi_1', kind: 'tip', name: 'Ali', toman: 300000 }), false, 'the same support never twice');
  await b.flush();
  assert.equal(d.timer.remaining, 3600 + 30, '300,000 toman at "10,000 toman = 1 s"');
  assert.equal(d.goal.progress, 1300000);
  assert.equal(d.goal.initial, 0, 'initial is put back');
  assert.equal(b._state().queue.length, 0);
  assert.equal(b._state().restore, null);
  await b.flush();
  assert.equal(d.goal.progress, 1300000, 'a second flush adds nothing');
  const st = b.publicState();
  assert.equal(st.status, 'connected');
  assert.equal(st.recent[0].seconds, 30);
  assert.equal(st.recent[0].goal, 300000);
});

test('gift subs without a fixed toman value use the USD rate; fractions of a second carry over', async t => {
  const d = fakeDonofa();
  const { b, dir } = bridge(d, { rate: 100000 });
  t.after(() => {
    b.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  b.add({ id: 'gift_a', kind: 'gift', name: 'G', usd: 4.99 * 3, count: 3 }); // 1,497,000 toman = 149.7 s
  await b.flush();
  assert.equal(d.timer.remaining, 3600 + 149);
  assert.equal(d.goal.progress, 1000000 + 1497000);
  b.add({ id: 'gift_b', kind: 'gift', name: 'G', usd: 4.99, count: 1 }); // 49.9 s + 0.7 carried = 50.6
  await b.flush();
  assert.equal(d.timer.remaining, 3600 + 149 + 50);
});

test('without a USD rate a sub waits in the queue instead of counting as zero', async t => {
  const d = fakeDonofa();
  let rate = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahne-donofa-'));
  const b = createDonofaBridge({
    dataDir: dir,
    getKey: () => KEY,
    getRate: () => rate,
    request: d.request,
    WebSocket: null,
    pollMs: 3600000
  });
  t.after(() => {
    b.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  b.add({ id: 'sub_1', kind: 'sub', name: 'S', usd: 4.99, count: 1 });
  await b.flush();
  assert.equal(d.timer.remaining, 3600);
  assert.equal(b._state().queue.length, 1, 'still waiting');
  rate = 100000;
  await b.flush();
  assert.equal(d.timer.remaining, 3600 + 49);
  assert.equal(b._state().queue.length, 0);
});

test("Kick subs are always counted by the app; Donofa's own Kick-sub switch is only reported, so the UI can ask to turn it off", async t => {
  const d = fakeDonofa({
    goal: { sources: { sub: { kick: true } } },
    timer: {
      rates: {
        donation: { amount: 10000, seconds: 1, enabled: true },
        'sub:kick': { amount: 1, seconds: 10, enabled: true }
      }
    }
  });
  const { b, dir } = bridge(d);
  t.after(() => {
    b.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  b.add({ id: 'sub_1', kind: 'sub', name: 'S', toman: 500000, count: 1 });
  b.add({ id: 'pi_1', kind: 'tip', name: 'T', toman: 100000 });
  await b.flush();
  assert.equal(d.timer.remaining, 3600 + 50 + 10, 'the sub at the timer rate, and the tip');
  assert.equal(d.goal.progress, 1000000 + 500000 + 100000, 'the sub and the tip');
  const st = b.publicState();
  assert.equal(st.goal.subKick, true, 'reported for the "turn it off on Donofa" note');
  assert.equal(st.timer.subKick, true);
  const sub = st.recent.find(r => r.kind === 'sub');
  assert.equal(sub.timerNote, null);
  assert.equal(sub.goalNote, null);
});

test('a finished timer, a disabled donation rate and the switches skip the timer without blocking the goal', async t => {
  for (const [over, settings, note] of [
    [{ timer: { status: 'finished' } }, undefined, 'no-timer'],
    [{ timer: { rates: { donation: { amount: 10000, seconds: 1, enabled: false } } } }, undefined, 'no-rate'],
    [{}, { timer: false, goal: true }, 'off']
  ]) {
    const d = fakeDonofa(over);
    const { b, dir } = bridge(d, { settings });
    b.add({ id: 'pi_x', kind: 'tip', name: 'T', toman: 100000 });
    await b.flush();
    assert.ok(!d.calls.includes('POST /api/v2/timer/extend'), note);
    assert.equal(d.goal.progress, 1100000, note + ': the goal still gets it');
    assert.equal(b.publicState().recent[0].timerNote, note);
    b.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a "piece" goal counts subs, not money', async t => {
  const d = fakeDonofa({ goal: { unit: 'piece', progress: 4, total: 100 } });
  const { b, dir } = bridge(d);
  t.after(() => {
    b.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  b.add({ id: 'gift_1', kind: 'gift', name: 'G', usd: 4.99 * 5, count: 5 });
  b.add({ id: 'sub_1', kind: 'sub', name: 'S', usd: 4.99, count: 1 });
  b.add({ id: 'pi_1', kind: 'tip', name: 'T', toman: 100000 });
  await b.flush();
  assert.equal(d.goal.progress, 4 + 6);
});

test('a failed push stays queued and is retried once, never twice', async t => {
  const d = fakeDonofa();
  const { b, dir } = bridge(d);
  t.after(() => {
    b.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  d.fail['POST /api/v2/timer/extend'] = 500;
  b.add({ id: 'pi_1', kind: 'tip', name: 'T', toman: 200000 });
  await b.flush();
  assert.equal(d.timer.remaining, 3600);
  assert.equal(d.goal.progress, 1000000, 'the goal waits for the same retry');
  assert.equal(b.publicState().status, 'error');
  delete d.fail['POST /api/v2/timer/extend'];
  await b.flush();
  assert.equal(d.timer.remaining, 3620);
  assert.equal(d.goal.progress, 1200000);
  // timer done, goal failing: the retry only does the goal
  d.fail['POST /api/v2/goals/12/reset'] = 500;
  b.add({ id: 'pi_2', kind: 'tip', name: 'T', toman: 100000 });
  await b.flush();
  assert.equal(d.timer.remaining, 3630);
  assert.equal(d.goal.progress, 1200000);
  assert.equal(d.goal.initial, 1300000, 'raised, reset failed');
  delete d.fail['POST /api/v2/goals/12/reset'];
  await b.flush();
  assert.equal(d.timer.remaining, 3630, 'the timer is not extended again');
  assert.equal(d.goal.progress, 1300000);
  assert.equal(d.goal.initial, 0);
});

test('a reset whose answer is lost is not repeated (it already happened)', async t => {
  const d = fakeDonofa();
  const { b, dir } = bridge(d);
  t.after(() => {
    b.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  d.fail['POST /api/v2/goals/12/reset'] = 'lost';
  b.add({ id: 'pi_1', kind: 'tip', name: 'T', toman: 100000 });
  await b.flush();
  delete d.fail['POST /api/v2/goals/12/reset'];
  await b.flush();
  assert.equal(d.goal.progress, 1100000, 'counted once');
  assert.equal(d.goal.initial, 0);
  assert.equal(b._state().queue.length, 0);
});

test('if putting initial back fails, the support is not added again and initial is repaired later, even after a restart', async t => {
  const d = fakeDonofa();
  const { b, dir } = bridge(d);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let raised = 0;
  const orig = d.request;
  d.request = async (m, p, body, key) => {
    if (m === 'POST' && p === '/api/v2/goals/12' && body && body.initial === 0 && raised++ === 0)
      return { status: 500, json: {} }; // the first "put back" fails
    return orig(m, p, body, key);
  };
  const b2 = createDonofaBridge({
    dataDir: dir,
    getKey: () => KEY,
    getRate: () => 100000,
    request: (...a) => d.request(...a),
    WebSocket: null,
    pollMs: 3600000
  });
  b.stop();
  b2.add({ id: 'pi_1', kind: 'tip', name: 'T', toman: 100000 });
  await b2.flush();
  assert.equal(d.goal.progress, 1100000);
  assert.equal(d.goal.initial, 1100000, 'not put back yet');
  assert.equal(b2._state().queue.length, 0, 'the support itself is done');
  b2.stop(); // "restart"
  const b3 = createDonofaBridge({
    dataDir: dir,
    getKey: () => KEY,
    request: d.request,
    WebSocket: null,
    pollMs: 3600000
  });
  await b3.flush();
  assert.equal(d.goal.initial, 0, 'repaired on the next start');
  assert.equal(d.goal.progress, 1100000);
  b3.stop();
});

test('a rejected API key shows an error and keeps the support', async t => {
  const d = fakeDonofa();
  const { b, dir } = bridge(d, { key: 'ffffffff-0000-0000-0000-00000000dead' }); // not the key Donofa knows
  t.after(() => {
    b.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  b.add({ id: 'pi_1', kind: 'tip', name: 'T', toman: 100000 });
  await b.flush();
  const st = b.publicState();
  assert.equal(st.status, 'error');
  assert.match(st.error, /API Key/);
  assert.equal(st.queue, 1);
});

test('server: setup checks the key with Donofa, keeps it out of the UI, and Kick gifts / KICKs / tips reach Donofa', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahne-test-'));
  const port = 8400 + Math.floor(Math.random() * 100);
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ port, rate: { auto: false, manual: 100000 }, kick: { enabled: false }, app: { autostart: false } })
  );
  const d = fakeDonofa();
  const srv = createServer({
    dataDir: dir,
    publicDir: path.join(__dirname, '..', 'public'),
    appVersion: 'test',
    testHooks: { offline: true },
    donofaRequest: d.request,
    donofaPollMs: 3600000
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
          let s = '';
          res.on('data', c => (s += c));
          res.on('end', () => resolve({ status: res.statusCode, body: s }));
        }
      );
      r.on('error', reject);
      if (body) r.write(JSON.stringify(body));
      r.end();
    });
  assert.equal((await req('POST', '/api/donofa/setup', { key: 'nope' })).status, 400, 'malformed key: no network call');
  assert.equal(d.calls.length, 0);
  assert.equal(
    (await req('POST', '/api/donofa/setup', { key: '11111111-2222-3333-4444-555555555555' })).status,
    400,
    'rejected by Donofa'
  );
  const ok = await req('POST', '/api/donofa/setup', { key: KEY });
  assert.equal(ok.status, 200);
  const cfg = await req('GET', '/api/config');
  assert.ok(!cfg.body.includes(KEY), 'the key never reaches the UI');
  const j = JSON.parse(cfg.body);
  assert.equal(j.config.donofa.configured, true);
  assert.deepEqual([j.config.donofa.timer, j.config.donofa.goal], [true, true]);
  const onDisk = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
  assert.ok(onDisk.includes('donofa_key'), 'stored (plain here: no OS store in tests)');

  const bridgeObj = srv.testHooks.donofa();
  srv.testHooks.kickGifts('Gifter', ['a', 'b']); // 2 × 4.99 USD × 100,000 = 998,000 toman
  srv.testHooks.kicksGifted({ id: 'k1', sender: { username: 'Kicker' }, gift: { amount: 1000 } }); // 1000 × 0.0105 × 100,000
  srv.testHooks.kicksGifted({ id: 'k1', sender: { username: 'Kicker' }, gift: { amount: 1000 } }); // echo
  await bridgeObj.flush();
  assert.equal(d.goal.progress, 1000000 + 998000 + 1050000);
  assert.equal(d.timer.remaining, 3600 + Math.floor((998000 + 1050000) / 10000));
  assert.ok(!fs.readFileSync(path.join(dir, 'donofa.json'), 'utf8').includes(KEY), 'the queue file holds no key');

  // the switch: goal off -> only the timer moves
  assert.equal((await req('POST', '/api/config', { donofa: { goal: false } })).status, 200);
  srv.testHooks.streamElementsActivity({
    _id: 'se1',
    type: 'tip',
    provider: 'kick',
    data: { username: 'Ali', amount: 2, currency: 'USD', message: '' },
    createdAt: new Date().toISOString()
  });
  await bridgeObj.flush();
  assert.equal(d.goal.progress, 1000000 + 998000 + 1050000, 'goal switched off');

  assert.equal((await req('POST', '/api/donofa/disconnect')).status, 200);
  const after = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
  assert.ok(!after.includes('donofa_key'), 'nothing stored after disconnect');
});

test('lost reset AND a failed check: the goal is settled on the next flush from its progress, never added twice', async t => {
  const d = fakeDonofa();
  const { b, dir } = bridge(d);
  t.after(() => {
    b.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  // the reset is applied but its answer is lost, and the verification GET fails too
  d.fail['POST /api/v2/goals/12/reset'] = 'lost';
  const orig = d.request;
  let gets = 0;
  d.request = async (m, p, body, key) => {
    // GETs: 1 refresh, 2 read before the change, 3 re-read before the reset, 4 the check after the lost reset
    if (m === 'GET' && p === '/api/v2/goals/default' && ++gets >= 4) {
      d.request = orig; // only this one check fails
      throw new Error('timeout');
    }
    return orig(m, p, body, key);
  };
  b.add({ id: 'pi_1', kind: 'tip', name: 'T', toman: 100000 });
  await b.flush();
  assert.equal(d.goal.progress, 1100000, 'applied on Donofa');
  assert.ok(b._state().inflight.goal, 'left as in flight');
  delete d.fail['POST /api/v2/goals/12/reset'];
  await b.flush();
  assert.equal(d.goal.progress, 1100000, 'not added a second time');
  assert.equal(d.goal.initial, 0, 'initial repaired');
  assert.equal(b._state().queue.length, 0);
  assert.equal(b._state().inflight.goal, null);
});

test('killed between the POST and the save: on restart the timer push counts as sent, the goal push is checked', async t => {
  const d = fakeDonofa();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahne-donofa-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mk = () =>
    createDonofaBridge({
      dataDir: dir,
      getKey: () => KEY,
      getRate: () => 100000,
      request: (...a) => d.request(...a),
      WebSocket: null,
      pollMs: 3600000
    });
  // simulate the kill: the extend reaches Donofa, then the process dies before anything else is written
  const b1 = mk();
  const orig = d.request;
  d.request = async (m, p, body, key) => {
    const r = await orig(m, p, body, key);
    if (m === 'POST' && p === '/api/v2/timer/extend') throw Object.assign(new Error('killed'), { killed: true });
    return r;
  };
  b1.add({ id: 'pi_1', kind: 'tip', name: 'T', toman: 100000 });
  await b1.flush().catch(() => {});
  assert.equal(d.timer.remaining, 3610, 'reached Donofa');
  const disk = JSON.parse(fs.readFileSync(path.join(dir, 'donofa.json'), 'utf8'));
  assert.ok(disk.inflight.timer, 'marker on disk');
  b1.stop();
  d.request = orig;
  const b2 = mk(); // "restart"
  await b2.flush();
  assert.equal(d.timer.remaining, 3610, 'not extended again');
  assert.equal(d.goal.progress, 1100000, 'the goal part was still pending and went once');
  assert.equal(b2.publicState().recent[0].seconds, 10);
  b2.stop();
});

test('a donation landing while initial is raised is folded into the target instead of being erased', async t => {
  const d = fakeDonofa();
  const { b, dir } = bridge(d);
  t.after(() => {
    b.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const orig = d.request;
  let raised = false;
  d.request = async (m, p, body, key) => {
    const r = await orig(m, p, body, key);
    if (m === 'POST' && p === '/api/v2/goals/12' && body && body.initial > 0 && !raised) {
      raised = true;
      d.goal.progress += 50000; // a Donofa donation arrives right now
    }
    return r;
  };
  b.add({ id: 'pi_1', kind: 'tip', name: 'T', toman: 100000 });
  await b.flush();
  assert.equal(d.goal.progress, 1000000 + 50000 + 100000, 'both kept');
  assert.equal(d.goal.initial, 0);
});

test('a reached goal is left alone (a reset would reopen it); the timer still gets the time', async t => {
  const d = fakeDonofa({ goal: { progress: 100000000, status: 'completed' } });
  const { b, dir } = bridge(d);
  t.after(() => {
    b.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  b.add({ id: 'pi_1', kind: 'tip', name: 'T', toman: 100000 });
  await b.flush();
  assert.equal(d.goal.progress, 100000000);
  assert.ok(!d.calls.includes('POST /api/v2/goals/12/reset'));
  assert.equal(d.timer.remaining, 3610);
  assert.equal(b.publicState().recent[0].goalNote, 'completed');
});

test('a push in progress finishes with the key it started with; reset() waits for it', async t => {
  const d = fakeDonofa();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahne-donofa-'));
  let key = KEY;
  const seen = [];
  let release;
  const gate = new Promise(r => (release = r));
  const b = createDonofaBridge({
    dataDir: dir,
    getKey: () => key,
    getRate: () => 100000,
    request: async (m, p, body, k) => {
      seen.push(k);
      if (m === 'POST' && p === '/api/v2/timer/extend') await gate;
      return d.request(m, p, body, k);
    },
    WebSocket: null,
    pollMs: 3600000
  });
  t.after(() => {
    b.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  b.add({ id: 'pi_1', kind: 'tip', name: 'T', toman: 100000 });
  const fl = b.flush();
  await new Promise(r => setTimeout(r, 20));
  key = 'ffffffff-0000-0000-0000-000000000000'; // the user pastes another account's key mid-push
  const rs = b.reset();
  release();
  await fl;
  await rs;
  assert.ok(seen.length > 3 && seen.slice(0, -1).every(k => k === KEY), 'every call of that push used the old key');
  assert.equal(d.goal.progress, 1100000, 'the old account got the whole push');
  assert.equal(b._state().queue.length, 0, 'and the new account starts empty');
});

test('a null frame on the Donofa socket is ignored', () => {
  const { readGoal: rg } = require('../server/donofa');
  assert.equal(rg(null), null);
  // the socket handler is exercised through a fake WebSocket class
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahne-donofa-'));
  let handler = null;
  class FakeWS {
    constructor() {
      this.readyState = 1;
      setTimeout(() => handler && handler.onmessage({ data: 'null' }), 0);
    }
    set onmessage(f) {
      this._on = f;
      handler = this;
    }
    get onmessage() {
      return this._on;
    }
    send() {}
    close() {}
  }
  const b = createDonofaBridge({
    dataDir: dir,
    getKey: () => KEY,
    request: async () => ({ status: 200, json: {} }),
    WebSocket: FakeWS,
    pollMs: 3600000
  });
  b.start();
  return new Promise(r =>
    setTimeout(() => {
      assert.doesNotThrow(() => handler.onmessage({ data: 'null' }));
      assert.doesNotThrow(() => handler.onmessage({ data: '"str"' }));
      b.stop();
      fs.rmSync(dir, { recursive: true, force: true });
      r();
    }, 30)
  );
});
