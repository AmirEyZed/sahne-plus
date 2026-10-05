// Analytics unit + integration tests: the pure aggregation engine, the history store, and POST /api/analytics.
// Run with `node --test test/analytics.test.js`.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const A = require('../server/analytics');
const { createAnalyticsStore, MAX_PER_DAY } = require('../server/analytics-store');
const { createServer, parseEventTime, parseTz } = require('../server/server');

const TZ = 210; // Asia/Tehran, the audience the app is built for
const NOW = Date.parse('2026-09-24T18:00:00Z'); // a Thursday evening in Tehran
const sleep = ms => new Promise(r => setTimeout(r, ms));

const run = (items, opts = {}) => A.computeAnalytics(items, { now: NOW, tz: TZ, rate: { value: 1000000 }, ...opts });

// ---------------------------------------------------------------------------------------------
// Calendar and timezone correctness
// ---------------------------------------------------------------------------------------------

test('timezone: a UTC instant is bucketed by the local calendar day, never by its UTC date', () => {
  // 20:30Z on the 24th is 00:00 on the 25th in Tehran (+03:30); 19:30Z is still 23:00 on the 24th.
  const items = [
    { id: 'late', ts: '2026-09-24T20:30:00Z', name: 'A', amount: 10, currency: 'USD' },
    { id: 'before', ts: '2026-09-24T19:30:00Z', name: 'B', amount: 20, currency: 'USD' }
  ];
  const r = run(items, { range: 'custom', from: '2026-09-25', to: '2026-09-25' });
  assert.equal(r.totals.count, 1, 'only the event that is on the 25th locally');
  assert.equal(r.totals.amountUsd, 10);

  const prev = run(items, { range: 'custom', from: '2026-09-24', to: '2026-09-24' });
  assert.equal(prev.totals.count, 1);
  assert.equal(prev.totals.amountUsd, 20);

  // the same instants seen from UTC land on the 24th
  const utc = A.computeAnalytics(items, {
    range: 'custom',
    from: '2026-09-24',
    to: '2026-09-24',
    now: NOW,
    tz: 0,
    rate: { value: 1000000 }
  });
  assert.equal(utc.totals.count, 2, 'a bare UTC reading of the same data would have been wrong for Tehran');
});

test('week boundaries are Saturday-anchored; the month boundary follows the Persian calendar', () => {
  const r = run([], { range: 'today' });
  const week = A.resolveRange('week', { now: NOW, tz: TZ });
  // 2026-09-24 is a Thursday; the week opens on Saturday the 19th at 00:00 Tehran.
  assert.equal(A.dateKey(week.start, TZ), '2026-09-19');
  assert.equal(A.localParts(week.start, TZ).dow, 6);
  const month = A.resolveRange('month', { now: NOW, tz: TZ });
  // 2026-09-24 is 1405/07/02, so the month opens on 1405/07/01 = 2026-09-23 local.
  assert.equal(A.dateKey(month.start, TZ), '2026-09-23');
  assert.equal(A.jalaliMonthKey(month.start, TZ), A.jalaliMonthKey(NOW, TZ));
  assert.ok(A.startOfPreviousJalaliMonth(NOW, TZ) < month.start);
  void r;
});

test('a provider timestamp without a zone is read as UTC, and a broken one is flagged not guessed', () => {
  assert.equal(parseEventTime('2026-09-24 20:30:00'), Date.parse('2026-09-24T20:30:00Z'));
  assert.equal(parseEventTime('2026-09-24T20:30:00Z'), Date.parse('2026-09-24T20:30:00Z'));
  assert.equal(parseEventTime('2026-09-24T23:30:00+03:30'), Date.parse('2026-09-24T20:00:00Z'));
  assert.equal(parseEventTime('nonsense'), null);
  assert.equal(parseEventTime(null), null);
  assert.equal(A.parseTimestamp('2026-09-24 20:30:00'), Date.parse('2026-09-24T20:30:00Z'));
  assert.equal(A.parseTimestamp('2026-09-24T20:30:00'), Date.parse('2026-09-24T20:30:00Z'));
  // a timestamp-less event is counted but never placed in a bucket
  const r = run([
    { id: 'undated', name: 'X', amount: 5, currency: 'USD' },
    { id: 'ok', ts: '2026-09-24T10:00:00Z', name: 'Y', amount: 7, currency: 'USD' }
  ]);
  assert.equal(r.excluded.undated, 1);
  assert.equal(r.totals.count, 1);
  assert.ok(r.notes.some(n => n.code === 'undated' && n.count === 1));
});

test('per-day rates count calendar days touched, not fractional days', () => {
  const items = [{ id: 'a', ts: '2026-09-24T08:00:00Z', name: 'A', amount: 5, currency: 'USD' }];
  const today = run(items, { range: 'today' });
  assert.equal(today.range.dayCount, 1);
  assert.equal(today.totals.perDay, 1, 'one donation in one day is 1/day, not 2.23/day');
  const custom = run(items, { range: 'custom', from: '2026-09-20', to: '2026-09-24' });
  assert.equal(custom.range.dayCount, 5);
  assert.equal(custom.totals.perDay, 0.2);
});

// ---------------------------------------------------------------------------------------------
// Aggregation: day / week / month / custom
// ---------------------------------------------------------------------------------------------

const spread = [
  {
    id: 'd1',
    ts: '2026-09-24T08:00:00Z',
    name: 'Ali',
    amount: 10,
    currency: 'USD',
    toman: 10000000,
    kind: 'tip',
    source: 'kickbot'
  },
  {
    id: 'd2',
    ts: '2026-09-24T09:00:00Z',
    name: 'Sara',
    amount: 30,
    currency: 'USD',
    toman: 30000000,
    kind: 'tip',
    source: 'streamelements'
  },
  {
    id: 'd3',
    ts: '2026-09-23T09:00:00Z',
    name: 'Ali',
    amount: 20,
    currency: 'USD',
    toman: 20000000,
    kind: 'tip',
    source: 'kickbot'
  },
  {
    id: 'd4',
    ts: '2026-09-22T09:00:00Z',
    name: 'Reza',
    amount: 5,
    currency: 'USD',
    toman: 5000000,
    kind: 'gift',
    source: 'kick'
  },
  {
    id: 'd5',
    ts: '2026-09-18T09:00:00Z',
    name: 'Mina',
    amount: 4,
    currency: 'USD',
    toman: 4000000,
    kind: 'sub',
    source: 'kick'
  }
];

test('daily aggregation: hourly buckets for today, one point per calendar day', () => {
  const r = run(spread, { range: 'today' });
  assert.equal(r.range.granularity, 'hour');
  assert.equal(r.totals.count, 2);
  assert.equal(r.totals.amountUsd, 40);
  assert.equal(r.totals.amountToman, 40000000);
  assert.equal(r.totals.avgUsd, 20);
  assert.equal(r.totals.medianUsd, 20);
  assert.equal(r.totals.maxUsd, 30);
  assert.equal(r.totals.minUsd, 10);
  assert.equal(r.totals.uniqueDonors, 2);
  const nonEmpty = r.series.points.filter(p => p.count);
  assert.equal(nonEmpty.length, 2);
  assert.equal(nonEmpty[0].usd, 10);
  assert.equal(nonEmpty[1].usd, 30);
  // the series spans the whole local day, so a quiet hour is an explicit zero, not a missing point
  assert.ok(r.series.points.length >= 24);
  assert.ok(r.series.points.every(p => Number.isFinite(p.usd) && Number.isFinite(p.toman)));
});

test('weekly aggregation covers the Iranian week (Saturday onwards) with daily points', () => {
  const r = run(spread, { range: 'week' });
  assert.equal(r.range.granularity, 'day');
  assert.equal(A.dateKey(r.range.startMs, TZ), '2026-09-19');
  // Mon–Thu of this week: d1..d4. The 18th is the Friday before the week opens, so d5 is excluded.
  // d4 is a Kick gift, so it is excluded from USD totals (synthetic USD amount).
  assert.equal(r.totals.count, 4);
  assert.equal(r.totals.amountUsd, 60);
  assert.equal(r.series.points.length, 6, 'Sat 19 … Thu 24');
});

test('monthly aggregation follows the Persian month boundary', () => {
  const r = run(spread, { range: 'month' });
  assert.equal(A.dateKey(r.range.startMs, TZ), '2026-09-23');
  assert.equal(r.totals.count, 3, 'the 22nd is in the previous Persian month');
  assert.equal(r.totals.amountUsd, 60);
  const last = run(spread, { range: 'month' });
  assert.equal(last.totals.uniqueDonors, 2);
});

test('custom range includes both end days and picks a granularity from its length', () => {
  const r = run(spread, { range: 'custom', from: '2026-09-18', to: '2026-09-24' });
  assert.equal(r.totals.count, 5, 'an inclusive calendar-day range');
  assert.equal(r.range.granularity, 'day');
  assert.equal(A.dateKey(r.range.startMs, TZ), '2026-09-18');
  assert.equal(A.dateKey(r.range.endMs - 1, TZ), '2026-09-24');
  assert.equal(A.granularityFor(1 * 86400000), 'hour', 'a day or two stays hourly');
  assert.equal(A.granularityFor(200 * 86400000), 'week');
  assert.equal(A.granularityFor(900 * 86400000), 'month');
  // a reversed pair is rejected with a clear error (the HTTP layer turns it into a 400)
  assert.throws(() => run(spread, { range: 'custom', from: '2026-09-24', to: '2026-09-18' }), /from_after_to/);
  // malformed and out-of-range dates are rejected too, never silently becoming "today"
  assert.throws(() => run(spread, { range: 'custom', from: 'nonsense', to: '2026-09-18' }), /invalid_from/);
  assert.throws(() => run(spread, { range: 'custom', from: '2019-01-01', to: '2026-09-18' }), /out_of_range_from/);
  assert.throws(() => run(spread, { range: 'custom', from: '2026-09-18', to: '2099-01-01' }), /out_of_range_to/);
  assert.throws(() => run(spread, { range: 'custom', from: '2026-02-30', to: '2026-09-18' }), /invalid_from/);
});

