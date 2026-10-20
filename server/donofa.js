// Donofa bridge. Donofa's own goal and timer widgets stay the on-stream visuals: their look, title, target and timer
// rates are set by the streamer on donofa.com and this app never draws them. Donofa only counts its own donations, so
// the bridge pushes the supports Donofa never sees (KickBot and StreamElements tips, Kick subs, gift subs and KICKs)
// into the same goal and timer through Donofa's documented API v2:
//   timer: POST /api/v2/timer/extend {seconds}, converted with the timer's own donation rate ("every N toman = S s")
//   goal:  there is no "add progress" call, but POST /api/v2/goals/{id}/reset sets progress to the goal's `initial`.
//          So `initial` is raised to progress + delta, the goal is reset, and the original `initial` is put back.
//          Changing `initial` alone never moves progress (verified against the live API on 2026-10-20).
// Each support is pushed at most once (ids persisted), failed pushes are retried and Donofa's own donations are never
// touched. Kick subs are always counted here: the app sees every sub and gift sub in Kick chat and values them with
// the streamer's own sub price, so Donofa's own "Kick sub" switch should be off. While it is on, the app says so
// (goal.subKick / timer.subKick) because Donofa may then count the same sub a second time.
//
// Why only Donofa: this needs a service whose API can ADD to its goal and timer. Donofa's API v2 can (timer/extend,
// goals/{id}, goals/{id}/reset). Reymit's public API (reymit.ir/APIs, checked 2026-10-20) is read-only: GET user,
// goal, timer and donation lists, with no call that changes them. A read-only service cannot be bridged without
// drawing our own widget instead of the streamer's, which this feature deliberately does not do.
// Zero dependencies; the HTTP call and the WebSocket class are injected so the tests run offline.
'use strict';
const fs = require('fs');
const path = require('path');

const DONOFA_WS = 'wss://ws.donofa.com/app/AF5Ed2JK?protocol=7&client=js&version=8.5.0'; // Reverb (Pusher protocol)
const QUIET_MS = 3000; // no goal push within 3 s of a Donofa donation: its reset must not overwrite that donation
const FLUSH_DELAY_MS = 1500; // supports arriving together (a gift burst) are pushed as one call
const POLL_MS = 60 * 1000; // goal / timer shown in the app
const MAX_QUEUE = 500,
  MAX_SENT = 1000,
  MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const SUB_KINDS = new Set(['sub', 'gift']);

class DonofaError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status || 0;
  }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
// the parts of Donofa's goal / timer resources the bridge uses (and the app shows)
function readGoal(g) {
  if (!g || typeof g !== 'object' || g.id == null) return null;
  const sub = g.sources && g.sources.sub;
  return {
    id: g.id,
    title: String(g.title || '').slice(0, 80),
    unit: String(g.unit || 'IRT').toUpperCase(),
    initial: num(g.initial),
    progress: num(g.progress),
    total: num(g.total),
    status: String(g.status || ''),
    active: g.is_active !== false,
    subKick: !!(sub && sub.kick) // Donofa's own Kick-sub switch: should be off, the app counts subs (see top)
  };
}
function readTimer(t) {
  if (!t || typeof t !== 'object') return null;
  const rates = t.rates || {},
    d = rates.donation || {},
    s = rates['sub:kick'] || {};
  return {
    status: String(t.status || ''),
    remaining: num(t.remaining),
    endsAt: t.ends_at || null,
    rate: num(d.amount) > 0 && num(d.seconds) > 0 ? { amount: num(d.amount), seconds: num(d.seconds) } : null,
    rateEnabled: d.enabled !== false,
    subKick: !!s.enabled // Donofa's own Kick-sub timer rate: should be off, the app counts subs (see top)
  };
}

