// Sahne Plus — controller logic (talks to the local server over HTTP + SSE; desktop features through window.sahne).
'use strict';
const $ = s => document.querySelector(s),
  $$ = s => [...document.querySelectorAll(s)];
const DESK = !!(window.sahne && window.sahne.desktop);
if (!DESK) document.body.classList.add('web');
let CFG = null,
  STATE = null,
  INFO = null,
  selectedId = null;

const api = (p, opt) => fetch(p, opt).then(r => r.json());
const post = (p, body) =>
  api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
const patch = (p, body) =>
  api(p, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
let toastT;
function toast(m, kind) {
  const t = $('#toast');
  t.textContent = m;
  t.className = 'toast show ' + (kind || '');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), 2000);
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
const faNum = n => Number(n || 0).toLocaleString('fa-IR');
function fmtToman(t) {
  t = Number(t);
  if (!t) return 'بدون مبلغ';
  if (t >= 1e6) return faNum(+(t / 1e6).toFixed(2)) + ' میلیون';
  if (t >= 1e3) return faNum(+(t / 1e3).toFixed(1)) + ' هزار';
  return faNum(t) + ' تومان';
}
function fmtSize(b) {
  if (!b) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (b > 1024 && i < 3) {
    b /= 1024;
    i++;
  }
  return b.toFixed(i ? 1 : 0) + ' ' + u[i];
}
function copyText(t) {
  if (DESK) return window.sahne.app.copy(t);
  return navigator.clipboard.writeText(t);
}

// ---------- window chrome ----------
if (DESK) {
  $('#wMin').onclick = () => window.sahne.win.minimize();
  $('#wMax').onclick = () => window.sahne.win.toggleMax();
  $('#wClose').onclick = () => window.sahne.win.close();
  $('#chrome').addEventListener('dblclick', e => {
    if (e.target.closest('.win-controls')) return;
    window.sahne.win.toggleMax();
  });
}
$('#btnExit').onclick = async () => {
  if (!DESK) {
    toast('در نسخه‌ی مرورگر خروج معنی نداره');
    return;
  }
  if (confirm('برنامه کاملاً بسته می‌شه و تا باز شدن دوباره، هیچ آلرتی روی استریم نمایش داده نمی‌شه. مطمئنی؟'))
    window.sahne.app.quit();
};

// ---------- navigation ----------
const nav = $('#nav'),
  capsule = $('#capsule');
function moveCapsule(btn) {
  if (!btn) return;
  capsule.style.opacity = 1;
  capsule.style.transform = `translateY(${btn.offsetTop}px)`;
  capsule.style.height = btn.offsetHeight + 'px';
}
function goPage(name) {
  $$('.nav button').forEach(b => b.classList.toggle('active', b.dataset.page === name));
  $$('.page').forEach(p => p.classList.toggle('active', p.dataset.page === name));
  moveCapsule($(`.nav button[data-page="${name}"]`));
  if (name === 'look') setTimeout(fitPreview, 30);
  if (name === 'home') loadSim();
  if (name === 'about' && !$('#docView').textContent) showDoc('PRIVACY.md');
  if (name !== 'files') closeInspector();
  try {
    localStorage.setItem('sp.page', name);
  } catch {}
}
$$('.nav button').forEach(b => (b.onclick = () => goPage(b.dataset.page)));
window.addEventListener('resize', () => moveCapsule($('.nav button.active')));

// ---------- load ----------
async function load() {
  const r = await api('/api/config');
  CFG = r.config;
  STATE = r.state;
  if (DESK && !INFO) {
    try {
      INFO = await window.sahne.app.info();
    } catch {}
  }
  $('#brandVer').textContent = 'Sahne Plus v' + (r.version || (INFO && INFO.version) || '');
  renderFiles();
  fillLook();
  renderState();
  fillSettings();
  renderRate();
  fillSetup();
  fillKick();
  fillApp();
  $('#log').innerHTML = '';
  (r.logs || []).forEach(addLog);
}
function fillSetup() {
  const need = !(CFG.kickbot && CFG.kickbot.configured);
  $('#setupCard').hidden = !need;
}
async function doSetup(inputSel, msgSel) {
  const msg = $(msgSel);
  msg.textContent = 'در حال بررسی…';
  const r = await post('/api/setup', { url: $(inputSel).value });
  if (r.ok) {
    toast('متصل شد', 'ok');
    msg.textContent = 'انجام شد. Streamer ID: ' + r.streamer_id;
    load();
  } else {
    msg.textContent = r.error || 'خطا';
    toast(r.error || 'خطا', 'err');
  }
}
$('#btnSetup').onclick = () => doSetup('#setupUrl', '#setupMsg');
$('#btnSetup2').onclick = () => doSetup('#setupUrl2', '#setupMsg2');

