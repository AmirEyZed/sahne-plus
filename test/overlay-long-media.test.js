// Unit test: a video longer than «حداکثر مدت» plays to its end in the Browser Source, and its length is reported to the
// server (/api/extend) so the queue does not move on while it plays. Runs public/overlay.js in a minimal fake DOM
// (as overlay-xss.test.js), here as the real Browser Source (not the preview), with real timers kept short.
'use strict';
const fs = require('fs'),
  path = require('path'),
  vm = require('vm'),
  assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'overlay.js'), 'utf8');

function el(tag) {
  const e = {
    tagName: tag.toUpperCase(),
    children: [],
    style: {},
    _cls: new Set(),
    _html: '',
    _src: null,
    listeners: {},
    get className() {
      return [...this._cls].join(' ');
    },
    set className(v) {
      this._cls = new Set(String(v).split(/\s+/).filter(Boolean));
    },
    classList: { add: c => e._cls.add(c), remove: c => e._cls.delete(c), contains: c => e._cls.has(c) },
    get innerHTML() {
      return this._html;
    },
    set innerHTML(v) {
      this._html = String(v);
    },
    get src() {
      return this._src;
    },
    set src(v) {
      this._src = String(v);
    },
    appendChild(c) {
      this.children.push(c);
      c.parent = this;
      return c;
    },
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this);
    },
    addEventListener(t, f) {
      (this.listeners[t] = this.listeners[t] || []).push(f);
    },
    fire(t) {
      (this.listeners[t] || []).forEach(f => f({}));
    },
    setPointerCapture() {},
    querySelector(sel) {
      const want = sel.replace('.', '');
      const walk = n => {
        for (const c of n.children) {
          if (c._cls.has(want)) return c;
          const r = walk(c);
          if (r) return r;
        }
        return null;
      };
      return walk(this);
    },
    animate() {
      const a = {};
      setTimeout(() => a.onfinish && a.onfinish(), 0);
      return a;
    },
    play() {
      return Promise.resolve();
    },
    pause() {},
    getContext() {
      return { fillRect() {} };
    },
    setAttribute() {}
  };
  return e;
}
const stage = el('div');
const calls = [];
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  URL,
  URLSearchParams,
  JSON,
  Math,
  Number,
  String,
  Promise,
  Date,
  Array,
  Object,
  RegExp,
  isNaN,
  parseInt,
  parseFloat,
  document: {
    getElementById: () => stage,
    createElement: t => el(t),
    documentElement: { style: { setProperty() {} } },
    visibilityState: 'visible',
    body: { classList: { add() {} } }
  },
  location: { search: '', origin: 'http://127.0.0.1:7799', hostname: '127.0.0.1' },
  parent: { postMessage() {} },
  innerWidth: 1920,
  innerHeight: 1080,
  Audio: class {
    constructor(u) {
      this.src = u;
      this.listeners = {};
    }
    addEventListener(t, f) {
      (this.listeners[t] = this.listeners[t] || []).push(f);
    }
    play() {
      return Promise.resolve();
    }
    pause() {}
  },
  fetch: (url, opts) => {
    calls.push({ url: String(url), body: opts && opts.body ? JSON.parse(opts.body) : null });
    return Promise.resolve({ ok: true });
  },
  EventSource: class {
    constructor(u) {
      this.url = u;
      sandbox.__es = this;
    }
    close() {}
  }
};
sandbox.window = sandbox;
vm.runInNewContext(src, sandbox, { filename: 'overlay.js' });
const es = sandbox.__es;
assert(es && es.url.includes('role=overlay'), 'overlay connected as the Browser Source');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const done = () => calls.filter(c => c.url === '/api/done');
const extend = () => calls.filter(c => c.url === '/api/extend');
const appearance = {
  font: 'Vazirmatn',
  textSize: 34,
  width: 720,
  showAmount: true,
  showMessage: true,
  currency: 'toman',
  template: '{name} {amount}',
  animation: 'none',
  minDuration: 0.05,
  maxDuration: 0.3, // 300 ms: the old cap would end the alert long before the video does
  cardDelay: 0,
  volume: 80,
  ttsVolume: 70
};
es.onmessage({ data: JSON.stringify({ type: 'config', appearance }) });
const play = (id, media) =>
  es.onmessage({
    data: JSON.stringify({
      type: 'play',
      tip: { id, name: 'Long', amount: 5, toman: 500000, kind: 'sub', count: 1, message: '', media }
    })
  });
