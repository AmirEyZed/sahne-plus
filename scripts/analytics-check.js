// One-off helper for eyeballing the Analytics engine without launching the app.
// Usage: node scripts/analytics-check.js
'use strict';
const A = require('../server/analytics');
const { createAnalyticsStore } = require('../server/analytics-store');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TZ = 210; // Asia/Tehran (UTC+03:30), the audience the app is built for
const now = Date.parse('2026-09-24T18:00:00Z');

const items = [
  { id: 'a1', ts: '2026-09-24T05:00:00Z', name: 'Ali', amount: 50, currency: 'USD', toman: 62500000, kind: 'tip', source: 'kickbot', played: true },
  { id: 'a2', ts: '2026-09-24T05:30:00Z', name: 'Sara', amount: 5, currency: 'USD', toman: 6250000, kind: 'tip', source: 'kickbot', played: true },
  { id: 'a3', ts: '2026-09-23T19:00:00Z', name: 'Ali', amount: 12, currency: 'USD', toman: 15000000, kind: 'tip', source: 'streamelements', played: true },
  { id: 'a4', ts: '2026-09-22T19:00:00Z', name: 'Reza', amount: 5, currency: 'EUR', toman: 12500000, kind: 'sub', source: 'kick', played: false },
  { id: 'a5', ts: '2026-09-22T19:00:00Z', name: 'Ali', amount: 5, currency: 'USD', toman: 6250000, kind: 'tip', source: 'kickbot', played: true }, // duplicate id of a3's donor, not of a3
  { id: 'a4', ts: '2026-09-22T19:00:00Z', name: 'Reza', amount: 5, currency: 'EUR', toman: 12500000, kind: 'sub', source: 'kick', played: false }, // exact duplicate id
  { id: 'x1', ts: 'not-a-date', name: 'Ghost', amount: 9, currency: 'USD', kind: 'tip', source: 'kickbot' },
  { id: 'x2', ts: '2026-09-24T06:00:00Z', name: 'Bad', amount: -3, currency: 'USD', kind: 'tip', source: 'kickbot' }
];

const r = A.computeAnalytics(items, { range: 'today', now, tz: TZ, rate: { value: 1250000, source: 'baha24' } });
console.log('range      ', r.range.key, r.range.granularity, 'tz', r.range.tzOffsetMin);
console.log('totals     ', JSON.stringify(r.totals, null, 1));
console.log('series     ', r.series.points.map(p => `${p.key} c${p.count} $${p.usd} t${p.toman}`).join('\n            '));
console.log('top donors ', r.topDonors.map(d => `${d.name} ${d.count} $${d.usd} ${d.toman}T`).join(' | '));
console.log('activity   ', JSON.stringify(r.activity.busiestDay), JSON.stringify(r.activity.busiestHour));
console.log('heatmap    ', r.heatmap.available, 'dated', r.heatmap.dated, 'max', r.heatmap.max);
console.log('previous   ', JSON.stringify(r.previous));
console.log('notes      ', r.notes.map(n => n.code + (n.reason ? ':' + n.reason : '') + (n.count ? ':' + n.count : '')).join(', '));
console.log('excluded   ', JSON.stringify(r.excluded));

const week = A.computeAnalytics(items, { range: 'week', now, tz: TZ, rate: { value: 1250000 } });
console.log('\nweek       ', week.range.start, '→', week.range.end, week.range.granularity, 'count', week.totals.count);
const month = A.computeAnalytics(items, { range: 'month', now, tz: TZ, rate: { value: 1250000 } });
console.log('month      ', month.range.start, '→', month.range.end, 'count', month.totals.count, 'perDay', month.totals.perDay);

// store round-trip
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahne-analytics-'));
const store = createAnalyticsStore(dir, { tz: TZ, now: () => now });
for (const it of items.slice(0, 4))
  store.record({ id: it.id, at: A.parseTimestamp(it.ts), name: it.name, amount: it.amount, currency: it.currency, toman: it.toman, kind: it.kind, source: it.source, played: it.played });
store.markOutcome('a1', false);
store.flush();
const loaded = store.load();
console.log('\nstore      ', loaded.items.length, 'items, coverage', JSON.stringify(loaded.coverage));
console.log('files      ', fs.readdirSync(dir).join(', '));
store.rollup(true);
console.log('rollups    ', store.stats.rolledMonths, 'files', fs.readdirSync(dir).join(', '));
fs.rmSync(dir, { recursive: true, force: true });