// ---------- kick ----------
function fillKick() {
  const k = CFG.kick || {};
  $('#kEnabled').checked = k.enabled !== false;
  $('#kChannel').value = k.channel || '';
  $('#kGift').value = k.giftValueToman || 0;
  $('#kSub').value = k.subValueToman || 0;
  $('#kShowSubs').checked = k.showNewSubs !== false;
  renderKickStatus();
}
function renderKickStatus() {
  const st = (STATE && STATE.kick) || {};
  const el = $('#kStatus'),
    pill = $('#stKick'),
    h = $('#hKick');
  let txt = '',
    cls = 'chip',
    pcls = 'status-pill';
  if (!CFG.kick || CFG.kick.enabled === false) {
    txt = 'غیرفعال';
  } else if (!CFG.kick.channel) {
    txt = 'اسم کانال وارد نشده';
    pcls += ' warn';
  } else if (st.connected) {
    txt = 'متصل به چت ' + st.channel;
    cls += ' on';
    pcls += ' on';
  } else {
    txt = st.error ? 'خطا: ' + st.error : 'در حال اتصال…';
    cls += ' warn';
    pcls += ' warn';
  }
  el.textContent = txt;
  el.className = cls;
  h.textContent = txt;
  h.className = cls;
  pill.className = pcls;
  // what to do about the error (filtered kick.com, VPN, wrong channel name)
  const hint = $('#kHint');
  const showHint = !!(st.hint && CFG.kick && CFG.kick.enabled !== false && CFG.kick.channel && !st.connected);
  hint.hidden = !showHint;
  hint.textContent = showHint ? st.hint : '';
}
$('#btnSaveKick').onclick = async () => {
  await post('/api/config', {
    kick: {
      enabled: $('#kEnabled').checked,
      channel: $('#kChannel').value.trim(),
      giftValueToman: Number($('#kGift').value) || 0,
      subValueToman: Number($('#kSub').value) || 0,
      showNewSubs: $('#kShowSubs').checked
    }
  });
  toast('ذخیره شد', 'ok');
  setTimeout(load, 1200);
};
$('#btnTestGift').onclick = () =>
  post('/api/test-sub', { kind: 'gift', name: 'AliGamer', count: 3 }).then(() => toast('ارسال شد', 'ok'));
$('#btnTestSub').onclick = () =>
  post('/api/test-sub', { kind: 'sub', name: 'AliGamer', months: 1 }).then(() => toast('ارسال شد', 'ok'));

// ---------- settings ----------
const KB_TEXT = {
  connected: ['متصل', 'chip on'],
  connecting: ['در حال اتصال…', 'chip warn'],
  reconnecting: ['قطع شده، تلاش مجدد…', 'chip warn'],
  unconfigured: ['تنظیم نشده', 'chip']
};
function renderKb() {
  const kb = (CFG && CFG.kickbot) || {};
  const st = (STATE && STATE.kbStatus) || (kb.configured ? 'reconnecting' : 'unconfigured');
  const [txt, cls] = KB_TEXT[st] || KB_TEXT.unconfigured;
  $('#kbChip').textContent = txt;
  $('#kbChip').className = cls;
  $('#kbStreamer').textContent = kb.streamer_id || '—';
  $('#kbSecret').textContent = kb.configured
    ? kb.secretStorage === 'os'
      ? 'ذخیره شده (رمزنگاری‌شده با ویندوز)'
      : 'ذخیره شده (بدون رمزنگاری؛ DPAPI در دسترس نیست)'
    : 'وارد نشده';
  $('#btnDisconnect').disabled = !kb.configured;
  renderSe();
}
const SE_TEXT = {
  connected: ['متصل', 'chip on'],
  connecting: ['در حال اتصال…', 'chip warn'],
  reconnecting: ['قطع شده، تلاش مجدد…', 'chip warn'],
  error: ['خطا', 'chip warn'],
  unconfigured: ['تنظیم نشده', 'chip']
};
function renderSe() {
  const se = (CFG && CFG.streamelements) || {};
  const st = (STATE && STATE.se) || {};
  const status = st.status || (se.configured ? 'reconnecting' : 'unconfigured');
  const [txt, cls] = SE_TEXT[status] || SE_TEXT.unconfigured;
  const label = status === 'error' && st.error ? 'خطا: ' + st.error : txt;
  $('#seChip').textContent = label;
  $('#seChip').className = cls;
  $('#hSe').textContent = label;
  $('#hSe').className = cls;
  $('#hSeRow').hidden = !se.configured;
  $('#stSe').hidden = !se.configured;
  $('#stSe').className = 'status-pill' + (status === 'connected' ? ' on' : se.configured ? ' warn' : '');
  $('#seAccount').textContent = se.configured
    ? (se.username || '—') + (se.provider ? ' (' + se.provider + ')' : '')
    : 'وصل نشده';
  $('#seSecret').textContent = se.configured
    ? se.secretStorage === 'os'
      ? 'ذخیره شده (رمزنگاری‌شده با ویندوز)'
      : 'ذخیره شده (بدون رمزنگاری؛ DPAPI در دسترس نیست)'
    : 'وارد نشده';
  $('#btnSeDisconnect').disabled = !se.configured;
}
$('#btnSeSetup').onclick = async () => {
  const msg = $('#seMsg');
  msg.textContent = 'در حال بررسی…';
  const r = await post('/api/se/setup', { token: $('#seToken').value });
  if (r.ok) {
    $('#seToken').value = '';
    toast('StreamElements وصل شد', 'ok');
    msg.textContent = 'انجام شد: ' + (r.username || '') + (r.provider ? ' (' + r.provider + ')' : '');
    load();
  } else {
    msg.textContent = r.error || 'خطا';
    toast(r.error || 'خطا', 'err');
  }
};
$('#btnSeDisconnect').onclick = async () => {
  if (!confirm('اتصال StreamElements قطع و توکن حذف شود؟')) return;
  await post('/api/se/disconnect');
  toast('اتصال StreamElements حذف شد', 'ok');
  load();
};
function fillSettings() {
  $('#ovUrl').value = 'http://localhost:' + (CFG.port || 7788) + '/overlay';
  $('#mode').value = CFG.mode;
  $('#showNoMedia').checked = CFG.showAlertWithoutMedia !== false;
  renderKb();
}
function fillApp() {
  $('#appVer').value = INFO ? INFO.version + ' · Electron ' + INFO.electron : 'web';
  $('#dataDir').value = INFO ? INFO.dataDir : '';
  $('#autostart').checked = !!(INFO && INFO.autostart);
  $('#autostart').disabled = !DESK;
  $('#updCheck').checked = !(CFG.app && CFG.app.updateCheck === false);
  $('#updCheck').disabled = !DESK;
  $('#btnOpenData').disabled = !DESK;
  $('#btnOpenLog').disabled = !DESK;
  $('#btnClearData').disabled = !DESK;
  // about
  $('#abVer').textContent = INFO
    ? `${INFO.version} · Electron ${INFO.electron} · Chromium ${INFO.chrome}`
    : (CFG && CFG.version) || 'web';
  $('#abData').textContent = INFO ? INFO.dataDir : '—';
  $('#abServer').textContent = 'http://localhost:' + (CFG.port || 7788);
  $('#abSecret').textContent =
    CFG.kickbot && CFG.kickbot.secretStorage === 'os'
      ? 'رمزنگاری‌شده با ویندوز (DPAPI)'
      : 'متن ساده در config.json (DPAPI در دسترس نیست)';
  $('#abSec').textContent = INFO ? INFO.securityContact : '—';
}
$('#btnDisconnect').onclick = async () => {
  if (!confirm('اتصال کیک‌بات قطع و کلید ویجت از این کامپیوتر حذف شود؟ دونیت‌ها تا اتصال دوباره نمایش داده نمی‌شوند.'))
    return;
  await post('/api/disconnect-kickbot');
  toast('اتصال کیک‌بات حذف شد', 'ok');
  load();
};
$('#btnResetSettings').onclick = async () => {
  if (!confirm('ظاهر، نرخ، حالت کار و تنظیمات ساب به پیش‌فرض برگردند؟ فایل‌ها و اتصال کیک‌بات می‌مانند.')) return;
  await post('/api/reset-settings');
  toast('تنظیمات بازگردانی شد', 'ok');
  load();
};
$('#btnClearData').onclick = () => {
  if (DESK) window.sahne.app.clearData();
};
$('#abOpenData').onclick = () => DESK && window.sahne.app.openPath('data');
$('#abOpenLog').onclick = () => DESK && window.sahne.app.openPath('log');
async function showDoc(name) {
  const el = $('#docView');
  el.textContent = '…';
  try {
    el.textContent = await fetch('/legal/' + name).then(r => (r.ok ? r.text() : 'سند پیدا نشد'));
  } catch {
    el.textContent = 'سند پیدا نشد';
  }
}
$$('[data-doc]').forEach(
  b =>
    (b.onclick = () => {
      $$('[data-doc]').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      showDoc(b.dataset.doc);
    })
);
$('#autostart').onchange = async e => {
  if (!DESK) return;
  const r = await window.sahne.app.autostart(e.target.checked);
  e.target.checked = !!r;
  await post('/api/config', { app: { autostart: !!r } });
  toast(r ? 'اجرای خودکار فعال شد' : 'اجرای خودکار غیرفعال شد', 'ok');
};
$('#updCheck').onchange = async e => {
  await post('/api/config', { app: { updateCheck: e.target.checked } });
  toast(e.target.checked ? 'بررسی خودکار آپدیت روشن شد' : 'بررسی خودکار آپدیت خاموش شد', 'ok');
};
// ---------- updates (desktop app only; checking, downloading and verifying happen in the main process) ----------
let UPD = null,
  updLater = false;
