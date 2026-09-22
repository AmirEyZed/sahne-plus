// Unit test: the Browser Source must render donor names / messages / templates as text only.
// Runs public/overlay.js in a minimal fake DOM and inspects the produced card HTML.
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
const guide = el('div');
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
  location: { search: '?preview=1', origin: 'http://127.0.0.1:7799', hostname: '127.0.0.1' },
  parent: { postMessage() {} },
  innerWidth: 1920,
  innerHeight: 1080,
  Audio: class {
    constructor(u) {
      this.src = u;
      this.listeners = {};
      (sandbox.__audios = sandbox.__audios || []).push(String(u));
    }
    addEventListener(t, f) {
      (this.listeners[t] = this.listeners[t] || []).push(f);
    }
    play() {
      return Promise.resolve();
    }
    pause() {}
  },
  fetch: () => Promise.resolve({ ok: true }),
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
assert(es && es.url.includes('role=preview'), 'overlay connected as preview');

const appearance = {
  font: 'Vazirmatn',
  textSize: 34,
  nameColor: '#53fc18',
  textColor: '#fff',
  accent: '#53fc18',
  bgColor: '#0b0f0c',
  bgOpacity: 0.6,
  mediaMaxHeight: 55,
  width: 720,
  showAmount: true,
  showMessage: true,
  currency: 'toman',
  persianDigits: false,
  template: '<img src=x onerror=alert(9)> {name} gave {amount} {count}',
  animation: 'none',
  minDuration: 6,
  maxDuration: 90,
  volume: 80,
  ttsVolume: 70
};
es.onmessage({ data: JSON.stringify({ type: 'config', appearance }) });

const tip = {
  id: 't1',
  name: '<script>alert(1)</script>$& $` {amount} ‮EVIL\' onmouseover=\'x" onfocus="y',
  amount: 7,
  toman: 1600200,
  kind: 'tip',
  count: null,
  message:
    '<img src=x onerror=alert(2)><style>body{display:none}</style> javascript:alert(3) <a href="http://evil">link</a> ${1+1}',
  gif_url: 'javascript:alert(4)',
  tts_url: 'http://evil.example/tts.mp3',
  is_test: true,
  media: { url: 'http://evil.example/steal.webm', type: 'video', volume: 100, duration: null, name: 'x' }
};
es.onmessage({ data: JSON.stringify({ type: 'play', tip }) });

