// Unit tests for the Analytics page (public/analytics-ui.js): the two presentation bugs that could only be caught
// by driving the real script. Runs the file in a minimal fake DOM (same approach as overlay-xss.test.js) and inspects
// the produced markup. No network, no Electron, no timers beyond the ones the page itself schedules.
'use strict';
const fs = require('fs'),
  path = require('path'),
  vm = require('vm'),
  test = require('node:test'),
  assert = require('node:assert/strict');
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'analytics-ui.js'), 'utf8');

/** A stand-in element: the page only ever reads/writes innerHTML, textContent, clientWidth, onclick, hidden. */
function stubEl(id) {
  return {
    id,
    _html: '',
    textContent: '',
    hidden: false,
    clientWidth: 420,
    onclick: null,
    dataset: {},
    children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    get innerHTML() {
      return this._html;
    },
    set innerHTML(v) {
      this._html = String(v);
    },
    addEventListener() {},
    getBoundingClientRect: () => ({ width: 10, height: 10, top: 0, left: 0 }),
    querySelectorAll: () => []
  };
}

/**
 * Load the page script with a fake DOM and a controllable `api`.
 * @param {(url: string) => Promise<object>} api  stands in for the app's fetch helper
 */
function loadPage(api) {
  const els = new Map();
  const $ = sel => {
    if (!sel.startsWith('#')) return null;
    const id = sel.slice(1);
    if (!els.has(id)) els.set(id, stubEl(id));
    return els.get(id);
  };
  const document = {
    body: { appendChild() {} },
    createElement: tag => stubEl('<' + tag + '>'),
    addEventListener() {},
    querySelector: sel => (sel.includes('data-page="analytics"') ? { classList: { contains: () => true } } : null)
  };
  const sandbox = {
    document,
    console,
    setTimeout,
    clearTimeout,
    URLSearchParams,
    Intl,
    Date,
    Math,
    Number,
    JSON,
    Object,
    Array,
    String,
    isNum: null, // never read; kept out so a missing helper cannot hide a bug
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener() {},
    // the page's dependencies are classic-script globals owned by app.js
    $,
    esc: s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]),
    faNum: n => Number(n || 0).toLocaleString('fa-IR'),
    fmtToman: t => (Number(t) ? Number(t).toLocaleString('fa-IR') + ' تومان' : 'بدون مبلغ'),
    api,
    toast: () => {}
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'analytics-ui.js' });
  // the tests look elements up by id, the page by '#id'
  return { ANALYTICS: sandbox.ANALYTICS, el: id => $(id.startsWith('#') ? id : '#' + id) };
}

/** A payload with `points` hourly buckets; the first and last have money, the rest are empty. */
function payload(over = {}) {
  const points = [];
  for (let h = 0; h < 24; h++) {
    const filled = h === 10 || h === 14;
    points.push({
      key: `2026-09-24T${String(h).padStart(2, '0')}`,
      startMs: Date.parse(`2026-09-24T${String(h).padStart(2, '0')}:00:00Z`),
      start: new Date(Date.parse(`2026-09-24T${String(h).padStart(2, '0')}:00:00Z`)).toISOString(),
      count: filled ? 1 : 0,
      usd: filled ? 10 : 0,
      toman: filled ? 10000000 : 0,
      converted: filled ? 1 : 0
    });
  }
  return {
    ok: true,
    generatedAt: '2026-09-24T12:00:00.000Z',
    range: {
      key: 'today',
      start: '2026-09-24T00:00:00.000Z',
      end: '2026-09-24T12:00:00.000Z',
      startMs: Date.parse('2026-09-24T00:00:00Z'),
      endMs: Date.parse('2026-09-24T12:00:00Z'),
      dayCount: 1,
      spanHours: 12,
      granularity: 'hour',
      tzOffsetMin: 0
    },
    rate: { value: 1000000, manual: false, source: null, updatedAt: null, usable: true },
    coverage: null,
    totals: {
      count: 2,
      uniqueDonors: 2,
      repeatDonors: 0,
      newDonors: 2,
      returningDonors: 0,
      usdCount: 2,
      convertedCount: 2,
      unconvertedCount: 0,
      amountUsd: 20,
      amountToman: 20000000,
      usdEquivalent: 20,
      avgUsd: 10,
      avgToman: 10000000,
      medianUsd: 10,
      medianToman: 10000000,
      maxUsd: 10,
      maxToman: 10000000,
      minUsd: 10,
      minToman: 10000000,
      largestDonor: 'Ali',
      largestAt: '2026-09-24T10:00:00.000Z',
      topShare: { top1: 50, top5: 100, top10: 100 },
      perDay: 2,
      perWeek: 14,
      tomanPerDay: 20000000
    },
    breakdown: { byCurrency: [], byKind: [], bySource: [] },
    series: { granularity: 'hour', points },
    distribution: [],
    topDonors: [],
    heatmap: null,
    activity: {
      busiestDay: { key: '2026-09-24', count: 2 },
      richestDay: { key: '2026-09-24', toman: 20000000 },
      busiestHour: { hour: 10, count: 1 },
      activeDays: 1,
      byHour: new Array(24).fill(0)
    },
    previous: null,
    sequences: { gapCount: 1, medianGapMin: 240, perHour: 0.5, spanHours: 4, medianToman: 10000000 },
    notes: [],
    excluded: { test: 0, undated: 0, invalid: 0, duplicates: 0 },
    ...over
  };
}