function renderUpdate(s) {
  if (s) UPD = s;
  const bar = $('#updBar'),
    ab = $('#abUpd');
  if (!DESK || !UPD) {
    bar.hidden = true;
    ab.textContent = DESK ? '—' : 'فقط در برنامه‌ی دسکتاپ';
    return;
  }
  const v = UPD.latest || '';
  let txt = '',
    show = false,
    busy = false;
  if (UPD.status === 'available') {
    txt = 'نسخه‌ی جدید صحنه پلاس (' + v + ') آماده است.' + (UPD.error ? ' ' + UPD.error : '');
    show = !updLater;
  } else if (UPD.status === 'downloading') {
    txt = 'در حال دانلود نسخه‌ی ' + v + '… ' + (UPD.progress || 0) + '٪';
    show = busy = true;
  } else if (UPD.status === 'ready') {
    txt = 'نسخه‌ی ' + v + ' دانلود و با چک‌سام رسمی بررسی شد (حالت تست؛ نصب نمی‌شود).';
    show = busy = true;
  } else if (UPD.status === 'installing') {
    txt = 'در حال نصب نسخه‌ی ' + v + '… برنامه چند ثانیه بسته و دوباره باز می‌شود.';
    show = busy = true;
  }
  bar.hidden = !show;
  $('#updText').textContent = txt;
  $('#updGo').disabled = busy;
  $('#updGo').textContent = UPD.canInstall ? 'آپدیت' : 'دانلود';
  $('#updLater').style.display = busy ? 'none' : '';
  const labels = {
    idle: 'هنوز بررسی نشده',
    checking: 'در حال بررسی…',
    uptodate: 'به‌روز است (' + UPD.current + ')',
    available: 'نسخه‌ی ' + v + ' آمده',
    downloading: 'در حال دانلود…',
    ready: 'دانلود شد (تست)',
    installing: 'در حال نصب…',
    error: UPD.error || 'بررسی ناموفق بود'
  };
  ab.textContent = labels[UPD.status] || '—';
}
if (DESK && window.sahne.update) {
  window.sahne.update.onStatus(renderUpdate);
  window.sahne.update
    .get()
    .then(renderUpdate)
    .catch(() => {});
  $('#updGo').onclick = async () => {
    if (!UPD) return;
    if (!UPD.canInstall) {
      if (UPD.page) window.sahne.app.openExternal(UPD.page);
      return;
    }
    if (
      !confirm(
        'نسخه‌ی ' +
          UPD.latest +
          ' دانلود و نصب شود؟ برنامه چند ثانیه بسته و دوباره باز می‌شود؛ تنظیمات و فایل‌ها سر جایشان می‌مانند.'
      )
    )
      return;
    renderUpdate(await window.sahne.update.install());
  };
  $('#updNotes').onclick = () => UPD && UPD.page && window.sahne.app.openExternal(UPD.page);
  $('#updLater').onclick = () => {
    updLater = true;
    renderUpdate();
  };
  $('#abCheckUpd').onclick = async () => {
    updLater = false;
    const s = await window.sahne.update.check();
    renderUpdate(s);
    if (!s) return;
    if (s.status === 'uptodate') toast('صحنه پلاس به‌روز است', 'ok');
    else if (s.status === 'available') toast('نسخه‌ی ' + s.latest + ' آمده است', 'ok');
    else toast(s.error || 'بررسی آپدیت ناموفق بود', 'err');
  };
} else {
  $('#abCheckUpd').disabled = true;
  renderUpdate(null);
}
$('#btnOpenData').onclick = () => DESK && window.sahne.app.openPath('data');
$('#btnOpenLog').onclick = () => DESK && window.sahne.app.openPath('log');
$('#btnClearLog').onclick = () => {
  $('#log').innerHTML = '';
};
async function meldReload() {
  const r = await post('/api/meld-reload');
  toast(r.ok ? 'لایه‌های Meld ری‌لود شدند' : 'Meld در دسترس نبود یا لایه‌ای پیدا نشد', r.ok ? 'ok' : 'err');
}
$('#btnMeld').onclick = meldReload;
$('#hMeld').onclick = meldReload;
$('#btnCopy').onclick = () => {
  copyText($('#ovUrl').value);
  toast('کپی شد', 'ok');
};
$('#hCopyUrl').onclick = () => {
  copyText($('#ovUrl').value);
  toast('لینک Browser Source کپی شد', 'ok');
};
$('#btnSaveSettings').onclick = async () => {
  await post('/api/config', { mode: $('#mode').value, showAlertWithoutMedia: $('#showNoMedia').checked });
  toast('ذخیره شد', 'ok');
  load();
};

