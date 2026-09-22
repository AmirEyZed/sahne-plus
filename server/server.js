// Sahne Plus — local alert server (KickBot tips + Kick subs/gift subs) with local transparent media.
// Hosted by the Electron main process. Zero runtime dependencies; needs Node 22+ (native fetch + WebSocket).
'use strict';
const http = require('http');
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---- third-party endpoints (documented in DATA_FLOW.md) ----
const KB_WS = 'wss://kickbot.live/ws'; // KickBot tipping event stream (same source the official widget uses)
const KB_API = 'https://widgets.kickbot.com'; // KickBot widget API: queue sync, capture_tip, widget metadata
const PUSHER_WS = 'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false'; // Kick's public chat feed (Pusher, undocumented)
const KICK_CHANNEL_API = 'https://kick.com/api/v2/channels/'; // undocumented Kick web endpoint used only to resolve slug -> chatroom id
const BAHA24 = 'https://baha24.com/api/v1/price'; // USD->toman sell rate, public JSON API (primary)
const BONBAST = 'https://www.bonbast.com/'; // USD->toman sell rate (scraped; fallback only)
const MELD_WS = 'ws://127.0.0.1:13376'; // Meld Studio local API (loopback only)
const KICK_SUB_USD = 4.99;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36';

// ---- limits ----
const LIMITS = {
  name: 80,
  message: 500,
  keyword: 50,
  keywords: 20,
  fileName: 120,
  upload: 512 * 1024 * 1024,
  files: 500,
  sse: { overlay: 8, preview: 4, admin: 4 }, // concurrent event streams per role
  played: 1000,
  logs: 300,
  minRateInterval: 1,
  minBonbastInterval: 5
};

const DEFAULT_CONFIG = {
  port: 7788,
  streamer_id: null,
  mode: 'standalone', // standalone: replaces the KickBot widget (captures the tip, plays TTS) | companion: only reacts to the widget's tip_play
  appearance: {
    font: 'Vazirmatn',
    textSize: 34,
    nameColor: '#53fc18',
    textColor: '#ffffff',
    accent: '#53fc18',
    bgColor: '#0b0f0c',
    bgOpacity: 0.6,
    mediaMode: 'full',
    mediaFit: 'cover',
    cardX: 50,
    cardY: 82,
    cardScale: 1,
    radius: 26,
    amountStyle: 'pill',
    showLine: true,
    showGlow: true,
    showBorder: true,
    headlineColor: '#ffffff',
    borderColor: '#ffffff',
    borderOpacity: 0.1,
    padY: 26,
    padX: 34,
    animation: 'pop',
    showMessage: true,
    showAmount: true,
    currency: 'toman',
    persianDigits: true,
    template: '{name} با {amount} حمایت کرد',
    giftTemplate: '{name} {count} تا ساب گیفت داد 🎁 {amount}',
    subTemplate: '{name} ساب شد ⭐ {amount}',
    imageDuration: 8,
    minDuration: 6,
    maxDuration: 90,
    cardDelay: 0,
    mediaMaxHeight: 55,
    volume: 80,
    ttsVolume: 70,
    shadow: true,
    width: 720,
    showGloss: false
  },
  files: [],
  showAlertWithoutMedia: true,
  rate: { auto: true, manual: null, value: null, updatedAt: null, source: null, intervalMin: 2, proxy: '', fx: {} },
  kick: {
    enabled: true,
    channel: '',
    chatroomId: null,
    channelId: null,
    resolvedFor: null,
    giftValueToman: 0,
    subValueToman: 0,
    showNewSubs: true
  },
  se: { channelId: null, username: null, provider: null }, // StreamElements account (the JWT token is stored separately, encrypted)
  app: { autostart: true, updateCheck: true, updateNotifiedFor: null }
};
const FONTS = ['Vazirmatn', 'Estedad', 'Lalezar', 'Inter', 'Poppins', 'Segoe UI', 'Tahoma'];
const ENUMS = {
  mediaMode: ['full', 'boxed'],
  mediaFit: ['cover', 'contain'],
  amountStyle: ['pill', 'plain', 'inherit', 'soft'],
  animation: ['pop', 'slide', 'fade', 'none'],
  currency: ['eq-en', 'eq-fa', 'toman', 'toman-full', 'toman-both', 'dollar-fa', 'usd', 'usd-code'],
  mode: ['standalone', 'companion']
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml'
};
const TYPES = {
  video: ['.mp4', '.webm', '.mov', '.mkv'],
  image: ['.png', '.jpg', '.jpeg', '.gif', '.webp'],
  audio: ['.mp3', '.wav', '.ogg', '.m4a']
};
function typeOf(file) {
  const e = path.extname(String(file || '')).toLowerCase();
  for (const k in TYPES) if (TYPES[k].includes(e)) return k;
  return null;
}

// Content sniffing: the file must actually look like the container its extension claims (imported media is untrusted).
function sniffOk(buf, ext) {
  if (!buf || buf.length < 12) return false;
  const h = buf.subarray(0, 12);
  const ascii = (o, s) => h.toString('latin1', o, o + s.length) === s;
  switch (ext) {
    case '.webm':
    case '.mkv':
      return h[0] === 0x1a && h[1] === 0x45 && h[2] === 0xdf && h[3] === 0xa3;
    case '.mp4':
    case '.mov':
    case '.m4a':
      return ascii(4, 'ftyp');
    case '.png':
      return h[0] === 0x89 && ascii(1, 'PNG');
    case '.jpg':
    case '.jpeg':
      return h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff;
    case '.gif':
      return ascii(0, 'GIF8');
    case '.webp':
      return ascii(0, 'RIFF') && ascii(8, 'WEBP');
    case '.wav':
      return ascii(0, 'RIFF') && ascii(8, 'WAVE');
    case '.ogg':
      return ascii(0, 'OggS');
    case '.mp3':
      return ascii(0, 'ID3') || (h[0] === 0xff && (h[1] & 0xe0) === 0xe0);
    default:
      return false;
  }
}
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
// Safe media file name: basename only, no control/bidi chars, no reserved names, bounded length, extension kept.
function safeMediaName(orig) {
  const bn = String(orig || '')
    .split(/[\\/]/)
    .pop(); // basename on both separators, independent of the host OS
  const m = /\.([a-z0-9]{1,5})$/i.exec(bn); // also handles dot-files like ".webm"
  const ext = m ? '.' + m[1].toLowerCase() : '';
  let base = ext ? bn.slice(0, -ext.length) : bn;
  base = base
    .replace(/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .replace(/[^\w.\-؀-ۿ ]+/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, LIMITS.fileName);
  if (!base || WIN_RESERVED.test(base)) base = 'media_' + crypto.randomBytes(3).toString('hex');
  return base + ext;
}
// Persian (۰-۹) and Arabic-Indic (٠-٩) digits -> ASCII, so "۱۰۰T" and a donor typing "۱۲۳" both work
const toAsciiDigits = s =>
  String(s ?? '')
    .replace(/[\u06F0-\u06F9]/g, d => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x0660));
// "150T" -> 150000, "1.5M" -> 1500000, "500K" -> 500000, "2000000" -> 2000000, otherwise null
function parseThreshold(name) {
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*([tTkKmM]?)(?![a-zA-Z0-9])/.exec(toAsciiDigits(name));
  if (!m) return null;
  const n = parseFloat(m[1].replace(',', '.'));
  const u = m[2].toUpperCase();
  if (u === 'M') return Math.round(n * 1000000);
  if (u === 'T' || u === 'K') return Math.round(n * 1000);
  return n >= 1000 ? Math.round(n) : null;
}
// text from third parties (donor names, messages, usernames): strip control + bidi-override chars, bound length
function cleanText(s, max) {
  return String(s ?? '')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .slice(0, max);
}
// Persian/Arabic normalisation for keyword matching (ي/ی, ك/ک, ة/ه, diacritics, ZWNJ)
function normFa(s) {
  return toAsciiDigits(String(s ?? '').toLowerCase())
    .replace(/[ي]/g, 'ی')
    .replace(/[ك]/g, 'ک')
    .replace(/ة/g, 'ه')
    .replace(/[ً-ْٰ‌]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function httpsUrl(u) {
  try {
    const x = new URL(String(u));
    return x.protocol === 'https:' ? x.href : null;
  } catch {
    return null;
  }
}
// StreamElements "channel.activities" message -> a queue entry, or null when it is not a tip we can use.
// Tips are already paid on StreamElements' side, so they enter the queue like local events (no capture step).
function parseSeActivity(a) {
  if (!a || typeof a !== 'object') return null;
  if (String(a.type || '').toLowerCase() !== 'tip') return null; // subs/follows: not used (subs come from Kick chat)
  const d = a.data && typeof a.data === 'object' ? a.data : {};
  const idRaw = String(a._id || d.tipId || '')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 64);
  if (!idRaw) return null;
  const amount = finite(d.amount, 0, 1e9, 0);
  const currency = /^[A-Za-z]{3}$/.test(String(d.currency || '')) ? String(d.currency).toUpperCase() : 'USD';
  return {
    stripe_pi_id: 'se_' + idRaw,
    tipper_name: cleanText(d.displayName || d.username || d.name, LIMITS.name) || 'ناشناس',
    tip_message: cleanText(d.message, LIMITS.message),
    amount_total: Math.round(amount * 100),
    currency,
    approval_status: 'approved',
    is_local: true,
    is_test: !!(a.isMock || a.mock || d.isMock || a.test || d.test),
    kind: 'tip',
    count: null,
    tags: [],
    toman_override: null,
    source: 'streamelements',
    created_at: typeof a.createdAt === 'string' ? a.createdAt : new Date().toISOString()
  };
}
// a StreamElements JWT: three base64url parts, second part decodes to JSON with a channel id
function seTokenOk(t) {
  const s = String(t || '').trim();
  if (s.length < 40 || s.length > 4000 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(s)) return false;
  try {
    const p = JSON.parse(Buffer.from(s.split('.')[1], 'base64url').toString('utf8'));
    return !!(p && typeof p === 'object');
  } catch {
    return false;
  }
}

// Other currencies a StreamElements tipping page may use, converted to toman with the sell rates that baha24
// (and bonbast as fallback) publish next to the dollar. Anything else is shown as "5 XYZ" without conversion.
const FX_CODES = [
  'EUR',
  'GBP',
  'AED',
  'TRY',
  'CAD',
  'CHF',
  'RUB',
  'CNY',
  'INR',
  'SGD',
  'NOK',
  'SEK',
  'DKK',
  'AUD',
  'THB',
  'KWD',
  'MYR',
  'OMR',
  'JPY',
  'AZN',
  'AFN'
];
function sanitizeFx(fx) {
  const o = {};
  if (fx && typeof fx === 'object')
    for (const c of FX_CODES) {
      const v = Number(fx[c]);
      if (Number.isFinite(v) && v >= 10 && v <= 1e9) o[c] = Math.round(v);
    }
  return o;
}
function fxFromBaha24(list) {
  const fx = {};
  for (const x of Array.isArray(list) ? list : []) {
    const sym = x && String(x.symbol || '').toUpperCase();
    if (!FX_CODES.includes(sym)) continue;
    const v = Number(String(x.sell).replace(/,/g, ''));
    if (Number.isFinite(v) && v >= 10 && v <= 1e9) fx[sym] = Math.round(v);
  }
  return fx;
}
function fxFromBonbast(j) {
  const fx = {};
  for (const c of FX_CODES) {
    const v = Number(String((j && j[c.toLowerCase() + '1']) || '').replace(/,/g, ''));
    if (Number.isFinite(v) && v >= 10 && v <= 1e9) fx[c] = Math.round(v);
  }
  return fx;
}

// ---------- network helpers (pure, unit-tested) ----------
// Failures of the kind a filtered site produces in Iran: reset / refused / timeout / DNS / TLS handshake cut.
const NET_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ECONNABORTED',
  'EPIPE'
]);
function isNetError(e) {
  if (!e) return false;
  if (e.code && NET_CODES.has(String(e.code))) return true;
  if (/^(ERR_TLS|ERR_SSL|CERT_|UNABLE_TO|DEPTH_ZERO|SELF_SIGNED)/.test(String(e.code || ''))) return true;
  return /^timeout$|proxy connect timeout|socket hang up|before secure TLS connection/i.test(String(e.message || ''));
}
// Chromium / Windows proxy answer ("PROXY 127.0.0.1:10809; DIRECT") -> "http://127.0.0.1:10809", otherwise ''.
// httpsRequest() speaks HTTP CONNECT only, so SOCKS and HTTPS proxies are ignored.
function parsePacProxy(s) {
  for (const part of String(s || '').split(';')) {
    const m = /^\s*PROXY\s+([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\]):(\d{1,5})\s*$/i.exec(part);
    if (m && Number(m[2]) > 0 && Number(m[2]) < 65536) return 'http://' + m[1] + ':' + m[2];
  }
  return '';
}
// Ordered, de-duplicated routes to try; '' means a direct connection.
function routeOrder({ manual = '', system = '', directFirst = false } = {}) {
  const proxies = [manual, system].map(s => String(s || '').trim()).filter(s => /^https?:\/\/\S+$/.test(s));
  const list = directFirst ? ['', ...proxies] : [...proxies, ''];
  return list.filter((v, i) => list.indexOf(v) === i);
}
// host:port of a proxy URL without credentials, for logs and messages
function routeLabel(px) {
  if (!px) return 'direct';
  try {
    return new URL(px).host || 'proxy';
  } catch {
    return 'proxy';
  }
}
// attempts: [{ route, err }] from resolveKickChannel() -> { error: short text for the status chip, hint: what to do }
function describeKickFailure(attempts) {
  const list = Array.isArray(attempts) ? attempts.filter(a => a && a.err) : [];
  const status = a => Number(a.err.httpStatus) || 0;
  if (list.some(a => status(a) === 404))
    return {
      error: 'کانال پیدا نشد',
      hint: 'اسم کانال را درست وارد کنید: فقط قسمتی که بعد از kick.com/ می‌آید، مثلاً amireyzed.'
    };
  const refused = list.find(a => status(a) === 403 || status(a) === 429);
  if (refused)
    return {
      error: 'kick.com درخواست را رد کرد (' + status(refused) + ')',
      hint: 'کیک اتصال از این IP را قبول نکرد؛ معمولاً IP سرور VPN است. سرور یا لوکیشن VPN را عوض کنید و دوباره «ذخیره» را بزنید.'
    };
  const direct = list.find(a => !a.route);
  const viaProxy = list.filter(a => a.route);
  if (
    direct &&
    isNetError(direct.err) &&
    viaProxy.every(a => isNetError(a.err) || /^proxy CONNECT/.test(String(a.err.message)))
  ) {
    const first = viaProxy.length
      ? 'از طریق پراکسی (' +
        viaProxy.map(a => routeLabel(a.route)).join('، ') +
        ') هم وصل نشد؛ مطمئن شوید VPN روشن و وصل است. '
      : 'kick.com در ایران فیلتر است و برنامه نتوانست به آن وصل شود. VPN را روشن کنید. ';
    return {
      error: 'kick.com در دسترس نیست (فیلتر)',
      hint:
        first +
        'اگر VPN روشن است و باز هم این خطا می‌آید، حالت TUN را در برنامه‌ی VPN روشن کنید، یا آدرس پراکسی HTTP آن را در کادر «پراکسی» (بخش نرخ دلار) بنویسید، مثلاً http://127.0.0.1:10809 برای v2rayN. این فقط برای شناسایی کانال لازم است؛ بعد از آن ساب‌ها معمولاً بدون VPN هم می‌آیند.'
    };
  }
  const last = list[list.length - 1];
  if (last && status(last))
    return {
      error: 'kick.com خطای HTTP ' + status(last) + ' داد',
      hint: 'ممکن است سرور کیک موقتاً مشکل داشته باشد؛ چند دقیقه بعد دوباره «ذخیره» را بزنید.'
    };
  if (last && last.err.kind === 'parse')
    return {
      error: 'جواب kick.com قابل خواندن نبود',
      hint: 'احتمالاً کیک صفحه‌ی بررسی امنیتی (Cloudflare) برگردانده است؛ سرور VPN را عوض کنید یا چند دقیقه بعد دوباره امتحان کنید.'
    };
  return {
    error: 'اتصال به kick.com ناموفق بود',
    hint: 'اینترنت و VPN را بررسی کنید و دوباره «ذخیره» را بزنید؛ جزئیات در صفحه‌ی لاگ است.'
  };
}

