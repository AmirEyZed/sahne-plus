// Sahne Plus Browser Source. Donor names/messages are UNTRUSTED and are only ever inserted as escaped text.
'use strict';
(function () {
  const stage = document.getElementById('stage');
  const qs = new URLSearchParams(location.search);
  const isPreview = qs.get('preview') === '1';
  const isEdit = isPreview && qs.get('edit') === '1';
  if (isEdit) document.body.classList.add('edit');
  let A = null;
  let current = null; // {el, tip, timers[], media[]}
  let sample = null; // static sample card in edit mode

  function applyConfig(a) {
    A = a;
    const r = document.documentElement.style;
    r.setProperty('--font', `'${String(a.font || 'Vazirmatn').replace(/[^\w .-]/g, '')}'`);
    r.setProperty('--size', a.textSize + 'px');
    r.setProperty('--name', a.nameColor);
    r.setProperty('--text', a.textColor);
    r.setProperty('--accent', a.accent);
    r.setProperty('--bg', hexToRgb(a.bgColor));
    r.setProperty('--bgA', a.bgOpacity);
    r.setProperty('--mediaH', a.mediaMaxHeight + 'vh');
    r.setProperty('--width', a.width + 'px');
    r.setProperty('--radius', (a.radius ?? 26) + 'px');
    r.setProperty('--cardX', a.cardX ?? 50);
    r.setProperty('--cardY', a.cardY ?? 82);
    r.setProperty('--cardScale', a.cardScale ?? 1);
    r.setProperty('--fit', a.mediaFit || 'cover');
    r.setProperty('--headline', a.headlineColor || a.textColor);
    r.setProperty('--border', hexToRgb(a.borderColor || '#ffffff'));
    r.setProperty('--borderA', a.borderOpacity ?? 0.1);
    r.setProperty('--padY', (a.padY ?? 26) + 'px');
    r.setProperty('--padX', (a.padX ?? 34) + 'px');
    r.setProperty('--gap', 'calc(' + a.textSize * 2.6 + 'px * var(--cardScale) + ' + a.mediaMaxHeight / 2 + 'vh)');
    r.setProperty('--shadow', a.shadow ? '0 30px 80px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.06) inset' : 'none');
    if (isEdit) showSample();
  }
  function hexToRgb(h) {
    h = (h || '#000').replace('#', '');
    if (h.length === 3)
      h = h
        .split('')
        .map(c => c + c)
        .join('');
    const n = parseInt(h, 16);
    return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
  }
  const faDigits = s => String(s).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]);
  function fmtNum(n, dec) {
    const s =
      dec != null
        ? Number(n)
            .toFixed(dec)
            .replace(/(\.\d*?)0+$/, '$1')
            .replace(/\.$/, '')
        : Math.round(n).toLocaleString('en-US');
    return A.persianDigits ? faDigits(s.replace('.', '٫').replace(/,/g, '٬')) : s;
  }
  function fmtUsd(v) {
    const s = (Math.round(Number(v || 0) * 100) / 100).toString();
    const n = A.persianDigits ? faDigits(s.replace('.', '٫')) : s;
    return A.currency === 'usd' ? '$' + n : A.currency === 'usd-code' ? n + ' USD' : n + ' دلار';
  }
  function fmtToman(t, full) {
    t = Number(t || 0);
    if (full) return fmtNum(t) + ' تومان';
    if (t >= 1000000) return fmtNum(t / 1000000, t % 1000000 === 0 ? 0 : t % 100000 === 0 ? 1 : 2) + ' میلیون تومان';
    if (t >= 1000) return fmtNum(t / 1000, 0) + ' هزار تومان';
    return fmtNum(t) + ' تومان';
  }
  // the amount in its own currency: "$5" style for dollars, "5 EUR" for a StreamElements tip in another currency
  function fmtOrig(tip, fa) {
    if (tip.currency && tip.currency !== 'USD') {
      const u = Math.round(tip.amount * 100) / 100;
      return (fa ? fmtNum(u, 2) : String(u)) + ' ' + tip.currency;
    }
    return fmtUsd(tip.amount);
  }
  function fmtAmount(tip) {
    const foreign = !!(tip.currency && tip.currency !== 'USD');
    if (foreign && tip.toman == null) return fmtOrig(tip); // no rate for this currency: amount and code only
    const c = A.currency || 'toman';
    if (c === 'eq-en') {
      const u = Math.round(tip.amount * 100) / 100;
      const left = foreign ? u + ' ' + tip.currency : u + '$';
      return tip.toman != null ? left + ' = ' + Math.round(tip.toman).toLocaleString('en-US') + ' Toman' : left;
    }
    if (c === 'eq-fa') {
      const u = fmtNum(Math.round(tip.amount * 100) / 100, 2);
      const left = foreign ? u + ' ' + tip.currency : u + '$';
      return tip.toman != null ? left + ' = ' + fmtNum(tip.toman) + ' تومان' : left;
    }
    if (c.startsWith('toman') && tip.toman != null) {
      if (c === 'toman-full') return fmtToman(tip.toman, true);
      if (c === 'toman-both')
        return (
          fmtToman(tip.toman) +
          ' (' +
          (foreign
            ? Math.round(tip.amount * 100) / 100 + ' ' + tip.currency
            : '$' + Math.round(tip.amount * 100) / 100) +
          ')'
        );
      return fmtToman(tip.toman);
    }
    return fmtOrig(tip);
  }
  function dirOf(s) {
    return /[؀-ۿ]/.test(s || '') ? 'rtl' : 'ltr';
  }
  function esc(s) {
    return String(s ?? '').replace(
      /[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
  }
  function safeUrl(u) {
    try {
      const x = new URL(String(u));
      return x.protocol === 'https:' || (x.protocol === 'http:' && x.hostname === location.hostname) ? x.href : null;
    } catch {
      return null;
    }
  }
  function localUrl(u) {
    try {
      const x = new URL(String(u), location.origin);
      return x.origin === location.origin ? x.href : null;
    } catch {
      return null;
    }
  }
  function headline(tip) {
    let tpl = A.template || '{name} با {amount} حمایت کرد';
    if (tip.kind === 'gift') tpl = A.giftTemplate || '{name} {count} تا ساب گیفت داد 🎁 {amount}';
    else if (tip.kind === 'sub') tpl = A.subTemplate || '{name} ساب شد ⭐ {amount}';
    const pill = txt =>
      `<span class="amt${['plain', 'inherit', 'soft'].includes(A.amountStyle) ? ' ' + A.amountStyle : ''}" dir="auto">${esc(txt)}</span>`;
    // every placeholder is resolved in ONE pass over the (escaped) template, so a donor name that itself
    // contains "{amount}" or "$&" can never be re-interpreted; values are always escaped text.
    const parts = {
      name: `<b dir="auto">${esc(tip.name)}</b>`,
      amount: A.showAmount ? pill(fmtAmount(tip)) : '',
      toman: tip.toman != null ? pill(fmtToman(tip.toman)) : '',
      usd: pill(fmtOrig(tip)),
      count: pill(A.persianDigits ? faDigits(String(tip.count || 1)) : String(tip.count || 1))
    };
    return esc(tpl).replace(/\{(name|amount|toman|usd|count)\}/g, (m, k) => parts[k]);
  }
  function buildCard(tip) {
    const card = document.createElement('div');
    card.className =
      'card' +
      (A.showLine === false ? ' noline' : '') +
      (A.showGlow === false ? ' noglow' : '') +
      (A.showBorder === false ? ' noborder' : '') +
      (A.showGloss ? ' gloss' : '');
    card.innerHTML =
      `<span class="badge">TEST</span><div class="shine"></div><div class="headline" dir="${dirOf(tip.kind === 'gift' ? A.giftTemplate : tip.kind === 'sub' ? A.subTemplate : A.template)}">${headline(tip)}</div>` +
      (A.showMessage && tip.message ? `<div class="msg" dir="auto">${esc(tip.message)}</div>` : '');
    return card;
  }

  function play(tip) {
    stop();
    hideSample();
    const el = document.createElement('div');
    el.className = 'alert' + (tip.is_test ? ' test' : '');
    const mediaBox = document.createElement('div');
    mediaBox.className = 'media ' + (A.mediaMode === 'boxed' ? 'boxed' : 'full');
    const card = buildCard(tip);
    el.appendChild(mediaBox);
    el.appendChild(card);
    stage.appendChild(el);
    current = { el, tip, timers: [], media: [] };
    // Optional delay before the name/amount card (and the TTS) appears: per file first, else the appearance setting.
    const delayS = tip.media && tip.media.cardDelay != null ? Number(tip.media.cardDelay) : Number(A.cardDelay || 0);
    const cardDelayMs =
      Number.isFinite(delayS) && delayS > 0
        ? Math.min(delayS * 1000, Math.max(0, (A.maxDuration || 90) * 1000 - 1500))
        : 0;
    const ttsUrl = tip.tts_url ? safeUrl(tip.tts_url) : null;
    let ttsDone = () => {};
    const showCard = () => {
      if (!current || current.el !== el) return;
      card.style.visibility = '';
      animate(card, 'in');
      if (ttsUrl) playTts(ttsUrl, clamp((A.ttsVolume ?? 70) / 100)).then(ttsDone, ttsDone);
    };
    animate(mediaBox, 'in', true);

    const vol = clamp((A.volume ?? 80) / 100);
    let visualDur = null,
      waits = [];
    const m = tip.media;
    const addImg = src => {
      const ok = localUrl(src) || safeUrl(src);
      /* local /media/... first, then https for KickBot GIFs */ if (!ok) return;
      const im = document.createElement('img');
      im.src = ok;
      mediaBox.appendChild(im);
      mediaBox.style.display = 'block';
    };
    if (m && m.type === 'video') {
      const v = document.createElement('video');
      v.src = localUrl(m.url) || '';
      v.autoplay = true;
      v.playsInline = true;
      v.volume = clamp(vol * ((m.volume ?? 100) / 100));
      mediaBox.appendChild(v);
      mediaBox.style.display = 'block';
      current.media.push(v);
      waits.push(
        new Promise(res => {
          let d = false;
          const fin = () => {
            if (!d) {
              d = true;
              res();
            }
          };
          v.addEventListener('ended', fin);
          v.addEventListener('error', fin);
          if (m.duration)
            v.addEventListener('timeupdate', () => {
              if (v.currentTime >= m.duration) {
                v.pause();
                fin();
              }
            });
          v.play().catch(fin);
        })
      );
    } else if (m && m.type === 'image') {
      addImg(m.url);
      visualDur = (m.duration || A.imageDuration || 8) * 1000;
    } else if (m && m.type === 'audio') {
      const a = new Audio(localUrl(m.url) || '');
      a.volume = clamp(vol * ((m.volume ?? 100) / 100));
      current.media.push(a);
      waits.push(
        new Promise(res => {
          let d = false;
          const fin = () => {
            if (!d) {
              d = true;
              res();
            }
          };
          a.addEventListener('ended', fin);
          a.addEventListener('error', fin);
          if (m.duration)
            a.addEventListener('timeupdate', () => {
              if (a.currentTime >= m.duration) {
                a.pause();
                fin();
              }
            });
          a.play().catch(fin);
        })
      );
      if (tip.gif_url) addImg(tip.gif_url);
    } else if (tip.gif_url) addImg(tip.gif_url);

    if (ttsUrl) waits.push(new Promise(r => (ttsDone = r)));
    if (cardDelayMs > 0) {
      card.style.visibility = 'hidden';
      current.timers.push(setTimeout(showCard, cardDelayMs));
    } else showCard();

    const minMs = (A.minDuration || 6) * 1000,
      maxMs = (A.maxDuration || 90) * 1000;
    const cardMinMs = cardDelayMs ? cardDelayMs + Math.min(minMs, 4000) : 0; // a delayed card still stays up for a few seconds
    const minWait = new Promise(r => current.timers.push(setTimeout(r, Math.max(minMs, visualDur || 0, cardMinMs))));
    const cap = new Promise(r => current.timers.push(setTimeout(r, maxMs)));
    Promise.race([Promise.all([Promise.all(waits), minWait]), cap]).then(() => {
      if (current && current.el === el) end();
    });
  }

  // JS-driven animation. If the host does not advance animations (hidden/offscreen page),
  // the animation is cancelled after a short grace period and the element snaps to its resting state.
  function animate(el, dir, isMedia) {
    if (!el) return Promise.resolve();
    const kind = A.animation || 'pop';
    if (kind === 'none' || document.visibilityState === 'hidden') return Promise.resolve();
    const sc = Number(A.cardScale ?? 1);
    const base = `translate(-50%,-50%) scale(${sc})`;
    const tr = (m, dy) => `translate(-50%,calc(-50% + ${dy || 0}px)) scale(${sc * (m || 1)})`;
    let frames,
      dur = 500;
    if (isMedia) {
      frames = dir === 'in' ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }];
    } else if (kind === 'pop') {
      dur = dir === 'in' ? 700 : 450;
      frames =
        dir === 'in'
          ? [
              { opacity: 0, transform: tr(0.6) },
              { opacity: 1, transform: tr(1.05), offset: 0.6 },
              { opacity: 1, transform: base }
            ]
          : [
              { opacity: 1, transform: base },
              { opacity: 0, transform: tr(0.85) }
            ];
    } else if (kind === 'slide') {
      dur = dir === 'in' ? 650 : 500;
      frames =
        dir === 'in'
          ? [
              { opacity: 0, transform: tr(1, 160) },
              { opacity: 1, transform: base }
            ]
          : [
              { opacity: 1, transform: base },
              { opacity: 0, transform: tr(1, 160) }
            ];
    } else {
      frames = dir === 'in' ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }];
    }
    let anim;
    try {
      anim = el.animate(frames, {
        duration: dur,
        easing: dir === 'in' && kind === 'pop' ? 'cubic-bezier(.2,1.2,.3,1)' : 'ease-out',
        fill: 'forwards'
      });
    } catch {
      return Promise.resolve();
    }
    return new Promise(res => {
      let done = false;
      const fin = () => {
        if (!done) {
          done = true;
          res();
        }
      };
      anim.onfinish = fin;
      anim.oncancel = fin;
      setTimeout(() => {
        if (!done) {
          try {
            anim.cancel();
          } catch {}
          fin();
        }
      }, dur + 400);
    });
  }

  function playTts(url, vol) {
    const candidates = [url];
    try {
      const p = new URL(url).pathname;
      candidates.push('https://ttsaudio.kickbot.com' + p, 'https://tts.kickbotcdn.com' + p);
    } catch {}
    return new Promise(res => {
      let i = 0,
        started = false,
        done = false;
      const fin = () => {
        if (!done) {
          done = true;
          res();
        }
      };
      const next = () => {
        if (started || done) return fin(); // never start a second copy once one has played
        if (i >= candidates.length) return fin();
        const a = new Audio(candidates[i++]);
        a.volume = vol;
        current && current.media.push(a);
        a.addEventListener('playing', () => {
          started = true;
        });
        a.addEventListener('ended', fin);
        a.addEventListener('error', () => {
          if (!started) next();
          else fin();
        });
        a.play().catch(() => {
          if (!started) next();
        });
      };
      next();
    });
  }
  function end() {
    if (!current) return;
    const c = current;
    current = null;
    c.timers.forEach(clearTimeout);
    const card = c.el.querySelector('.card'),
      mb = c.el.querySelector('.media');
    Promise.all([animate(card, 'out'), animate(mb, 'out', true)]).then(() => {
      c.media.forEach(x => {
        try {
          x.pause();
          x.src = '';
        } catch {}
      });
      c.el.remove();
      if (isEdit) showSample();
    });
    if (!isPreview)
      fetch('/api/done', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: c.tip.id })
      }).catch(() => {});
  }
  function stop() {
    if (!current) return;
    const c = current;
    current = null;
    c.timers.forEach(clearTimeout);
    c.media.forEach(x => {
      try {
        x.pause();
        x.src = '';
      } catch {}
    });
    c.el.remove();
    if (isEdit) showSample();
  }
  function clamp(v) {
    return Math.max(0, Math.min(1, isNaN(v) ? 1 : v));
  }

  // ---- edit mode: static sample card, draggable ----
  function showSample() {
    if (current) return;
    hideSample();
    const el = document.createElement('div');
    el.className = 'alert';
    const card = buildCard({
      name: 'AliGamer',
      amount: 10,
      toman: A.sampleToman || null,
      message: 'اینجا پیام دونیت نمایش داده می‌شه'
    });
    card.style.opacity = 1;
    el.appendChild(card);
    stage.appendChild(el);
    sample = el;
    let drag = null;
    card.addEventListener('pointerdown', e => {
      e.preventDefault();
      card.setPointerCapture(e.pointerId);
      card.classList.add('dragging');
      drag = { sx: e.clientX, sy: e.clientY, x: Number(A.cardX ?? 50), y: Number(A.cardY ?? 82) };
    });
    card.addEventListener('pointermove', e => {
      if (!drag) return;
      let x = drag.x + ((e.clientX - drag.sx) / innerWidth) * 100,
        y = drag.y + ((e.clientY - drag.sy) / innerHeight) * 100;
      if (e.shiftKey) {
        if (Math.abs(x - 50) < 2) x = 50;
        if (Math.abs(y - 50) < 2) y = 50;
      }
      x = Math.max(0, Math.min(100, x));
      y = Math.max(0, Math.min(100, y));
      A.cardX = x;
      A.cardY = y;
      document.documentElement.style.setProperty('--cardX', x);
      document.documentElement.style.setProperty('--cardY', y);
      parent.postMessage({ type: 'cardpos', x: +x.toFixed(2), y: +y.toFixed(2), final: false }, location.origin);
    });
    const up = e => {
      if (!drag) return;
      drag = null;
      card.classList.remove('dragging');
      parent.postMessage(
        { type: 'cardpos', x: +Number(A.cardX).toFixed(2), y: +Number(A.cardY).toFixed(2), final: true },
        location.origin
      );
    };
    card.addEventListener('pointerup', up);
    card.addEventListener('pointercancel', up);
  }
  function hideSample() {
    if (sample) {
      sample.remove();
      sample = null;
    }
  }

  // ---- connection ----
  function connect() {
    const es = new EventSource('/events?role=' + (isPreview ? 'preview' : 'overlay'));
    es.onmessage = ev => {
      let d;
      try {
        d = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (d.type === 'config') applyConfig(d.appearance);
      else if (d.type === 'play') play(d.tip);
      else if (d.type === 'stop') stop();
    };
    es.onerror = () => {
      es.close();
      setTimeout(connect, 2000);
    };
  }
  connect();
  const cv = document.createElement('canvas');
  cv.width = cv.height = 1;
  const ctx = cv.getContext('2d', { alpha: false });
  ctx && ctx.fillRect(0, 0, 1, 1);
})();