// ---------- files ----------
let fFilter = 'all',
  fQuery = '',
  fSort = 'amount';
const typeIcon = { video: 'i-video', image: 'i-image', audio: 'i-audio' };
const typeLabel = { video: 'ویدیو', image: 'تصویر', audio: 'صدا' };
function visibleFiles() {
  let list = [...(CFG.files || [])];
  const counts = { all: list.length, video: 0, image: 0, audio: 0, off: 0 };
  for (const f of list) {
    if (counts[f.type] != null) counts[f.type]++;
    if (f.enabled === false) counts.off++;
  }
  $$('#fSeg button').forEach(b => (b.querySelector('.n').textContent = counts[b.dataset.f] ?? 0));
  if (fFilter === 'off') list = list.filter(f => f.enabled === false);
  else if (fFilter !== 'all') list = list.filter(f => f.type === fFilter);
  if (fQuery) {
    const q = fQuery.toLowerCase();
    list = list.filter(
      f =>
        (f.name || '').toLowerCase().includes(q) ||
        (f.file || '').toLowerCase().includes(q) ||
        (f.keywords || []).join(' ').toLowerCase().includes(q)
    );
  }
  const by = {
    amount: (a, b) =>
      (Number(a.minToman) || 0) - (Number(b.minToman) || 0) || String(a.name).localeCompare(String(b.name)),
    name: (a, b) => String(a.name).localeCompare(String(b.name), 'fa'),
    size: (a, b) => (b.size || 0) - (a.size || 0)
  };
  return list.sort(by[fSort] || by.amount);
}
function renderFiles() {
  $('#navFiles').textContent = (CFG.files || []).length;
  const box = $('#files');
  box.innerHTML = '';
  const list = visibleFiles();
  if (!list.length) {
    box.innerHTML = `<div class="empty" style="grid-column:1/-1">${(CFG.files || []).length ? 'چیزی با این فیلتر پیدا نشد.' : 'هنوز فایلی اضافه نشده. فایل‌ها رو اینجا رها کن یا «افزودن فایل» رو بزن.'}</div>`;
    return;
  }
  for (const f of list) {
    const el = document.createElement('div');
    el.className = 'fcard' + (f.enabled === false ? ' off' : '') + (f.id === selectedId ? ' selected' : '');
    el.dataset.id = f.id;
    const src = '/media/' + encodeURIComponent(f.file);
    const thumb =
      f.type === 'image'
        ? `<img src="${src}" loading="lazy">`
        : f.type === 'video'
          ? `<video src="${src}#t=0.5" muted preload="metadata" loop></video>`
          : `<svg><use href="#${typeIcon.audio}"/></svg>`;
    const kw = (f.keywords || []).filter(Boolean);
    const amount = kw.length
      ? `<span class="amount kw">${esc(kw.slice(0, 2).join('، '))}${kw.length > 2 ? ' …' : ''}</span>`
      : `<span class="amount${Number(f.minToman) ? '' : ' none'}">${Number(f.minToman) ? 'از ' + fmtToman(f.minToman) : 'بدون مبلغ'}</span>`;
    el.innerHTML = `<div class="thumb">${thumb}</div>${amount}${f.enabled === false ? '<span class="offlbl">غیرفعال</span>' : ''}
      <div class="cap"><div class="name">${esc(f.name)}</div><div class="meta">${fmtSize(f.size)}</div><span class="type"><svg><use href="#${typeIcon[f.type] || 'i-files'}"/></svg>${esc((f.file.split('.').pop() || '').toUpperCase())}</span></div>`;
    el.onclick = () => selectFile(f.id);
    const v = el.querySelector('video');
    if (v) {
      el.onmouseenter = () => {
        v.play().catch(() => {});
      };
      el.onmouseleave = () => {
        v.pause();
        try {
          v.currentTime = 0.5;
        } catch {}
      };
    }
    box.appendChild(el);
  }
}
$('#fSearch').oninput = e => {
  fQuery = e.target.value.trim();
  renderFiles();
};
$('#fSort').onchange = e => {
  fSort = e.target.value;
  renderFiles();
};
$$('#fSeg button').forEach(
  b =>
    (b.onclick = () => {
      $$('#fSeg button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      fFilter = b.dataset.f;
      renderFiles();
    })
);
$('#btnOpenFolder').onclick = () => (DESK ? window.sahne.app.openPath('media') : post('/api/open-media-folder'));
$('#btnScan').onclick = async () => {
  const r = await post('/api/scan');
  toast(faNum(r.added) + ' فایل جدید اضافه شد', 'ok');
  load();
};
$('#btnAdd').onclick = async () => {
  if (DESK) {
    const r = await window.sahne.files.pick();
    if (r.added.length) toast(faNum(r.added.length) + ' فایل اضافه شد', 'ok');
    if (r.skipped.length) toast('پشتیبانی نشد: ' + r.skipped.join('، '), 'err');
    if (r.added.length) load();
  } else $('#fileInput').click();
};
$('#fileInput').onchange = () => {
  uploadHttp([...$('#fileInput').files]);
  $('#fileInput').value = '';
};
async function uploadHttp(files) {
  const st = $('#upStatus');
  for (let i = 0; i < files.length; i++) {
    st.textContent = `در حال آپلود ${i + 1}/${files.length}: ${files[i].name}`;
    const r = await fetch('/api/upload?name=' + encodeURIComponent(files[i].name), {
      method: 'PUT',
      body: files[i]
    }).then(r => r.json());
    if (r.error) toast(r.error, 'err');
  }
  st.textContent = '';
  toast('اضافه شد', 'ok');
  load();
}
// drag & drop anywhere on the content area
const content = $('#content');
let dragDepth = 0;
content.addEventListener('dragenter', e => {
  if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  content.classList.add('dragover');
  goPage('files');
});
content.addEventListener('dragover', e => {
  if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault();
});
content.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    content.classList.remove('dragover');
  }
});
content.addEventListener('drop', async e => {
  e.preventDefault();
  dragDepth = 0;
  content.classList.remove('dragover');
  const files = [...(e.dataTransfer.files || [])];
  if (!files.length) return;
  if (DESK) {
    const r = await window.sahne.files.importDropped(files);
    if (r.added.length) toast(faNum(r.added.length) + ' فایل اضافه شد', 'ok');
    if (r.skipped.length) toast('پشتیبانی نشد: ' + r.skipped.join('، '), 'err');
    load();
  } else uploadHttp(files);
});