const videoOf = () => stage.children[stage.children.length - 1].querySelector('.media').children[0];

(async () => {
  // 1. a 1 s video with a 0.3 s maximum: it plays to its end and its length is reported
  play('long-1', { url: '/media/long.webm', type: 'video', volume: 100, duration: null, name: 'long' });
  const v = videoOf();
  assert.equal(v.tagName, 'VIDEO');
  v.duration = 1.0;
  v.fire('loadedmetadata');
  await sleep(700);
  assert.equal(done().length, 0, 'not cut at the maximum duration while the video still plays');
  assert.deepEqual(
    extend().map(c => c.body),
    [{ id: 'long-1', seconds: 3 }],
    'the length (+1.5 s, rounded up) is reported to the server once'
  );
  v.fire('ended');
  await sleep(100);
  assert.deepEqual(
    done().map(c => c.body.id),
    ['long-1'],
    'the alert ends with the video'
  );

  // 2. the file's own «قطع بعد از» wins over a longer video
  calls.length = 0;
  play('cut-2', { url: '/media/long.webm', type: 'video', volume: 100, duration: 0.5, name: 'cut' });
  const v2 = videoOf();
  v2.duration = 120;
  v2.fire('loadedmetadata');
  await sleep(20);
  assert.deepEqual(
    extend().map(c => c.body),
    [{ id: 'cut-2', seconds: 2 }],
    'the cut-off (0.5 s + 1.5 s) bounds the extension'
  );
  v2.fire('ended');
  await sleep(100);

  // 3. a short video inside the maximum: nothing to report, the maximum stays the safety net
  calls.length = 0;
  appearance.maxDuration = 5;
  es.onmessage({ data: JSON.stringify({ type: 'config', appearance }) });
  play('short-3', { url: '/media/short.webm', type: 'video', volume: 100, duration: null, name: 'short' });
  const v3 = videoOf();
  v3.duration = 1;
  v3.fire('loadedmetadata');
  await sleep(20);
  assert.equal(extend().length, 0, 'no extension for a video shorter than the maximum');
  v3.fire('ended');
  await sleep(100);
  assert.deepEqual(
    done().map(c => c.body.id),
    ['short-3']
  );

  // 4. an unknown length that is not playing (stuck, never started) ends at the maximum
  calls.length = 0;
  appearance.maxDuration = 0.3;
  es.onmessage({ data: JSON.stringify({ type: 'config', appearance }) });
  play('stuck-4', { url: '/media/stuck.webm', type: 'video', volume: 100, duration: null, name: 'stuck' });
  const v4 = videoOf();
  v4.duration = Infinity;
  v4.fire('loadedmetadata');
  await sleep(600);
  assert.equal(extend().length, 0, 'no extension for an unknown length that does not advance');
  assert.deepEqual(
    done().map(c => c.body.id),
    ['stuck-4'],
    'the maximum ends it'
  );

  // 5. a file without a stored length (Infinity) that keeps advancing is not cut; once it stops advancing, it ends
  calls.length = 0;
  play('rec-5', { url: '/media/recording.webm', type: 'video', volume: 100, duration: null, name: 'rec' });
  const v5 = videoOf();
  v5.duration = Infinity;
  v5.paused = false;
  v5.ended = false;
  v5.fire('loadedmetadata');
  v5.currentTime = 0.9; // playing: its position advanced past the first check
  await sleep(500); // the maximum (0.3 s) has passed
  assert.equal(done().length, 0, 'still advancing at the maximum: not cut');
  assert.deepEqual(
    extend().map(c => c.body),
    [{ id: 'rec-5', seconds: 3 }],
    'one step (1 s, plus 1.5 s) reported to the server'
  );
  v5.currentTime = 1.9; // still advancing at the next check
  await sleep(1000);
  assert.equal(done().length, 0, 'still advancing at the second check');
  assert.equal(extend().length, 2, 'a second step');
  // the position stops moving (a stall): the next check ends the alert
  await sleep(1100);
  assert.deepEqual(
    done().map(c => c.body.id),
    ['rec-5'],
    'a stalled file still ends at the next check'
  );

  console.log('OK: long video/audio alerts play to their end; the server is told their length');
  process.exit(0);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