const finite = (v, min, max, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
};
const intOrNull = (v, min, max) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.min(max, Math.max(min, n)));
};
const isHex = s => /^#[0-9a-f]{6}$/i.test(String(s || ''));

/**
 * @param {{ dataDir: string, publicDir: string, appVersion?: string, onLog?: Function, openPath?: Function,
 *           secretStore?: { available: () => boolean, encrypt: (s:string)=>string, decrypt: (s:string)=>string } }} opts
 */
function createServer(opts) {
  const DATA = opts.dataDir,
    PUB = opts.publicDir;
  const MEDIA = path.join(DATA, 'media');
  const CFG_PATH = path.join(DATA, 'config.json');
  const PLAYED_PATH = path.join(DATA, 'played.json');
  const APP_VERSION = opts.appVersion || '0.0.0';
  const NODE_OK = typeof fetch === 'function' && typeof WebSocket === 'function';
  const store = opts.secretStore || null;
  fs.mkdirSync(MEDIA, { recursive: true });

  // ---------- config ----------
  // The KickBot secret never lives in `config` (and therefore never in config.json in plaintext when the OS store is available).
  let secret = ''; // in-memory only
  let seToken = ''; // StreamElements JWT, in-memory only
  let secretStorage = 'none'; // 'os' (DPAPI via Electron safeStorage) | 'plain' (fallback) | 'none'
  let config = loadConfig();
  function loadConfig() {
    let c = {},
      raw = null;
    try {
      raw = fs.readFileSync(CFG_PATH, 'utf8');
      c = JSON.parse(raw.replace(/^\uFEFF/, ''));
    } catch (e) {
      if (raw !== null) {
        // corrupted: keep a copy, never overwrite it silently
        try {
          fs.copyFileSync(CFG_PATH, CFG_PATH + '.corrupt-' + Date.now());
        } catch {}
        console.error('config.json could not be parsed; defaults used, corrupted copy kept:', e.message);
      }
      c = {};
    }
    const merged = {
      ...DEFAULT_CONFIG,
      ...c,
      appearance: { ...DEFAULT_CONFIG.appearance, ...(c.appearance || {}) },
      rate: { ...DEFAULT_CONFIG.rate, ...(c.rate || {}) },
      kick: { ...DEFAULT_CONFIG.kick, ...(c.kick || {}) },
      se: { ...DEFAULT_CONFIG.se, ...(c.se || {}) },
      app: { ...DEFAULT_CONFIG.app, ...(c.app || {}) }
    };
    merged.app.updateCheck = merged.app.updateCheck !== false;
    if (!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(String(merged.app.updateNotifiedFor || '')))
      merged.app.updateNotifiedFor = null;
    // secret: encrypted field preferred; legacy plaintext migrated on first save
    if (c.secret_id_enc && store && store.available()) {
      try {
        secret = String(store.decrypt(c.secret_id_enc) || '');
        secretStorage = 'os';
      } catch {
        secret = '';
      }
    } else if (typeof c.secret_id === 'string' && c.secret_id) {
      secret = c.secret_id;
      secretStorage = store && store.available() ? 'os' : 'plain';
    } else secretStorage = store && store.available() ? 'os' : 'plain';
    delete merged.secret_id;
    delete merged.secret_id_enc;
    if (c.se_token_enc && store && store.available()) {
      try {
        seToken = String(store.decrypt(c.se_token_enc) || '');
      } catch {
        seToken = '';
      }
    } else if (typeof c.se_token === 'string' && c.se_token) seToken = c.se_token;
    if (!seTokenOk(seToken)) seToken = '';
    delete merged.se_token;
    delete merged.se_token_enc;
    if (!/^[A-Za-z0-9]{1,64}$/.test(String(merged.se.channelId || ''))) merged.se.channelId = null;
    if (!Array.isArray(merged.files)) merged.files = [];
    merged.files = merged.files.map(sanitizeFile).filter(Boolean).slice(0, LIMITS.files);
    if (merged.rate.proxy == null)
      merged.rate.proxy =
        process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';
    merged.rate.intervalMin = Math.max(LIMITS.minRateInterval, Number(merged.rate.intervalMin) || 2);
    merged.rate.fx = sanitizeFx(merged.rate.fx);
    merged.port = finite(merged.port, 1024, 65535, 7788);
    if (!ENUMS.mode.includes(merged.mode)) merged.mode = 'standalone';
    return merged;
  }
  function serializedConfig() {
    const out = { ...config };
    if (secret) {
      if (store && store.available()) {
        try {
          out.secret_id_enc = store.encrypt(secret);
          secretStorage = 'os';
        } catch {
          out.secret_id = secret;
          secretStorage = 'plain';
        }
      } else {
        out.secret_id = secret;
        secretStorage = 'plain';
      }
    }
    if (seToken) {
      let enc = null;
      if (store && store.available()) {
        try {
          enc = store.encrypt(seToken);
        } catch {
          enc = null;
        }
      }
      if (enc) out.se_token_enc = enc;
      else out.se_token = seToken;
    }
    return out;
  }
  function saveConfig() {
    try {
      const tmp = CFG_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(serializedConfig(), null, 2));
      fs.renameSync(tmp, CFG_PATH);
    } catch (e) {
      log('error', 'ذخیره‌ی config.json ناموفق بود', e.message);
    }
  }
  // what the controller UI may see: everything except the secret
  function publicConfig() {
    return {
      ...config,
      kickbot: { configured: !!(secret && config.streamer_id), streamer_id: config.streamer_id, secretStorage },
      streamelements: {
        configured: !!(seToken && config.se.channelId),
        username: config.se.username,
        provider: config.se.provider,
        secretStorage
      }
    };
  }
  if (!fs.existsSync(CFG_PATH)) saveConfig();

  // ---------- validation ----------
  function sanitizeFile(f) {
    if (!f || typeof f !== 'object') return null;
    const file = path.basename(String(f.file || ''));
    if (!file || file !== String(f.file) || !typeOf(file)) return null; // basename only, known type
    const kw = Array.isArray(f.keywords)
      ? f.keywords
          .map(k => cleanText(k, LIMITS.keyword).trim())
          .filter(Boolean)
          .slice(0, LIMITS.keywords)
      : [];
    return {
      id: /^[0-9a-f]{10}$/.test(String(f.id)) ? f.id : crypto.randomBytes(5).toString('hex'),
      file,
      name: cleanText(f.name || path.basename(file, path.extname(file)), LIMITS.name).trim() || file,
      type: typeOf(file),
      enabled: f.enabled !== false,
      minToman: intOrNull(f.minToman, 0, 1e12) ?? (f.minToman === undefined ? parseThreshold(f.name || file) : null),
      maxToman: intOrNull(f.maxToman, 0, 1e12),
      minAmount: finite(f.minAmount, 0, 1e9, 0),
      maxAmount: intOrNull(f.maxAmount, 0, 1e9),
      keywords: kw,
      volume: finite(f.volume, 0, 100, 100),
      duration: intOrNull(f.duration, 1, 3600),
      // seconds before the name/amount card (and TTS) appears for this file; null = use the appearance setting
      cardDelay:
        f.cardDelay === null || f.cardDelay === undefined || f.cardDelay === ''
          ? null
          : Math.round(finite(f.cardDelay, 0, 60, 0) * 10) / 10,
      size: finite(f.size, 0, 1e13, 0)
    };
  }
  function sanitizeAppearance(a) {
    const cur = config.appearance,
      out = { ...cur };
    if (!a || typeof a !== 'object') return out;
    const num = (k, min, max) => {
      if (k in a) out[k] = finite(a[k], min, max, cur[k]);
    };
    const bool = k => {
      if (k in a) out[k] = !!a[k];
    };
    const str = (k, max) => {
      if (k in a) out[k] = cleanText(a[k], max);
    };
    const col = k => {
      if (k in a && isHex(a[k])) out[k] = String(a[k]).toLowerCase();
    };
    const en = k => {
      if (k in a && ENUMS[k].includes(a[k])) out[k] = a[k];
    };
    if ('font' in a) out.font = FONTS.includes(a.font) ? a.font : cur.font;
    num('textSize', 10, 120);
    num('bgOpacity', 0, 1);
    num('borderOpacity', 0, 1);
    num('width', 200, 1920);
    num('radius', 0, 120);
    num('cardX', 0, 100);
    num('cardY', 0, 100);
    num('cardScale', 0.2, 3);
    num('padY', 0, 120);
    num('padX', 0, 160);
    num('mediaMaxHeight', 10, 100);
    num('imageDuration', 1, 600);
    num('minDuration', 1, 600);
    num('maxDuration', 2, 3600);
    num('cardDelay', 0, 60);
    out.cardDelay = Math.round((Number(out.cardDelay) || 0) * 10) / 10;
    num('volume', 0, 100);
    num('ttsVolume', 0, 100);
    ['nameColor', 'textColor', 'accent', 'bgColor', 'headlineColor', 'borderColor'].forEach(col);
    ['showLine', 'showGlow', 'showBorder', 'showGloss', 'shadow', 'showMessage', 'showAmount', 'persianDigits'].forEach(
      bool
    );
    ['template', 'giftTemplate', 'subTemplate'].forEach(k => str(k, 200));
    ['mediaMode', 'mediaFit', 'amountStyle', 'animation', 'currency'].forEach(en);
    if (out.maxDuration < out.minDuration) out.maxDuration = out.minDuration;
    return out;
  }

  // ---------- logging (never contains the secret; tip payloads are reduced to name/amount/message/kind) ----------
  const logs = [];
  function log(level, msg, extra) {
    const entry = { t: new Date().toISOString(), level, msg, extra: extra === undefined ? undefined : safe(extra) };
    logs.push(entry);
    if (logs.length > LIMITS.logs) logs.shift();
    const line = `[${entry.t.slice(11, 19)}] ${level.toUpperCase()} ${msg}${extra !== undefined ? ' ' + JSON.stringify(entry.extra) : ''}`;
    (level === 'error' ? console.error : console.log)(line);
    if (opts.onLog) {
      try {
        opts.onLog(line);
      } catch {}
    }
    broadcast('admin', { type: 'log', entry });
  }
  function safe(v) {
    try {
      return JSON.parse(
        JSON.stringify(v, (k, val) =>
          ['secret_id', 'authorization', 'secret_id_enc', 'se_token', 'se_token_enc', 'token'].includes(k)
            ? '[redacted]'
            : val
        )
      );
    } catch {
      return String(v);
    }
  }

  // ---------- SSE clients ----------
  const clients = { overlay: new Set(), admin: new Set(), preview: new Set() };
  function broadcast(role, obj) {
    const data = `data: ${JSON.stringify(obj)}\n\n`;
    for (const res of clients[role]) {
      try {
        res.write(data);
      } catch {}
    }
  }
  function sendState() {
    broadcast('admin', { type: 'state', state: publicState() });
  }
  function kbStatus() {
    if (!secret || !config.streamer_id) return 'unconfigured';
    if (ws && ws.readyState === 1) return 'connected';
    if (ws && ws.readyState === 0) return 'connecting';
    return 'reconnecting';
  }
  function kickStatus() {
    if (!config.kick.enabled) return 'disabled';
    if (!config.kick.channel) return 'unconfigured';
    if (kickState.connected) return 'connected';
    if (kickState.error) return 'error';
    return 'reconnecting';
  }
  function publicState() {
    return {
      connected: !!ws && ws.readyState === 1,
      kbStatus: kbStatus(),
      configured: !!(secret && config.streamer_id),
      secretStorage,
      overlays: clients.overlay.size,
      queueStatus,
      queueDelay,
      queueMode,
      tippingEnabled,
      pending: pending.length,
      approved: approved.length,
      playing: playing ? tipSummary(playing) : null,
      mode: config.mode,
      nodeVersion: process.versions.node,
      nodeOk: NODE_OK,
      kick: {
        connected: kickState.connected,
        status: kickStatus(),
        channel: config.kick.channel,
        chatroomId: config.kick.chatroomId,
        error: kickState.error,
        hint: kickState.hint
      },
      se: sePublic(),
      rate: currentRate(),
      rateUpdatedAt: config.rate.updatedAt,
      rateManual: Number(config.rate.manual) > 0,
      rateError: rateError,
      rateSource: config.rate.source,
      systemProxy: systemProxyLabel,
      recent,
      port: config.port,
      version: APP_VERSION
    };
  }

  // ---------- played-id memory (survives restarts so a re-synced tip is not shown twice) ----------
  const playedIds = new Set();
  let playedOrder = [];
  try {
    const arr = JSON.parse(fs.readFileSync(PLAYED_PATH, 'utf8'));
    if (Array.isArray(arr))
      for (const id of arr.slice(-LIMITS.played)) {
        playedIds.add(String(id));
        playedOrder.push(String(id));
      }
  } catch {}
  let playedSaveT = null;
  function markPlayed(id) {
    if (!id || playedIds.has(id)) return;
    playedIds.add(id);
    playedOrder.push(id);
    while (playedOrder.length > LIMITS.played) playedIds.delete(playedOrder.shift());
    clearTimeout(playedSaveT);
    playedSaveT = setTimeout(() => {
      try {
        fs.writeFileSync(PLAYED_PATH, JSON.stringify(playedOrder));
      } catch {}
    }, 500);
  }

  // ---------- KickBot connection ----------
  let ws = null,
    reconnectTimer = null,
    pulseTimer = null,
    stopped = false;
  let queueStatus = 'play',
    queueDelay = 5,
    queueMode = 'automatic',
    tippingEnabled = true;
  let pending = [],
    approved = [];
  let playing = null,
    lastEnd = 0,
    playTimeout = null;
  const recent = [];
  const timers = [];
  function connect() {
    if (stopped || !NODE_OK || !secret || !config.streamer_id) return;
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    try {
      ws = new WebSocket(KB_WS);
    } catch (e) {
      log('error', 'WebSocket create failed', e.message);
      return scheduleReconnect();
    }
    const connTimeout = setTimeout(() => {
      if (ws && ws.readyState === 0) {
        try {
          ws.close();
        } catch {}
      }
    }, 10000);
    ws.onopen = () => {
      clearTimeout(connTimeout);
      log('info', 'به کیک‌بات وصل شد', { channel: 'tipping_' + config.streamer_id });
      ws.send(JSON.stringify({ type: 'subscribe', channel: 'tipping_' + config.streamer_id, authorization: secret }));
      clearInterval(pulseTimer);
      pulseTimer = setInterval(() => publish('pulse', {}), 3000);
      sendState();
      syncQueue();
    };
    ws.onmessage = ev => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      const d = m && m.data;
      if (!d || typeof d !== 'object') return;
      handleEvent(String(d.event_type || ''), d.payload && typeof d.payload === 'object' ? d.payload : {});
    };
    ws.onerror = () => {};
    ws.onclose = ev => {
      clearTimeout(connTimeout);
      clearInterval(pulseTimer);
      log('warn', 'اتصال کیک‌بات قطع شد، تلاش مجدد تا ۵ ثانیه دیگر', { code: ev.code });
      sendState();
      scheduleReconnect();
    };
  }
  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    if (!stopped) reconnectTimer = setTimeout(connect, 5000);
  }
  timers.push(
    setInterval(() => {
      if (!ws || ws.readyState === 3) connect();
    }, 10000)
  );
  function publish(event_type, payload) {
    if (!ws || ws.readyState !== 1) return;
    ws.send(
      JSON.stringify({
        channel: 'tipping_' + config.streamer_id,
        authorization: secret,
        type: 'publish',
        data: { event_type, payload }
      })
    );
  }
  function normalizeTip(p) {
    // only the fields we use, with bounded, cleaned text; ids must be strings
    return {
      stripe_pi_id: String(p.stripe_pi_id || ''),
      tipper_name: cleanText(p.tipper_name, LIMITS.name),
      tip_message: cleanText(p.tip_message, LIMITS.message),
      amount_total: finite(p.amount_total, 0, 1e12, 0),
      approval_status: String(p.approval_status || ''),
      is_replay: !!p.is_replay,
      is_test: !!p.is_test,
      gif_url: httpsUrl(p.gif_url),
      audio_url: httpsUrl(p.audio_url),
      created_at: p.created_at
    };
  }
  function handleEvent(type, raw) {
    if (type === 'pulse') return;
    const p = type.startsWith('tip_') ? normalizeTip(raw) : raw;
    if (type !== 'tip_play' && type !== 'tip_end')
      log('info', 'ایونت: ' + type, type.startsWith('tip_') ? tipSummary(p) : p);
    switch (type) {
      case 'tip_queue_config_updated':
        queueMode = p.queue_mode ?? queueMode;
        queueDelay = finite(p.queue_delay, 0, 600, queueDelay);
        queueStatus = p.queue_status ?? queueStatus;
        tippingEnabled = p.is_active ?? tippingEnabled;
        break;
      case 'queue_play':
        queueStatus = 'play';
        tryNext();
        break;
      case 'queue_pause':
        queueStatus = 'pause';
        break;
      case 'queue_clear':
        pending = [];
        approved = [];
        break;
      case 'tip_initiated':
        if (!p.stripe_pi_id) break;
        if (p.approval_status === 'pending') pending.push(p);
        else if (p.approval_status === 'approved') {
          approved.push(p);
          tryNext();
        }
        break;
      case 'tip_approved': {
        const t = pending.find(x => x.stripe_pi_id === p.stripe_pi_id);
        if (t) {
          pending = pending.filter(x => x.stripe_pi_id !== p.stripe_pi_id);
          approved.push(t);
          tryNext();
        }
        break;
      }
      case 'tip_rejected':
        pending = pending.filter(x => x.stripe_pi_id !== p.stripe_pi_id);
        approved = approved.filter(x => x.stripe_pi_id !== p.stripe_pi_id);
        if (playing && playing.stripe_pi_id === p.stripe_pi_id) {
          broadcast('overlay', { type: 'stop' });
          finishPlaying(p.stripe_pi_id, true);
        }
        break;
      case 'tip_play':
        if (config.mode === 'companion') {
          const t = [...approved, ...pending].find(x => x.stripe_pi_id === p.stripe_pi_id);
          if (t && !playedIds.has(t.stripe_pi_id)) {
            markPlayed(t.stripe_pi_id);
            showTip(t);
          }
        }
        break;
    }
    if (pending.length > 500) pending = pending.slice(-500);
    if (approved.length > 500) approved = approved.slice(-500);
    sendState();
  }
  async function syncQueue() {
    if (!secret) return;
    try {
      const r = await fetch(`${KB_API}/api/tip_queue_sync?secret_id=${encodeURIComponent(secret)}`, {
        signal: AbortSignal.timeout(15000)
      });
      if (!r.ok) return;
      const j = await r.json();
      const list = (Array.isArray(j.tip_transactions) ? j.tip_transactions : [])
        .map(normalizeTip)
        .filter(t => t.stripe_pi_id);
      const pendIds = new Set(pending.map(t => t.stripe_pi_id)),
        apprIds = new Set(approved.map(t => t.stripe_pi_id));
      for (const t of list) {
        const id = t.stripe_pi_id;
        if ((playing && playing.stripe_pi_id === id) || playedIds.has(id)) continue;
        if (t.approval_status === 'approved') {
          if (pendIds.has(id)) {
            pending = pending.filter(x => x.stripe_pi_id !== id);
            approved.push(t);
          } else if (!apprIds.has(id)) approved.push(t);
        } else if (t.approval_status === 'pending' && !pendIds.has(id) && !apprIds.has(id)) pending.push(t);
      }
      const ids = new Set(list.map(t => t.stripe_pi_id));
      pending = pending.filter(t => ids.has(t.stripe_pi_id) || t.is_test || t.is_local);
      approved = approved.filter(t => ids.has(t.stripe_pi_id) || t.is_test || t.is_local);
      tryNext();
      sendState();
    } catch (e) {
      log('warn', 'همگام‌سازی صف کیک‌بات ناموفق بود', e.name === 'TimeoutError' ? 'timeout' : e.message);
    }
  }
  timers.push(
    setInterval(() => {
      if (secret) syncQueue();
    }, 60000)
  );
  // Same call the official KickBot widget makes when it starts showing a tip: it asks KickBot to capture the
  // (already authorised) payment. KickBot/Stripe decide the outcome; this app only relays the request.
  async function captureTip(t) {
    try {
      const r = await fetch(`${KB_API}/api/capture_tip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(20000),
        body: JSON.stringify({
          stripe_pi_id: t.stripe_pi_id,
          secret_id: secret,
          streamer_id: config.streamer_id,
          is_replay: !!t.is_replay,
          is_test: !!t.is_test
        })
      });
      if (r.status >= 500 || r.status === 429) {
        log('warn', 'capture_tip: HTTP ' + r.status + ' from KickBot', tipSummary(t));
        return 'retry';
      }
      const j = await r.json();
      log('info', 'capture_tip', { success: j.success, payment_success: j.payment_success });
      return j.payment_success === true ? 'ok' : 'failed'; // a parsed answer is definitive: KickBot/Stripe declined the capture
    } catch (e) {
      log('warn', 'capture_tip failed', e.name === 'TimeoutError' ? 'timeout' : e.message);
      return 'retry';
    } // network / timeout / non-JSON: transient
  }

  const capture =
    opts.testHooks && typeof opts.testHooks.captureTip === 'function' ? opts.testHooks.captureTip : captureTip;

  // ---------- minimal HTTPS client with optional HTTP CONNECT proxy ----------
  function httpsRequest(urlStr, { method = 'GET', headers = {}, body = null, proxy = '' } = {}, timeoutMs = 15000) {
    const u = new URL(urlStr);
    const doRequest = socket =>
      new Promise((resolve, reject) => {
        const o = { method, host: u.hostname, path: u.pathname + u.search, headers: { Host: u.hostname, ...headers } };
        if (socket) {
          o.socket = socket;
          o.agent = false;
          o.servername = u.hostname;
          o.createConnection = () => tls.connect({ socket, servername: u.hostname });
        }
        const req = https.request(o, res => {
          const chunks = [];
          let n = 0;
          res.on('data', c => {
            n += c.length;
            if (n > 4 * 1024 * 1024) {
              req.destroy(new Error('response larger than 4 MB'));
              return;
            }
            chunks.push(c);
          });
          res.on('end', () =>
            resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') })
          );
        });
        req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
      });
    if (!proxy) return doRequest(null);
    let pu;
    try {
      pu = new URL(proxy);
    } catch {
      return Promise.reject(new Error('bad proxy url'));
    }
    return new Promise((resolve, reject) => {
      const creq = http.request({
        host: pu.hostname,
        port: Number(pu.port) || 80,
        method: 'CONNECT',
        path: `${u.hostname}:${u.port || 443}`,
        headers: { Host: `${u.hostname}:${u.port || 443}` }
      });
      creq.setTimeout(timeoutMs, () => creq.destroy(new Error('proxy connect timeout')));
      creq.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          return reject(new Error('proxy CONNECT ' + res.statusCode));
        }
        doRequest(socket).then(resolve, reject);
      });
      creq.on('error', reject);
      creq.end();
    });
  }

  // ---------- Windows system proxy (a VPN app in "system proxy" mode). Node ignores it, so the Electron shell resolves
  // it (opts.systemProxy, Chromium's resolver incl. PAC) and it is tried after a manual proxy. ----------
  let systemProxyLabel = null;
  async function systemProxyFor(url) {
    if (typeof opts.systemProxy !== 'function') return '';
    let p = '';
    try {
      p = String((await opts.systemProxy(url)) || '');
    } catch {
      p = '';
    }
    if (!/^https?:\/\/\S+$/.test(p)) p = '';
    const label = p ? routeLabel(p) : null;
    if (label !== systemProxyLabel) {
      systemProxyLabel = label;
      if (label) log('info', 'پراکسی سیستم ویندوز پیدا شد', { proxy: label });
      sendState();
    }
    return p;
  }
  const routesFor = async (url, directFirst) =>
    routeOrder({ manual: config.rate.proxy, system: await systemProxyFor(url), directFirst });

  // ---------- USD -> Toman rate: baha24 public JSON API first, bonbast.com (scraped) as fallback. Never silently trusted. ----------
  let rateError = null,
    lastBonbastAttempt = 0,
    lastFx = null;
  async function fetchBaha24() {
    const attempt = async px => {
      const r = await httpsRequest(
        BAHA24,
        { headers: { 'User-Agent': UA, Accept: 'application/json' }, proxy: px },
        10000
      );
      if (r.status !== 200) throw new Error('baha24 HTTP ' + r.status);
      let j;
      try {
        j = JSON.parse(r.text);
      } catch {
        throw new Error('baha24 json unparsable');
      }
      const list = Array.isArray(j) ? j : j && Array.isArray(j.data) ? j.data : null;
      const usd = list ? list.find(x => x && String(x.symbol).toUpperCase() === 'USD') : null;
      lastFx = fxFromBaha24(list);
      if (!usd) throw new Error('baha24: USD not in response');
      const v = Number(String(usd.sell).replace(/,/g, ''));
      if (!Number.isFinite(v) || v < 1000 || v > 1e9)
        throw new Error('baha24 sell out of range: ' + String(usd.sell).slice(0, 20));
      return Math.round(v);
    };
    const order = await routesFor(BAHA24, true); // direct first (not filtered); manual proxy, then the system proxy as retries
    let lastErr;
    for (const px of order) {
      try {
        return await attempt(px);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  }
  async function fetchBonbast() {
    const attempt = async px => {
      const page = await httpsRequest(BONBAST, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
        proxy: px
      });
      if (page.status !== 200) throw new Error('bonbast page HTTP ' + page.status);
      const cookie = []
        .concat(page.headers['set-cookie'] || [])
        .map(c => c.split(';')[0])
        .join('; ');
      const m = /param:\s*"([^"]+)"/.exec(page.text);
      if (!m) throw new Error('bonbast token not found (page format changed?)');
      const body = 'param=' + encodeURIComponent(m[1]);
      const r = await httpsRequest(BONBAST + 'json', {
        method: 'POST',
        proxy: px,
        headers: {
          'User-Agent': UA,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          Referer: BONBAST,
          'X-Requested-With': 'XMLHttpRequest',
          Cookie: cookie
        },
        body
      });
      let j;
      try {
        j = JSON.parse(r.text);
      } catch {
        throw new Error('bonbast json unparsable');
      }
      const v = Number(String(j.usd1 || '').replace(/,/g, ''));
      if (!Number.isFinite(v) || v < 1000 || v > 1e9)
        throw new Error('bonbast usd1 out of range: ' + String(j.usd1).slice(0, 20));
      lastFx = fxFromBonbast(j);
      return Math.round(v);
    };
    const order = await routesFor(BONBAST, false); // bonbast is filtered in Iran: proxies first, direct last
    let lastErr;
    for (const px of order) {
      try {
        return await attempt(px);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  }
  let rateTimer = null,
    rateBusy = false;
  async function refreshRate(force) {
    if (!NODE_OK || rateBusy) return null;
    if (!config.rate.auto && !force) return null;
    rateBusy = true;
    try {
      let v,
        source = 'baha24';
      const errs = [];
      try {
        v = await fetchBaha24();
      } catch (e1) {
        errs.push('baha24: ' + e1.message);
        if (Date.now() - lastBonbastAttempt < LIMITS.minBonbastInterval * 60000)
          throw new Error(errs.join(' | ') + ' | bonbast: skipped (rate-limited)');
        lastBonbastAttempt = Date.now();
        try {
          v = await fetchBonbast();
          source = 'bonbast';
        } catch (e2) {
          errs.push('bonbast: ' + e2.message);
          throw new Error(errs.join(' | '));
        }
      }
      const changed = v !== config.rate.value || source !== config.rate.source;
      config.rate.value = v;
      config.rate.updatedAt = new Date().toISOString();
      config.rate.source = source;
      if (lastFx && Object.keys(lastFx).length) config.rate.fx = lastFx; // other currencies from the same answer
      rateError = null;
      saveConfig();
      if (changed) log('info', 'نرخ دلار به‌روز شد (' + source + ')', { toman: v });
      broadcast('admin', { type: 'rate', rate: config.rate, effective: currentRate() });
      sendState();
      return v;
    } catch (e) {
      rateError = e.message;
      log('warn', 'دریافت نرخ دلار ناموفق بود؛ نرخ قبلی استفاده می‌شود', e.message);
      sendState();
      return null;
    } finally {
      rateBusy = false;
    }
  }
  function scheduleRate() {
    clearInterval(rateTimer);
    rateTimer = setInterval(
      () => refreshRate(false),
      Math.max(LIMITS.minRateInterval, Number(config.rate.intervalMin) || 2) * 60000
    );
  }
  function currentRate() {
    return Number(config.rate.manual) > 0 ? Number(config.rate.manual) : Number(config.rate.value) || 0;
  }
  function tomanOf(usd) {
    const r = currentRate();
    return r ? Math.round(usd * r) : null;
  }

  // ---------- media ----------
  function newFileEntry(file, size) {
    const name = path.basename(file, path.extname(file));
    return {
      id: crypto.randomBytes(5).toString('hex'),
      file,
      name,
      type: typeOf(file),
      enabled: true,
      minToman: parseThreshold(name),
      maxToman: null,
      minAmount: 0,
      maxAmount: null,
      keywords: [],
      volume: 100,
      duration: null,
      cardDelay: null,
      size
    };
  }
  function uniqueMediaName(orig) {
    const base = safeMediaName(orig);
    let file = base,
      i = 1;
    while (fs.existsSync(path.join(MEDIA, file))) {
      const e = path.extname(base);
      file = base.slice(0, -e.length) + '_' + i++ + e;
    }
    return file;
  }
  // Import files by absolute path (desktop dialog / drag & drop). Copies into the managed folder; the source is never modified.
  function importFiles(paths) {
    const added = [],
      skipped = [];
    for (const src0 of (Array.isArray(paths) ? paths : []).slice(0, 100)) {
      const src = String(src0 || '');
      const shown = path.basename(src);
      try {
        if (!path.isAbsolute(src)) {
          skipped.push(shown + ' (مسیر نامعتبر)');
          continue;
        }
        const real = fs.realpathSync(src); // resolves symlinks/junctions to the actual file
        const st = fs.statSync(real);
        const ext = path.extname(real).toLowerCase(),
          type = typeOf(real);
        if (!st.isFile() || !type) {
          skipped.push(shown + ' (فرمت پشتیبانی نمی‌شود)');
          continue;
        }
        if (st.size > LIMITS.upload) {
          skipped.push(shown + ' (بزرگ‌تر از ۵۱۲ مگابایت)');
          continue;
        }
        if (config.files.length >= LIMITS.files) {
          skipped.push(shown + ' (سقف تعداد فایل)');
          continue;
        }
        const fd = fs.openSync(real, 'r');
        const head = Buffer.alloc(16);
        fs.readSync(fd, head, 0, 16, 0);
        fs.closeSync(fd);
        if (!sniffOk(head, ext)) {
          skipped.push(shown + ' (محتوای فایل با پسوندش نمی‌خواند)');
          continue;
        }
        const file = uniqueMediaName(real);
        fs.copyFileSync(real, path.join(MEDIA, file));
        const entry = newFileEntry(file, st.size);
        config.files.push(entry);
        added.push(entry);
        log('info', 'فایل اضافه شد', { file, type });
      } catch (e) {
        skipped.push(shown);
        log('warn', 'افزودن فایل ناموفق', e.message);
      }
    }
    if (added.length) saveConfig();
    sendState();
    return { added, skipped };
  }

  // ---------- Meld Studio self-heal (loopback only) ----------
  let meldLastReload = 0;
  function meldReloadLayers(reason) {
    return new Promise(resolve => {
      if (opts.meldSelfHeal !== true) return resolve(false); // opt-in: only the Electron shell enables it; embedded/test instances never touch the user's Meld layers
      let mws;
      try {
        mws = new WebSocket(MELD_WS);
      } catch {
        return resolve(false);
      }
      let id = 1;
      const waiting = new Map();
      let done = false;
      const finish = v => {
        if (!done) {
          done = true;
          try {
            mws.close();
          } catch {}
          resolve(v);
        }
      };
      const send = msg =>
        new Promise(res => {
          const i = id++;
          waiting.set(i, res);
          mws.send(JSON.stringify({ ...msg, id: i }));
        });
      const t = setTimeout(() => finish(false), 8000);
      mws.onerror = () => finish(false);
      mws.onmessage = ev => {
        try {
          const m = JSON.parse(ev.data);
          if (m.id && waiting.has(m.id)) {
            waiting.get(m.id)(m.data);
            waiting.delete(m.id);
          }
        } catch {}
      };
      mws.onopen = async () => {
        try {
          const objs = await send({ type: 3 });
          const meld = objs && objs.meld;
          if (!meld) return finish(false);
          const methods = Object.fromEntries((meld.methods || []).map(([n, i]) => [n, i]));
          const props = {};
          for (const pr of meld.properties || []) props[pr[1]] = pr[3];
          const all = (props.session && props.session.items) || {};
          const isOurs = u => {
            try {
              const x = new URL(String(u || ''));
              return (
                x.protocol === 'http:' &&
                ['localhost', '127.0.0.1'].includes(x.hostname) &&
                Number(x.port) === Number(config.port) &&
                x.pathname.replace(/\/+$/, '') === '/overlay'
              );
            } catch {
              return false;
            }
          };
          const mine = Object.entries(all).filter(([, l]) => l.type === 'layer' && isOurs(l.url));
          for (const [lid] of mine)
            await send({
              type: 6,
              object: 'meld',
              method: methods.setProperty,
              args: [lid, 'url', `http://localhost:${config.port}/overlay?r=${Date.now()}`]
            });
          clearTimeout(t);
          log('info', 'لایه‌های Browser داخل Meld ری‌لود شدند', { count: mine.length, reason });
          meldLastReload = Date.now();
          finish(mine.length > 0);
        } catch {
          finish(false);
        }
      };
    });
  }
  let overlayMissingSince = Date.now();
  timers.push(
    setInterval(() => {
      if (clients.overlay.size > 0) {
        overlayMissingSince = Date.now();
        return;
      }
      if (Date.now() - overlayMissingSince > 20000 && Date.now() - meldLastReload > 120000) {
        meldLastReload = Date.now();
        meldReloadLayers('no overlay connected');
      }
    }, 5000)
  );

  // ---------- Kick subs / gifted subs (public chat feed; undocumented, see DATA_FLOW.md) ----------
  let kws = null,
    kickPing = null,
    kickRetry = 5000;
  const kickState = { connected: false, error: null, hint: null };
  const recentKeys = new Map();
  function seenRecently(key, ms = 2500) {
    const now = Date.now();
    for (const [k, t] of recentKeys) if (now - t > 60000) recentKeys.delete(k);
    if (recentKeys.has(key) && now - recentKeys.get(key) < ms) return true;
    recentKeys.set(key, now);
    return false;
  }
  async function resolveKickChannel() {
    const slug = String(config.kick.channel || '')
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\/(www\.)?kick\.com\//, '')
      .replace(/[/?#].*$/, '')
      .replace(/^@/, '');
    if (!/^[a-z0-9_.-]{1,40}$/.test(slug)) {
      if (slug) {
        kickState.error = 'اسم کانال نامعتبر است';
        kickState.hint = 'فقط اسم کانال را بنویسید (حروف انگلیسی، عدد، _ . -)، مثلاً amireyzed.';
        sendState();
      }
      return false;
    }
    if (config.kick.chatroomId && config.kick.resolvedFor === slug) return true;
    const attempts = [];
    for (const px of await routesFor(KICK_CHANNEL_API, false)) {
      try {
        const r = await httpsRequest(KICK_CHANNEL_API + encodeURIComponent(slug), {
          headers: { 'User-Agent': UA, Accept: 'application/json' },
          proxy: px
        });
        if (r.status !== 200) {
          const e = new Error('kick api HTTP ' + r.status);
          e.httpStatus = r.status;
          throw e;
        }
        let j;
        try {
          j = JSON.parse(r.text);
        } catch {
          const e = new Error('kick api: response is not JSON');
          e.kind = 'parse';
          throw e;
        }
        const chatroomId = Number(j && j.chatroom && j.chatroom.id),
          channelId = Number(j && j.id);
        if (!chatroomId) {
          const e = new Error('kick api: chatroom not in response');
          e.kind = 'parse';
          throw e;
        }
        config.kick.channel = slug;
        config.kick.chatroomId = chatroomId;
        config.kick.channelId = channelId || null;
        config.kick.resolvedFor = slug;
        saveConfig();
        kickState.error = null;
        kickState.hint = null;
        log('info', 'کانال کیک شناسایی شد', { channel: slug, chatroom: chatroomId, via: routeLabel(px) });
        return true;
      } catch (e) {
        attempts.push({ route: px, err: e });
        if (e.httpStatus === 404) break; // definitive: no such channel, other routes would say the same
      }
    }
    const d = describeKickFailure(attempts);
    kickState.error = d.error;
    kickState.hint = d.hint;
    log(
      'warn',
      'شناسایی کانال کیک ناموفق بود: ' + d.error,
      attempts
        .map(
          a =>
            routeLabel(a.route) + ': ' + (a.err.httpStatus ? 'HTTP ' + a.err.httpStatus : a.err.code || a.err.message)
        )
        .join(' | ')
    );
    sendState();
    return false;
  }
  // ---------- StreamElements: tips from the streamer's own SE tipping page. Same shape as the KickBot link: one
  // token, one websocket, tips enter the queue. Tips are already paid on SE's side, so there is no capture call. ----------
  const SE_WS = 'wss://astro.streamelements.com';
  const SE_ME = 'https://api.streamelements.com/kappa/v2/channels/me';
  let sews = null,
    seReconnectTimer = null,
    seReconnectToken = '',
    seSubscribed = false,
    seError = null;
  const seConfigured = () => !!(seToken && config.se.channelId);
  function seStatus() {
    if (!seConfigured()) return 'unconfigured';
    if (seError) return 'error';
    if (sews && sews.readyState === 1 && seSubscribed) return 'connected';
    if (sews && (sews.readyState === 0 || sews.readyState === 1)) return 'connecting';
    return 'reconnecting';
  }
  function sePublic() {
    return {
      configured: seConfigured(),
      status: seStatus(),
      username: config.se.username,
      provider: config.se.provider,
      error: seError
    };
  }
  function seScheduleReconnect(ms) {
    clearTimeout(seReconnectTimer);
    if (!stopped && seConfigured()) seReconnectTimer = setTimeout(seConnect, ms || 5000);
  }
  function seConnect() {
    if (stopped || !NODE_OK || !seConfigured()) return;
    if (sews && (sews.readyState === 0 || sews.readyState === 1)) return;
    seSubscribed = false;
    let sock;
    try {
      sock = new WebSocket(
        seReconnectToken ? SE_WS + '/?reconnect_token=' + encodeURIComponent(seReconnectToken) : SE_WS
      );
    } catch (e) {
      log('error', 'StreamElements: WebSocket create failed', e.message);
      return seScheduleReconnect();
    }
    sews = sock;
    const connTimeout = setTimeout(() => {
      if (sock.readyState === 0) {
        try {
          sock.close();
        } catch {}
      }
    }, 15000);
    sock.onopen = () => clearTimeout(connTimeout);
    sock.onmessage = ev => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!m || typeof m !== 'object') return;
      if (m.type === 'welcome') {
        seReconnectToken = '';
        sock.send(
          JSON.stringify({
            type: 'subscribe',
            nonce: crypto.randomUUID(),
            data: { topic: 'channel.activities', room: config.se.channelId, token: seToken, token_type: 'jwt' }
          })
        );
      } else if (m.type === 'response') {
        if (m.error) {
          const msg = String((m.data && m.data.message) || m.error).slice(0, 160);
          seError = /unauth|signature|expired|invalid/i.test(msg)
            ? 'توکن StreamElements پذیرفته نشد؛ توکن جدید از داشبورد بگیرید و دوباره وارد کنید'
            : 'StreamElements: ' + msg;
          log('warn', 'StreamElements: اشتراک ناموفق بود', { error: String(m.error).slice(0, 60), message: msg });
          try {
            sock.close(); // a rejected token: close and retry only occasionally (the user may paste a new token)
          } catch {}
          clearTimeout(seReconnectTimer);
          seReconnectTimer = setTimeout(seConnect, 5 * 60 * 1000);
        } else {
          seSubscribed = true;
          seError = null;
          log('info', 'به StreamElements وصل شد', { username: config.se.username, provider: config.se.provider });
        }
        sendState();
      } else if (m.type === 'reconnect') {
        seReconnectToken = String((m.data && m.data.token) || m.token || '');
        try {
          sock.close();
        } catch {}
      } else if (m.type === 'message' && String(m.topic || '') === 'channel.activities') {
        handleSeActivity(m.data);
      }
    };
    sock.onerror = () => {};
    sock.onclose = ev => {
      clearTimeout(connTimeout);
      if (sews === sock) sews = null;
      const was = seSubscribed;
      seSubscribed = false;
      if (was && seConfigured() && !stopped) log('warn', 'اتصال StreamElements قطع شد، تلاش مجدد', { code: ev.code });
      sendState();
      if (!seError) seScheduleReconnect(seReconnectToken ? 500 : 5000);
    };
  }
  timers.push(
    setInterval(() => {
      if (seConfigured() && !seError && (!sews || sews.readyState === 3)) seConnect();
    }, 10000)
  );
  function handleSeActivity(a) {
    const t = parseSeActivity(a);
    if (!t) {
      if (a && a.type) log('info', 'StreamElements: رویداد نادیده گرفته شد', { type: String(a.type).slice(0, 30) });
      return;
    }
    if (
      playedIds.has(t.stripe_pi_id) ||
      approved.some(x => x.stripe_pi_id === t.stripe_pi_id) ||
      (playing && playing.stripe_pi_id === t.stripe_pi_id)
    )
      return;
    log('info', 'دونیت StreamElements', tipSummary(t));
    if (config.mode === 'companion') showTip(t);
    else {
      approved.push(t);
      tryNext();
    }
    sendState();
  }
  function seDisconnect() {
    seToken = '';
    config.se = { ...DEFAULT_CONFIG.se };
    seReconnectToken = '';
    seError = null;
    seSubscribed = false;
    clearTimeout(seReconnectTimer);
    if (sews) {
      try {
        sews.close();
      } catch {}
      sews = null;
    }
  }

  function kickConnect() {
    if (!NODE_OK || !config.kick.enabled || !config.kick.chatroomId) return;
    if (kws && (kws.readyState === 0 || kws.readyState === 1)) return;
    if (stopped) return;
    try {
      kws = new WebSocket(PUSHER_WS);
    } catch {
      return;
    }
    const sock = kws;
    sock.onmessage = ev => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.event === 'pusher:connection_established') {
        const chans = [`chatrooms.${config.kick.chatroomId}.v2`, `chatroom_${config.kick.chatroomId}`];
        if (config.kick.channelId) chans.push(`channel.${config.kick.channelId}`);
        for (const ch of chans)
          sock.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: ch } }));
        kickState.connected = true;
        kickState.error = null;
        kickState.hint = null;
        kickRetry = 5000;
        log('info', 'به چت کیک وصل شد (ساب / ساب‌گیفت)', { channel: config.kick.channel });
        clearInterval(kickPing);
        kickPing = setInterval(() => {
          try {
            sock.send(JSON.stringify({ event: 'pusher:ping', data: {} }));
          } catch {}
        }, 60000);
        sendState();
      } else if (m.event === 'pusher:ping') {
        try {
          sock.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
        } catch {}
      } else if (m.event === 'pusher:error') {
        log('warn', 'pusher error', m.data);
      } else if (/GiftedSubscriptionsEvent$/.test(m.event || '')) {
        let d = {};
        try {
          d = typeof m.data === 'string' ? JSON.parse(m.data) : m.data;
        } catch {}
        const names = Array.isArray(d.gifted_usernames)
          ? d.gifted_usernames.map(n => cleanText(n, LIMITS.name)).slice(0, 200)
          : [];
        handleGift(cleanText(d.gifter_username, LIMITS.name) || 'ناشناس', names);
      } else if (/\\SubscriptionEvent$/.test(m.event || '')) {
        let d = {};
        try {
          d = typeof m.data === 'string' ? JSON.parse(m.data) : m.data;
        } catch {}
        handleSub(cleanText(d.username, LIMITS.name) || 'ناشناس', finite(d.months, 1, 240, 1));
      }
    };
    sock.onerror = () => {};
    sock.onclose = () => {
      clearInterval(kickPing);
      if (kickState.connected) log('warn', 'اتصال چت کیک قطع شد؛ تلاش مجدد');
      kickState.connected = false;
      sendState();
      if (!stopped) setTimeout(kickConnect, kickRetry);
      kickRetry = Math.min(60000, kickRetry * 2);
    };
  }
  timers.push(
    setInterval(() => {
      if (config.kick.enabled && config.kick.chatroomId && (!kws || kws.readyState === 3)) kickConnect();
    }, 15000)
  );
  function subValueToman(kind) {
    const v = Number(kind === 'gift' ? config.kick.giftValueToman : config.kick.subValueToman) || 0;
    if (v > 0) return v;
    const r = currentRate();
    return r ? Math.round(KICK_SUB_USD * r) : 0;
  }
  function localEvent(kind, name, toman, message, count, tags) {
    const rate = currentRate();
    // no rate yet (first run / offline) and no fixed toman value: keep the USD list price so the alert shows "$4.99" instead of "0 توم��ن"
    const usd = toman > 0 ? (rate ? toman / rate : KICK_SUB_USD * (count || 1)) : KICK_SUB_USD * (count || 1);
    return {
      stripe_pi_id: kind + '_' + crypto.randomBytes(6).toString('hex'),
      tipper_name: name,
      amount_total: Math.round(usd * 100),
      tip_message: cleanText(message, LIMITS.message),
      approval_status: 'approved',
      is_local: true,
      kind,
      count,
      tags,
      toman_override: toman > 0 ? toman : null,
      created_at: new Date().toISOString()
    };
  }
  function enqueueLocal(t) {
    log('info', t.kind === 'gift' ? 'ساب‌گیفت' : 'ساب جدید', {
      name: t.tipper_name,
      count: t.count,
      toman: t.toman_override
    });
    if (config.mode === 'companion') showTip(t);
    else {
      approved.push(t);
      tryNext();
    }
    sendState();
  }
  // Kick chat events carry no stable event id, so the same event arriving on more than one subscribed channel is
  // suppressed by (gifter + sorted recipients) / (name) within 2.5 s — echoes arrive within a few hundred ms.
  function handleGift(gifter, names, isTest) {
    const count = Math.max(1, names.length);
    if (!isTest && seenRecently(`gift:${gifter}:${names.slice().sort().join('|')}`)) return;
    const t = localEvent('gift', gifter, count * subValueToman('gift'), names.join('، '), count, [
      'giftsub',
      'gift',
      'sub'
    ]);
    if (isTest) t.is_test = true;
    enqueueLocal(t);
  }
  function handleSub(name, months, isTest) {
    if (!config.kick.showNewSubs && !isTest) return;
    if (!isTest && seenRecently(`sub:${name}`)) return;
    const t = localEvent('sub', name, subValueToman('sub'), months > 1 ? `${months} ماه` : '', months || 1, [
      'sub',
      'newsub'
    ]);
    if (isTest) t.is_test = true;
    enqueueLocal(t);
  }

  // ---------- queue / playback ----------
  // toman per unit of a currency: USD from the rate card (manual or fetched), others from the fetched fx table
  function fxRate(code) {
    if (!code || code === 'USD') return currentRate();
    const v = config.rate.fx && config.rate.fx[code];
    return Number.isFinite(v) && v > 0 ? v : null;
  }
  function tomanFor(t) {
    if (t.toman_override != null) return t.toman_override;
    const r = fxRate(t.currency || 'USD');
    return r ? Math.round(((t.amount_total || 0) / 100) * r) : null;
  }
  function tipSummary(t) {
    return {
      id: t.stripe_pi_id,
      name: t.tipper_name,
      amount: (t.amount_total || 0) / 100,
      currency: t.currency || 'USD',
      source: t.source || (t.is_local ? 'kick' : 'kickbot'),
      message: t.tip_message,
      test: !!t.is_test,
      kind: t.kind || 'tip',
      count: t.count || null
    };
  }
  let nextTimer = null,
    advancing = false;
  const captureFailures = new Map(); // stripe_pi_id -> attempts
  const CAPTURE_MAX_ATTEMPTS = 3,
    CAPTURE_RETRY_MS = Number(opts.captureRetryMs) || 15000;
  async function tryNext() {
    if (config.mode === 'companion' || advancing) return;
    if (playing || queueStatus !== 'play' || approved.length === 0) return;
    if (clients.overlay.size === 0) return; // wait until a Browser Source is open; nothing is lost
    const wait = lastEnd + queueDelay * 1000 - Date.now();
    if (wait > 0) {
      clearTimeout(nextTimer);
      nextTimer = setTimeout(tryNext, wait + 50);
      return;
    }
    const t = approved.shift();
    if (!t) return;
    if (!t.is_replay && playedIds.has(t.stripe_pi_id)) return tryNext();
    advancing = true;
    let next = false;
    try {
      playing = t;
      sendState();
      if (!t.is_test && !t.is_local) {
        const res = await capture(t);
        if (!playing || playing.stripe_pi_id !== t.stripe_pi_id) return; // skipped / cleared while capturing
        if (res !== 'ok') {
          playing = null;
          next = true; // nothing was shown, so the inter-alert gap does not apply
          if (res === 'failed') {
            // KickBot/Stripe answered and declined: the payment cannot be captured, the tip is over
            captureFailures.delete(t.stripe_pi_id);
            markPlayed(t.stripe_pi_id);
            log('error', 'پرداخت کپچر نشد، دونیت رد شد', tipSummary(t));
            publish('tip_end', { stripe_pi_id: t.stripe_pi_id });
            sendState();
            return;
          }
          // transient failure (network, timeout, KickBot 5xx): the tip is NOT marked as played, so an authorised payment is never lost
          const attempts = (captureFailures.get(t.stripe_pi_id) || 0) + 1;
          if (attempts >= CAPTURE_MAX_ATTEMPTS) {
            // leave the local queue for now; KickBot still lists the tip as approved, so the next queue sync brings it back
            captureFailures.delete(t.stripe_pi_id);
            log(
              'error',
              'پرداخت بعد از ' + attempts + ' تلاش کپچر نشد؛ بعد از همگام‌سازی بعدی صف دوباره تلاش می‌شود',
              tipSummary(t)
            );
            sendState();
            return;
          }
          captureFailures.set(t.stripe_pi_id, attempts);
          approved.push(t); // back to the end of the queue
          log('warn', 'پرداخت کپچر نشد؛ تلاش مجدد (' + attempts + '/' + CAPTURE_MAX_ATTEMPTS + ')', tipSummary(t));
          sendState();
          clearTimeout(nextTimer);
          nextTimer = setTimeout(tryNext, CAPTURE_RETRY_MS);
          next = approved.length > 1;
          return; // other tips need not wait; the failed one is retried after the delay
        }
        publish('tip_play', { stripe_pi_id: t.stripe_pi_id });
      }
      captureFailures.delete(t.stripe_pi_id);
      markPlayed(t.stripe_pi_id);
      showTip(t);
    } finally {
      advancing = false;
      if (next) tryNext();
    }
  }
  function showTip(t) {
    const media = pickMedia(t);
    if (!media && config.showAlertWithoutMedia === false) {
      log('info', 'آلرت بدون فایل نمایش داده نشد (طبق تنظیمات)', tipSummary(t));
      recent.unshift({
        ...tipSummary(t),
        toman: tomanFor(t),
        media: null,
        skipped: true,
        at: Date.now()
      });
      if (recent.length > 30) recent.pop();
      if (config.mode !== 'companion' && playing && playing.stripe_pi_id === t.stripe_pi_id) {
        if (!t.is_test && !t.is_local) publish('tip_end', { stripe_pi_id: t.stripe_pi_id });
        playing = null;
        lastEnd = Date.now();
        sendState();
        setTimeout(tryNext, 0);
      }
      return;
    }
    const payload = buildPayload(t, media);
    recent.unshift({ ...tipSummary(t), toman: payload.toman, media: media ? media.name : null, at: Date.now() });
    if (recent.length > 30) recent.pop();
    log('info', 'نمایش دونیت', { ...tipSummary(t), media: media ? media.file : '-' });
    broadcast('overlay', { type: 'play', tip: payload });
    clearTimeout(playTimeout);
    playTimeout = setTimeout(
      () => finishPlaying(t.stripe_pi_id, false, true),
      (config.appearance.maxDuration + 15) * 1000
    );
    sendState();
  }
  function finishPlaying(id, rejected, timedOut) {
    if (config.mode === 'companion') return;
    if (!playing || playing.stripe_pi_id !== id) return;
    clearTimeout(playTimeout);
    if (timedOut) log('warn', 'اورلی پایان پخش را اعلام نکرد؛ رد شدن به بعدی');
    if (!playing.is_test && !playing.is_local && !rejected) publish('tip_end', { stripe_pi_id: id });
    playing = null;
    lastEnd = Date.now();
    sendState();
    tryNext();
  }
  function buildPayload(t, media) {
    return {
      id: t.stripe_pi_id,
      name: cleanText(t.tipper_name, LIMITS.name) || 'ناشناس',
      amount: (t.amount_total || 0) / 100,
      currency: t.currency || 'USD',
      toman: tomanFor(t),
      rate: currentRate(),
      kind: t.kind || 'tip',
      count: t.count || null,
      message: cleanText(t.tip_message, LIMITS.message),
      gif_url: httpsUrl(t.gif_url),
      tts_url: httpsUrl(t.audio_url),
      is_test: !!t.is_test,
      media: media
        ? {
            url: '/media/' + encodeURIComponent(media.file),
            type: media.type,
            volume: media.volume ?? 100,
            duration: media.duration || null,
            cardDelay: media.cardDelay ?? null,
            name: media.name
          }
        : null
    };
  }
  function pickMedia(t) {
    const rate = currentRate();
    const toman = t.toman_override != null ? Number(t.toman_override) : tomanFor(t); // any currency with a known rate
    // dollar-based tiers (minAmount) see the dollar equivalent; a currency without a rate matches keyword files only
    const usd =
      t.currency && t.currency !== 'USD' ? (toman != null && rate ? toman / rate : 0) : (t.amount_total || 0) / 100;
    const msg = normFa(t.tip_message);
    const tags = (t.tags || []).map(x => normFa(x));
    const files = config.files.filter(f => f.enabled !== false && fs.existsSync(path.join(MEDIA, f.file)));
    const minT = f => (f.minToman != null ? Number(f.minToman) : rate ? (Number(f.minAmount) || 0) * rate : 0);
    const maxT = f =>
      f.maxToman != null ? Number(f.maxToman) : rate && f.maxAmount != null ? Number(f.maxAmount) * rate : null;
    const value = toman != null ? toman : usd;
    const inRange = f =>
      value >= (toman != null ? minT(f) : Number(f.minAmount) || 0) && (maxT(f) == null || value <= maxT(f));
    const kw = files.filter(
      f =>
        inRange(f) &&
        (f.keywords || []).some(k => {
          const n = normFa(k);
          return n && (msg.includes(n) || tags.includes(n));
        })
    );
    if (kw.length) return rand(kw);
    if (toman == null) return null; // no exchange rate yet: tiers cannot be evaluated; only keyword files (above) apply
    const noKw = files.filter(f => inRange(f) && !(f.keywords || []).length);
    if (!noKw.length) return null;
    const top = Math.max(...noKw.map(minT));
    return rand(noKw.filter(f => minT(f) === top));
  }
  function rand(a) {
    return a[crypto.randomInt(a.length)];
  }
  function makeTestTip({ name, amount, message }) {
    return {
      stripe_pi_id: 'test_' + crypto.randomBytes(6).toString('hex'),
      tipper_name: cleanText(name, LIMITS.name) || 'تستی',
      amount_total: Math.round(finite(amount, 0, 1e6, 5) * 100),
      tip_message: cleanText(message, LIMITS.message),
      approval_status: 'approved',
      is_test: true,
      created_at: new Date().toISOString()
    };
  }
  function simulate(toman, tags) {
    const m = pickMedia({ amount_total: 0, tip_message: '', tags: tags || [], toman_override: toman });
    return m ? { id: m.id, name: m.name, file: m.file } : null;
  }

  // ---------- HTTP ----------
  function json(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  }
  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let n = 0;
      req.on('data', c => {
        n += c.length;
        if (n > limit) {
          reject(new Error('too large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }
  async function readJson(req) {
    const b = await readBody(req, 1024 * 1024);
    try {
      const v = JSON.parse(b.toString('utf8') || '{}');
      return v && typeof v === 'object' ? v : {};
    } catch {
      return {};
    }
  }
  const CSP_APP =
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";
  const CSP_OVERLAY =
    "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' https:; media-src 'self' https:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
  function serveFile(req, res, fp, csp) {
    fs.stat(fp, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404);
        return res.end('not found');
      }
      if (csp) res.setHeader('Content-Security-Policy', csp);
      const type = MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream';
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        if (!m) {
          res.writeHead(416);
          return res.end();
        }
        let start, end;
        if (!m[1] && m[2]) {
          start = Math.max(0, st.size - parseInt(m[2], 10));
          end = st.size - 1;
        } // suffix range: last N bytes
        else {
          start = m[1] ? parseInt(m[1], 10) : 0;
          end = m[2] ? parseInt(m[2], 10) : st.size - 1;
        }
        if (start >= st.size) {
          res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
          return res.end();
        }
        end = Math.min(end, st.size - 1);
        res.writeHead(206, {
          'Content-Type': type,
          'Content-Range': `bytes ${start}-${end}/${st.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
          'Cache-Control': 'no-cache'
        });
        fs.createReadStream(fp, { start, end }).pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Type': type,
          'Content-Length': st.size,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-cache'
        });
        fs.createReadStream(fp).pipe(res);
      }
    });
  }
  function servePublic(req, res, rel) {
    const fp = path.normalize(path.join(PUB, rel));
    if (!fp.startsWith(path.normalize(PUB + path.sep))) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    return serveFile(req, res, fp);
  }
  // loopback hardening: Host must be a loopback name with our port (DNS rebinding); browser-originated
  // state changes must come from our own origin (CSRF). Requests without an Origin header (curl, the Electron main process) pass.
  const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
  const hostAllowed = req => {
    const h = String(req.headers.host || '').toLowerCase();
    return LOCAL_HOSTS.some(n => h === n || h === `${n}:${config.port}`);
  };
  const originAllowed = req => {
    const o = req.headers.origin;
    if (o == null) return true;
    const s = String(o).toLowerCase();
    return LOCAL_HOSTS.some(n => s === `http://${n}:${config.port}`);
  };
  const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  const STATIC = /^\/(app\.css|app\.js|overlay\.css|overlay\.js)$/;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let p = url.pathname.toLowerCase().replace(/\/+$/, '') || '/';
    if (!hostAllowed(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('forbidden host');
    }
    if (MUTATING.has(req.method) && !originAllowed(req)) {
      log('warn', 'درخواست خارجی رد شد (origin)', { origin: String(req.headers.origin).slice(0, 100), path: p });
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('forbidden origin');
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    if (/^\/(overlay|overlay\.html|overly|overlai|alert|alerts|browser|source)$/.test(p)) p = '/overlay';
    if (/^\/(app|admin|panel|index\.html|admin\.html|app\.html)$/.test(p)) p = '/';
    try {
      // ---- pages & static ----
      if (p === '/') return serveFile(req, res, path.join(PUB, 'app.html'), CSP_APP);
      if (p === '/overlay') return serveFile(req, res, path.join(PUB, 'overlay.html'), CSP_OVERLAY);
      if (STATIC.test(p) || p.startsWith('/fonts/') || p.startsWith('/brand/') || p.startsWith('/legal/'))
        return servePublic(req, res, decodeURIComponent(url.pathname.slice(1)));
      if (p.startsWith('/media/')) {
        // only files that are registered alerts: never other content of the media folder (notes, partial uploads)
        const name = path.basename(decodeURIComponent(url.pathname.slice(7)));
        const entry =
          config.files.find(f => f.file === name) ||
          config.files.find(f => f.file.toLowerCase() === name.toLowerCase());
        if (!entry) return json(res, 404, { error: 'not found' });
        return serveFile(req, res, path.join(MEDIA, entry.file));
      }
      // ---- events: the Browser Source only ever receives {config(appearance), play, stop} ----
      if (p === '/events') {
        const role = url.searchParams.get('role') || 'overlay';
        if (!clients[role]) return json(res, 400, { error: 'bad role' });
        // A page on another site can open an EventSource to this server; the browser cannot read the answer, but the
        // connection alone would count as a Browser Source and consume alerts. Browsers send Origin (and Sec-Fetch-Site)
        // on such a request, while our own pages, OBS and Meld are same-origin.
        if (!originAllowed(req) || String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
          log('warn', 'اتصال اورلی از یک صفحه‌ی خارجی رد شد', {
            origin: String(req.headers.origin || '').slice(0, 100),
            role
          });
          return json(res, 403, { error: 'forbidden origin' });
        }
        if (clients[role].size >= (LIMITS.sse[role] || 4)) {
          log('warn', 'تعداد اتصال‌های هم‌زمان به صف رویدادها پر است', { role, open: clients[role].size });
          return json(res, 429, { error: 'too many connections' });
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no'
        });
        res.write(':ok\n\n');
        clients[role].add(res);
        res.write(`data: ${JSON.stringify({ type: 'config', appearance: config.appearance })}\n\n`);
        if (role === 'admin') res.write(`data: ${JSON.stringify({ type: 'state', state: publicState() })}\n\n`);
        const ka = setInterval(() => {
          try {
            res.write(':ka\n\n');
          } catch {}
        }, 15000);
        req.on('close', () => {
          clearInterval(ka);
          clients[role].delete(res);
          if (role === 'overlay') sendState();
        });
        if (role === 'overlay') {
          log('info', 'اورلی (Browser Source) وصل شد');
          sendState();
          tryNext();
        }
        return;
      }
      // ---- controller API ----
      if (p === '/api/config' && req.method === 'GET')
        return json(res, 200, {
          config: publicConfig(),
          state: publicState(),
          logs,
          mediaDir: MEDIA,
          dataDir: DATA,
          effectiveRate: currentRate(),
          version: APP_VERSION,
          fonts: FONTS
        });
      if (p === '/api/config' && req.method === 'POST') {
        const body = await readJson(req);
        if (body.appearance) config.appearance = sanitizeAppearance(body.appearance);
        if (Array.isArray(body.files)) {
          // update existing entries by id; unknown ids are ignored and nothing is removed (use DELETE /api/file)
          for (const raw of body.files) {
            const cur = raw && config.files.find(x => x.id === raw.id);
            if (!cur) continue;
            const merged = sanitizeFile({ ...cur, ...raw, id: cur.id, file: cur.file, size: cur.size });
            if (merged) Object.assign(cur, merged);
          }
        }
        if (body.mode && ENUMS.mode.includes(body.mode)) config.mode = body.mode;
        if (typeof body.showAlertWithoutMedia === 'boolean') config.showAlertWithoutMedia = body.showAlertWithoutMedia;
        if (body.app && typeof body.app === 'object')
          config.app = {
            ...config.app,
            autostart: body.app.autostart === undefined ? config.app.autostart : !!body.app.autostart,
            updateCheck: body.app.updateCheck === undefined ? config.app.updateCheck !== false : !!body.app.updateCheck
          };
        if (body.kick && typeof body.kick === 'object') {
          const k = body.kick,
            prevSlug = config.kick.channel,
            prevEnabled = config.kick.enabled;
          const next = { ...config.kick };
          if ('enabled' in k) next.enabled = !!k.enabled;
          if ('showNewSubs' in k) next.showNewSubs = !!k.showNewSubs;
          if ('giftValueToman' in k) next.giftValueToman = finite(k.giftValueToman, 0, 1e12, 0);
          if ('subValueToman' in k) next.subValueToman = finite(k.subValueToman, 0, 1e12, 0);
          if (typeof k.channel === 'string')
            next.channel = k.channel
              .trim()
              .toLowerCase()
              .replace(/^https?:\/\/(www\.)?kick\.com\//, '')
              .replace(/^@/, '')
              .replace(/[^a-z0-9_.-]/g, '')
              .slice(0, 40);
          config.kick = next;
          if (config.kick.channel !== prevSlug) {
            config.kick.chatroomId = null;
            config.kick.channelId = null;
            config.kick.resolvedFor = null;
          }
          saveConfig();
          if (kws) {
            try {
              kws.close();
            } catch {}
            kws = null;
          }
          if (config.kick.enabled)
            resolveKickChannel().then(ok => {
              if (ok) kickConnect();
            });
          else if (prevEnabled) kickState.connected = false;
        }
        if (body.rate && typeof body.rate === 'object') {
          const r = body.rate;
          config.rate = {
            ...config.rate,
            auto: !!r.auto,
            manual: intOrNull(r.manual, 1000, 1e9),
            intervalMin: Math.max(LIMITS.minRateInterval, finite(r.intervalMin, LIMITS.minRateInterval, 1440, 2)),
            proxy: /^(https?:\/\/[^\s]{1,200})?$/.test(String(r.proxy ?? '').trim())
              ? String(r.proxy ?? '').trim()
              : config.rate.proxy
          };
          scheduleRate();
          if (config.rate.auto) refreshRate(false);
        }
        saveConfig();
        broadcast('overlay', { type: 'config', appearance: config.appearance });
        broadcast('preview', { type: 'config', appearance: config.appearance });
        sendState();
        return json(res, 200, { ok: true, config: publicConfig() });
      }
      if (p === '/api/file' && req.method === 'PATCH') {
        const body = await readJson(req);
        const f = config.files.find(x => x.id === body.id);
        if (!f) return json(res, 404, { error: 'not found' });
        const merged = sanitizeFile({ ...f, ...body, id: f.id, file: f.file, size: f.size });
        if (!merged) return json(res, 400, { error: 'invalid' });
        Object.assign(f, merged);
        saveConfig();
        sendState();
        return json(res, 200, { ok: true, file: f });
      }
      if (p === '/api/upload' && (req.method === 'PUT' || req.method === 'POST')) {
        const orig = decodeURIComponent(url.searchParams.get('name') || 'file');
        const ext = path.extname(orig).toLowerCase();
        const type = typeOf(orig);
        if (!type) return json(res, 400, { error: 'فرمت فایل پشتیبانی نمی‌شود' });
        if (config.files.length >= LIMITS.files) return json(res, 400, { error: 'سقف تعداد فایل' });
        const tmp = path.join(MEDIA, '.upload-' + crypto.randomBytes(6).toString('hex') + '.tmp');
        let size = 0,
          head = Buffer.alloc(0);
        try {
          await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(tmp);
            let failed = null;
            const fail = err => {
              if (!failed) failed = err;
              req.unpipe(out);
              if (!out.destroyed) out.destroy();
            };
            out.on('close', () => (failed ? reject(failed) : resolve())); // 'close' = data flushed AND handle released, so the file can be renamed/unlinked (Windows)
            out.on('error', fail);
            req.on('error', fail);
            req.on('close', () => {
              if (!req.complete) fail(new Error('aborted'));
            });
            req.on('data', c => {
              size += c.length;
              if (head.length < 16) head = Buffer.concat([head, c]).subarray(0, 16);
              if (size > LIMITS.upload) {
                fail(new Error('too large'));
                req.destroy();
              }
            });
            req.pipe(out);
          });
        } catch (e) {
          try {
            fs.unlinkSync(tmp);
          } catch {}
          return json(res, 413, { error: 'فایل بزرگ‌تر از ۵۱۲ مگابایت است' });
        }
        if (!sniffOk(head, ext)) {
          try {
            fs.unlinkSync(tmp);
          } catch {}
          return json(res, 400, { error: 'محتوای فایل با پسوندش نمی‌خواند' });
        }
        const file = uniqueMediaName(orig);
        fs.renameSync(tmp, path.join(MEDIA, file));
        const entry = newFileEntry(file, size);
        config.files.push(entry);
        saveConfig();
        log('info', 'فایل اضافه شد', { file, type });
        sendState();
        return json(res, 200, { ok: true, entry });
      }
      if (p === '/api/scan' && req.method === 'POST') {
        let added = 0;
        for (const f of fs.readdirSync(MEDIA)) {
          const type = typeOf(f);
          if (!type || config.files.some(x => x.file === f) || config.files.length >= LIMITS.files) continue;
          const fp = path.join(MEDIA, f);
          const st = fs.statSync(fp);
          if (!st.isFile()) continue;
          try {
            const fd = fs.openSync(fp, 'r');
            const head = Buffer.alloc(16);
            fs.readSync(fd, head, 0, 16, 0);
            fs.closeSync(fd);
            if (!sniffOk(head, path.extname(f).toLowerCase())) continue;
          } catch {
            continue;
          }
          config.files.push(newFileEntry(f, st.size));
          added++;
        }
        config.files = config.files.filter(f => fs.existsSync(path.join(MEDIA, f.file)));
        saveConfig();
        sendState();
        return json(res, 200, { ok: true, added, files: config.files });
      }
      if (p === '/api/file' && req.method === 'DELETE') {
        const id = url.searchParams.get('id');
        const f = config.files.find(x => x.id === id);
        if (f) {
          config.files = config.files.filter(x => x.id !== id);
          try {
            fs.unlinkSync(path.join(MEDIA, f.file));
          } catch {}
          saveConfig();
          sendState();
        }
        return json(res, 200, { ok: true });
      }
      // ---- test / preview (never touch KickBot: is_test/is_local skip capture and tip_play/tip_end) ----
      if (p === '/api/test' && req.method === 'POST') {
        const t = makeTestTip(await readJson(req));
        if (config.mode === 'companion') showTip(t);
        else {
          approved.push(t);
          tryNext();
        }
        if (clients.overlay.size === 0) log('warn', 'هیچ Browser Source ای متصل نیست؛ دونیت تستی در صف ماند');
        sendState();
        return json(res, 200, { ok: true, tip: tipSummary(t) });
      }
      if (p === '/api/preview' && req.method === 'POST') {
        const body = await readJson(req);
        let t;
        if (body.kind === 'gift') {
          const n = Math.max(1, Math.min(100, finite(body.count, 1, 100, 3)));
          t = localEvent(
            'gift',
            cleanText(body.name, LIMITS.name) || 'Tester',
            n * subValueToman('gift'),
            Array.from({ length: n }, (_, i) => 'viewer' + (i + 1)).join('، '),
            n,
            ['giftsub', 'gift', 'sub']
          );
          t.is_test = true;
        } else if (body.kind === 'sub') {
          t = localEvent('sub', cleanText(body.name, LIMITS.name) || 'Tester', subValueToman('sub'), '', 1, [
            'sub',
            'newsub'
          ]);
          t.is_test = true;
        } else t = makeTestTip(body);
        const media = body.fileId ? config.files.find(f => f.id === body.fileId) : pickMedia(t);
        broadcast('preview', { type: 'play', tip: buildPayload(t, media || null) });
        return json(res, 200, { ok: true });
      }
      if (p === '/api/test-sub' && req.method === 'POST') {
        const body = await readJson(req);
        const n = Math.max(1, Math.min(100, finite(body.count, 1, 100, 1)));
        if (body.kind === 'sub')
          handleSub(cleanText(body.name, LIMITS.name) || 'Tester', finite(body.months, 1, 240, 1), true);
        else
          handleGift(
            cleanText(body.name, LIMITS.name) || 'Tester',
            Array.from({ length: n }, (_, i) => 'viewer' + (i + 1)),
            true
          );
        return json(res, 200, { ok: true });
      }
      if (p === '/api/simulate' && req.method === 'GET') {
        const per = subValueToman('sub'),
          perGift = subValueToman('gift');
        const rows = [{ label: 'sub', toman: per, media: simulate(per, ['sub', 'newsub']) }];
        for (const n of [1, 2, 3, 5, 10, 20])
          rows.push({
            label: 'gift',
            count: n,
            toman: n * perGift,
            media: simulate(n * perGift, ['giftsub', 'gift', 'sub'])
          });
        return json(res, 200, { ok: true, rate: currentRate(), rows });
      }
      // ---- KickBot connection: the widget URL is parsed here and only the secret is kept (encrypted) ----
      if (p === '/api/setup' && req.method === 'POST') {
        const body = await readJson(req);
        const raw = String(body.url || '')
          .trim()
          .slice(0, 500);
        const m =
          /tipping\/([0-9a-f]{32})(?::|%3A|%3a)([0-9a-f]{32})/i.exec(raw) ||
          /^([0-9a-f]{32}):([0-9a-f]{32})$/i.exec(raw);
        if (!m)
          return json(res, 400, {
            error: 'لینک ویجت معتبر نیست. باید شبیه https://widgets.kickbot.com/external/tipping/....%3A.... باشد'
          });
        const sec = `${m[1]}:${m[2]}`.toLowerCase();
        let streamer = null;
        try {
          const r = await fetch(`${KB_API}/external/tipping/${encodeURIComponent(sec)}/__data.json`, {
            signal: AbortSignal.timeout(15000)
          });
          const j = await r.json();
          for (const node of j.nodes || []) {
            const d = node && node.data;
            if (!Array.isArray(d) || !d[0] || typeof d[0] !== 'object') continue;
            if (d[0].streamer_db_id != null) {
              streamer = d[d[0].streamer_db_id];
              break;
            }
          }
        } catch (e) {
          return json(res, 502, {
            error: 'اتصال به کیک‌بات ممکن نشد: ' + (e.name === 'TimeoutError' ? 'timeout' : e.message)
          });
        }
        if (!Number.isFinite(Number(streamer)))
          return json(res, 400, { error: 'کیک‌بات این لینک را نشناخت (Streamer ID پیدا نشد)' });
        secret = sec;
        config.streamer_id = Number(streamer);
        saveConfig();
        log('info', 'لینک ویجت کیک‌بات تنظیم شد', { streamer_id: config.streamer_id, secretStorage });
        if (ws) {
          try {
            ws.close();
          } catch {}
        } else connect();
        sendState();
        return json(res, 200, { ok: true, streamer_id: config.streamer_id, secretStorage });
      }
      if (p === '/api/se/setup' && req.method === 'POST') {
        const body = await readJson(req);
        const token = String(body.token || '').trim();
        if (!seTokenOk(token))
          return json(res, 400, {
            error: 'توکن معتبر نیست. توکن JWT را از داشبورد StreamElements (Account → Channels → Show secrets) کپی کنید'
          });
        let me = null,
          lastErr = null;
        for (const px of await routesFor(SE_ME, true)) {
          try {
            const r = await httpsRequest(
              SE_ME,
              {
                headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', 'User-Agent': UA },
                proxy: px
              },
              15000
            );
            if (r.status === 401 || r.status === 403) {
              lastErr = new Error('rejected');
              break;
            }
            if (r.status !== 200) throw new Error('HTTP ' + r.status);
            me = JSON.parse(r.text);
            break;
          } catch (e) {
            lastErr = e;
          }
        }
        if (!me) {
          const rejected = lastErr && lastErr.message === 'rejected';
          return json(res, rejected ? 400 : 502, {
            error: rejected
              ? 'StreamElements این توکن را قبول نکرد؛ مطمئن شوید توکن JWT کامل و به‌روز است'
              : 'اتصال به StreamElements ممکن نشد: ' + (lastErr ? lastErr.message : 'unknown')
          });
        }
        const channelId = String(me._id || '').replace(/[^A-Za-z0-9]/g, '');
        if (!channelId) return json(res, 400, { error: 'StreamElements شناسه‌ی کانال را برنگرداند' });
        seDisconnect();
        seToken = token;
        config.se = {
          channelId,
          username: cleanText(me.username || me.displayName || '', 60) || null,
          provider: cleanText(me.provider || '', 20) || null
        };
        saveConfig();
        log('info', 'حساب StreamElements وصل شد', {
          username: config.se.username,
          provider: config.se.provider,
          secretStorage
        });
        seConnect();
        sendState();
        return json(res, 200, { ok: true, username: config.se.username, provider: config.se.provider, secretStorage });
      }
      if (p === '/api/se/disconnect' && req.method === 'POST') {
        seDisconnect();
        approved = approved.filter(t => t.source !== 'streamelements');
        saveConfig();
        log('info', 'اتصال StreamElements حذف شد');
        sendState();
        return json(res, 200, { ok: true });
      }
      if (p === '/api/disconnect-kickbot' && req.method === 'POST') {
        secret = '';
        config.streamer_id = null;
        pending = [];
        approved = [];
        saveConfig();
        if (ws) {
          try {
            ws.close();
          } catch {}
          ws = null;
        }
        log('info', 'اتصال کیک‌بات حذف شد');
        sendState();
        return json(res, 200, { ok: true });
      }
      if (p === '/api/reset-settings' && req.method === 'POST') {
        // appearance, kick, rate and mode go back to defaults; files, the KickBot connection and app options are kept
        config.appearance = { ...DEFAULT_CONFIG.appearance };
        config.rate = { ...DEFAULT_CONFIG.rate, proxy: '' };
        config.mode = 'standalone';
        config.kick = { ...DEFAULT_CONFIG.kick };
        if (kws) {
          try {
            kws.close();
          } catch {}
          kws = null;
        }
        kickState.connected = false;
        saveConfig();
        scheduleRate();
        broadcast('overlay', { type: 'config', appearance: config.appearance });
        broadcast('preview', { type: 'config', appearance: config.appearance });
        log('info', 'تنظیمات به حالت پیش‌فرض برگشت');
        sendState();
        return json(res, 200, { ok: true, config: publicConfig() });
      }
      if (p === '/api/rate' && req.method === 'POST') {
        const v = await refreshRate(true);
        return json(res, 200, { ok: v != null, rate: config.rate, effective: currentRate(), error: rateError });
      }
      if (p === '/api/meld-reload' && req.method === 'POST')
        return json(res, 200, { ok: await meldReloadLayers('manual') });
      if (p === '/api/done' && req.method === 'POST') {
        const body = await readJson(req);
        finishPlaying(String(body.id || ''), false, false);
        return json(res, 200, { ok: true });
      }
      if (p === '/api/skip' && req.method === 'POST') {
        broadcast('overlay', { type: 'stop' });
        if (playing) finishPlaying(playing.stripe_pi_id, false, false);
        return json(res, 200, { ok: true });
      }
      if (p === '/api/clear-queue' && req.method === 'POST') {
        approved = [];
        pending = [];
        sendState();
        return json(res, 200, { ok: true });
      }
      if (p === '/api/open-media-folder' && req.method === 'POST') {
        if (opts.openPath) opts.openPath(MEDIA);
        return json(res, 200, { ok: !!opts.openPath });
      }
      if (p === '/api/logs' && req.method === 'GET') return json(res, 200, { logs });
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><body style="margin:0;background:#141416;color:#F7F5F2;font-family:Vazirmatn,Tahoma,sans-serif;display:grid;place-items:center;height:100vh"><div style="text-align:center;line-height:2"><div style="font-size:22px;font-weight:700">این آدرس وجود ندارد</div><div style="color:#B0ACA7">آدرس Browser Source برای Meld / OBS:</div><code style="direction:ltr;display:inline-block;background:#1B1B1D;padding:6px 14px;border-radius:8px;font-size:18px">http://localhost:${config.port}/overlay</code></div></body></html>`
      );
    } catch (e) {
      log('error', 'http error', e.message);
      try {
        json(res, 500, { error: 'internal error' });
      } catch {}
    }
  });
  server.on('clientError', (err, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    } catch {}
  });

  let started = false;
  function start() {
    return new Promise((resolve, reject) => {
      if (started) return resolve(config.port);
      server.once('error', reject);
      server.listen(config.port, '127.0.0.1', () => {
        // loopback only, never 0.0.0.0
        started = true;
        log('info', `Sahne Plus ${APP_VERSION} اجرا شد`, {
          overlay: `http://localhost:${config.port}/overlay`,
          data: DATA,
          secretStorage
        });
        if ((secret || seToken) && secretStorage === 'os') saveConfig(); // migrates a legacy plaintext secret/token into the encrypted fields
        if (!(opts.testHooks && opts.testHooks.offline)) {
          // tests run fully offline
          connect();
          seConnect();
          refreshRate(false);
          scheduleRate();
          if (config.kick.enabled && config.kick.channel)
            resolveKickChannel().then(ok => {
              if (ok) kickConnect();
            });
        }
        if (!secret) log('warn', 'راه‌اندازی اولیه: لینک ویجت کیک‌بات را در صفحه اصلی وارد کنید');
        resolve(config.port);
      });
    });
  }
  function stop() {
    stopped = true;
    for (const t of timers) clearInterval(t);
    clearInterval(rateTimer);
    clearInterval(pulseTimer);
    clearInterval(kickPing);
    clearTimeout(reconnectTimer);
    clearTimeout(seReconnectTimer);
    try {
      if (sews) sews.close();
    } catch {}
    clearTimeout(nextTimer);
    clearTimeout(playTimeout);
    clearTimeout(playedSaveT);
    try {
      fs.writeFileSync(PLAYED_PATH, JSON.stringify(playedOrder));
    } catch {}
    try {
      if (ws) ws.close();
    } catch {}
    try {
      if (kws) kws.close();
    } catch {}
    for (const role in clients)
      for (const res of clients[role]) {
        try {
          res.end();
        } catch {}
      }
    return new Promise(r => server.close(() => r()));
  }
  // wipe everything this app manages (config, media, played memory). The caller confirms with the user first.
  function clearData() {
    stop().catch(() => {});
    for (const f of fs.readdirSync(MEDIA)) {
      try {
        fs.unlinkSync(path.join(MEDIA, f));
      } catch {}
    }
    for (const f of [CFG_PATH, PLAYED_PATH]) {
      try {
        fs.unlinkSync(f);
      } catch {}
    }
    for (const f of fs.readdirSync(DATA))
      if (/^config\.json\.(corrupt-\d+|tmp)$/.test(f)) {
        try {
          fs.unlinkSync(path.join(DATA, f));
        } catch {}
      }
  }

  const testHooks = opts.testHooks
    ? {
        injectTip: t => {
          approved.push(t);
          tryNext();
        },
        queueLength: () => approved.length,
        isPlayed: id => playedIds.has(id)
      }
    : undefined;
  return {
    start,
    stop,
    clearData,
    importFiles,
    log,
    saveConfig,
    testHooks,
    get port() {
      return config.port;
    },
    get config() {
      return config;
    },
    get mediaDir() {
      return MEDIA;
    },
    get dataDir() {
      return DATA;
    },
    state: publicState,
    overlayUrl: () => `http://localhost:${config.port}/overlay`,
    appUrl: () => `http://127.0.0.1:${config.port}/`
  };
}

module.exports = {
  createServer,
  DEFAULT_CONFIG,
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
  sanitizeFx,
  FX_CODES
};