// ---------- inspector ----------
let insT = null;
function selectFile(id) {
  selectedId = id;
  const f = (CFG.files || []).find(x => x.id === id);
  if (!f) return closeInspector();
  $$('.fcard').forEach(c => c.classList.toggle('selected', c.dataset.id === id));
  const src = '/media/' + encodeURIComponent(f.file);
  $('#insThumb').innerHTML =
    f.type === 'image'
      ? `<img src="${src}">`
      : f.type === 'video'
        ? `<video src="${src}" muted autoplay loop playsinline></video>`
        : `<svg style="width:40px;height:40px;color:var(--muted)"><use href="#i-audio"/></svg>`;
  $('#insMeta').textContent = `${f.file} · ${fmtSize(f.size)} · ${typeLabel[f.type] || f.type}`;
  $('#iName').value = f.name || '';
  $('#iEnabled').checked = f.enabled !== false;
  $('#iMin').value = f.minToman ?? '';
  $('#iMax').value = f.maxToman ?? '';
  $('#iKw').value = (f.keywords || []).join(', ');
  $('#iVol').value = f.volume ?? 100;
  $('#iDur').value = f.duration ?? '';
  $('#iCardDelay').value = f.cardDelay ?? '';
  $('#iMinChip').textContent = fmtToman(f.minToman);
  $('#inspector').hidden = false;
  $('#shell').classList.add('has-inspector');
}
function closeInspector() {
  selectedId = null;
  $('#inspector').hidden = true;
  $('#shell').classList.remove('has-inspector');
  $$('.fcard').forEach(c => c.classList.remove('selected'));
  const v = $('#insThumb video');
  if (v) {
    v.pause();
    v.src = '';
  }
}
$('#insClose').onclick = closeInspector;
function collectInspector() {
  const num = v => (v === '' ? null : Number(v));
  return {
    id: selectedId,
    name: $('#iName').value.trim() || selectedId,
    enabled: $('#iEnabled').checked,
    minToman: num($('#iMin').value),
    maxToman: num($('#iMax').value),
    keywords: $('#iKw')
      .value.split(',')
      .map(s => s.trim())
      .filter(Boolean),
    volume: Math.max(0, Math.min(100, Number($('#iVol').value) || 0)),
    duration: num($('#iDur').value),
    cardDelay: num($('#iCardDelay').value)
  };
}
['#iName', '#iEnabled', '#iMin', '#iMax', '#iKw', '#iVol', '#iDur', '#iCardDelay'].forEach(sel =>
  $(sel).addEventListener('input', () => {
    if (!selectedId) return;
    $('#iMinChip').textContent = fmtToman($('#iMin').value);
    clearTimeout(insT);
    insT = setTimeout(async () => {
      const body = collectInspector();
      const r = await patch('/api/file', body);
      if (r.ok) {
        const f = CFG.files.find(x => x.id === body.id);
        if (f) Object.assign(f, r.file);
        renderFiles();
        const s = $('#insSaved');
        s.classList.add('show');
        setTimeout(() => s.classList.remove('show'), 1200);
      } else toast(r.error || 'ذخیره نشد', 'err');
    }, 350);
  })
);
$('#iPreview').onclick = () => {
  if (!selectedId) return;
  const id = selectedId;
  goPage('look');
  post('/api/preview', {
    name: $('#pvName').value,
    amount: $('#pvAmount').value,
    message: $('#pvMsg').value,
    fileId: id
  });
};
$('#iDelete').onclick = async () => {
  const f = CFG.files.find(x => x.id === selectedId);
  if (!f) return;
  if (!confirm('حذف «' + f.name + '»؟ فایل از پوشه هم پاک می‌شه.')) return;
  await fetch('/api/file?id=' + f.id, { method: 'DELETE' });
  closeInspector();
  toast('حذف شد', 'ok');
  load();
};