/** Click a range button through the page's own handler, exactly as a user would. */
function clickRange($, name) {
  const seg = $('anRange');
  assert.ok(seg && typeof seg.onclick === 'function', 'the range control is wired up');
  seg.onclick({
    target: {
      closest: sel => (sel === 'button[data-range]' ? { dataset: { range: name } } : null)
    }
  });
}

/** Click a metric button (دلار / تومان / تعداد) through the page's own handler. */
function clickMetric($, name) {
  const seg = $('anMetric');
  assert.ok(seg && typeof seg.onclick === 'function', 'the metric control is wired up');
  seg.onclick({
    target: {
      closest: sel => (sel === 'button[data-metric]' ? { dataset: { metric: name } } : null)
    }
  });
}

/**
 * An `api` stub that answers with a payload whose `range.key` echoes the requested range, so the page's range label
 * shows which range the data belongs to. Each answer is released by the test, so a slow request can be simulated.
 */
function stubApi(asked) {
  const release = [];
  const api = url => {
    asked.push(url);
    return new Promise(resolve =>
      release.push(() => resolve(payload({ range: { ...payload().range, key: /range=([^&]+)/.exec(url)[1] } })))
    );
  };
  return { api, release };
}

test('a range change made while a request is in flight is not dropped', async () => {
  const asked = [];
  const { api, release } = stubApi(asked);
  const { ANALYTICS, el: $ } = loadPage(api);

  // the first fetch is in flight when the user picks another range
  const first = ANALYTICS.refresh();
  assert.equal(asked.length, 1, 'one request was sent');
  assert.match(asked[0], /range=today/);

  clickRange($, 'week'); // the page must queue this, not ignore it
  assert.equal(asked.length, 1, 'no overlapping request is started while one is running');

  // the first response lands: the queued range must now be requested
  release[0]();
  await first;
  await new Promise(r => setImmediate(r));
  assert.equal(asked.length, 2, 'the queued range was fetched after the in-flight request finished');
  assert.match(asked[1], /range=week/, 'and it is the range the user actually selected');

  release[1]();
  await new Promise(r => setImmediate(r));
  assert.equal($('anRangeLabel').textContent, 'این هفته', 'the page ends up showing the range the user clicked');
});

test('a stale response never overwrites a newer range selection', async () => {
  const asked = [];
  const { api, release } = stubApi(asked);
  const { ANALYTICS, el: $ } = loadPage(api);

  const first = ANALYTICS.refresh(); // range=today
  clickRange($, 'month'); // queued while busy
  release[0]();
  await first;
  await new Promise(r => setImmediate(r));
  assert.match(asked[1], /range=month/);
  release[1]();
  await new Promise(r => setImmediate(r));
  assert.equal($('anRangeLabel').textContent, 'این ماه', 'the last requested range is what is displayed');
});

test('a range selected twice while busy resolves to the last one the user picked', async () => {
  const asked = [];
  const { api, release } = stubApi(asked);
  const { ANALYTICS, el: $ } = loadPage(api);
  const first = ANALYTICS.refresh(); // today
  clickRange($, 'week');
  clickRange($, 'month'); // the newest choice wins
  release[0]();
  await first;
  await new Promise(r => setImmediate(r));
  release[1]();
  await new Promise(r => setImmediate(r));
  assert.match(asked[1], /range=month/, 'only the newest selection is fetched, not every intermediate one');
  assert.equal($('anRangeLabel').textContent, 'این ماه');
});

