// Sahne Plus — Analytics page. Presentation only: every number comes from GET /api/analytics, which the server
// computes from the recorded donation history with the same calendar, currency and rate rules as the rest of the app.
// Loaded after app.js and deliberately redeclares none of its globals ($ / esc / faNum / fmtToman / api / toast);
// those are shared classic-script globals, and a second `const $` would be a redeclaration SyntaxError.
'use strict';

(() => {
  if (!$('#anBody')) return; // the page markup is optional (e.g. an older app.html)

  const RANGES = ['today', 'week', 'month'];
  let LAST = null; // the last payload, so a metric switch or a resize redraws without re-fetching
  let RANGE = 'today';
  let CUSTOM = null; // { from, to } once the user applies a custom range
  let METRIC = 'usd'; // usd | toman | count
  let BUSY = false;
  let liveT; // debounce timer for a live refresh triggered by the event stream

  // ---------- small formatters (the page's own, not a second copy of the app's) ----------
  const isNum = n => typeof n === 'number' && Number.isFinite(n);
  const axisTz = () => (LAST && LAST.range ? LAST.range.tzOffsetMin : -new Date().getTimezoneOffset());
  const localDate = ms => new Date(ms + axisTz() * 60000);

  const usd = n => (isNum(n) ? '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—');
  /** Compact USD for axis ticks: $1.2k / $12k / $1.2M. */
  function usdShort(n) {
    if (!isNum(n)) return '';
    const a = Math.abs(n);
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
    if (a >= 1e3) return '$' + (n / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k';
    return '$' + Math.round(n);
  }
  const KIND_FA = { tip: 'دونیت', sub: 'ساب', gift: 'ساب‌گیفت' };
  const SOURCE_FA = { kickbot: 'کیک‌بات', streamelements: 'StreamElements', kick: 'چت کیک', other: 'دیگر' };

  /** "2026-09-24" → "۲۴ شهریور" style, via the Persian calendar the app already relies on. */
  const dayFmt = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  function dayLabel(ms) {
    try {
      return dayFmt.format(localDate(ms));
    } catch {
      return String(localDate(ms).getUTCDate());
    }
  }
  function hourLabel(ms) {
    const d = localDate(ms);
    return faNum(String(d.getUTCHours()).padStart(2, '0')) + ':۰۰';
  }
  function bucketLabel(p, g) {
    if (g === 'hour') return hourLabel(p.startMs);
    return dayLabel(p.startMs);
  }
  function fullStamp(ms) {
    const d = localDate(ms);
    return `${dayLabel(ms)} — ${faNum(String(d.getUTCHours()).padStart(2, '0'))}:${faNum(String(d.getUTCMinutes()).padStart(2, '0'))}`;
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    const ms = Date.parse(iso);
    return isNum(ms) ? dayLabel(ms) : '—';
  }
  /**
   * A "YYYY-MM-DD" key is a *local* calendar day, so it is rendered as local noon of that day. Parsing it as an
   * instant and shifting would land on the previous day for a negative offset.
   */
  function dayKeyLabel(key) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
    if (!m) return '—';
    return dayLabel(Date.UTC(+m[1], +m[2] - 1, +m[3], 12) - axisTz() * 60000);
  }
  /** "۳ دقیقه پیش" for the last-updated line. */
  function agoText(iso) {
    const ms = Date.parse(iso || '');
    if (!isNum(ms)) return '';
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 45) return 'همین حالا';
    if (s < 3600) return faNum(Math.round(s / 60)) + ' دقیقه پیش';
    return faNum(Math.round(s / 3600)) + ' ساعت پیش';
  }

  // ---------- tooltip ----------
  let TT = null;
  function tip(html, x, y) {
    if (!TT) {
      TT = document.createElement('div');
      TT.className = 'an-tt';
      document.body.appendChild(TT);
    }
    TT.innerHTML = html;
    TT.classList.add('show');
    const r = TT.getBoundingClientRect();
    let left = x + 14;
    let top = y - r.height - 12;
    if (left + r.width > innerWidth - 10) left = x - r.width - 14;
    if (top < 10) top = y + 18;
    TT.style.left = Math.max(10, left) + 'px';
    TT.style.top = Math.max(10, top) + 'px';
  }
  function untip() {
    if (TT) TT.classList.remove('show');
  }
  document.addEventListener('mouseover', e => {
    const el = e.target.closest && e.target.closest('[data-tip]');
    if (!el) return;
    const ev = e;
    tip(el.getAttribute('data-tip'), ev.clientX, ev.clientY);
  });
  document.addEventListener('mousemove', e => {
    if (!TT || !TT.classList.contains('show')) return;
    if (!(e.target.closest && e.target.closest('[data-tip]'))) return untip();
    const r = TT.getBoundingClientRect();
    let left = e.clientX + 14;
    let top = e.clientY - r.height - 12;
    if (left + r.width > innerWidth - 10) left = e.clientX - r.width - 14;
    if (top < 10) top = e.clientY + 18;
    TT.style.left = Math.max(10, left) + 'px';
    TT.style.top = Math.max(10, top) + 'px';
  });
  document.addEventListener('mouseout', e => {
    if (TT && e.target.closest && e.target.closest('[data-tip]')) untip();
  });
  window.addEventListener('scroll', untip, true);

  const tipRows = rows =>
    rows
      .filter(r => r[1] !== null && r[1] !== undefined && r[1] !== '')
      .map(r => `<div class="r"><span>${esc(r[0])}</span><span>${esc(String(r[1]))}</span></div>`)
      .join('');

  /**
   * Tooltips are built as escaped HTML and carried in a `data-tip` attribute, then assigned with innerHTML. The
   * escaping therefore has to be applied twice: `tipRows` escapes each value once (so a donor name cannot inject
   * markup into the tooltip), and `tipAttr` escapes the assembled tooltip again so that the one round of
   * character-reference decoding the HTML parser performs on the attribute yields back that same safe markup —
   * not a decoded `<script>`.
   */
  const tipAttr = html => esc(html);

  // ---------- KPI cards ----------
  function delta(cur, prev, unit) {
    if (!isNum(cur) || !isNum(prev) || !prev) return '';
    const d = ((cur - prev) / prev) * 100;
    const cls = d > 0.5 ? 'up' : d < -0.5 ? 'down' : 'flat';
    const sign = d > 0 ? '+' : '';
    return `<span class="delta ${cls}">${sign}${faNum(Math.round(d))}٪ ${esc(unit)}</span>`;
  }

  function kpiCards(d) {
    const t = d.totals;
    const prev = d.previous;
    const rate = d.rate && d.rate.usable ? d.rate.value : null;
    const cards = [
      {
        icon: 'i-send',
        lbl: 'مجموع دونیت‌ها',
        // a period with donations in another currency only has no dollar total — say so rather than showing $0.00
        big: t.usdCount ? usd(t.amountUsd) : t.count ? '—' : usd(0),
        sub:
          t.usdCount && t.count > t.usdCount
            ? `<span class="fa">از ${faNum(t.usdCount)} دونیت دلاری</span>`
            : `<span class="fa">${faNum(t.count)} دونیت</span>`,
        subFa: true,
        delta: delta(t.amountUsd, prev && prev.amountUsd, 'نسبت به دوره‌ی قبل')
      },
      {
        icon: 'i-chart',
        lbl: 'معادل تومانی',
        big: isNum(t.amountToman) ? fmtToman(t.amountToman) : '—',
        sub: isNum(t.amountToman)
          ? rate
            ? `<span class="fa">با نرخ ${faNum(rate)} تومان</span>`
            : ''
          : '<span class="fa">نرخ دلار در دسترس نیست</span>',
        subFa: true,
        delta: delta(t.amountToman, prev && prev.amountToman, 'نسبت به دوره‌ی قبل')
      },
      { icon: 'i-queue', lbl: 'تعداد دونیت', big: faNum(t.count), sub: '', delta: delta(t.count, prev && prev.count, 'نسبت به دوره‌ی قبل') },
      {
        icon: 'i-pulse',
        lbl: 'میانگین',
        big: t.usdCount ? usd(t.avgUsd) : '—',
        sub: isNum(t.avgToman) ? `<span class="fa">≈ ${fmtToman(t.avgToman)} تومان</span>` : '',
        subFa: true,
        delta: ''
      },
      {
        icon: 'i-star',
        lbl: 'بزرگ‌ترین دونیت',
        big: t.usdCount ? usd(t.maxUsd) : isNum(t.maxToman) ? fmtToman(t.maxToman) : '—',
        sub: t.largestDonor ? esc(t.largestDonor) : '',
        subFa: true,
        delta: ''
      },
      {
        icon: 'i-users',
        lbl: 'دونیت‌کننده‌ی یکتا',
        big: faNum(t.uniqueDonors),
        sub:
          t.uniqueDonors > 0
            ? `<span class="fa">${faNum(t.repeatDonors)} نفر تکرار کرده${t.newDonors ? ' · ' + faNum(t.newDonors) + ' نفر تازه' : ''}</span>`
            : '',
        subFa: true,
        delta: delta(t.uniqueDonors, prev && prev.uniqueDonors, 'نسبت به دوره‌ی قبل')
      }
    ];
    return cards
      .map(
        c => `<div class="an-kpi span-4">
        <div class="lbl"><svg><use href="#${c.icon}"/></svg>${esc(c.lbl)}</div>
        <div class="big">${c.big}</div>
        <div class="sub${c.subFa ? ' fa' : ''}">${c.sub || ''} ${c.delta || ''}</div>
      </div>`
      )
      .join('');
  }

  // ---------- trend chart ----------
  function metricValue(p, metric) {
    if (metric === 'count') return p.count;
    if (metric === 'toman') return p.converted ? p.toman : null;
    return p.count && !p.usd && p.toman ? null : p.usd;
  }
  const axisFmt = (v, metric) => {
    if (metric === 'count') return faNum(v);
    if (metric === 'toman') return fmtToman(v);
    return usdShort(v);
  };

  function trendChart(d) {
    const g = d.series.granularity;
    const pts = d.series.points;
    const metric = METRIC;
    const W = Math.max($('#anTrend') ? $('#anTrend').clientWidth : 0, 320);
    const H = 220;
    const pad = { l: 52, r: 12, t: 12, b: 26 };
    const iw = W - pad.l - pad.r;
    const ih = H - pad.t - pad.b;
    const vals = pts.map(p => metricValue(p, metric));
    const nums = vals.filter(isNum);
    const max = nums.length ? Math.max(...nums) : 0;
    // a flat-zero series must not become a full-height line at the top: keep a nominal scale and say so below
    const scaleMax = max > 0 ? max : 1;
    const x = i => pad.l + (pts.length === 1 ? iw / 2 : (i / (pts.length - 1)) * iw);
    const y = v => pad.t + ih - (Math.max(0, isNum(v) ? v : 0) / scaleMax) * ih;

    const gridN = 4;
    let grid = '';
    for (let k = 0; k <= gridN; k++) {
      const v = (scaleMax / gridN) * k;
      const yy = y(v);
      grid += `<line class="grid-line" x1="${pad.l}" y1="${yy.toFixed(1)}" x2="${W - pad.r}" y2="${yy.toFixed(1)}"/>`;
      grid += `<text x="${pad.l - 8}" y="${(yy + 3.5).toFixed(1)}" text-anchor="end">${esc(axisFmt(v, metric))}</text>`;
    }

    const known = pts.map((p, i) => ({ i, v: metricValue(p, metric) })).filter(o => o.v !== null);
    let path = '';
    if (known.length) {
      path = known.map((o, k) => `${k ? 'L' : 'M'}${x(o.i).toFixed(1)} ${y(o.v).toFixed(1)}`).join(' ');
      // close back to the baseline for the soft area fill
      const area = `${path} L${x(known[known.length - 1].i).toFixed(1)} ${(pad.t + ih).toFixed(1)} L${x(known[0].i).toFixed(1)} ${(pad.t + ih).toFixed(1)} Z`;
      path = `<path class="area" d="${area}"/><path class="line" vector-effect="non-scaling-stroke" d="${path}"/>`;
    } else {
      path = `<line class="empty-line" x1="${pad.l}" y1="${pad.t + ih}" x2="${W - pad.r}" y2="${pad.t + ih}"/>`;
    }

    // x labels: never crowd them — pick a stride that keeps roughly 8 labels
    const stride = Math.max(1, Math.ceil(pts.length / 8));
    let xlabels = '';
    pts.forEach((p, i) => {
      if (i % stride && i !== pts.length - 1) return;
      xlabels += `<text class="fa" x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(bucketLabel(p, g))}</text>`;
    });

    // hit targets + dots
    let marks = '';
    const r = Math.max(3, Math.min(14, iw / Math.max(pts.length, 1) / 2.4));
    pts.forEach((p, i) => {
      const v = metricValue(p, metric);
      const cx = x(i);
      const rows = [
        [g === 'hour' ? 'ساعت' : 'بازه', fullStamp(p.startMs)],
        ['تعداد', faNum(p.count)],
        ['دلار', p.usd ? usd(p.usd) : null],
        ['تومان', isNum(p.toman) && p.toman ? fmtToman(p.toman) + ' تومان' : null]
      ];
      const tipHtml = `<b>${esc(fullStamp(p.startMs))}</b>${tipRows(rows)}`;
      marks += `<rect class="hit" x="${(cx - r).toFixed(1)}" y="${pad.t}" width="${(r * 2).toFixed(1)}" height="${ih.toFixed(
        1
      )}" data-tip="${tipAttr(tipHtml)}"/>`;
      if (isNum(v) && v > 0)
        marks += `<circle class="dot" cx="${cx.toFixed(1)}" cy="${y(v).toFixed(1)}" r="3" data-tip="${tipAttr(tipHtml)}"/>`;
    });

    const zeroNote = max === 0 ? `<p class="hint">در این بازه هیچ مبلغی ثبت نشده؛ نمودار صفر است.</p>` : '';
    return {
      html: `<div class="seg" id="anMetric" style="margin-bottom:10px">
          <button data-metric="usd" class="${METRIC === 'usd' ? 'active' : ''}">دلار</button>
          <button data-metric="toman" class="${METRIC === 'toman' ? 'active' : ''}">تومان</button>
          <button data-metric="count" class="${METRIC === 'count' ? 'active' : ''}">تعداد</button>
        </div>
        <svg class="an-chart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
          ${grid}${path}${marks}${xlabels}
        </svg>
        ${zeroNote}`
    };
  }

  // ---------- distribution ----------
  function distributionChart(d) {
    const bins = d.distribution || [];
    const total = bins.reduce((a, b) => a + b.count, 0);
    if (!total) return '<p class="hint">مبلغی برای دسته‌بندی نیست.</p>';
    const max = Math.max(...bins.map(b => b.count), 1);
    const W = Math.max($('#anDist') ? $('#anDist').clientWidth : 0, 320);
    const H = 190;
    const pad = { l: 34, r: 10, t: 16, b: 40 };
    const iw = W - pad.l - pad.r;
    const ih = H - pad.t - pad.b;
    const bw = iw / bins.length;
    let bars = '';
    bins.forEach((b, i) => {
      const h = (b.count / max) * ih;
      const x = pad.l + i * bw + bw * 0.16;
      const w = bw * 0.68;
      const yy = pad.t + ih - h;
      const rows = [
        ['تعداد', faNum(b.count) + (total ? ` (${faNum(Math.round((b.count / total) * 100))}٪)` : '')],
        ['مجموع دلار', b.usd ? usd(b.usd) : null]
      ];
      bars += `<rect class="${i === bins.length - 1 ? 'bar hot' : 'bar'}" x="${x.toFixed(1)}" y="${yy.toFixed(
        1
      )}" width="${w.toFixed(1)}" height="${Math.max(h, 1).toFixed(1)}" rx="4" data-tip="${tipAttr(
        `<b>${esc(b.label)}</b>${tipRows(rows)}`
      )}"/>`;
      if (b.count)
        bars += `<text x="${(x + w / 2).toFixed(1)}" y="${(yy - 5).toFixed(1)}" text-anchor="middle">${esc(faNum(b.count))}</text>`;
      bars += `<text class="fa" x="${(x + w / 2).toFixed(1)}" y="${H - 22}" text-anchor="middle">${esc(b.label)}</text>`;
    });
    return `<svg class="an-chart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
        <line class="axis" x1="${pad.l}" y1="${pad.t + ih}" x2="${W - pad.r}" y2="${pad.t + ih}"/>${bars}
      </svg>
      <p class="hint">دسته‌ها روی مبلغ دلاری بسته می‌شوند؛ ${esc(faNum(total))} دونیت دلاری در این بازه.</p>`;
  }

  // ---------- top donors ----------
  function donorList(d) {
    const list = d.topDonors || [];
    if (!list.length) return '<p class="hint">دونیت‌کننده‌ای در این بازه نیست.</p>';
    const max = Math.max(...list.map(x => (isNum(x.toman) ? x.toman : x.usd || 0)), 1);
    return `<div class="an-donors">${list
      .map((x, i) => {
        const v = isNum(x.toman) && x.toman ? x.toman : x.usd || 0;
        const amt = isNum(x.toman) && x.toman ? fmtToman(x.toman) : usd(x.usd);
        const tipHtml = `<b>${esc(x.name)}</b>${tipRows([
          ['تعداد', faNum(x.count)],
          ['مجموع دلار', x.usd ? usd(x.usd) : null],
          ['مجموع تومان', isNum(x.toman) && x.toman ? fmtToman(x.toman) + ' تومان' : null],
          ['میانگین', x.avgUsd ? usd(x.avgUsd) : null]
        ])}`;
        return `<div class="an-donor" data-tip="${tipAttr(tipHtml)}">
          <span class="rank">${esc(faNum(i + 1))}</span>
          <div class="who"><b>${esc(x.name)}</b>
            <div class="track"><div class="fill" style="width:${Math.max(2, Math.round((v / max) * 100))}%"></div></div>
          </div>
          <div class="amt">${esc(amt)}<small>${esc(faNum(x.count))} دونیت</small></div>
        </div>`;
      })
      .join('')}</div>`;
  }

  // ---------- breakdown ----------
  function breakdownRows(rows, labelOf, d) {
    const total = rows.reduce((a, r) => a + r.count, 0) || 1;
    return rows
      .map(r => {
        const s = r.count / total;
        return `<div class="kv" data-tip="${tipAttr(
          tipRows([
            ['تعداد', faNum(r.count)],
            ['سهم', faNum(Math.round(s * 100)) + '٪'],
            ['مجموع دلار', r.amountUsd ? usd(r.amountUsd) : null],
            ['مجموع تومان', isNum(r.amountToman) && r.amountToman ? fmtToman(r.amountToman) + ' تومان' : null]
          ])
        )}">
        <b>${esc(labelOf(r.key))}</b>
        <span class="row" style="gap:10px">
          <span class="hint" style="margin:0">${esc(faNum(Math.round(s * 100)))}٪</span>
          <span class="num">${esc(faNum(r.count))}</span>
        </span>
      </div>`;
      })
      .join('');
  }

  // ---------- heatmap ----------
  function heatmap(d) {
    const h = d.heatmap;
    if (!h) return '';
    if (!h.available)
      return `<div class="empty" style="padding:26px">
        <div>برای نقشه‌ی فعالیت، داده کافی نیست.</div>
        <p class="hint" style="margin-top:8px">با ${esc(faNum(h.dated))} دونیتِ زمان‌دار در این بازه، هر الگویی فقط تصادف است. حداقل ${esc(
          faNum(h.minEvents)
        )} دونیت لازم است.</p>
      </div>`;
    const cells = h.cells || [];
    let html = '<div class="an-heat">';
    html += '<div class="dy"></div>';
    for (let hr = 0; hr < 24; hr++) html += `<div class="hd">${hr % 3 === 0 ? esc(faNum(hr)) : ''}</div>`;
    for (let rw = 0; rw < 7; rw++) {
      html += `<div class="dy">${esc(h.days ? h.days[rw] : '')}</div>`;
      for (let hr = 0; hr < 24; hr++) {
        const c = (cells[rw] && cells[rw][hr]) || 0;
        const a = c && h.max ? 0.16 + 0.84 * (c / h.max) : 0;
        html += `<div class="cell" style="${c ? `background:rgba(210,180,163,${a.toFixed(2)})` : ''}" data-tip="${tipAttr(
          `<b>${esc(h.days ? h.days[rw] : '')} — ${esc(faNum(hr))}:۰۰</b>${tipRows([['تعداد', faNum(c)]])}`
        )}"></div>`;
      }
    }
    html += '</div>';
    html += `<p class="hint">رنگ هر خانه نسبت به شلوغ‌ترین ساعت همین بازه است (بیشترین: ${esc(faNum(h.max))} دونیت). زمان‌ها به وقت محلی همین کامپیوتر‌اند.</p>`;
    return html;
  }

  // ---------- notes ----------
  const NOTE_TEXT = {
    duplicates: n => `${faNum(n)} دونیت تکراری فقط یک‌بار شمرده شد (همان شناسه‌ی پرداخت).`,
    undated: n => `${faNum(n)} دونیت بدون زمان معتبر بود و در بازه‌ها نیامده.`,
    'no-rate': n => `نرخ دلار در دسترس نیست، پس معادل تومانی برای ${faNum(n)} دونیت محاسبه نشد.`,
    unconverted: n => `برای ${faNum(n)} دونیت معادل تومانی ثبت نشده؛ در جمع تومانی نیامده‌اند.`,
    'no-historic-rate': () =>
      'معادل تومانی هر دونیت همان لحظه‌ای ثبت شده که دونیت رسیده؛ در کارت‌ها نرخ «الان» نمایش داده می‌شود، نه نرخ تاریخی.',
    truncated: () => 'تاریخچه بیشتر از سقف ذخیره‌سازی است؛ فقط جدیدترین رکوردها محاسبه شده‌اند.',
    'rolled-up': n =>
      `این بازه به ${faNum(n)} ماه قدیمی‌تر می‌رسد که فقط به‌صورت خلاصه‌ی ماهانه نگه‌داری می‌شوند؛ جزئیات آن‌ها برای محاسبه‌ی دقیق در دسترس نیست.`
  };
  const BAD_DATA_TEXT = {
    'missing-id': 'بدون شناسه‌ی پرداخت',
    'invalid-amount': 'مبلغ نامعتبر یا صفر',
    'not-an-object': 'ساختار ناشناس'
  };
  function notesBlock(d) {
    const out = [];
    for (const n of d.notes || []) {
      if (n.code === 'no-historic-rate') continue; // always shown, in the methodology paragraph
      const t = NOTE_TEXT[n.code];
      const label = n.code === 'bad-data' ? `داده‌ی ناسالم (${BAD_DATA_TEXT[n.reason] || n.reason})` : null;
      const count = n.count !== undefined ? n.count : null;
      const text = label ? `${label}: ${faNum(count ?? 0)} مورد نادیده گرفته شد.` : t ? t(count ?? 0) : null;
      if (text) out.push({ text, quiet: false });
    }
    return out;
  }

  // ---------- page ----------
  function emptyState(d) {
    const hasHistory = d.coverage && d.coverage.events > 0;
    return `<div class="empty" style="padding:60px 24px">
      <div style="font-size:16px;font-weight:700;color:var(--text)">در این بازه دونیتی ثبت نشده</div>
      <p class="hint" style="margin-top:10px">${
        hasHistory
          ? `تاریخچه‌ی ضبط‌شده ${esc(faNum(d.coverage.events))} دونیت دارد؛ در بازه‌ی انتخاب‌شده چیزی نیست. بازه‌ی دیگری را امتحان کن.`
          : 'هنوز هیچ دونیتی ضبط نشده. از زمانی که برنامه روشن است، دونیت‌های رسیده اینجا جمع می‌شوند.'
      }</p>
    </div>`;
  }

  function gotoHint(d) {
    const src = (d.breakdown && d.breakdown.bySource) || [];
    const byKind = (d.breakdown && d.breakdown.byKind) || [];
    const cur = (d.breakdown && d.breakdown.byCurrency) || [];
    const bits = [];
    if (cur.length > 1 || (cur[0] && cur[0].key !== 'USD')) bits.push(`واحدها: ${cur.map(c => esc(c.key)).join('، ')}`);
    if (byKind.length) bits.push(`نوع: ${byKind.map(k => esc(KIND_FA[k.key] || k.key)).join('، ')}`);
    if (src.length) bits.push(`منبع: ${src.map(s => esc(SOURCE_FA[s.key] || s.key)).join('، ')}`);
    return bits.length ? bits.join(' · ') : '';
  }

  function render(d) {
    LAST = d;
    const t = d.totals;
    const thin = t.count > 0 && t.count < 5;
    const blocks = [];

    blocks.push(`<div class="an-grid">${kpiCards(d)}</div>`);

    if (!t.count) {
      blocks.push(emptyState(d));
    } else {
      if (thin)
        blocks.push(
          `<div class="an-note quiet" style="margin-top:14px"><svg><use href="#i-info"/></svg><div>تعداد دونیت این بازه کم است؛ میانگین، میانه و نمودار روند را با احتیاط بخوان.${d.previous ? '' : ' دوره‌ی قبل هم داده‌ای ندارد، پس مقایسه‌ای نشان داده نمی‌شود.'}</div></div>`
        );

      blocks.push(`<div class="an-grid" style="margin-top:14px">
        <div class="card an-w7 span-7" id="anTrendCard">
          <h3><svg><use href="#i-chart"/></svg>روند دونیت‌ها<span class="tail" id="anTrendTail"></span></h3>
          <div id="anTrend"></div>
        </div>
        <div class="card an-w5 span-5">
          <h3><svg><use href="#i-queue"/></svg>وضعیت کلی</h3>
          <div class="kv"><b>روزهای دارای دونیت</b><span class="num">${esc(faNum(d.activity.activeDays))}</span></div>
          <div class="kv"><b>میانه‌ی مبلغ (دلار)</b><span class="num">${esc(isNum(t.medianUsd) ? usd(t.medianUsd) : '—')}</span></div>
          <div class="kv"><b>کوچک‌ترین دونیت (دلار)</b><span class="num">${esc(isNum(t.minUsd) ? usd(t.minUsd) : '—')}</span></div>
          <div class="kv"><b>شلوغ‌ترین روز</b><span>${esc(d.activity.busiestDay ? dayKeyLabel(d.activity.busiestDay.key) + ' · ' + faNum(d.activity.busiestDay.count) : '—')}</span></div>
          <div class="kv"><b>شلوغ‌ترین ساعت</b><span>${esc(d.activity.busiestHour ? faNum(d.activity.busiestHour.hour) + ':۰۰' : '—')}</span></div>
          <div class="kv"><b>سهم ۱ / ۵ / ۱۰ دونیت‌کننده‌ی برتر</b><span class="num">${esc(faNum(t.topShare.top1))}٪ / ${esc(faNum(t.topShare.top5))}٪ / ${esc(faNum(t.topShare.top10))}٪</span></div>
          <div class="kv"><b>دونیت در روز</b><span class="num">${esc(faNum(t.perDay))}</span></div>
          ${
            d.sequences && d.sequences.perHour !== null
              ? `<div class="kv"><b>دونیت در ساعت (فعال)</b><span class="num">${esc(faNum(d.sequences.perHour))}</span></div>
                 <div class="kv"><b>میانه‌ی فاصله بین دونیت‌ها</b><span>${esc(faNum(d.sequences.medianGapMin))} دقیقه</span></div>`
              : ''
          }
        </div>
      </div>`);

      blocks.push(`<div class="an-grid" style="margin-top:14px">
        <div class="card an-w6 span-6" id="anDistCard">
          <h3><svg><use href="#i-chart"/></svg>توزیع مبالغ<span class="tail">دلاری</span></h3>
          <div id="anDist"></div>
        </div>
        <div class="card an-w6 span-6">
          <h3><svg><use href="#i-star"/></svg>دونیت‌کننده‌های برتر<span class="tail">بر اساس مبلغ تومانی</span></h3>
          <div id="anDonors"></div>
        </div>
      </div>`);

      const byKind = (d.breakdown && d.breakdown.byKind) || [];
      const bySource = (d.breakdown && d.breakdown.bySource) || [];
      if (byKind.length || bySource.length) {
        blocks.push(`<div class="an-grid" style="margin-top:14px">
          ${byKind.length ? `<div class="card an-w6 span-6"><h3><svg><use href="#i-gift"/></svg>به تفکیک نوع</h3>${breakdownRows(byKind, k => KIND_FA[k] || k, d)}</div>` : ''}
          ${bySource.length ? `<div class="card an-w6 span-6"><h3><svg><use href="#i-link"/></svg>به تفکیک منبع</h3>${breakdownRows(bySource, k => SOURCE_FA[k] || k, d)}</div>` : ''}
        </div>`);
      }

      const heat = heatmap(d);
      if (heat) blocks.push(`<div class="card" style="margin-top:14px"><h3><svg><use href="#i-pulse"/></svg>نقشه‌ی فعالیت<span class="tail">روز هفته × ساعت</span></h3>${heat}</div>`);
    }

    const notes = notesBlock(d);
    const method = `<div class="an-note quiet"><svg><use href="#i-info"/></svg><div>${
      d.rate && d.rate.usable
        ? `معادل تومانی هر دونیت همان لحظه‌ای ثبت شده که دونیت رسیده (نرخ تاریخی). نرخ نمایش‌داده‌شده در کارت‌ها نرخ <b>الان</b> است${d.rate.manual ? ' و دستی تنظیم شده' : d.rate.source ? ' از ' + esc(d.rate.source) : ''}.`
        : 'نرخ دلار در دسترس نیست، بنابراین معادل تومانی محاسبه نشده است.'
    }${gotoHint(d) ? ' ' + gotoHint(d) + '.' : ''}</div></div>`;

    blocks.push(`<div class="card" style="margin-top:14px"><h3><svg><use href="#i-info"/></svg>روش محاسبه و نکات داده</h3>
      <div class="an-notes">${method}${notes.map(n => `<div class="an-note"><svg><use href="#i-info"/></svg><div>${esc(n.text)}</div></div>`).join('')}</div>
    </div>`);

    $('#anBody').innerHTML = blocks.join('');
    drawCharts();
    rangeLabel(); // the label lives outside #anBody, so a redraw has to refresh it explicitly
    const tail = $('#anTrendTail');
    if (tail)
      tail.textContent =
        d.series.granularity === 'hour'
          ? 'ساعتی'
          : d.series.granularity === 'day'
            ? 'روزانه'
            : d.series.granularity === 'week'
              ? 'هفتگی'
              : 'ماهانه';
  }

  /** Charts need real pixel widths, so they are drawn after the markup is in the DOM. */
  function drawCharts() {
    if (!LAST || !LAST.totals.count) return;
    const trend = $('#anTrend');
    if (trend) {
      const { html } = trendChart(LAST);
      trend.innerHTML = html;
      const seg = $('#anMetric');
      if (seg)
        seg.onclick = e => {
          const b = e.target.closest('button[data-metric]');
          if (!b) return;
          METRIC = b.dataset.metric;
          drawCharts();
        };
    }
    const dist = $('#anDist');
    if (dist) dist.innerHTML = distributionChart(LAST);
    const don = $('#anDonors');
    if (don) don.innerHTML = donorList(LAST);
  }

  // ---------- data ----------
  function query() {
    const p = new URLSearchParams({ range: RANGE, tz: String(-new Date().getTimezoneOffset()) });
    if (RANGE === 'custom' && CUSTOM) {
      p.set('from', CUSTOM.from);
      p.set('to', CUSTOM.to);
    }
    return p.toString();
  }
  async function refresh() {
    if (BUSY) return;
    BUSY = true;
    const body = $('#anBody');
    const btn = $('#anRefresh');
    if (btn) btn.disabled = true;
    if (!LAST) body.innerHTML = '<div class="empty" id="anLoading">در حال محاسبه…</div>';
    try {
      const r = await api('/api/analytics?' + query());
      if (!r || !r.ok) throw new Error('bad response');
      render(r);
    } catch (e) {
      if (!LAST)
        body.innerHTML = `<div class="empty"><div>محاسبه‌ی آمار ممکن نشد.</div><p class="hint">سرور محلی پاسخ نداد. یک‌بار دیگر تلاش کن.</p></div>`;
      else if (typeof toast === 'function') toast('به‌روزرسانی آمار ناموفق بود', 'err');
    } finally {
      BUSY = false;
      if (btn) btn.disabled = false;
      const upd = $('#anUpdated');
      if (upd && LAST) upd.textContent = 'به‌روزرسانی: ' + agoText(LAST.generatedAt);
    }
  }

  function rangeLabel() {
    const el = $('#anRangeLabel');
    if (!el || !LAST) return;
    const r = LAST.range;
    el.textContent =
      r.key === 'custom'
        ? `${fmtDate(r.start)} تا ${fmtDate(new Date(r.endMs - 1).toISOString())}`
        : r.key === 'today'
          ? 'امروز'
          : r.key === 'week'
            ? 'این هفته'
            : 'این ماه';
  }

  function open() {
    if (LAST) {
      rangeLabel();
      const upd = $('#anUpdated');
      if (upd) upd.textContent = 'به‌روزرسانی: ' + agoText(LAST.generatedAt);
    }
    refresh();
  }

  // ---------- wiring ----------
  const seg = $('#anRange');
  if (seg)
    seg.onclick = e => {
      const b = e.target.closest('button[data-range]');
      if (!b) return;
      const name = b.dataset.range;
      const custom = $('#anCustom');
      if (name === 'custom') {
        custom.hidden = false;
        // default the pickers to the month so far, so the fields are never empty when applied
        if (!$('#anFrom').value) {
          const end = LAST ? new Date(LAST.range.endMs - 1) : new Date();
          const start = new Date(end.getTime() - 29 * 86400000);
          const iso = d => new Date(d.getTime() + axisTz() * 60000).toISOString().slice(0, 10);
          $('#anFrom').value = iso(start);
          $('#anTo').value = iso(end);
        }
        [...seg.children].forEach(x => x.classList.toggle('active', x === b));
        return;
      }
      [...seg.children].forEach(x => x.classList.toggle('active', x === b));
      custom.hidden = true;
      RANGE = name;
      refresh();
    };

  const apply = $('#anApply');
  if (apply)
    apply.onclick = () => {
      const from = $('#anFrom').value;
      const to = $('#anTo').value;
      if (!from || !to) return toast('هر دو تاریخ را انتخاب کن', 'err');
      RANGE = 'custom';
      CUSTOM = { from, to };
      refresh();
    };

  const rb = $('#anRefresh');
  if (rb) rb.onclick = () => refresh();

  RANGE = RANGES.includes(RANGE) ? RANGE : 'today';
  let rt;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(drawCharts, 140);
  });

  window.ANALYTICS = {
    open,
    refresh,
    /**
     * The admin stream carries no dedicated "tip" event: a donation shows up as a state broadcast (the queue moved)
     * or a log line ("نمایش دونیت"). Either one is a hint, not a promise, so refresh is debounced and only while the
     * page is on screen.
     */
    onEvent(what) {
      if (!what || (what.type !== 'state' && what.type !== 'log')) return;
      const page = document.querySelector('.page[data-page="analytics"]');
      if (!page || !page.classList.contains('active')) return;
      clearTimeout(liveT);
      liveT = setTimeout(refresh, 1200);
    }
  };
})();