// ---------- look ----------
const lbl = {
  textSize: 'lblSize',
  bgOpacity: 'lblOp',
  width: 'lblW',
  mediaMaxHeight: 'lblMH',
  volume: 'lblVol',
  ttsVolume: 'lblTts',
  cardScale: 'lblCS',
  radius: 'lblR',
  borderOpacity: 'lblBO',
  padY: 'lblPY',
  padX: 'lblPX'
};
const LOOK_DEFAULTS = {
  giftTemplate: '{name} {count} تا ساب گیفت داد 🎁 {amount}',
  subTemplate: '{name} ساب شد ⭐ {amount}',
  mediaMode: 'full',
  mediaFit: 'cover',
  cardX: 50,
  cardY: 82,
  cardScale: 1,
  cardDelay: 0,
  radius: 26,
  amountStyle: 'pill',
  showLine: true,
  showGlow: true,
  showBorder: true,
  headlineColor: '#ffffff',
  borderColor: '#ffffff',
  borderOpacity: 0.1,
  padY: 26,
  padX: 34
};
function fillLook() {
  for (const k in LOOK_DEFAULTS) if (CFG.appearance[k] === undefined) CFG.appearance[k] = LOOK_DEFAULTS[k];
  $$('[data-a]').forEach(el => {
    const k = el.dataset.a,
      v = CFG.appearance[k];
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
    if (lbl[k]) $('#' + lbl[k]).textContent = v;
  });
}
let saveT;
$$('[data-a]').forEach(el =>
  el.addEventListener('input', () => {
    const k = el.dataset.a;
    const v =
      el.type === 'checkbox' ? el.checked : el.type === 'number' || el.type === 'range' ? Number(el.value) : el.value;
    CFG.appearance[k] = v;
    if (lbl[k]) $('#' + lbl[k]).textContent = v;
    saveLook();
  })
);
function setA(k, v) {
  CFG.appearance[k] = v;
  const el = document.querySelector(`[data-a="${k}"]`);
  if (el) {
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
  }
  if (lbl[k]) $('#' + lbl[k]).textContent = v;
}
function saveLook() {
  clearTimeout(saveT);
  saveT = setTimeout(() => post('/api/config', { appearance: CFG.appearance }), 250);
}
$('#btnPreview').onclick = () =>
  post('/api/preview', { name: $('#pvName').value, amount: $('#pvAmount').value, message: $('#pvMsg').value });