function createDonofaBridge(o) {
  const FILE = path.join(o.dataDir, 'donofa.json');
  const now = o.now || Date.now;
  const log = o.log || (() => {});
  const changed = o.onChange || (() => {});
  const WS = o.WebSocket === undefined ? globalThis.WebSocket : o.WebSocket;
  const settings = () => ({ timer: true, goal: true, ...(o.getSettings ? o.getSettings() : {}) });
  const configured = () => !!o.getKey();

  // inflight: the POST that may have reached Donofa when the app stopped or the answer was lost. Written before each
  // POST, cleared after it is confirmed; recover() settles it on the next flush so nothing is ever pushed twice.
  const empty = () => ({
    queue: [],
    sent: [],
    carry: { timer: 0, goal: 0 },
    restore: null,
    inflight: { timer: null, goal: null },
    recent: []
  });
  const STATUS = new Set(['todo', 'done', 'off', 'no-timer', 'no-rate', 'no-goal', 'not-counted', 'completed']);
  function loadItem(x) {
    if (!x || typeof x !== 'object' || !x.id) return null;
    const toman = num(x.toman),
      usd = num(x.usd);
    if (!(toman > 0) && !(usd > 0)) return null;
    return {
      id: String(x.id).slice(0, 80),
      kind: String(x.kind || 'tip').slice(0, 10),
      name: String(x.name || '').slice(0, 80),
      toman: toman > 0 ? Math.round(toman) : null,
      usd: usd > 0 ? usd : null,
      count: Math.max(1, Math.round(num(x.count) || 1)),
      at: num(x.at) || now(),
      timer: STATUS.has(x.timer) ? x.timer : 'todo',
      goal: STATUS.has(x.goal) ? x.goal : 'todo',
      seconds: num(x.seconds) || 0, // what an in-flight push had computed, shown after a recovery
      delta: num(x.delta) || 0
    };
  }
  const ids = a => (Array.isArray(a) ? a.map(String).slice(0, MAX_QUEUE) : []);
  let st = empty();
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (j && typeof j === 'object') {
      st.queue = (Array.isArray(j.queue) ? j.queue : []).map(loadItem).filter(Boolean).slice(-MAX_QUEUE);
      st.sent = ids(j.sent).slice(-MAX_SENT);
      st.carry = { timer: num(j.carry && j.carry.timer), goal: num(j.carry && j.carry.goal) };
      st.restore = j.restore && j.restore.id != null ? { id: j.restore.id, initial: num(j.restore.initial) } : null;
      const f = j.inflight && typeof j.inflight === 'object' ? j.inflight : {};
      st.inflight = {
        timer: f.timer && typeof f.timer === 'object' ? { ids: ids(f.timer.ids), seconds: num(f.timer.seconds) } : null,
        goal:
          f.goal && typeof f.goal === 'object' && f.goal.id != null
            ? { ids: ids(f.goal.ids), id: f.goal.id, target: num(f.goal.target), delta: num(f.goal.delta) }
            : null
      };
      st.recent = Array.isArray(j.recent) ? j.recent.slice(0, 20) : [];
    }
  } catch {}
  const sent = new Set(st.sent);
  function save(force) {
    if (stopped && !force) return; // after stop() nothing is written again (clearData deletes the file right after)
    try {
      const tmp = FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ ...st, sent: [...sent].slice(-MAX_SENT) }));
      fs.renameSync(tmp, FILE);
    } catch (e) {
      log('error', 'دونوفا: ذخیره‌ی صف ناموفق بود', e.message);
    }
  }

  let goal = null,
    timer = null,
    error = null,
    checkedAt = 0,
    lastDonateAt = 0,
    flushing = false,
    again = false,
    flushT = null,
    flushP = null, // the running flush, awaited by reset() / stop() so a key change never finishes an old push
    retryMs = 0,
    stopped = false;
  let activeKey = ''; // the key a flush started with: every call of that flush uses it, even if the key changes

  async function call(method, pathname, body) {
    let r;
    try {
      r = await o.request(method, pathname, body, activeKey || o.getKey());
    } catch (e) {
      throw new DonofaError('اتصال به دونوفا ممکن نشد: ' + (e && e.message ? e.message : 'network'), 0);
    }
    if (r.status === 401 || r.status === 403)
      throw new DonofaError('دونوفا API Key را قبول نکرد؛ کلید جدید را از پنل دونوفا بگیرید', r.status);
    if (r.status === 429) throw new DonofaError('محدودیت درخواست دونوفا؛ کمی بعد دوباره تلاش می‌شود', 429);
    return r;
  }

  // ---- goal / timer read (also what the app shows) ----
  async function refresh() {
    if (stopped || !configured()) return;
    const [g, t] = await Promise.all([call('GET', '/api/v2/goals/default'), call('GET', '/api/v2/timer')]);
    goal = g.status === 200 ? readGoal(g.json && g.json.goal) : null; // 404 = the streamer has no goal
    timer = t.status === 200 ? readTimer(t.json && t.json.timer) : null;
    if (g.status >= 500 || t.status >= 500)
      throw new DonofaError('خطای سرور دونوفا (HTTP ' + Math.max(g.status, t.status) + ')', 500);
    checkedAt = now();
    if (error) {
      error = null;
      log('info', 'دونوفا دوباره در دسترس است');
    }
    changed();
  }

  // a crash between "raise initial" and "put it back" would leave the goal with a wrong initial: finish that first
  async function restoreInitial() {
    if (!st.restore) return;
    const { id, initial } = st.restore;
    const r = await call('POST', '/api/v2/goals/' + encodeURIComponent(id), { initial });
    if (r.status === 404)
      st.restore = null; // the goal was deleted meanwhile
    else if (r.status !== 200)
      throw new DonofaError('برگرداندن مقدار اولیه‌ی هدف ناموفق بود (HTTP ' + r.status + ')', r.status);
    else st.restore = null;
    save();
  }
  function markDone(list, field, value) {
    const set = new Set(list);
    for (const it of st.queue) if (set.has(it.id) && it[field] === 'todo') it[field] = value;
  }
  // A POST was written as in flight and never confirmed (app killed, answer lost). Timer: Donofa's extend cannot be
  // checked, so the supports count as sent (an under-count is the lesser evil than a double count). Goal: the reset is
  // visible in the progress, so it is read: at or past the target means it happened, otherwise the supports go again.
  async function recover() {
    const f = st.inflight;
    if (f.timer) {
      markDone(f.timer.ids, 'timer', 'done');
      log('warn', 'دونوفا: معلوم نیست آخرین افزودن زمان رسیده یا نه؛ برای اینکه دوبار حساب نشود، ارسال‌شده فرض شد', {
        seconds: f.timer.seconds,
        supports: f.timer.ids.length
      });
      f.timer = null;
      save();
    }
    if (f.goal) {
      const r = await call('GET', '/api/v2/goals/default');
      const g = r.status === 200 ? readGoal(r.json && r.json.goal) : null;
      if (r.status !== 200 && r.status !== 404)
        throw new DonofaError('خواندن هدف دونوفا ناموفق بود (HTTP ' + r.status + ')', r.status);
      const applied = !g || g.id !== f.goal.id || g.progress >= f.goal.target;
      markDone(f.goal.ids, 'goal', applied ? 'done' : 'todo');
      log(
        applied ? 'info' : 'warn',
        applied ? 'دونوفا: افزودن ناتمام به هدف انجام شده بود' : 'دونوفا: افزودن ناتمام به هدف دوباره فرستاده می‌شود',
        {
          delta: f.goal.delta,
          target: f.goal.target,
          progress: g ? g.progress : null
        }
      );
      f.goal = null;
      save();
    }
  }

  // ---- queue ----
  function add(ev) {
    if (!ev || !ev.id || !configured()) return false;
    const s = settings();
    if (!s.timer && !s.goal) return false;
    const id = String(ev.id);
    if (sent.has(id) || st.queue.some(x => x.id === id)) return false;
    const item = {
      id,
      kind: String(ev.kind || 'tip'),
      name: String(ev.name || '').slice(0, 80),
      toman: num(ev.toman) > 0 ? Math.round(num(ev.toman)) : null,
      usd: num(ev.usd) > 0 ? num(ev.usd) : null,
      count: Math.max(1, Math.round(num(ev.count) || 1)),
      at: now(),
      timer: 'todo',
      goal: 'todo'
    };
    if (item.toman == null && item.usd == null) return false; // no value at all
    st.queue.push(item);
    if (st.queue.length > MAX_QUEUE) st.queue.splice(0, st.queue.length - MAX_QUEUE);
    save();
    schedule(FLUSH_DELAY_MS);
    changed();
    return true;
  }
  function tomanOf(item) {
    if (item.toman != null) return item.toman;
    const rate = num(o.getRate && o.getRate());
    return item.usd != null && rate > 0 ? Math.round(item.usd * rate) : null; // null: wait for the USD rate
  }
  function schedule(ms) {
    if (stopped) return;
    clearTimeout(flushT);
    flushT = setTimeout(flush, ms);
  }

  async function flush() {
    if (stopped) return;
    if (flushing) {
      again = true;
      return;
    }
    flushing = true;
    activeKey = o.getKey();
    let wait = 0;
    let done;
    flushP = new Promise(r => (done = r));
    try {
      if (!configured()) return;
      await recover();
      await restoreInitial();
      const cutoff = now() - MAX_AGE_MS;
      st.queue = st.queue.filter(x => x.at >= cutoff);
      if (!st.queue.length) return;
      const quiet = lastDonateAt + QUIET_MS - now();
      if (quiet > 0) {
        wait = quiet + 100;
        return;
      }
      await refresh();
      await pushTimer();
      await pushGoal();
      settle();
      retryMs = 0;
      if (st.queue.length && st.queue.some(x => x.timer === 'todo' || x.goal === 'todo')) wait = 30000; // waiting for a rate
    } catch (e) {
      error = e.message;
      retryMs = Math.min(5 * 60 * 1000, retryMs ? retryMs * 2 : 15000);
      wait = retryMs;
      log('warn', 'دونوفا: ارسال ناموفق بود، دوباره تلاش می‌شود', { error: e.message, retryInSec: retryMs / 1000 });
    } finally {
      save();
      flushing = false;
      activeKey = '';
      done();
      changed();
      if (again) {
        again = false;
        schedule(300);
      } else if (wait) schedule(wait);
    }
  }

  async function pushTimer() {
    const s = settings(),
      t = timer;
    let total = 0;
    const take = [];
    for (const it of st.queue) {
      if (it.timer !== 'todo') continue;
      if (!s.timer) it.timer = 'off';
      else if (!t || !['running', 'paused'].includes(t.status))
        it.timer = 'no-timer'; // finished/none: extend has no effect
      else if (!t.rate || !t.rateEnabled) it.timer = 'no-rate';
      else {
        const toman = tomanOf(it);
        if (toman == null) continue;
        it.seconds = (toman * t.rate.seconds) / t.rate.amount;
        total += it.seconds;
        take.push(it);
      }
    }
    if (!take.length) return;
    const sum = total + st.carry.timer,
      whole = Math.floor(sum);
    if (whole >= 1) {
      st.inflight.timer = { ids: take.map(it => it.id), seconds: whole };
      save(); // if the app dies now, recover() counts these as sent rather than sending them twice
      // a thrown call (timeout, connection reset) may or may not have reached Donofa: the marker stays, never resent
      const r = await call('POST', '/api/v2/timer/extend', { seconds: whole });
      st.inflight.timer = null; // Donofa answered: an error status means it did not apply the change, so try again later
      if (r.status !== 200)
        throw new DonofaError('افزودن زمان به تایمر دونوفا ناموفق بود (HTTP ' + r.status + ')', r.status);
      if (timer) timer.remaining += whole;
      log('info', 'دونوفا: زمان به تایمر اضافه شد', { seconds: whole, supports: take.length });
    }
    st.carry.timer = sum - whole; // a fraction of a second is kept for the next support
    for (const it of take) it.timer = 'done';
  }

  async function pushGoal() {
    const s = settings(),
      g = goal;
    let total = 0;
    const take = [];
    for (const it of st.queue) {
      if (it.goal !== 'todo') continue;
      if (!s.goal) it.goal = 'off';
      else if (!g || !g.active) it.goal = 'no-goal';
      else if (g.status === 'completed' || (g.total > 0 && g.progress >= g.total))
        it.goal = 'completed'; // a reset would set a reached goal back to "pending": leave it be
      else if (g.unit === 'PIECE') {
        if (!SUB_KINDS.has(it.kind))
          it.goal = 'not-counted'; // a "piece" goal counts subs, not money
        else {
          it.delta = it.count;
          total += it.delta;
          take.push(it);
        }
      } else {
        const toman = tomanOf(it);
        if (toman == null) continue;
        const rate = num(o.getRate && o.getRate());
        if (g.unit === 'USD') {
          if (it.usd == null && !(rate > 0)) continue;
          it.delta = it.usd != null ? it.usd : toman / rate;
        } else it.delta = toman;
        total += it.delta;
        take.push(it);
      }
    }
    if (!take.length) return;
    const sum = total + st.carry.goal,
      whole = Math.floor(sum);
    if (whole >= 1) await addToGoal(whole, take);
    st.carry.goal = sum - whole;
    for (const it of take) it.goal = 'done';
  }

  // progress += delta, as described at the top. The goal is read right before the change and once more right before
  // the reset, so a Donofa donation that lands while `initial` is being raised is folded into the target; the one
  // remaining window is the reset request itself.
  async function addToGoal(delta, take) {
    const readDefault = async () => {
      const r = await call('GET', '/api/v2/goals/default');
      const g = r.status === 200 ? readGoal(r.json && r.json.goal) : null;
      if (!g) throw new DonofaError('هدف دونوفا پیدا نشد (HTTP ' + r.status + ')', r.status);
      return g;
    };
    const g = await readDefault();
    if (goal && g.id !== goal.id) goal = g; // the default goal changed: the new one gets it
    const gid = encodeURIComponent(g.id);
    const setInitial = async v => {
      const r = await call('POST', '/api/v2/goals/' + gid, { initial: v });
      if (r.status !== 200) throw new DonofaError('تغییر هدف دونوفا ناموفق بود (HTTP ' + r.status + ')', r.status);
    };
    let target = Math.round(g.progress + delta);
    st.restore = { id: g.id, initial: g.initial };
    st.inflight.goal = { ids: take.map(it => it.id), id: g.id, target, delta };
    save(); // before the change: a crash in the next calls is repaired (restore) and settled (recover) on the next start
    await setInitial(target);
    const fresh = await readDefault(); // a Donofa donation may have landed meanwhile: do not let the reset erase it
    if (fresh.id === g.id && fresh.progress !== g.progress) {
      target = Math.round(fresh.progress + delta);
      st.inflight.goal.target = target;
      save();
      await setInitial(target);
    }
    let after = null;
    try {
      const r2 = await call('POST', '/api/v2/goals/' + gid + '/reset');
      if (r2.status !== 200)
        throw new DonofaError('به‌روزرسانی پیشرفت هدف ناموفق بود (HTTP ' + r2.status + ')', r2.status);
      after = readGoal(r2.json && r2.json.goal);
    } catch (e) {
      // the answer was lost but the reset may have happened: look first; if even that fails, inflight.goal stays
      // written and recover() settles it on the next flush (at or past the target = done), never a second add
      const chk = await call('GET', '/api/v2/goals/default').catch(() => null);
      const now2 = chk && chk.status === 200 ? readGoal(chk.json && chk.json.goal) : null;
      if (!now2 || now2.id !== g.id || now2.progress < target) throw e;
      after = now2;
    }
    st.inflight.goal = null;
    // from here the delta is on the goal: a failure to put `initial` back must not make the caller add it again
    try {
      await restoreInitial();
    } catch (e) {
      log('warn', 'دونوفا: برگرداندن مقدار اولیه‌ی هدف بعداً دوباره تلاش می‌شود', e.message);
    }
    goal = after ? { ...after, initial: g.initial } : { ...g, progress: target };
    if (after && after.progress !== target)
      log('warn', 'دونوفا: پیشرفت هدف با مقدار مورد انتظار نمی‌خواند', { expected: target, got: after.progress });
    log('info', 'دونوفا: به هدف اضافه شد', { delta, progress: goal.progress, total: goal.total });
  }

  function settle() {
    const keep = [];
    for (const it of st.queue) {
      if (it.timer === 'todo' || it.goal === 'todo') {
        keep.push(it);
        continue;
      }
      sent.add(it.id);
      st.recent.unshift({
        name: it.name,
        kind: it.kind,
        toman: tomanOf(it),
        seconds: it.timer === 'done' ? Math.round(it.seconds || 0) : 0,
        goal: it.goal === 'done' ? it.delta || 0 : 0,
        timerNote: it.timer === 'done' ? null : it.timer,
        goalNote: it.goal === 'done' ? null : it.goal,
        at: now()
      });
    }
    st.queue = keep;
    st.recent = st.recent.slice(0, 20);
  }

  // ---- Donofa's realtime channel: live goal/timer numbers for the app, and the time of each Donofa donation ----
  let ws = null,
    wsUp = false,
    wsRetry = 5000,
    wsT = null,
    pingT = null;
  function connect() {
    if (stopped || !configured() || typeof WS !== 'function') return;
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    let sock;
    try {
      sock = new WS(DONOFA_WS);
    } catch {
      return;
    }
    ws = sock;
    sock.onmessage = ev => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!m || typeof m !== 'object') return;
      const name = String(m.event || '').replace(/^\./, '');
      if (name === 'pusher:connection_established') {
        // the channel name contains the API key: it is sent to Donofa only, never logged
        sock.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'user.' + o.getKey() } }));
        wsUp = true;
        wsRetry = 5000;
        clearInterval(pingT);
        pingT = setInterval(() => {
          try {
            sock.send(JSON.stringify({ event: 'pusher:ping', data: {} }));
          } catch {}
        }, 60000);
        changed();
        return;
      }
      if (name === 'pusher:ping') {
        try {
          sock.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
        } catch {}
        return;
      }
      let d = m.data;
      try {
        if (typeof d === 'string') d = JSON.parse(d);
      } catch {
        d = null;
      }
      if (name === 'donate.created') {
        lastDonateAt = now();
        if (st.queue.length) schedule(QUIET_MS + 200);
        setTimeout(() => refresh().catch(() => {}), 2500); // Donofa's own donation moved its goal / timer
      } else if (name === 'goal.updated' || name === 'goal.completed') {
        const g = readGoal(d && (d.goal || d));
        if (g && (!goal || g.id === goal.id)) {
          goal = g;
          changed();
        }
      } else if (name === 'timer.updated') {
        const t = readTimer(d && (d.timer || d));
        if (t) {
          timer = t;
          changed();
        }
      }
    };
    sock.onerror = () => {};
    sock.onclose = () => {
      clearInterval(pingT);
      if (ws === sock) ws = null;
      wsUp = false;
      changed();
      if (!stopped && configured()) {
        clearTimeout(wsT);
        wsT = setTimeout(connect, wsRetry);
        wsRetry = Math.min(60000, wsRetry * 2);
      }
    };
  }
  function closeWs() {
    clearTimeout(wsT);
    clearInterval(pingT);
    wsUp = false;
    if (ws) {
      try {
        ws.close();
      } catch {}
      ws = null;
    }
  }
  const pollT = setInterval(() => {
    if (stopped || !configured()) return;
    if (st.queue.length || st.restore || st.inflight.timer || st.inflight.goal) flush();
    else
      refresh().catch(e => {
        error = e.message;
        changed();
      });
    if (!ws) connect();
  }, o.pollMs || POLL_MS);

  const refreshSafe = () =>
    refresh().catch(e => {
      error = e.message;
      changed();
    });
  return {
    add,
    flush,
    refresh: refreshSafe,
    start() {
      if (!configured()) return;
      connect();
      flush().then(() => (checkedAt ? null : refreshSafe()));
    },
    // the key changed or was removed: the old account's numbers and pending supports no longer apply. Called before
    // the old key is dropped, so a pending `initial` repair still reaches the old account.
    async reset() {
      closeWs();
      clearTimeout(flushT);
      if (flushP) await flushP; // a push in progress finishes against the old account first
      try {
        await recover();
        await restoreInitial();
      } catch {}
      goal = timer = error = null;
      checkedAt = 0;
      st = empty();
      sent.clear();
      save();
      changed();
    },
    stop() {
      stopped = true; // a flush still running keeps its in-flight marker on disk; recover() settles it next start
      clearInterval(pollT);
      clearTimeout(flushT);
      closeWs();
      save();
    },
    publicState() {
      const s = settings();
      return {
        configured: configured(),
        status: !configured() ? 'unconfigured' : error ? 'error' : checkedAt ? 'connected' : 'connecting',
        error,
        live: wsUp,
        timerOn: s.timer,
        goalOn: s.goal,
        goal: goal && {
          title: goal.title,
          unit: goal.unit,
          progress: goal.progress,
          total: goal.total,
          active: goal.active,
          subKick: goal.subKick
        },
        timer: timer && {
          status: timer.status,
          remaining: timer.remaining,
          endsAt: timer.endsAt,
          rate: timer.rate,
          rateEnabled: timer.rateEnabled,
          subKick: timer.subKick
        },
        queue: st.queue.length,
        recent: st.recent.slice(0, 8)
      };
    },
    _state: () => st // tests
  };
}

module.exports = { createDonofaBridge, readGoal, readTimer, DONOFA_WS };