test('a plain YYYY-MM-DD bound is that calendar day in the timezone, east and west of UTC', () => {
  const items = [
    { id: 'a', ts: '2026-10-01T02:00:00Z', name: 'A', amount: 5, currency: 'USD' }, // 30 Sep, 22:00 in UTC−4
    { id: 'b', ts: '2026-10-01T12:00:00Z', name: 'B', amount: 7, currency: 'USD' } // 1 Oct, 08:00 in UTC−4
  ];
  const day = (tz, items2 = items) =>
    A.computeAnalytics(items2, {
      range: 'custom',
      from: '2026-10-01',
      to: '2026-10-01',
      now: NOW,
      tz,
      rate: { value: 1000000 }
    });

  // West of UTC: read as UTC midnight the bound would snap back to the 30th and the whole day would shift by one.
  const west = day(-240);
  assert.equal(A.dateKey(west.range.startMs, -240), '2026-10-01', 'the range opens on the 1st locally');
  assert.equal(A.dateKey(west.range.endMs - 1, -240), '2026-10-01', 'and closes at the end of the 1st locally');
  assert.equal(west.totals.amountUsd, 7, 'only the donation that falls on the 1st west of UTC');
  assert.equal(west.topDonors[0].name, 'B');

  // East of UTC the same string must keep working exactly as before.
  const east = day(TZ, [
    { id: 'a', ts: '2026-10-01T02:00:00Z', name: 'A', amount: 5, currency: 'USD' }, // 1 Oct, 05:30 in Tehran
    { id: 'b', ts: '2026-09-30T20:00:00Z', name: 'B', amount: 7, currency: 'USD' } // 30 Sep, 23:30 in Tehran
  ]);
  assert.equal(A.dateKey(east.range.startMs, TZ), '2026-10-01');
  assert.equal(A.dateKey(east.range.endMs - 1, TZ), '2026-10-01');
  assert.equal(east.totals.amountUsd, 5, 'the 30th in Tehran stays out of the 1st');
});

test('a long custom range coarsens instead of exploding into thousands of buckets', () => {
  const items = [];
  for (let i = 0; i < 200; i++)
    items.push({ id: 'x' + i, ts: Date.UTC(2020, 0, 1 + i), name: 'A' + (i % 7), amount: 1, currency: 'USD' });
  const r = run(items, { range: 'custom', from: '2020-01-01', to: '2020-12-31' });
  assert.equal(r.range.granularity, 'week');
  assert.ok(r.series.points.length <= A.MAX_BUCKETS);
  assert.equal(r.totals.count, 200);
  assert.equal(r.totals.amountUsd, 200);
});

// ---------------------------------------------------------------------------------------------
// Currency conversion
// ---------------------------------------------------------------------------------------------

test('USD → Toman uses the stored historical toman value, and never the current rate retroactively', () => {
  // toman is what the app converted with at the time; the current rate is 1,000,000, the old one was 800,000
  const items = [
    { id: 'a', ts: '2026-09-24T08:00:00Z', name: 'A', amount: 10, currency: 'USD', toman: 8000000, rate: 800000 },
    { id: 'b', ts: '2026-09-24T09:00:00Z', name: 'B', amount: 10, currency: 'USD', toman: 10000000, rate: 1000000 }
  ];
  const r = run(items, { range: 'today', rate: { value: 1000000, source: 'baha24' } });
  assert.equal(r.totals.amountToman, 18000000, 'the two different historical rates are both respected');
  assert.equal(r.totals.amountUsd, 20);
  assert.equal(r.rate.value, 1000000);
  assert.equal(r.rate.source, 'baha24');
  assert.ok(
    r.notes.some(n => n.code === 'no-historic-rate'),
    'the payload says the rate shown is the current one, not a historical one'
  );
  assert.equal(A.localParts(r.range.startMs, TZ).h, 0, 'nothing else about the item changes');
});

test('a manual rate takes precedence over the fetched one, exactly as the rest of the app does', () => {
  const r = run([{ id: 'a', ts: '2026-09-24T08:00:00Z', name: 'A', amount: 2, currency: 'USD', toman: 2000000 }], {
    range: 'today',
    rate: { value: 900000, manual: 1000000, source: 'baha24' }
  });
  assert.equal(r.rate.value, 1000000);
  assert.equal(r.rate.manual, true);
  assert.equal(r.totals.usdEquivalent, 2, '2,000,000 T ÷ the effective rate');
});

test('other currencies count towards Toman and never towards the USD totals', () => {
  const items = [
    { id: 'usd', ts: '2026-09-24T08:00:00Z', name: 'A', amount: 10, currency: 'USD', toman: 10000000 },
    { id: 'eur', ts: '2026-09-24T08:30:00Z', name: 'B', amount: 5, currency: 'EUR', toman: 12500000 },
    { id: 'gbp', ts: '2026-09-24T09:00:00Z', name: 'C', amount: 5, currency: 'GBP', toman: 13000000 }
  ];
  const r = run(items, { range: 'today' });
  assert.equal(r.totals.amountUsd, 10, 'only the USD donation is a dollar total');
  assert.equal(r.totals.usdCount, 1);
  assert.equal(r.totals.convertedCount, 3);
  assert.equal(r.totals.amountToman, 35500000);
  assert.equal(r.totals.avgUsd, 10);
  assert.equal(r.totals.avgToman, Math.round(35500000 / 3));
  const byCurrency = Object.fromEntries(r.breakdown.byCurrency.map(c => [c.key, c.count]));
  assert.deepEqual(byCurrency, { USD: 1, EUR: 1, GBP: 1 });
});

test('an event with no known Toman value is reported as unconverted, not silently treated as zero', () => {
  const items = [
    { id: 'a', ts: '2026-09-24T08:00:00Z', name: 'A', amount: 10, currency: 'USD', toman: 10000000 },
    { id: 'b', ts: '2026-09-24T09:00:00Z', name: 'B', amount: 7, currency: 'XAF', toman: null }
  ];
  const r = run(items, { range: 'today' });
  assert.equal(r.totals.unconvertedCount, 1);
  assert.equal(r.totals.amountToman, 10000000, 'unknown values do not inflate the Toman total');
  assert.equal(r.totals.amountUsd, 10, 'nor the USD total (the currency is not USD)');
  assert.ok(r.notes.some(n => n.code === 'unconverted' && n.count === 1));
});

test('when no rate is known the Toman totals stay null rather than becoming a misleading zero', () => {
  const r = A.computeAnalytics([{ id: 'a', ts: '2026-09-24T08:00:00Z', name: 'A', amount: 10, currency: 'USD' }], {
    range: 'today',
    now: NOW,
    tz: TZ,
    rate: { value: null }
  });
  assert.equal(r.rate.usable, false);
  assert.equal(r.totals.amountToman, null);
  assert.equal(r.totals.avgToman, null);
  assert.equal(r.totals.amountUsd, 10);
  assert.ok(r.notes.some(n => n.code === 'no-rate'));
});

// ---------------------------------------------------------------------------------------------
// Bad data, duplicates, large values
// ---------------------------------------------------------------------------------------------

test('duplicate events are counted once; the kept line is the newest one for that id', () => {
  const items = [
    { id: 'dup', ts: '2026-09-24T08:00:00Z', name: 'A', amount: 10, currency: 'USD', toman: 10000000, played: null },
    { id: 'dup', ts: '2026-09-24T08:00:00Z', name: 'A', amount: 10, currency: 'USD', toman: 10000000, played: true }
  ];
  const r = run(items, { range: 'today' });
  assert.equal(r.totals.count, 1);
  assert.equal(r.totals.amountUsd, 10);
  assert.equal(r.excluded.duplicates, 1);
  assert.ok(r.notes.some(n => n.code === 'duplicates' && n.count === 1));
  const played = Object.fromEntries(r.breakdown.bySource.map(s => [s.key + ':played', s.played]));
  assert.ok(Object.values(played).every(v => v >= 0));
});

test('zero, negative, missing and non-numeric amounts are dropped and reported', () => {
  const items = [
    { id: 'ok', ts: '2026-09-24T08:00:00Z', name: 'A', amount: 10, currency: 'USD' },
    { id: 'zero', ts: '2026-09-24T08:00:00Z', name: 'B', amount: 0, currency: 'USD' },
    { id: 'neg', ts: '2026-09-24T08:00:00Z', name: 'C', amount: -5, currency: 'USD' },
    { id: 'nan', ts: '2026-09-24T08:00:00Z', name: 'D', amount: 'abc', currency: 'USD' },
    { id: '', ts: '2026-09-24T08:00:00Z', name: 'E', amount: 5, currency: 'USD' },
    null,
    'not-an-object'
  ];
  const r = run(items, { range: 'today' });
  assert.equal(r.totals.count, 1);
  assert.equal(r.totals.amountUsd, 10);
  // 7 inputs, 1 valid: 3 bad amounts, 1 missing id, 2 things that are not items at all
  assert.equal(r.excluded.invalid, 6);
  assert.ok(r.notes.filter(n => n.code === 'bad-data').length >= 3, 'each reason is surfaced, not swallowed');
});

test('a zero-value day does not produce NaN, Infinity or negative numbers anywhere', () => {
  const r = run([], { range: 'today' });
  assert.equal(r.totals.count, 0);
  assert.equal(r.totals.amountToman, null);
  assert.equal(r.totals.avgUsd, null);
  assert.equal(r.totals.medianUsd, null);
  assert.equal(r.totals.maxUsd, null);
  assert.equal(r.totals.minUsd, null);
  assert.equal(r.totals.largestDonor, null);
  assert.deepEqual(r.totals.topShare, { top1: 0, top5: 0, top10: 0 });
  assert.equal(r.topDonors.length, 0);
  assert.equal(r.previous, null);
  assert.ok(r.series.points.length > 0 && r.series.points.every(p => p.count === 0 && p.usd === 0));
  const json = JSON.stringify(r);
  assert.ok(!json.includes('NaN') && !json.includes('Infinity'), 'serialises cleanly, with no NaN or Infinity');
});

test('very large values stay exact and never lose precision or overflow the formatter', () => {
  const items = [
    { id: 'big', ts: '2026-09-24T08:00:00Z', name: 'Whale', amount: 1000000, currency: 'USD', toman: 1250000000000 },
    { id: 'small', ts: '2026-09-24T08:30:00Z', name: 'Minnow', amount: 0.5, currency: 'USD', toman: 625000 }
  ];
  const r = run(items, { range: 'today' });
  assert.equal(r.totals.amountUsd, 1000000.5);
  assert.equal(r.totals.amountToman, 1250000625000);
  assert.equal(r.totals.maxUsd, 1000000);
  assert.equal(r.totals.minUsd, 0.5);
  assert.ok(Number.isSafeInteger(r.totals.amountToman));
  assert.equal(r.totals.topShare.top1, Math.round((1250000000000 / 1250000625000) * 10000) / 100);
  const r2 = run([{ id: 'x', ts: '2026-09-24T08:00:00Z', name: 'A', amount: 0.01, currency: 'USD' }], {
    range: 'today'
  });
  assert.equal(r2.totals.amountUsd, 0.01);
  assert.equal(r2.totals.avgUsd, 0.01);
});