window.addEventListener('message', e => {
  if (e.origin !== location.origin) return;
  const d = e.data || {};
  if (d.type !== 'cardpos') return;
  setA('cardX', d.x);
  setA('cardY', d.y);
  if (d.final) saveLook();
});
$$('[data-pos]').forEach(
  b =>
    (b.onclick = () => {
      const [x, y] = b.dataset.pos.split(',').map(Number);
      setA('cardX', x);
      setA('cardY', y);
      saveLook();
    })
);
(function () {
  const pw = $('#pw'),
    pv = $('#pv');
  let drag = null;
  const scale = () => pw.clientWidth / 1920;
  const inner = e => {
    const r = pw.getBoundingClientRect();
    return [(e.clientX - r.left) / scale(), (e.clientY - r.top) / scale()];
  };
  const setVars = () => {
    try {
      const st = pv.contentDocument.documentElement.style;
      st.setProperty('--cardX', CFG.appearance.cardX);
      st.setProperty('--cardY', CFG.appearance.cardY);
    } catch {}
  };
  pw.addEventListener('pointerdown', e => {
    const [ix, iy] = inner(e);
    let hit = null;
    try {
      hit = pv.contentDocument.elementFromPoint(ix, iy);
    } catch {}
    if (!hit || !hit.closest('.card')) return;
    e.preventDefault();
    pw.setPointerCapture(e.pointerId);
    pw.classList.add('dragging');
    drag = {
      sx: e.clientX,
      sy: e.clientY,
      x: Number(CFG.appearance.cardX ?? 50),
      y: Number(CFG.appearance.cardY ?? 82)
    };
  });
  pw.addEventListener('pointermove', e => {
    if (!drag) return;
    let x = drag.x + ((e.clientX - drag.sx) / scale() / 1920) * 100,
      y = drag.y + ((e.clientY - drag.sy) / scale() / 1080) * 100;
    if (e.shiftKey) {
      if (Math.abs(x - 50) < 2) x = 50;
      if (Math.abs(y - 50) < 2) y = 50;
    }
    x = Math.max(0, Math.min(100, x));
    y = Math.max(0, Math.min(100, y));
    setA('cardX', +x.toFixed(2));
    setA('cardY', +y.toFixed(2));
    setVars();
  });
  const up = () => {
    if (!drag) return;
    drag = null;
    pw.classList.remove('dragging');
    saveLook();
  };
  pw.addEventListener('pointerup', up);
  pw.addEventListener('pointercancel', up);
})();
const PRESETS = {
  gold: {
    font: 'Segoe UI',
    textSize: 40,
    template: '{name} tipped {amount}',
    currency: 'eq-en',
    persianDigits: false,
    amountStyle: 'inherit',
    showAmount: true,
    showMessage: true,
    headlineColor: '#f7c948',
    nameColor: '#f7c948',
    accent: '#f7c948',
    textColor: '#ffffff',
    bgColor: '#070707',
    bgOpacity: 0.55,
    radius: 14,
    borderColor: '#f7c948',
    borderOpacity: 0.45,
    showLine: false,
    showGlow: false,
    showBorder: true,
    shadow: true,
    showGloss: false,
    width: 1000,
    padY: 16,
    padX: 30
  },
  dark: {
    font: 'Vazirmatn',
    textSize: 34,
    template: '{name} با {amount} حمایت کرد',
    currency: 'eq-fa',
    persianDigits: true,
    amountStyle: 'soft',
    showAmount: true,
    showMessage: true,
    headlineColor: '#ffffff',
    nameColor: '#8ab4ff',
    accent: '#8ab4ff',
    textColor: '#c9d1e3',
    bgColor: '#0d1014',
    bgOpacity: 0.88,
    radius: 18,
    borderColor: '#ffffff',
    borderOpacity: 0.12,
    showLine: false,
    showGlow: false,
    showBorder: true,
    shadow: true,
    showGloss: true,
    width: 780,
    padY: 18,
    padX: 28
  },
  green: {
    font: 'Vazirmatn',
    textSize: 34,
    template: '{name} با {amount} حمایت کرد',
    currency: 'toman',
    persianDigits: true,
    amountStyle: 'pill',
    showAmount: true,
    showMessage: true,
    headlineColor: '#ffffff',
    nameColor: '#53fc18',
    accent: '#53fc18',
    textColor: '#ffffff',
    bgColor: '#0b0f0c',
    bgOpacity: 0.6,
    radius: 26,
    borderColor: '#ffffff',
    borderOpacity: 0.1,
    showLine: true,
    showGlow: true,
    showBorder: true,
    shadow: true,
    showGloss: false,
    width: 720,
    padY: 26,
    padX: 34
  }
};
$$('[data-preset]').forEach(
  b =>
    (b.onclick = () => {
      const p = PRESETS[b.dataset.preset];
      for (const k in p) setA(k, p[k]);
      saveLook();
      toast('پریست اعمال شد', 'ok');
    })
);
function fitPreview() {
  const w = $('#pw').clientWidth;
  if (w) $('#pv').style.transform = `scale(${w / 1920})`;
}
window.addEventListener('resize', fitPreview);