const alertEl = stage.children[stage.children.length - 1];
const card = alertEl.querySelector('.card');
const html = card.innerHTML;
const mediaBox = alertEl.children[0];
const video = mediaBox.children.find(c => c.tagName === 'VIDEO');
const imgs = mediaBox.children.filter(c => c.tagName === 'IMG');
console.log('card html:', html.slice(0, 700));
// assertions
assert(!/<script/i.test(html), 'no raw <script> tag');
assert(
  !/onerror=|onmouseover=|onfocus=/i.test(html.replace(/&quot;|&#39;/g, '')) || !/<img|<a /i.test(html),
  'no live event-handler attributes'
);
assert(!/<img /i.test(html) && !/<style/i.test(html) && !/<a /i.test(html), 'no injected img/style/a elements');
assert(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'name escaped');
assert(html.includes('$&amp; $`'), '$-patterns kept literally');
assert(
  html.includes('{amount}') && html.split('{amount}').length === 2,
  'placeholder inside the name is NOT expanded again'
);
assert(html.includes('&lt;img src=x onerror=alert(9)&gt;'), 'template HTML escaped');
assert(html.includes('1.6 میلیون تومان') || html.includes('میلیون تومان'), 'amount rendered');
assert(imgs.length === 0, 'javascript: gif_url not loaded');
assert(video && video.src === '', 'foreign media URL refused (same-origin only)');
console.log(
  'OK: name/message/template rendered as text; foreign media/gif/tts URLs refused; imgs=%d video.src=%j',
  imgs.length,
  video.src
);

// Regression (independent audit, P0-1): an imported image alert is a relative /media/... URL and must render;
// an https GIF from KickBot may render; an image on a foreign http host may not.
const playImgs = m => {
  es.onmessage({
    data: JSON.stringify({
      type: 'play',
      tip: {
        ...tip,
        id: 'img-' + Math.random(),
        name: 'Donor',
        message: '',
        gif_url: null,
        tts_url: null,
        media: null,
        ...m
      }
    })
  });
  const a = stage.children[stage.children.length - 1];
  return a.children[0].children.filter(c => c.tagName === 'IMG').map(c => c.src);
};
assert.deepStrictEqual(
  playImgs({ media: { url: '/media/alert 1.png', type: 'image', duration: 5 } }),
  ['http://127.0.0.1:7799/media/alert%201.png'],
  'local image alert renders (audit P0-1)'
);
assert.deepStrictEqual(
  playImgs({ gif_url: 'https://cdn.example/x.gif' }),
  ['https://cdn.example/x.gif'],
  'https GIF URL from KickBot still allowed'
);
assert.deepStrictEqual(
  playImgs({ media: { url: 'http://evil.example/x.png', type: 'image' } }),
  [],
  'image on a foreign http host refused'
);
assert.deepStrictEqual(
  playImgs({ media: { url: '//evil.example/x.png', type: 'image' } }),
  [],
  'protocol-relative URL refused'
);
console.log('OK: local image alerts render; foreign image hosts refused');

// Card delay (1.3.1): the per-file value wins over the appearance setting; the card and the TTS appear only after it.
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const lastCard = () => stage.children[stage.children.length - 1].querySelector('.card');
  es.onmessage({
    data: JSON.stringify({ type: 'config', appearance: { ...appearance, cardDelay: 5, animation: 'none' } })
  });
  sandbox.__audios = [];
  const base = { ...tip, name: 'Donor', message: 'hi', gif_url: null };
  es.onmessage({
    data: JSON.stringify({
      type: 'play',
      tip: {
        ...base,
        id: 'd1',
        tts_url: 'https://tts.example/a.mp3',
        media: { url: '/media/a.png', type: 'image', duration: 5, cardDelay: 0.3 }
      }
    })
  });
  const c1 = lastCard();
  assert.strictEqual(c1.style.visibility, 'hidden', 'card hidden during the delay');
  assert.ok(!sandbox.__audios.some(u => u.includes('tts.example')), 'TTS waits for the card');
  await sleep(450);
  assert.strictEqual(c1.style.visibility, '', 'card shown after the per-file delay (0.3 s, not the global 5 s)');
  assert.ok(
    sandbox.__audios.some(u => u.includes('tts.example')),
    'TTS starts with the card'
  );
  es.onmessage({
    data: JSON.stringify({ type: 'config', appearance: { ...appearance, cardDelay: 0, animation: 'none' } })
  });
  es.onmessage({
    data: JSON.stringify({
      type: 'play',
      tip: { ...base, id: 'd2', tts_url: null, media: { url: '/media/a.png', type: 'image' } }
    })
  });
  assert.notStrictEqual(lastCard().style.visibility, 'hidden', 'no delay: the card shows at once');
  es.onmessage({
    data: JSON.stringify({ type: 'config', appearance: { ...appearance, cardDelay: 0.2, animation: 'none' } })
  });
  es.onmessage({
    data: JSON.stringify({
      type: 'play',
      tip: { ...base, id: 'd3', tts_url: null, media: { url: '/media/a.png', type: 'image' } }
    })
  });
  assert.strictEqual(lastCard().style.visibility, 'hidden', 'no per-file value: the appearance delay applies');
  console.log('OK: card delay (per file over appearance), TTS waits for the card');
  // StreamElements tips in another currency (1.3.5)
  const cardText = m => {
    es.onmessage({
      data: JSON.stringify({
        type: 'play',
        tip: { ...base, id: 'c-' + Math.random(), tts_url: null, media: null, gif_url: null, ...m }
      })
    });
    return stage.children[stage.children.length - 1].querySelector('.card').innerHTML; // the fake DOM has no textContent
  };
  es.onmessage({
    data: JSON.stringify({
      type: 'config',
      appearance: { ...appearance, currency: 'toman-both', persianDigits: false, cardDelay: 0, animation: 'none' }
    })
  });
  assert.ok(
    cardText({ amount: 5, currency: 'EUR', toman: 1338900 }).includes('(5 EUR)'),
    'euro with a rate: toman plus the original amount'
  );
  assert.ok(
    cardText({ amount: 5, currency: 'EUR', toman: null }).includes('5 EUR'),
    'euro without a rate: amount and code'
  );
  es.onmessage({
    data: JSON.stringify({
      type: 'config',
      appearance: { ...appearance, currency: 'eq-en', persianDigits: false, cardDelay: 0, animation: 'none' }
    })
  });
  assert.ok(
    cardText({ amount: 5, currency: 'EUR', toman: 1338900 }).includes('5 EUR = 1,338,900 Toman'),
    'equation format with euro'
  );
  assert.ok(
    cardText({ amount: 7, currency: 'USD', toman: 1600000 }).includes('7$ = 1,600,000 Toman'),
    'dollar unchanged'
  );
  console.log('OK: other currencies on the card');
  process.exit(0);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