// ---------------------------------------------------------------------------------------------
// Donors, medians, shares, distribution
// ---------------------------------------------------------------------------------------------

test('average and median differ correctly, including the even-count average of the two middle values', () => {
  const items = [1, 2, 3, 100].map((amount, i) => ({
    id: 'e' + i,
    ts: `2026-09-24T${String(8 + i).padStart(2, '0')}:00:00Z`,
    name: 'D' + i,
    amount,
    currency: 'USD',
    toman: amount * 1000
  }));
  const r = run(items, { range: 'today' });
  assert.equal(r.totals.avgUsd, 26.5);
  assert.equal(r.totals.medianUsd, 2.5, '(2 + 3) / 2');
  assert.equal(r.totals.medianToman, 2500);
  assert.equal(A.median([]), null);
  assert.equal(A.median([5]), 5);
  assert.equal(A.median([4, 1, 3, 2]), 2.5);
});

test('top donors rank by Toman, and new vs returning reflects the whole history handed in', () => {
  const items = [
    { id: 'a1', ts: '2026-09-20T08:00:00Z', name: 'Ali', amount: 10, currency: 'USD', toman: 10000000 },
    { id: 'a2', ts: '2026-09-24T08:00:00Z', name: 'Ali', amount: 10, currency: 'USD', toman: 10000000 },
    { id: 's1', ts: '2026-09-24T09:00:00Z', name: 'Sara', amount: 100, currency: 'USD', toman: 100000000 },
    { id: 'n1', ts: '2026-09-24T10:00:00Z', name: 'Newbie', amount: 1, currency: 'USD', toman: 1000000 },
    { id: 'r1', ts: '2026-09-24T11:00:00Z', name: 'Old', amount: 1, currency: 'USD', toman: 1000000 }
  ];
  const r = run(items, { range: 'today' });
  assert.equal(r.topDonors[0].name, 'Sara');
  assert.equal(r.topDonors[0].toman, 100000000);
  assert.equal(r.topDonors[0].count, 1);
  assert.equal(r.topDonors[0].avgToman, 100000000);
  const ali = r.topDonors.find(d => d.name === 'Ali');
  assert.equal(ali.count, 1, 'only today counts towards the period');
  assert.equal(ali.avgToman, 10000000);
  assert.equal(r.topDonors.length, 4);
  assert.equal(r.totals.uniqueDonors, 4);
  assert.equal(r.totals.repeatDonors, 0, 'Ali donated twice, but once in this period');
  const week = run(items, { range: 'custom', from: '2026-09-20', to: '2026-09-24' });
  assert.equal(week.totals.uniqueDonors, 4);
  assert.ok(week.topDonors.find(d => d.name === 'Ali').toman >= 20000000);
  // a season-long view sees Ali as a repeat donor
  const season = run(items, { range: 'custom', from: '2026-09-20', to: '2026-09-24' });
  assert.equal(season.totals.count, 5);
});

test('new vs returning donors uses first-seen, which the caller can supply from outside the window', () => {
  const items = [{ id: 'a', ts: '2026-09-24T08:00:00Z', name: 'Regular', amount: 5, currency: 'USD', toman: 5000000 }];
  const seen = new Map([['Regular', Date.parse('2025-01-01T00:00:00Z')]]);
  const r = A.computeAnalytics(items, {
    range: 'today',
    now: NOW,
    tz: TZ,
    rate: { value: 1000000 },
    donorFirstSeen: seen
  });
  assert.equal(r.totals.newDonors, 0);
  assert.equal(r.totals.returningDonors, 1);
  // without the index the same donation looks like a first-time donor
  const blind = run(items, { range: 'today' });
  assert.equal(blind.totals.newDonors, 1);
});

test('top-1/5/10 concentration is a share of the Toman total', () => {
  const items = [100, 50, 25, 25, 1].map((amount, i) => ({
    id: 'c' + i,
    ts: `2026-09-24T${String(8 + i).padStart(2, '0')}:00:00Z`,
    name: 'D' + i,
    amount,
    currency: 'USD',
    toman: amount * 1000000
  }));
  const r = run(items, { range: 'today' });
  assert.equal(r.totals.topShare.top1, 49.75);
  assert.equal(r.totals.topShare.top5, 100);
  assert.equal(r.totals.topShare.top10, 100);
});

test('distribution buckets use the app’s USD edges and keep the tail open-ended', () => {
  const amounts = [3, 4.99, 5, 9.99, 10, 24.99, 25, 49.99, 50, 99.99, 100, 500];
  const items = amounts.map((amount, i) => ({
    id: 'b' + i,
    // 06:00–17:00Z, all inside "today" (which ends at NOW = 18:00Z)
    ts: `2026-09-24T${String(6 + i).padStart(2, '0')}:00:00Z`,
    name: 'D' + i,
    amount,
    currency: 'USD',
    toman: amount * 1000000
  }));
  const r = run(items, { range: 'today' });
  assert.deepEqual(
    r.distribution.map(b => b.count),
    [2, 2, 2, 2, 2, 2]
  );
  assert.deepEqual(
    r.distribution.map(b => b.label),
    ['$0–$5', '$5–$10', '$10–$25', '$25–$50', '$50–$100', '≥$100']
  );
  assert.equal(r.distribution[0].usd, 7.99);
  assert.equal(r.distribution[5].usd, 600);
  assert.equal(
    r.distribution.reduce((a, b) => a + b.count, 0),
    12
  );
  // boundaries are half-open: $5 is in the 5–10 bucket, never in 0–5
  assert.equal(A.bucketize([5], [5]).find(b => b.from === 0).count, 0);
  assert.equal(A.bucketize([5], [5]).find(b => b.from === 5).count, 1);
});

test('custom bucket edges are honoured', () => {
  const r = run(
    [
      { id: 'a', ts: '2026-09-24T08:00:00Z', name: 'A', amount: 5, currency: 'USD' },
      { id: 'b', ts: '2026-09-24T08:00:00Z', name: 'B', amount: 50, currency: 'USD' }
    ],
    { range: 'today', bucketEdges: [10] }
  );
  assert.deepEqual(
    r.distribution.map(b => b.count),
    [1, 1]
  );
});

// ---------------------------------------------------------------------------------------------
// Activity, breakdown, sequences, comparison
// ---------------------------------------------------------------------------------------------

test('activity finds the busiest day and hour in local time', () => {
  const items = [
    // all three of these are within the local hour 11 (08:00–08:20Z is 11:30–11:50 in Tehran)
    { id: 'a', ts: '2026-09-24T08:00:00Z', name: 'A', amount: 5, currency: 'USD', toman: 5000000 },
    { id: 'b', ts: '2026-09-24T08:10:00Z', name: 'B', amount: 5, currency: 'USD', toman: 5000000 },
    { id: 'c', ts: '2026-09-24T08:20:00Z', name: 'C', amount: 5, currency: 'USD', toman: 5000000 },
    { id: 'd', ts: '2026-09-23T20:00:00Z', name: 'D', amount: 90, currency: 'USD', toman: 90000000 }
  ];
  const r = run(items, { range: 'custom', from: '2026-09-23', to: '2026-09-24' });
  assert.equal(r.activity.busiestDay.key, '2026-09-24');
  assert.equal(r.activity.busiestDay.count, 3);
  assert.equal(r.activity.busiestHour.hour, 11, '08:00Z is 11:30 in Tehran (+03:30)');
  assert.equal(r.activity.busiestHour.count, 3);
  assert.equal(r.activity.richestDay.key, '2026-09-23');
  assert.equal(r.activity.activeDays, 2);
  assert.equal(r.activity.byHour.length, 24);
});

test('the source and kind breakdowns only ever contain values the app can actually emit', () => {
  const r = run(spread, { range: 'custom', from: '2026-09-18', to: '2026-09-24' });
  const sources = r.breakdown.bySource.map(s => s.key).sort();
  assert.deepEqual(sources, ['kick', 'kickbot', 'streamelements']);
  const kinds = r.breakdown.byKind.map(k => k.key).sort();
  assert.deepEqual(kinds, ['gift', 'sub', 'tip']);
  const kick = r.breakdown.bySource.find(s => s.key === 'kick');
  assert.equal(kick.count, 2);
  // Kick subs/gifts carry a synthetic USD amount derived from toman, so they are excluded from USD totals
  assert.equal(kick.amountUsd, 0);
  assert.equal(kick.amountToman, 9000000);
  // an unknown provider is folded into "other" rather than passed through
  const odd = run([{ id: 'z', ts: '2026-09-24T08:00:00Z', name: 'Z', amount: 1, currency: 'USD', source: '../evil' }], {
    range: 'today'
  });
  assert.equal(odd.breakdown.bySource[0].key, 'other');
});

test('skipped alerts are recorded as such and never counted as played ones', () => {
  const items = [
    { id: 'p', ts: '2026-09-24T08:00:00Z', name: 'A', amount: 5, currency: 'USD', toman: 5000000, played: true },
    { id: 's', ts: '2026-09-24T09:00:00Z', name: 'B', amount: 5, currency: 'USD', toman: 5000000, played: false }
  ];
  const r = run(items, { range: 'today' });
  const kb = r.breakdown.bySource[0];
  assert.equal(kb.played, 1);
  assert.equal(kb.skipped, 1);
  assert.equal(r.totals.count, 2, 'a skipped donation is still a donation that was received');
});

test('the gap between donations and the per-active-hour rate are reported, and null when meaningless', () => {
  const items = [0, 30, 90].map((min, i) => ({
    id: 'g' + i,
    ts: new Date(Date.UTC(2026, 8, 24, 8, min)).toISOString(),
    name: 'A' + i,
    amount: 5,
    currency: 'USD',
    toman: 5000000
  }));
  const r = run(items, { range: 'today' });
  assert.equal(r.sequences.gapCount, 2);
  assert.equal(r.sequences.medianGapMin, 45, 'gaps are 30 and 60 minutes');
  assert.equal(r.sequences.spanHours, 1.5);
  assert.equal(r.sequences.perHour, 2);
  assert.equal(r.sequences.medianToman, 5000000);
  const one = run([items[0]], { range: 'today' });
  assert.equal(one.sequences.gapCount, 0);
  assert.equal(one.sequences.perHour, null, 'one donation says nothing about frequency');

  // Three donations a minute apart: a span below an hour has no per-hour rate to report, only a huge number.
  const burst = [0, 1, 2].map((min, i) => ({
    id: 'b' + i,
    ts: new Date(Date.UTC(2026, 8, 24, 8, min)).toISOString(),
    name: 'C' + i,
    amount: 5,
    currency: 'USD',
    toman: 5000000
  }));
  const tight = run(burst, { range: 'today' });
  assert.equal(tight.sequences.perHour, null, 'a span under an hour is not divided into a per-hour rate');
  assert.equal(tight.sequences.spanHours, 0, 'the span itself is still reported');
  assert.equal(tight.sequences.medianGapMin, 1, 'the gaps are still reported');
});