// ---------- home: queue / test / state ----------
$('#btnTest').onclick = async () => {
  await post('/api/test', { name: $('#tName').value, amount: $('#tAmount').value, message: $('#tMsg').value });
  toast('ارسال شد', 'ok');
};
$('#btnSkip').onclick = () => post('/api/skip');
$('#btnClear').onclick = () => post('/api/clear-queue').then(() => toast('صف خالی شد', 'ok'));
$('#hRateBtn').onclick = async () => {
  const r = await post('/api/rate');
  toast(r.ok ? 'نرخ به‌روز شد' : 'دریافت نرخ ناموفق بود', r.ok ? 'ok' : 'err');
  load();
};
function renderState() {
  const s = STATE;
  if (!s) return;
  $('#stKb').className = 'status-pill' + (s.connected ? ' on' : s.configured ? ' warn' : '');
  const kbt = KB_TEXT[s.kbStatus] || KB_TEXT.unconfigured;
  $('#hKb').textContent = kbt[0];
  $('#hKb').className = kbt[1];
  if (CFG) renderKb();
  if (CFG) renderKickStatus();
  if (CFG) renderSe();
  $('#stOv').className = 'status-pill' + (s.overlays > 0 ? ' on' : ' warn');
  $('#stOvN').textContent = s.overlays;
  $('#hOv').textContent = s.overlays;
  $('#hMode').textContent = s.mode === 'standalone' ? 'جایگزین ویجت' : 'کنار ویجت';
  $('#sPlaying').innerHTML = s.playing
    ? `<span class="chip on">${esc(s.playing.name)} · $${s.playing.amount}</span>`
    : '—';
  $('#sApproved').textContent = s.approved;
  $('#sPending').textContent = s.pending;
  $('#sQueue').textContent = s.queueStatus === 'play' ? 'در حال پخش' : 'متوقف';
  $('#sDelay').textContent = faNum(s.queueDelay) + ' ثانیه';
  $('#hRate').textContent = s.rate ? Number(s.rate).toLocaleString('en-US') : '—';
  $('#hRateMeta').textContent = s.rateManual
    ? 'دستی'
    : s.rateUpdatedAt
      ? (s.rateSource === 'bonbast' ? 'بن‌بست' : 'baha24') +
        ' · ' +
        new Date(s.rateUpdatedAt).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }) +
        (s.rateError ? ' · آخرین تلاش ناموفق' : '')
      : s.rateError
        ? 'دریافت نرخ ناموفق'
        : 'هنوز دریافت نشده';
  $('#sysProxy').textContent = s.systemProxy
    ? 'پراکسی سیستم ویندوز: ' +
      s.systemProxy +
      ' — اگر کادر بالا خالی باشد، برای kick.com و بن‌بست خودکار از همین استفاده می‌شود.'
    : 'پراکسی سیستم ویندوز پیدا نشد. اگر VPN در حالت TUN است یا kick.com بدون VPN باز می‌شود، نیازی به پراکسی نیست.';
  const rc = $('#recent');
  rc.innerHTML = s.recent.length ? '' : '<span class="hint">هنوز چیزی نیست</span>';
  s.recent.forEach(t => {
    const d = document.createElement('div');
    d.className = 'it';
    d.innerHTML = `<span class="a">${t.toman ? fmtToman(t.toman) : t.currency && t.currency !== 'USD' ? t.amount + ' ' + t.currency : '$' + t.amount}</span><b>${esc(t.name || '')}</b>${t.kind === 'gift' ? '<span class="chip">🎁 ' + faNum(t.count) + ' ساب‌گیفت</span>' : t.kind === 'sub' ? '<span class="chip">⭐ ساب</span>' : ''}<span class="m">${esc(t.message || '')}</span><span class="chip">${t.media ? esc(t.media) : 'بدون فایل'}</span>${t.test ? '<span class="chip warn">تست</span>' : ''}`;
    rc.appendChild(d);
  });
}
async function loadSim() {
  try {
    const r = await api('/api/simulate');
    const tb = $('#simTable tbody');
    tb.innerHTML = '';
    for (const row of r.rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${row.label === 'sub' ? '⭐ ۱ ساب' : '🎁 ' + faNum(row.count) + ' ساب‌گیفت'}</td><td class="num">${faNum(row.toman)}</td><td>${row.media ? '<span class="chip on">' + esc(row.media.name) + '</span>' : '<span class="chip">بدون فایل</span>'}</td>`;
      tb.appendChild(tr);
    }
  } catch {}
}
function addLog(e) {
  const l = $('#log');
  const d = document.createElement('div');
  d.className = e.level;
  d.textContent = `[${e.t.slice(11, 19)}] ${e.msg}${e.extra !== undefined ? '  ' + JSON.stringify(e.extra) : ''}`;
  l.appendChild(d);
  while (l.children.length > 400) l.firstChild.remove();
  l.scrollTop = l.scrollHeight;
}
function renderRate() {
  const r = CFG.rate || {};
  const eff = Number(r.manual) > 0 ? Number(r.manual) : r.value || 0;
  $('#rateVal').textContent = eff ? eff.toLocaleString('en-US') + ' T' : '—';
  $('#rateMeta').textContent =
    Number(r.manual) > 0
      ? '(دستی)'
      : r.updatedAt
        ? (r.source === 'bonbast' ? 'بن‌بست' : 'baha24') + ' · ' + new Date(r.updatedAt).toLocaleTimeString('fa-IR')
        : 'هنوز دریافت نشده';
  $('#rateAuto').checked = r.auto !== false;
  $('#rateInt').value = r.intervalMin || 2;
  $('#rateManual').value = r.manual || '';
  $('#rateProxy').value = r.proxy || '';
}
$('#btnSaveRate').onclick = async () => {
  await post('/api/config', {
    rate: {
      auto: $('#rateAuto').checked,
      manual: $('#rateManual').value,
      intervalMin: $('#rateInt').value,
      proxy: $('#rateProxy').value
    }
  });
  toast('ذخیره شد', 'ok');
  load();
};
$('#btnRate').onclick = async () => {
  const r = await post('/api/rate');
  toast(r.ok ? 'نرخ به‌روز شد' : 'دریافت نرخ ناموفق بود', r.ok ? 'ok' : 'err');
  load();
};

// ---------- live ----------
function connectEvents() {
  const es = new EventSource('/events?role=admin');
  es.onmessage = ev => {
    const d = JSON.parse(ev.data);
    if (d.type === 'state') {
      STATE = d.state;
      renderState();
    } else if (d.type === 'log') addLog(d.entry);
    else if (d.type === 'rate') {
      CFG.rate = d.rate;
      renderRate();
    }
  };
  es.onerror = () => {
    es.close();
    setTimeout(connectEvents, 2000);
  };
}
// keep file cards in sync when the server changes the list (import / scan / delete from elsewhere)
setInterval(async () => {
  if (document.hidden) return;
  try {
    const r = await api('/api/config');
    const a = JSON.stringify(r.config.files.map(f => [f.id, f.file, f.enabled, f.minToman, f.keywords]));
    const b = JSON.stringify((CFG.files || []).map(f => [f.id, f.file, f.enabled, f.minToman, f.keywords]));
    if (a !== b) {
      CFG.files = r.config.files;
      renderFiles();
      if (selectedId && !CFG.files.some(f => f.id === selectedId)) closeInspector();
    }
  } catch {}
}, 8000);

load().then(() => {
  connectEvents();
  fitPreview();
  let p = 'home';
  try {
    p = localStorage.getItem('sp.page') || 'home';
  } catch {}
  goPage(p);
  loadSim();
});