test('the toman chart plots empty periods as zero instead of skipping them', async () => {
  const api = async () => payload();
  const { ANALYTICS, el: $ } = loadPage(api);
  await ANALYTICS.refresh();

  // switch the trend chart to the toman metric the way the segmented control does
  clickMetric($, 'toman');
  const svg = $('anTrend').innerHTML;
  assert.ok(svg.includes('class="an-chart"'), 'the trend chart was drawn');

  // every bucket is a point on the line, including the 22 empty ones: a gap would draw a line straight across them
  const line = /<path class="line"[^>]*\sd="([^"]+)"/.exec(svg);
  assert.ok(line, 'a line path was produced: ' + svg.slice(0, 400));
  assert.equal(
    line[1].split('L').length,
    24,
    'all 24 hourly buckets are on the line, so an empty period is an explicit zero'
  );
  // the two non-empty buckets are still the only ones marked with a dot
  const dots = svg.match(/<circle class="dot"/g) || [];
  assert.equal(dots.length, 2, 'only the buckets that received money get a dot');
  // and the count metric behaves the same way (it already used 0)
  clickMetric($, 'count');
  const countLine = /<path class="line"[^>]*\sd="([^"]+)"/.exec($('anTrend').innerHTML);
  assert.equal(countLine[1].split('L').length, 24, 'the count chart is unchanged');
  // the USD chart is unchanged too
  clickMetric($, 'usd');
  const usdLine = /<path class="line"[^>]*\sd="([^"]+)"/.exec($('anTrend').innerHTML);
  assert.equal(usdLine[1].split('L').length, 24, 'the USD chart is unchanged');
});

test('the chart is laid out left-to-right and the toman axis zero is a number, not "no amount"', async () => {
  const api = async () => payload();
  const { ANALYTICS, el: $ } = loadPage(api);
  await ANALYTICS.refresh();
  clickMetric($, 'toman');
  const svg = $('anTrend').innerHTML;
  // the page is RTL, but an SVG chart is not: axis ticks and the y scale must not be mirrored
  assert.ok(svg.includes('style="direction: ltr;"'), 'the chart forces LTR inside the RTL page');
  assert.ok(!svg.includes('بدون مبلغ'), 'the axis never prints "no amount" for the zero tick');
});

test('an admin log line does not trigger an analytics refresh, a queue change does', async () => {
  const asked = [];
  const api = async url => {
    asked.push(url);
    return payload();
  };
  const { ANALYTICS } = loadPage(api);
  await ANALYTICS.refresh();
  assert.equal(asked.length, 1);

  // a failing /api/analytics logs an error, which arrives as a "log" event: it must not ask again
  ANALYTICS.onEvent({ type: 'log', entry: { level: 'error', msg: 'محاسبه‌ی آمار ناموفق بود' } });
  await new Promise(r => setTimeout(r, 1400));
  assert.equal(asked.length, 1, 'an analytics error log does not cause another analytics request (no loop)');

  // a state broadcast (the queue moved) is the real signal that analytics changed
  ANALYTICS.onEvent({ type: 'state', state: {} });
  await new Promise(r => setTimeout(r, 1400));
  assert.equal(asked.length, 2, 'a donation changing the queue refreshes the page');
});

test('a span under an hour shows no per-hour rate, but the gap between the donations is still shown', async () => {
  const api = async () =>
    payload({ sequences: { gapCount: 2, medianGapMin: 1, perHour: null, spanHours: 0, medianToman: 5000000 } });
  const { ANALYTICS, el: $ } = loadPage(api);
  await ANALYTICS.refresh();

  const body = $('anBody').innerHTML;
  assert.ok(!body.includes('دونیت در ساعت (فعال)'), 'no per-hour rate is invented out of a sub-hour span');
  assert.ok(body.includes('میانه‌ی فاصله بین دونیت‌ها'), 'the gap itself is a fact and is still shown');

  // with a real span both rows are there
  const withSpan = async () =>
    payload({ sequences: { gapCount: 2, medianGapMin: 45, perHour: 2, spanHours: 1.5, medianToman: 5000000 } });
  const second = loadPage(withSpan);
  await second.ANALYTICS.refresh();
  const html = second.el('anBody').innerHTML;
  assert.ok(html.includes('دونیت در ساعت (فعال)'), 'a span of an hour or more reports a rate');
  assert.ok(html.includes('میانه‌ی فاصله بین دونیت‌ها'));
});