test('the previous-period comparison is null when history does not reach back that far', () => {
  const items = [{ id: 'a', ts: '2026-09-24T10:00:00Z', name: 'A', amount: 10, currency: 'USD', toman: 10000000 }];
  // today: nothing to compare against, the window before it is empty
  assert.equal(run(items, { range: 'today' }).previous, null);
  // with a week of history the comparison appears
  const withHistory = [
    ...items,
    { id: 'b', ts: '2026-09-23T10:00:00Z', name: 'B', amount: 20, currency: 'USD', toman: 20000000 }
  ];
  const r = run(withHistory, { range: 'today' });
  assert.ok(r.previous);
  assert.equal(r.previous.count, 1);
  assert.equal(r.previous.amountUsd, 20);
  assert.equal(r.previous.uniqueDonors, 1);
  // coverage that only starts inside the previous window suppresses the comparison
  const shallow = A.computeAnalytics(withHistory, {
    range: 'today',
    now: NOW,
    tz: TZ,
    rate: { value: 1000000 },
    coverage: { from: '2026-09-24T12:00:00Z' }
  });
  assert.equal(shallow.previous, null, 'no baseline is invented for a period the app never recorded');
});

test('a heatmap is withheld while the dataset is too small to be meaningful', () => {
  const few = run(
    [1, 2, 3].map((i, k) => ({
      id: 'h' + k,
      ts: `2026-09-24T${String(i).padStart(2, '0')}:00:00Z`,
      name: 'A' + k,
      amount: 5,
      currency: 'USD'
    })),
    { range: 'today' }
  );
  assert.equal(few.heatmap.available, false);
  assert.equal(few.heatmap.dated, 3);
  const many = run(
    Array.from({ length: 20 }, (_, i) => ({
      id: 'h' + i,
      ts: new Date(Date.UTC(2026, 8, 24, 8 + (i % 10))).toISOString(),
      name: 'A' + (i % 4),
      amount: 5,
      currency: 'USD',
      toman: 5000000
    })),
    { range: 'today' }
  );
  assert.equal(many.heatmap.available, true);
  assert.equal(many.heatmap.max, 2);
  assert.equal(many.heatmap.cells.length, 7);
  assert.equal(many.heatmap.cells[0].length, 24);
  assert.equal(many.heatmap.days[0], 'شنبه', 'row 0 is Saturday');
});

test('test and preview events are excluded by default but can be included on request', () => {
  const items = [
    { id: 'real', ts: '2026-09-24T08:00:00Z', name: 'A', amount: 10, currency: 'USD', toman: 10000000 },
    { id: 'test', ts: '2026-09-24T08:00:00Z', name: 'B', amount: 999, currency: 'USD', toman: 999000000, test: true }
  ];
  const r = run(items, { range: 'today' });
  assert.equal(r.totals.count, 1);
  assert.equal(r.totals.amountUsd, 10);
  assert.equal(r.excluded.test, 1);
  const withTests = run(items, { range: 'today', includeTests: true });
  assert.equal(withTests.totals.count, 2);
});

// ---------------------------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------------------------

function tempStore(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahne-analytics-'));
  const store = createAnalyticsStore(dir, { tz: TZ, now: () => NOW, ...opts });
  return { dir, store };
}

test('the store appends one line per event, groups by local month, and reads them back', () => {
  const { dir, store } = tempStore();
  try {
    assert.equal(
      store.record({
        id: 'a',
        at: Date.parse('2026-09-24T08:00:00Z'),
        name: 'Ali',
        amount: 10,
        currency: 'USD',
        toman: 10000000
      }),
      true
    );
    // 20:30Z on the 24th belongs to the 25th locally, and both are the same Gregorian month here
    store.record({ id: 'b', at: Date.parse('2026-09-24T20:30:00Z'), name: 'Sara', amount: 5, currency: 'USD' });
    store.record({ id: 'c', at: Date.parse('2026-10-01T08:00:00Z'), name: 'Reza', amount: 7, currency: 'USD' });
    store.flush();
    const files = fs.readdirSync(dir).filter(f => f.startsWith('analytics-') && f.endsWith('.ndjson'));
    assert.deepEqual(files.sort(), ['analytics-2026-09.ndjson', 'analytics-2026-10.ndjson']);
    const data = store.load();
    assert.equal(data.items.length, 3);
    assert.equal(data.coverage.events, 3);
    assert.equal(data.coverage.from, '2026-09-24T08:00:00.000Z');
    const lines = fs.readFileSync(path.join(dir, 'analytics-2026-09.ndjson'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const rec = JSON.parse(lines[1]);
    assert.equal(rec.id, 'b');
    assert.equal(rec.day, '2026-09-25', 'the local day, not the UTC day');
    assert.ok(rec.toman === null && rec.played === null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the store rejects what is not a donation and never throws into the caller', () => {
  const { dir, store } = tempStore();
  try {
    assert.equal(store.record(null), false);
    assert.equal(store.record({ name: 'no id', amount: 5 }), false);
    assert.equal(store.record({ id: 'zero', amount: 0 }), false);
    assert.equal(store.record({ id: 'neg', amount: -3 }), false);
    assert.equal(store.record({ id: 'nan', amount: 'x' }), false);
    assert.equal(
      store.record({
        id: 'ok',
        at: new Date(NOW - 3600000).toISOString(),
        amount: '12.5',
        currency: 'eur',
        kind: 'nonsense',
        source: 'evil'
      }),
      true
    );
    store.flush();
    const [item] = store.load().items;
    assert.equal(item.amount, 12.5);
    assert.equal(item.currency, 'EUR');
    assert.equal(item.kind, 'tip', 'an unknown kind falls back instead of leaking through');
    assert.equal(item.source, 'evil', 'the source is stored as given; analytics folds unknown ones into "other"');
    const r = A.computeAnalytics([item], { range: 'today', now: NOW, tz: TZ, rate: { value: 1000 } });
    assert.equal(r.breakdown.bySource[0].key, 'other');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a flood cannot fill the disk: the per-day cap applies to the local day', () => {
  const { dir, store } = tempStore();
  try {
    const at = Date.parse('2026-09-24T08:00:00Z');
    for (let i = 0; i < MAX_PER_DAY + 25; i++)
      store.record({ id: 'f' + i, at: at + i, name: 'A', amount: 1, currency: 'USD' });
    store.flush();
    const lines = fs.readFileSync(path.join(dir, 'analytics-2026-09.ndjson'), 'utf8').trim().split('\n');
    assert.equal(lines.length, MAX_PER_DAY);
    assert.equal(store.stats.dropped, 25);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the per-day cap survives a restart and an invalidated cache, not just the first run', () => {
  const { dir, store } = tempStore();
  try {
    const at = Date.parse('2026-09-24T08:00:00Z');
    for (let i = 0; i < MAX_PER_DAY; i++)
      store.record({ id: 'a' + i, at: at + i, name: 'A', amount: 1, currency: 'USD' });
    store.flush();
    // The app is restarted: a brand-new store over the same directory has nothing in memory. Its cap must still see
    // the lines already on disk, or a fresh run would happily write another 5000.
    const reopened = createAnalyticsStore(dir, { tz: TZ, now: () => NOW });
    assert.equal(reopened.record({ id: 'overflow', at, name: 'A', amount: 1, currency: 'USD' }), false);
    reopened.flush();
    const lines = fs.readFileSync(path.join(dir, 'analytics-2026-09.ndjson'), 'utf8').trim().split('\n');
    assert.equal(lines.length, MAX_PER_DAY, 'the day never grows past the ceiling across runs');
    // A rollup/clear invalidates the in-memory counts; the cap must recover on its own rather than reset to zero.
    store.invalidate();
    assert.equal(store.record({ id: 'overflow2', at, name: 'A', amount: 1, currency: 'USD' }), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an outcome can be patched on disk after the fact, and in memory before the flush', () => {
  const { dir, store } = tempStore();
  try {
    const at = Date.parse('2026-09-24T08:00:00Z');
    store.record({ id: 'skipped-later', at, name: 'A', amount: 5, currency: 'USD' });
    assert.equal(store.markOutcome('skipped-later', false), true, 'patched while still pending');
    store.record({ id: 'already-written', at: at + 1, name: 'B', amount: 5, currency: 'USD' });
    store.flush();
    assert.equal(store.markOutcome('already-written', false), true, 'patched in the file');
    const items = store.load().items;
    assert.equal(items.find(i => i.id === 'skipped-later').played, false);
    assert.equal(items.find(i => i.id === 'already-written').played, false);
    assert.equal(store.markOutcome('never-seen', false), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('old months are rolled up into a summary and their detail is dropped, without losing the totals', () => {
  const clock = { now: Date.parse('2026-12-15T12:00:00Z') };
  const { dir, store } = tempStore({ now: () => clock.now });
  try {
    store.record({
      id: 'jan',
      at: Date.parse('2026-01-10T08:00:00Z'),
      name: 'Old',
      amount: 10,
      currency: 'USD',
      toman: 8000000
    });
    store.record({
      id: 'feb',
      at: Date.parse('2026-02-10T08:00:00Z'),
      name: 'Old',
      amount: 20,
      currency: 'USD',
      toman: 17000000
    });
    store.record({
      id: 'dec',
      at: Date.parse('2026-12-10T08:00:00Z'),
      name: 'New',
      amount: 5,
      currency: 'USD',
      toman: 5000000
    });
    store.flush();
    store.rollup(true);
    const months = fs.readdirSync(store.rollupDir).sort();
    assert.deepEqual(months, ['2026-01.json', '2026-02.json']);
    assert.ok(!fs.existsSync(path.join(dir, 'analytics-2026-01.ndjson')), 'the detailed file is gone');
    assert.ok(fs.existsSync(path.join(dir, 'analytics-2026-12.ndjson')), 'the recent month stays detailed');
    const data = store.load();
    assert.equal(data.items.length, 1, 'only the detailed month is read as items');
    assert.equal(data.months.length, 2);
    const jan = data.months.find(m => m.month === '2026-01');
    assert.equal(jan.count, 1);
    assert.equal(jan.usd, 10);
    assert.equal(jan.toman, 8000000);
    assert.equal(jan.donors, 1);
    assert.equal(jan.days['2026-01-10'].count, 1);
    assert.equal(jan.kinds.tip, 1);
    assert.equal(data.coverage.rolledMonths, 2);
    assert.equal(data.coverage.rolledFrom, '2026-01-10T08:00:00.000Z');
    // a rollup runs at most once per month unless forced
    store.rollup();
    assert.equal(fs.readdirSync(store.rollupDir).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the donor index survives a rollup, so "returning donor" stays correct on old history', () => {
  const clock = { now: Date.parse('2026-12-15T12:00:00Z') };
  const { dir, store } = tempStore({ now: () => clock.now });
  try {
    store.record({
      id: 'old',
      at: Date.parse('2026-01-10T08:00:00Z'),
      name: 'Loyal',
      amount: 10,
      currency: 'USD',
      toman: 8000000
    });
    store.flush();
    store.load();
    store.rollup(true); // details dropped, but the index was written alongside
    assert.ok(fs.existsSync(store.donorFile));
    assert.equal(store.donors().get('Loyal'), Date.parse('2026-01-10T08:00:00Z'));
    // a December donation from the same person must read as a returning donor
    store.record({
      id: 'new',
      at: Date.parse('2026-12-10T08:00:00Z'),
      name: 'Loyal',
      amount: 5,
      currency: 'USD',
      toman: 5000000
    });
    store.flush();
    const data = store.load();
    const firstSeen = new Map(store.donors());
    for (const it of data.items) {
      const prev = firstSeen.get(it.name);
      if (prev === undefined || it.at < prev) firstSeen.set(it.name, it.at);
    }
    const r = A.computeAnalytics(data.items, {
      range: 'custom',
      from: '2026-12-10',
      to: '2026-12-10',
      now: clock.now,
      tz: TZ,
      rate: { value: 1000000 },
      donorFirstSeen: firstSeen
    });
    assert.equal(r.totals.returningDonors, 1);
    assert.equal(r.totals.newDonors, 0);
    // the stored index is valid JSON and reloads
    assert.equal(JSON.parse(fs.readFileSync(store.donorFile, 'utf8')).Loyal, Date.parse('2026-01-10T08:00:00Z'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a torn last line from an interrupted write is skipped, not fatal', () => {
  const { dir, store } = tempStore();
  try {
    store.record({ id: 'a', at: Date.parse('2026-09-24T08:00:00Z'), name: 'A', amount: 5, currency: 'USD' });
    store.flush();
    fs.appendFileSync(path.join(dir, 'analytics-2026-09.ndjson'), '{"id":"b","at":123,"name":"trunc');
    const data = store.load();
    assert.equal(data.items.length, 1, 'the good line survives');
    assert.equal(data.items[0].id, 'a');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a range that reaches into rolled-up months says so instead of looking complete', () => {
  const clock = { now: Date.parse('2026-12-15T12:00:00Z') };
  const { dir, store } = tempStore({ now: () => clock.now });
  try {
    // January detail is rolled up; December stays detailed. A season-long range spans both.
    store.record({
      id: 'jan',
      at: Date.parse('2026-01-10T08:00:00Z'),
      name: 'Old',
      amount: 100,
      currency: 'USD',
      toman: 80000000
    });
    store.record({
      id: 'dec',
      at: Date.parse('2026-12-10T08:00:00Z'),
      name: 'New',
      amount: 5,
      currency: 'USD',
      toman: 5000000
    });
    store.flush();
    store.rollup(true);
    const data = store.load();
    const opts = { now: clock.now, tz: TZ, rate: { value: 1000000 }, coverage: data.coverage };
    // the whole year: only December's donation is in the detail, and the payload has to admit January is missing
    const wide = A.computeAnalytics(data.items, { ...opts, range: 'custom', from: '2026-01-01', to: '2026-12-31' });
    assert.equal(wide.totals.count, 1, 'the rolled-up January donation is not double-counted from the summary');
    assert.ok(
      wide.notes.some(n => n.code === 'rolled-up' && n.count === 1),
      'the missing month is disclosed, not silently dropped'
    );
    // a range entirely inside the detailed months says nothing, because nothing is missing from it
    const narrow = A.computeAnalytics(data.items, { ...opts, range: 'custom', from: '2026-12-01', to: '2026-12-31' });
    assert.ok(!narrow.notes.some(n => n.code === 'rolled-up'));
    // starting inside the rolled-up month still overlaps it, so it is disclosed
    const mid = A.computeAnalytics(data.items, { ...opts, range: 'custom', from: '2026-01-05', to: '2026-12-31' });
    assert.ok(mid.notes.some(n => n.code === 'rolled-up'));
    // a range that only touches the month AFTER the newest summary is fully detailed again
    const feb = A.computeAnalytics(data.items, { ...opts, range: 'custom', from: '2026-02-01', to: '2026-02-28' });
    assert.ok(!feb.notes.some(n => n.code === 'rolled-up'), 'February is not covered by any summary');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a rollup does not turn a test tip into a real donation in the monthly summary', () => {
  const clock = { now: Date.parse('2026-12-15T12:00:00Z') };
  const { dir, store } = tempStore({ now: () => clock.now });
  try {
    store.record({
      id: 'real',
      at: Date.parse('2026-01-10T08:00:00Z'),
      name: 'Ali',
      amount: 10,
      currency: 'USD',
      toman: 8000000
    });
    store.record({
      id: 't1',
      at: Date.parse('2026-01-11T08:00:00Z'),
      name: 'تستی',
      amount: 999,
      currency: 'USD',
      toman: 999000000,
      test: true
    });
    store.flush();
    store.rollup(true);
    const jan = store.load().months.find(m => m.month === '2026-01');
    assert.equal(jan.count, 1, 'the test tip is not counted as a donation in the summary');
    assert.equal(jan.usd, 10);
    assert.equal(jan.toman, 8000000);
    assert.equal(jan.tests, 1, 'and it is still accounted for, not hidden');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a stored record is dated by its `at` field, not read as undated', () => {
  // The history store writes `at` (milliseconds); computeAnalytics is also handed raw provider items that use `ts`.
  // Reading only `ts`/`created_at` made every stored donation undated, so the page was empty however much history
  // existed. This pins the field the store actually writes.
  const { dir, store } = tempStore();
  try {
    store.record({
      id: 'stored',
      at: Date.parse('2026-09-24T08:00:00Z'),
      name: 'Ali',
      amount: 10,
      currency: 'USD',
      toman: 10000000
    });
    store.flush();
    const [item] = store.load().items;
    assert.equal(item.at, Date.parse('2026-09-24T08:00:00Z'), 'the store persists the instant under `at`');
    const r = A.computeAnalytics(store.load().items, { range: 'today', now: NOW, tz: TZ, rate: { value: 1000000 } });
    assert.equal(r.excluded.undated, 0, 'a stored record is not treated as undated');
    assert.equal(r.totals.count, 1, 'and it lands inside the range');
    assert.equal(r.totals.amountToman, 10000000);
    assert.equal(r.activity.busiestDay.key, '2026-09-24');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a test tip is stored as a test and never counted as a real donation', () => {
  const { dir, store } = tempStore();
  try {
    store.record({
      id: 'real',
      at: Date.parse('2026-09-24T08:00:00Z'),
      name: 'Ali',
      amount: 10,
      currency: 'USD',
      toman: 10000000
    });
    store.record({
      id: 'test_1',
      at: Date.parse('2026-09-24T08:30:00Z'),
      name: 'تستی',
      amount: 999,
      currency: 'USD',
      toman: 999000000,
      test: true
    });
    store.flush();
    const data = store.load();
    assert.equal(data.items.find(i => i.id === 'test_1').test, true, 'the flag survives the round trip to disk');
    const r = A.computeAnalytics(data.items, { range: 'today', now: NOW, tz: TZ, rate: { value: 1000000 } });
    assert.equal(r.totals.count, 1, 'the test tip is not a donation on the page');
    assert.equal(r.totals.amountUsd, 10);
    assert.equal(r.excluded.test, 1);
    // and it is still recoverable on request, so the flag is not destroying data
    const withTests = A.computeAnalytics(data.items, {
      range: 'today',
      now: NOW,
      tz: TZ,
      rate: { value: 1000000 },
      includeTests: true
    });
    assert.equal(withTests.totals.count, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('clearing the app data removes every file the analytics store owns', () => {
  const { dir, store } = tempStore();
  try {
    store.record({
      id: 'a',
      at: Date.parse('2026-01-10T08:00:00Z'),
      name: 'A',
      amount: 5,
      currency: 'USD',
      toman: 4000000
    });
    store.record({
      id: 'b',
      at: Date.parse('2026-12-10T08:00:00Z'),
      name: 'B',
      amount: 5,
      currency: 'USD',
      toman: 5000000
    });
    store.flush();
    store.load();
    store.rollup(true);
    assert.ok(fs.readdirSync(dir).length > 1);
    store.clear();
    assert.deepEqual(
      fs.readdirSync(dir).filter(f => f.startsWith('analytics-') && f.endsWith('.ndjson')),
      []
    );
    assert.ok(!fs.existsSync(store.rollupDir));
    assert.equal(store.load().items.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// The HTTP endpoint, wired to the real server
// ---------------------------------------------------------------------------------------------

test('/api/analytics serves the stored history, honours range and tz, and hides nothing it cannot compute', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahne-test-'));
  const port = 8400 + Math.floor(Math.random() * 100);
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({
      port,
      secret_id: 'a'.repeat(32) + ':' + 'b'.repeat(32),
      streamer_id: 1,
      rate: { auto: false, manual: 1000000 },
      kick: { enabled: false },
      app: { autostart: false }
    })
  );
  const srv = createServer({
    dataDir: dir,
    publicDir: path.join(__dirname, '..', 'public'),
    appVersion: 'test',
    testHooks: { offline: true }
  });
  await srv.start();
  t.after(async () => {
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const get = p =>
    new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: p }, res => {
          let d = '';
          res.on('data', c => (d += c));
          res.on('end', () => resolve({ status: res.statusCode, body: d }));
        })
        .on('error', reject);
    });

  // an empty history is a valid, well-formed answer — never a 500 and never NaN
  const empty = await get('/api/analytics?range=today');
  assert.equal(empty.status, 200);
  const e = JSON.parse(empty.body);
  assert.equal(e.ok, true);
  assert.equal(e.totals.count, 0);
  assert.equal(e.totals.amountToman, null);
  assert.equal(e.rate.value, 1000000, 'the manual rate from config is what the page reports');
  assert.equal(e.coverage.events, 0);
  assert.ok(Array.isArray(e.notes));

  // seed the store the way the alert pipeline does, through the public store surface
  srv.analytics.record({
    id: 'pi_1',
    at: Date.now() - 3600000,
    name: 'Ali',
    amount: 25,
    currency: 'USD',
    toman: 25000000,
    rate: 1000000,
    kind: 'tip',
    source: 'kickbot',
    played: true
  });
  srv.analytics.record({
    id: 'pi_2',
    at: Date.now() - 1000,
    name: 'Ali',
    amount: 5,
    currency: 'USD',
    toman: 5000000,
    rate: 1000000
  });
  const today = JSON.parse((await get('/api/analytics?range=today')).body);
  assert.equal(today.totals.count, 2);
  assert.equal(today.totals.uniqueDonors, 1);
  assert.equal(today.totals.amountToman, 30000000);
  assert.equal(today.rate.value, 1000000);
  assert.equal(today.topDonors[0].name, 'Ali');
  assert.equal(today.series.granularity, 'hour');

  // a different timezone is honoured (the browser can ask for its own offset)
  const utc = JSON.parse((await get('/api/analytics?range=today&tz=0')).body);
  assert.equal(utc.range.tzOffsetMin, 0);
  assert.equal(utc.range.key, 'today');

  // a custom range that contains nothing is empty, not an error
  const custom = JSON.parse((await get('/api/analytics?range=custom&from=2020-01-01&to=2020-01-02')).body);
  assert.equal(custom.totals.count, 0);
  assert.equal(custom.range.key, 'custom');

  const bogus = JSON.parse((await get('/api/analytics?range=nonsense')).body);
  assert.equal(bogus.range.key, 'today', 'an unknown range falls back instead of failing');

  const badTz = JSON.parse((await get('/api/analytics?range=today&tz=99999')).body);
  assert.notEqual(badTz.range.tzOffsetMin, 99999, 'an out-of-range offset is refused');

  // the endpoint is read-only: a mutating method must not be accepted
  const posted = await new Promise(resolve => {
    const r = http.request({ host: '127.0.0.1', port, path: '/api/analytics', method: 'POST' }, res =>
      resolve(res.statusCode)
    );
    r.end();
  });
  assert.equal(posted, 404);
});

test('the Settings switch stops the donation history, and it is on unless the user turned it off', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahne-test-'));
  const port = 8500 + Math.floor(Math.random() * 100);
  // no `recordHistory` key at all: an existing config.json must default to recording, not to nothing
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({
      port,
      rate: { auto: false, manual: 1000000 },
      kick: { enabled: false },
      showAlertWithoutMedia: false, // an empty media folder then skips every alert at once, so the queue never waits
      app: { autostart: false }
    })
  );
  const srv = createServer({
    dataDir: dir,
    publicDir: path.join(__dirname, '..', 'public'),
    appVersion: 'test',
    testHooks: { offline: true }
  });
  await srv.start();
  const es = http.get({ host: '127.0.0.1', port, path: '/events?role=overlay' }, res => {
    res.setEncoding('utf8');
    res.on('data', () => {});
  });
  await sleep(150); // a Browser Source must be open, or a tip waits in the queue and is never played
  srv.testHooks.setQueueDelay(0); // no inter-alert gap, so the three donations below follow each other at once
  t.after(async () => {
    es.destroy();
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const req = (method, p, body) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const r = http.request(
        {
          host: '127.0.0.1',
          port,
          path: p,
          method,
          headers: {
            Origin: `http://127.0.0.1:${port}`,
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
          }
        },
        res => {
          let d = '';
          res.on('data', c => (d += c));
          res.on('end', () => resolve({ status: res.statusCode, body: d }));
        }
      );
      r.on('error', reject);
      if (payload) r.write(payload);
      r.end();
    });
  const page = async () => JSON.parse((await req('GET', '/api/analytics?range=today')).body);
  const cfg = async () => JSON.parse((await req('GET', '/api/config')).body).config.app;
  const tip = id => ({
    stripe_pi_id: id,
    tipper_name: 'Donor',
    amount_total: 500,
    approval_status: 'approved',
    is_local: true, // a local event is played (and therefore recorded) without a KickBot capture
    created_at: new Date().toISOString()
  });
  const stored = () =>
    fs
      .readdirSync(dir)
      .filter(f => f.startsWith('analytics-') && f.endsWith('.ndjson'))
      .flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').split('\n'))
      .filter(Boolean)
      .join('\n');

  assert.equal((await cfg()).recordHistory, true, 'recording is on by default');
  assert.equal((await page()).recording, true);
  srv.testHooks.injectTip(tip('pi_switch_on'));
  await sleep(150);
  assert.equal((await page()).totals.count, 1, 'a donation is recorded while the switch is on');

  assert.equal((await req('POST', '/api/config', { app: { recordHistory: false } })).status, 200);
  assert.equal((await cfg()).recordHistory, false, 'the switch can be turned off');
  const off = await page();
  assert.equal(off.recording, false, 'the page is told that recording is off');
  assert.ok(
    off.notes.some(n => n.code === 'recording-off'),
    'and the UI is given the note that explains why the numbers stop'
  );
  assert.equal(off.totals.count, 1, 'turning the switch off keeps the history that was already written');

  srv.testHooks.injectTip(tip('pi_switch_off'));
  await sleep(150);
  assert.equal((await page()).totals.count, 1, 'nothing new is counted while the switch is off');
  assert.ok(!stored().includes('pi_switch_off'), 'and nothing new reaches the disk');
  assert.ok(stored().includes('pi_switch_on'), 'the file that was written earlier is untouched');

  await req('POST', '/api/config', { app: { recordHistory: true } });
  srv.testHooks.injectTip(tip('pi_switch_again'));
  await sleep(150);
  assert.equal((await page()).totals.count, 2, 'recording resumes when the switch is turned back on');
});

test('analytics helpers are pure and exported for the server and the tests', () => {
  assert.equal(parseTz('210'), 210);
  assert.equal(parseTz('-330'), -330);
  assert.equal(parseTz(''), null);
  assert.equal(parseTz('99999'), null);
  assert.equal(parseTz('abc'), null);
  assert.equal(typeof A.computeAnalytics, 'function');
  assert.equal(typeof createAnalyticsStore, 'function');
  assert.deepEqual(A.DEFAULT_BUCKET_EDGES, [5, 10, 25, 50, 100]);
  assert.ok(A.MAX_BUCKETS >= 100 && A.MIN_HEATMAP_EVENTS > 0);
  // computeAnalytics must not mutate its input
  const items = [{ id: 'a', ts: '2026-09-24T08:00:00Z', name: 'A', amount: 5, currency: 'USD' }];
  const before = JSON.stringify(items);
  run(items);
  assert.equal(JSON.stringify(items), before);
});

// ---------------------------------------------------------------------------------------------
// Regression tests for review fixes
// ---------------------------------------------------------------------------------------------

test('rollup merges with an existing monthly summary instead of overwriting it', () => {
  const clock = { now: Date.parse('2026-12-15T12:00:00Z') };
  const { dir, store } = tempStore({ now: () => clock.now });
  try {
    // First rollup: January gets summarized
    store.record({
      id: 'jan1',
      at: Date.parse('2026-01-10T08:00:00Z'),
      name: 'Old',
      amount: 10,
      currency: 'USD',
      toman: 8000000
    });
    store.flush();
    store.rollup(true);
    let jan = store.load().months.find(m => m.month === '2026-01');
    assert.equal(jan.count, 1);
    assert.equal(jan.usd, 10);

    // A late-arriving donation for January (KickBot replay of an old tip)
    store.record({
      id: 'jan2',
      at: Date.parse('2026-01-15T08:00:00Z'),
      name: 'New',
      amount: 20,
      currency: 'USD',
      toman: 17000000
    });
    store.flush();
    store.rollup(true);
    jan = store.load().months.find(m => m.month === '2026-01');
    assert.equal(jan.count, 2, 'the late donation is merged into the existing summary');
    assert.equal(jan.usd, 30, 'totals are the sum of both donations');
    assert.equal(jan.toman, 25000000);
    assert.equal(jan.donors, 2, 'both donors are counted');
    assert.equal(jan.days['2026-01-10'].count, 1);
    assert.equal(jan.days['2026-01-15'].count, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a future month is never rolled up or deleted', () => {
  const clock = { now: Date.parse('2026-09-24T18:00:00Z') };
  const { dir, store } = tempStore({ now: () => clock.now });
  try {
    // A donation with a future created_at (or a clock rollback)
    store.record({
      id: 'future',
      at: Date.parse('2027-03-10T08:00:00Z'),
      name: 'Future',
      amount: 10,
      currency: 'USD',
      toman: 8000000
    });
    store.flush();
    store.rollup(true);
    // The future month file must still exist as detail data
    assert.ok(fs.existsSync(path.join(dir, 'analytics-2027-03.ndjson')), 'the future month is not rolled up');
    assert.ok(!fs.existsSync(store.rollupDir), 'no rollup directory was created at all');
    const data = store.load();
    assert.equal(data.items.length, 1, 'the future donation is still readable as detail');
    assert.equal(data.coverage.rolledMonths, 0, 'nothing is summarised');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('replay records with the same id are deduplicated during rollup', () => {
  const clock = { now: Date.parse('2026-12-15T12:00:00Z') };
  const { dir, store } = tempStore({ now: () => clock.now });
  try {
    // The same donation recorded twice (KickBot replay)
    store.record({
      id: 'replay',
      at: Date.parse('2026-01-10T08:00:00Z'),
      name: 'Ali',
      amount: 10,
      currency: 'USD',
      toman: 8000000
    });
    store.record({
      id: 'replay',
      at: Date.parse('2026-01-10T08:00:00Z'),
      name: 'Ali',
      amount: 10,
      currency: 'USD',
      toman: 8000000
    });
    store.flush();
    store.rollup(true);
    const jan = store.load().months.find(m => m.month === '2026-01');
    assert.equal(jan.count, 1, 'the replay is counted once, not twice');
    assert.equal(jan.usd, 10);
    assert.equal(jan.toman, 8000000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a torn final NDJSON line is repaired before the next append', () => {
  const { dir, store } = tempStore();
  try {
    store.record({ id: 'a', at: Date.parse('2026-09-24T08:00:00Z'), name: 'A', amount: 5, currency: 'USD' });
    store.flush();
    // Simulate a power loss mid-write: the file ends without a newline
    const file = path.join(dir, 'analytics-2026-09.ndjson');
    fs.appendFileSync(file, '{"id":"b","at":123,"name":"trunc');
    // The next record must not be concatenated onto the torn line
    store.record({ id: 'c', at: Date.parse('2026-09-24T09:00:00Z'), name: 'C', amount: 7, currency: 'USD' });
    store.flush();
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 3, 'the torn line is separated from the new record');
    assert.equal(JSON.parse(lines[0]).id, 'a');
    assert.equal(JSON.parse(lines[2]).id, 'c', 'the new record is on its own line');
    const data = store.load();
    assert.equal(data.items.length, 2, 'both valid records are readable');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('previousRange shifts by the full length of a custom range', () => {
  // A 7-day custom range: the previous period must be the 7 days before it, not 1 day before
  const range = A.resolveRange('custom', { now: NOW, tz: TZ, from: '2026-09-18', to: '2026-09-24' });
  const prev = A.previousRange(range, TZ);
  const span = range.end - range.start;
  assert.equal(prev.end - prev.start, span, 'the previous period has the same length');
  assert.equal(prev.end, range.start, 'the previous period ends exactly when the current one starts');
  assert.equal(A.dateKey(prev.start, TZ), '2026-09-11', '7 days before the 18th is the 11th');
  assert.equal(A.dateKey(prev.end - 1, TZ), '2026-09-17', 'the day before the 18th is the 17th');
});

test('the previous period of "this month" never enters the current month', () => {
  // Esfand (the 12th Persian month) is 29 or 30 days, so a naive shift back by the elapsed span can reach past the
  // start of the current month. The comparison must never overlap the period it is compared against.
  for (const iso of [
    '2026-03-18T12:00:00Z', // 1404/12/28 — deep into Esfand
    '2026-03-19T12:00:00Z', // 1404/12/29 — Esfand 29
    '2026-03-20T12:00:00Z', // 1404/12/30 — Esfand 30
    '2026-03-21T12:00:00Z', // the 1st of Farvardin, the month boundary itself
    '2026-09-24T18:00:00Z' // the 2nd of Mehr
  ]) {
    const range = A.resolveRange('month', { now: Date.parse(iso), tz: TZ });
    const prev = A.previousRange(range, TZ);
    assert.ok(prev.end <= range.start, `${iso}: the previous period ends at or before the month starts`);
    assert.equal(
      A.jalaliMonthKey(prev.start, TZ),
      A.jalaliMonthKey(prev.end - 1, TZ),
      `${iso}: the whole previous period stays inside the previous Persian month`
    );
    assert.ok(prev.start < prev.end, `${iso}: the previous period is not empty`);
  }
  // 1 Mehr: the previous period is Esfand, whatever its length
  const mehr = A.resolveRange('month', { now: Date.parse('2026-09-24T18:00:00Z'), tz: TZ });
  assert.equal(A.jalaliMonthKey(mehr.start, TZ), '1405-07');
  const mehrPrev = A.previousRange(mehr, TZ);
  assert.equal(A.jalaliMonthKey(mehrPrev.start, TZ), '1405-06');
  assert.ok(mehrPrev.end <= mehr.start);
  // late Farvardin: the previous period is Bahman and stops at the Farvardin boundary
  const farvardin = A.resolveRange('month', { now: Date.parse('2026-03-20T12:00:00Z'), tz: TZ });
  assert.equal(A.jalaliMonthKey(farvardin.start, TZ), '1404-12');
  const farvardinPrev = A.previousRange(farvardin, TZ);
  assert.equal(A.jalaliMonthKey(farvardinPrev.start, TZ), '1404-11');
  assert.ok(farvardinPrev.end <= farvardin.start, 'the previous period does not reach into Esfand');
});

test('busiest hour 0 (midnight) is reported correctly', () => {
  // 20:30Z and 21:00Z are 00:00 and 00:30 in Tehran (+03:30); 20:00Z is still 23:30 the day before.
  const items = [
    { id: 'a', ts: '2026-09-24T20:00:00Z', name: 'A', amount: 5, currency: 'USD', toman: 5000000 },
    { id: 'b', ts: '2026-09-24T20:30:00Z', name: 'B', amount: 5, currency: 'USD', toman: 5000000 },
    { id: 'c', ts: '2026-09-24T21:00:00Z', name: 'C', amount: 5, currency: 'USD', toman: 5000000 }
  ];
  // a custom range is needed: 20:30Z is already "tomorrow" locally
  const r = run(items, { range: 'custom', from: '2026-09-25', to: '2026-09-25' });
  assert.equal(r.totals.count, 2, 'only the two local-midnight donations are in the 25th');
  assert.equal(r.activity.busiestHour.hour, 0, 'midnight is a valid busiest hour');
  assert.equal(r.activity.busiestHour.count, 2);
  // hour 0 must also win on its own: the old `!busiestHour` check could never select it
  const onlyMidnight = run([items[1]], { range: 'custom', from: '2026-09-25', to: '2026-09-25' });
  assert.equal(onlyMidnight.activity.busiestHour.hour, 0);
  assert.equal(onlyMidnight.activity.busiestHour.count, 1);
  // and a non-zero hour still wins normally
  const evening = run(
    [{ id: 'd', ts: '2026-09-24T08:00:00Z', name: 'D', amount: 5, currency: 'USD', toman: 5000000 }],
    {
      range: 'today'
    }
  );
  assert.equal(evening.activity.busiestHour.hour, 11);
});

test('donor names are normalized for grouping and anonymous donors are excluded from donor metrics', () => {
  const items = [
    { id: 'a', ts: '2026-09-24T08:00:00Z', name: 'علی', amount: 10, currency: 'USD', toman: 10000000 },
    { id: 'b', ts: '2026-09-24T09:00:00Z', name: 'علي', amount: 20, currency: 'USD', toman: 20000000 }, // Arabic ي
    { id: 'c', ts: '2026-09-24T10:00:00Z', name: 'Ali', amount: 30, currency: 'USD', toman: 30000000 },
    { id: 'd', ts: '2026-09-24T11:00:00Z', name: 'ali', amount: 40, currency: 'USD', toman: 40000000 },
    { id: 'e', ts: '2026-09-24T12:00:00Z', name: 'Ali ', amount: 50, currency: 'USD', toman: 50000000 }, // trailing space
    { id: 'f', ts: '2026-09-24T13:00:00Z', name: '  Ali  ', amount: 60, currency: 'USD', toman: 60000000 },
    { id: 'g', ts: '2026-09-24T14:00:00Z', name: 'ناشناس', amount: 100, currency: 'USD', toman: 100000000 },
    { id: 'h', ts: '2026-09-24T15:00:00Z', name: '   ', amount: 200, currency: 'USD', toman: 200000000 }
  ];
  const r = run(items, { range: 'today' });
  // علی/علي is one donor, the Latin variants are another: the normalized key never merges two different scripts
  assert.equal(r.totals.uniqueDonors, 2, 'one donor per normalized name');
  assert.equal(r.totals.count, 8, 'every donation is still counted');
  assert.equal(r.totals.amountToman, 510000000, 'the Toman total still includes anonymous donations');
  assert.equal(r.totals.amountUsd, 510, 'the USD total still includes anonymous donations');
  // Anonymous donations must not turn into the #1 donor
  assert.notEqual(r.totals.largestDonor, 'ناشناس', 'an anonymous donation is never reported as "largest donor"');
  assert.equal(r.topDonors.length, 2, 'anonymous donors are not in the top-donor list');
  assert.ok(
    r.topDonors.every(d => d.name !== 'ناشناس'),
    'no anonymous entry in the top-donor list'
  );
  // Same script + case/whitespace variants do collapse into one
  assert.equal(r.topDonors[0].count, 4, 'Ali / ali / "Ali " / "  Ali  " are one donor');
  assert.equal(r.topDonors[1].count, 2, 'علی and علي are one donor');
  // Repeat/new/returning are computed over the named donors only
  assert.equal(r.totals.repeatDonors, 2);
  assert.equal(r.totals.newDonors, 2, 'both named donors first appear in this range');
  assert.equal(r.totals.returningDonors, 0);
  // Repeated whitespace is collapsed to a single space in the key
  assert.equal(A.normalizeDonorKey('Ali  \t Reza '), 'ali reza');
  assert.equal(A.normalizeDonorKey('علي'), A.normalizeDonorKey('علی'), 'Arabic ي normalizes to Persian ی');
  assert.equal(A.normalizeDonorKey('ك'), A.normalizeDonorKey('ک'), 'Arabic ك normalizes to Persian ک');
  assert.equal(A.normalizeDonorKey('Ali'), A.normalizeDonorKey('ali'), 'Latin case is normalized');
  assert.equal(A.normalizeDonorKey('Ali '), A.normalizeDonorKey('Ali'), 'trailing whitespace is trimmed');
  assert.notEqual(A.normalizeDonorKey('علی'), A.normalizeDonorKey('ali'), 'different scripts stay different donors');
  assert.equal(A.isAnonymousDonor(''), true);
  assert.equal(A.isAnonymousDonor('   '), true);
  assert.equal(A.isAnonymousDonor('ناشناس'), true);
  assert.equal(A.isAnonymousDonor('Ali'), false);
  // an anonymous donor never becomes a repeat or returning donor
  const anon = run(
    [0, 1, 2].map(i => ({
      id: 'anon' + i,
      ts: `2026-09-24T${String(8 + i).padStart(2, '0')}:00:00Z`,
      name: i === 0 ? '' : 'ناشناس',
      amount: 5,
      currency: 'USD',
      toman: 5000000
    })),
    { range: 'today' }
  );
  assert.equal(anon.totals.uniqueDonors, 0, 'anonymous donations produce no unique donor');
  assert.equal(anon.totals.repeatDonors, 0, 'they are not repeat donors');
  assert.equal(anon.totals.returningDonors, 0, 'they are not returning donors');
  assert.equal(anon.totals.count, 3, 'but they are still real donations in the totals');
  assert.deepEqual(anon.totals.topShare, { top1: 0, top5: 0, top10: 0 }, 'no named donor holds any share');
  assert.equal(anon.totals.largestDonor, null, 'and none is credited as the largest donor');
});

test('returning donor calculations work with normalized donor keys', () => {
  // Ali's first donation is before the range, Sara's is inside it. "Ali" and "ali" are one donor.
  const items = [
    { id: 'a0', ts: '2026-09-10T08:00:00Z', name: 'Ali', amount: 5, currency: 'USD', toman: 5000000 },
    { id: 'a1', ts: '2026-09-20T08:00:00Z', name: 'Ali', amount: 10, currency: 'USD', toman: 10000000 },
    { id: 'a2', ts: '2026-09-24T08:00:00Z', name: 'ali', amount: 10, currency: 'USD', toman: 10000000 },
    { id: 's1', ts: '2026-09-24T09:00:00Z', name: 'Sara', amount: 100, currency: 'USD', toman: 100000000 }
  ];
  const r = run(items, { range: 'custom', from: '2026-09-20', to: '2026-09-24' });
  assert.equal(r.totals.count, 3, 'the pre-range donation is not counted in the period');
  assert.equal(r.totals.uniqueDonors, 2, 'Ali and Sara are two donors');
  assert.equal(r.totals.repeatDonors, 1, 'Ali donated twice in the period under two spellings');
  assert.equal(r.totals.newDonors, 1, 'only Sara first appears in this range');
  assert.equal(
    r.totals.returningDonors,
    1,
    'Ali is a returning donor, because his first donation is older than the range'
  );
  // An externally supplied index (as the store provides after a rollup) is normalized the same way, so "Ali"/"ali"
  // stay one donor even when the index only ever saw one spelling.
  const fromStore = new Map([
    ['Ali', Date.parse('2026-09-10T08:00:00Z')],
    ['Sara', Date.parse('2026-09-24T09:00:00Z')]
  ]);
  const withIndex = A.computeAnalytics(items, {
    range: 'custom',
    from: '2026-09-20',
    to: '2026-09-24',
    now: NOW,
    tz: TZ,
    rate: { value: 1000000 },
    donorFirstSeen: fromStore
  });
  assert.equal(withIndex.totals.newDonors, 1, 'only Sara is new; Ali is already in the index under one spelling');
  assert.equal(withIndex.totals.returningDonors, 1, 'Ali counts as returning despite the spelling change');
  assert.equal(withIndex.totals.uniqueDonors, 2);
});

test('Kick subscriptions are excluded from USD monetary metrics but counted in totals', () => {
  const items = [
    {
      id: 'tip',
      ts: '2026-09-24T08:00:00Z',
      name: 'A',
      amount: 10,
      currency: 'USD',
      toman: 10000000,
      kind: 'tip',
      source: 'kickbot'
    },
    {
      id: 'sub',
      ts: '2026-09-24T09:00:00Z',
      name: 'B',
      amount: 4.99,
      currency: 'USD',
      toman: 4990000,
      kind: 'sub',
      source: 'kick'
    },
    {
      id: 'gift',
      ts: '2026-09-24T10:00:00Z',
      name: 'C',
      amount: 9.98,
      currency: 'USD',
      toman: 9980000,
      kind: 'gift',
      source: 'kick'
    }
  ];
  const r = run(items, { range: 'today' });
  assert.equal(r.totals.count, 3, 'all events are counted');
  assert.equal(r.totals.amountUsd, 10, 'only the real USD tip is in the USD total');
  assert.equal(r.totals.usdCount, 1, 'only one USD donation');
  assert.equal(r.totals.avgUsd, 10, 'average is over real USD donations only');
  assert.equal(r.totals.medianUsd, 10, 'median is over real USD donations only');
  assert.equal(r.totals.amountToman, 24970000, 'toman totals include all events');
  assert.equal(r.totals.convertedCount, 3, 'all events have toman values');
  // The distribution only includes real USD donations
  assert.equal(
    r.distribution.reduce((a, b) => a + b.count, 0),
    1,
    'only the tip is in the distribution'
  );
  // A donor's dollar figure follows the same rule everywhere: a Kick sub/gift has no USD of its own.
  const b = r.topDonors.find(d => d.name === 'B');
  assert.equal(b.usd, 0, 'the Kick sub carries no dollars in the donor list either');
  assert.equal(b.toman, 4990000, 'its Toman value is still counted');
  assert.equal(r.topDonors.find(d => d.name === 'A').usd, 10, 'a real USD tip keeps its dollars');
});

test('record() rejects timestamps outside a sane range', () => {
  const { dir, store } = tempStore();
  try {
    // A far-future / far-past created_at must never create a file like "analytics-10000-0.ndjson"
    assert.equal(
      store.record({ id: 'future', at: Date.parse('2099-01-01T00:00:00Z'), name: 'A', amount: 5, currency: 'USD' }),
      false
    );
    assert.equal(store.record({ id: 'future2', at: 99999999999999, name: 'A', amount: 5, currency: 'USD' }), false);
    assert.equal(
      store.record({ id: 'past', at: Date.parse('2010-01-01T00:00:00Z'), name: 'A', amount: 5, currency: 'USD' }),
      false
    );
    // A sane timestamp is accepted
    assert.equal(
      store.record({ id: 'ok', at: Date.parse('2026-09-24T08:00:00Z'), name: 'A', amount: 5, currency: 'USD' }),
      true
    );
    store.flush();
    const files = fs.readdirSync(dir).filter(f => f.startsWith('analytics-'));
    assert.deepEqual(files, ['analytics-2026-09.ndjson'], 'no unreadable file was created for an invalid timestamp');
    assert.equal(store.load().items.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('clear() prevents writes from pending timers, and resume() re-arms the store', async () => {
  const { dir, store } = tempStore();
  try {
    // a record is still in the debounce window when the user clears the data
    store.record({ id: 'pending', at: Date.parse('2026-09-24T08:00:00Z'), name: 'A', amount: 5, currency: 'USD' });
    store.clear();
    await sleep(600); // longer than the 400 ms debounce: the timer must not have written anything
    assert.equal(
      fs.readdirSync(dir).filter(f => f.startsWith('analytics-') && f.endsWith('.ndjson')).length,
      0,
      'a pending flush must not write a month file after clear()'
    );
    assert.equal(
      store.record({ id: 'b', at: Date.parse('2026-09-24T09:00:00Z'), name: 'B', amount: 5, currency: 'USD' }),
      false
    );
    assert.equal(store.markOutcome('pending', false), false, 'markOutcome is a no-op once the store is stopped');
    store.flush();
    assert.equal(store.rollup(true), undefined);
    assert.equal(
      fs.readdirSync(dir).filter(f => f.startsWith('analytics-') && f.endsWith('.ndjson')).length,
      0,
      'still nothing on disk after clear()'
    );
    // the application lifecycle reinitialises the store after a clear
    store.resume(true);
    assert.equal(
      store.record({ id: 'c', at: Date.parse('2026-09-24T10:00:00Z'), name: 'C', amount: 5, currency: 'USD' }),
      true
    );
    store.flush();
    const data = store.load();
    assert.equal(data.items.length, 1, 'the store works again after resume()');
    assert.equal(data.items[0].id, 'c');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('with the recording switch off the store writes nothing: no rollup, no donor index, no history', () => {
  const clock = { now: Date.parse('2026-12-15T12:00:00Z') };
  const { dir, store } = tempStore({ now: () => clock.now });
  try {
    // history exists from an earlier run
    store.record({
      id: 'old',
      at: Date.parse('2026-01-10T08:00:00Z'),
      name: 'Old',
      amount: 10,
      currency: 'USD',
      toman: 8000000
    });
    store.record({
      id: 'dec',
      at: Date.parse('2026-12-10T08:00:00Z'),
      name: 'New',
      amount: 5,
      currency: 'USD',
      toman: 5000000
    });
    store.flush();
    store.load();
    const before = fs.readdirSync(dir).sort().join(',');

    store.setRecordingEnabled(false);
    assert.equal(
      store.record({ id: 'off', at: Date.parse('2026-12-11T08:00:00Z'), name: 'Off', amount: 5, currency: 'USD' }),
      false
    );
    store.flush();
    store.rollup(true); // the shutdown path runs this; it must not write
    store.load(); // opening the page reads and would save the donor index
    store.rollup(true);
    const after = fs.readdirSync(dir).sort().join(',');
    assert.equal(after, before, 'opening the page and shutting down changed nothing on disk');
    assert.ok(!fs.existsSync(store.rollupDir), 'no rollup summary was written');
    assert.equal(store.load().items.length, 2, 'the stored history is preserved, not deleted');
    // turning the switch back on resumes recording
    store.setRecordingEnabled(true);
    assert.equal(
      store.record({ id: 'on', at: Date.parse('2026-12-12T08:00:00Z'), name: 'On', amount: 5, currency: 'USD' }),
      true
    );
    store.flush();
    assert.equal(store.load().items.length, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the HTTP endpoint returns 400 for invalid custom range parameters', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahne-test-'));
  const port = 8600 + Math.floor(Math.random() * 100);
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({
      port,
      rate: { auto: false, manual: 1000000 },
      kick: { enabled: false },
      app: { autostart: false }
    })
  );
  const srv = createServer({
    dataDir: dir,
    publicDir: path.join(__dirname, '..', 'public'),
    appVersion: 'test',
    testHooks: { offline: true }
  });
  await srv.start();
  t.after(async () => {
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const get = p =>
    new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: p }, res => {
          let d = '';
          res.on('data', c => (d += c));
          res.on('end', () => resolve({ status: res.statusCode, body: d }));
        })
        .on('error', reject);
    });

  // Invalid from date
  const badFrom = await get('/api/analytics?range=custom&from=nonsense&to=2026-09-24');
  assert.equal(badFrom.status, 400, 'malformed from date is rejected');

  // Out-of-range from date
  const outOfRange = await get('/api/analytics?range=custom&from=2019-01-01&to=2026-09-24');
  assert.equal(outOfRange.status, 400, 'out-of-range from date is rejected');

  // from > to
  const reversed = await get('/api/analytics?range=custom&from=2026-09-24&to=2026-09-18');
  assert.equal(reversed.status, 400, 'reversed range is rejected');

  // Valid range still works
  const ok = await get('/api/analytics?range=custom&from=2026-09-18&to=2026-09-24');
  assert.equal(ok.status, 200, 'valid range is accepted');
});
