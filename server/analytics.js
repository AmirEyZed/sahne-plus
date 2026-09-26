// Sahne Plus — analytics engine.
//
// Pure, dependency-free functions that turn normalized donation events (see analytics-store.js) into the numbers the
// Analytics page shows. Nothing here touches the network, the filesystem or the UI: the same code runs on the server
// (POST /api/analytics) and in the unit tests, with no Electron and no DOM.
//
// Design notes that matter for correctness:
//   * Every boundary (day, week, month) is computed against a FIXED timezone offset in minutes east of UTC, never
//     against the machine's ambient timezone and never by reading a UTC timestamp as local time. The server passes
//     its own offset once, so the browser and the server always agree on where "today" starts.
//   * Weeks start on Saturday and months follow the Persian (Jalali) calendar, matching the Iranian audience the app
//     is built for; both are derived from Intl's `persian` calendar, not from a hand-rolled conversion table.
//   * Items with no usable timestamp are counted but never placed in a time bucket (they would land in the wrong day).
//   * Items with no known Toman value contribute to the counts and to the USD totals but never to the Toman totals,
//     and are reported as `unconverted` instead of being silently treated as zero.
'use strict';

const HOUR_MS = 3600000;
const DAY_MS = 86400000;
const MAX_BUCKETS = 480; // a series never explodes: granularity is coarsened until it fits
const DEFAULT_BUCKET_EDGES = [5, 10, 25, 50, 100]; // USD: <5, 5–10, 10–25, 25–50, 50–100, 100+
const TOP_N = 10;
const MIN_HEATMAP_EVENTS = 8; // below this a heatmap is noise, not insight

const RANGE_KEYS = ['today', 'week', 'month', 'custom'];

// ---------------------------------------------------------------------------------------------
// Calendar helpers — all integer math on a fixed offset, so they are exact and unit-testable.
// ---------------------------------------------------------------------------------------------

const pad2 = n => String(n).padStart(2, '0');

/** Wall-clock fields of an instant, seen from `tz` (minutes east of UTC). */
function localParts(ms, tz) {
  const d = new Date(ms + tz * 60000);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    min: d.getUTCMinutes(),
    dow: d.getUTCDay() // 0 = Sunday … 6 = Saturday
  };
}

/** The instant of a wall-clock time in `tz`. Date.UTC normalizes out-of-range fields (day 32, hour 25, …). */
function fromLocal(y, m, d, h = 0, min = 0, tz = 0) {
  return Date.UTC(y, m - 1, d, h, min, 0, 0) - tz * 60000;
}

function startOfDay(ms, tz) {
  const p = localParts(ms, tz);
  return fromLocal(p.y, p.m, p.d, 0, 0, tz);
}

function startOfNextDay(ms, tz) {
  const p = localParts(ms, tz);
  return fromLocal(p.y, p.m, p.d + 1, 0, 0, tz);
}

/** Saturday-anchored week start. */
function startOfWeek(ms, tz) {
  const p = localParts(ms, tz);
  const since = (p.dow + 1) % 7; // Saturday → 0, Sunday → 1, … Friday → 6
  return startOfDay(ms - since * DAY_MS, tz);
}

const dateKey = (ms, tz) => {
  const p = localParts(ms, tz);
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
};

const hourKey = (ms, tz) => `${dateKey(ms, tz)}T${pad2(localParts(ms, tz).h)}`;

// Persian calendar via Intl (bundled with Node and Electron; no conversion table to get wrong).
const JALALI_FMT = new Intl.DateTimeFormat('en-US-u-ca-persian', {
  timeZone: 'UTC',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric'
});
let jalaliOk = true;
try {
  JALALI_FMT.formatToParts(new Date(0));
} catch {
  jalaliOk = false; // an exotic build without the persian calendar falls back to Gregorian months
}

function jalaliParts(ms, tz) {
  const shifted = new Date(ms + tz * 60000);
  const out = {};
  for (const part of JALALI_FMT.formatToParts(shifted))
    if (part.type === 'year' || part.type === 'month' || part.type === 'day') out[part.type] = Number(part.value);
  return { jy: out.year, jm: out.month, jd: out.day };
}

/** First instant of the Persian month containing `ms`. Walks at most 31 days back; no table lookup. */
function startOfJalaliMonth(ms, tz) {
  if (!jalaliOk) {
    const p = localParts(ms, tz);
    return fromLocal(p.y, p.m, 1, 0, 0, tz);
  }
  let cursor = startOfDay(ms, tz);
  for (let i = 0; i < 40; i++) {
    if (jalaliParts(cursor, tz).jd === 1) return cursor;
    cursor -= DAY_MS;
  }
  return startOfDay(ms, tz); // unreachable for any real date
}

/** First instant of the Persian month before the one containing `ms`. */
function startOfPreviousJalaliMonth(ms, tz) {
  return startOfJalaliMonth(startOfJalaliMonth(ms, tz) - DAY_MS, tz);
}

const jalaliMonthKey = (ms, tz) => {
  if (!jalaliOk) {
    const p = localParts(ms, tz);
    return `${p.y}-${pad2(p.m)}`;
  }
  const j = jalaliParts(ms, tz);
  return `${j.jy}-${pad2(j.jm)}`;
};

// ---------------------------------------------------------------------------------------------
// Item normalization — tolerant readers for everything stored or handed in by tests/providers.
// ---------------------------------------------------------------------------------------------

/**
 * Parse a provider timestamp without ever reading a UTC instant as local time.
 * ISO strings with an explicit zone are trusted; a bare "YYYY-MM-DD HH:MM:SS" is treated as UTC (that is what the
 * donation providers emit); anything unparsable returns null so the caller can flag the item instead of guessing.
 */
function parseTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 0 ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(raw)) {
    const iso = raw.replace(' ', 'T') + 'Z'; // no zone given → provider UTC, never local
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : null;
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

const finiteOrNull = v => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** A donation amount must be a positive, finite number: zero and negative events are dropped, not summed. */
function validAmount(v) {
  const n = finiteOrNull(v);
  return n !== null && n > 0 ? n : null;
}

const VALID_KINDS = { tip: true, sub: true, gift: true };
const VALID_SOURCES = { kickbot: true, streamelements: true, kick: true, other: true };

/**
 * Reduce a stored/injected record to the fields analytics needs, or null when it cannot contribute anything.
 * `invalid` reasons are surfaced by the caller so bad data is visible rather than quietly ignored.
 */
function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return { item: null, reason: 'not-an-object' };
  const id = String(raw.id || raw.stripe_pi_id || '').trim();
  // `at` is the field the history store writes (see analytics-store.js); `ts` is what computeAnalytics is called with
  // directly, and `created_at` is the raw provider field. Without the `at` case every stored record would read as
  // undated and no donation would ever land in a time bucket.
  const ts = parseTimestamp(raw.ts !== undefined ? raw.ts : raw.at !== undefined ? raw.at : raw.created_at);
  const amount = validAmount(raw.amount !== undefined ? raw.amount : (Number(raw.amount_total) || 0) / 100);
  if (!id) return { item: null, reason: 'missing-id' };
  if (amount === null) return { item: null, reason: 'invalid-amount' };
  const currency = /^[A-Za-z]{3}$/.test(String(raw.currency || '')) ? String(raw.currency).toUpperCase() : 'USD';
  const toman = finiteOrNull(raw.toman);
  const kind = VALID_KINDS[String(raw.kind || 'tip')] ? String(raw.kind || 'tip') : 'tip';
  const source = VALID_SOURCES[String(raw.source || '')] ? String(raw.source) : 'other';
  return {
    item: {
      id,
      ts,
      tsFallback: ts === null,
      kind,
      source,
      name: String(raw.name || raw.tipper_name || '').slice(0, 80) || 'ناشناس',
      amount,
      currency,
      toman: toman !== null && toman > 0 ? Math.round(toman) : null,
      rate: finiteOrNull(raw.rate),
      test: !!raw.test,
      preview: !!raw.preview,
      count: finiteOrNull(raw.count),
      played: raw.played === undefined ? null : !!raw.played
    },
    reason: null
  };
}

/** Keep only the last occurrence of a duplicated id (a re-synced provider queue must not double-count). */
function dedupeItems(items) {
  const byId = new Map();
  let duplicates = 0;
  for (const it of items) {
    if (byId.has(it.id)) duplicates++;
    byId.set(it.id, it);
  }
  return { items: [...byId.values()], duplicates };
}

// ---------------------------------------------------------------------------------------------
// Time ranges
// ---------------------------------------------------------------------------------------------

/** Resolve a named range (or a custom pair) into concrete bounds in `tz`. `end` is exclusive. */
function resolveRange(range, { now, tz, from, to, includeTests = false } = {}) {
  const key = RANGE_KEYS.includes(range) ? range : 'today';
  const at = Number.isFinite(now) ? now : Date.now();
  let out;
  if (key === 'custom') {
    const start = startOfDay(parseTimestamp(from) ?? at, tz);
    const rawEnd = parseTimestamp(to) ?? at;
    const endDay = rawEnd < start ? start : rawEnd; // a reversed pair collapses to the `from` day
    const end = startOfNextDay(endDay, tz); // inclusive calendar day, exclusive instant
    out = { key, start, end, granularity: granularityFor(end - start) };
  } else if (key === 'week') {
    out = { key, start: startOfWeek(at, tz), end: at, granularity: 'day' };
  } else if (key === 'month') {
    out = { key, start: startOfJalaliMonth(at, tz), end: at, granularity: 'day' };
  } else {
    out = { key: 'today', start: startOfDay(at, tz), end: at, granularity: 'hour' };
  }
  return { ...out, ...elapsed(out.start, out.end, tz) };
}

/**
 * How much of the range has actually elapsed. Rates ("donations per day") are reported per *calendar day the range
 * touches*, not per fractional day: a single day must not read as "2.23 donations per day".
 */
function elapsed(start, end, tz) {
  const firstDay = startOfDay(start, tz);
  const lastDay = startOfDay(Math.max(end - 1, start), tz);
  const dayCount = Math.round((lastDay - firstDay) / DAY_MS) + 1;
  const spanHours = Math.max((end - start) / HOUR_MS, 1 / 60);
  return { dayCount, spanHours: Math.round(spanHours * 100) / 100 };
}

/** Coarsen the bucket until the series fits MAX_BUCKETS, so a 5-year custom range stays readable. */
function granularityFor(spanMs) {
  const days = spanMs / DAY_MS;
  if (days <= 2) return 'hour';
  if (days <= 70) return 'day';
  if (days <= 400) return 'week';
  return 'month';
}

/** The equally-long window immediately before `range`, used for the previous-period comparison. */
function previousRange(range, tz) {
  const span = range.end - range.start;
  if (range.key === 'month') {
    const start = startOfPreviousJalaliMonth(range.start, tz);
    return { key: 'custom', start, end: start + span };
  }
  if (range.key === 'week') {
    const start = range.start - 7 * DAY_MS;
    return { key: 'custom', start, end: start + span };
  }
  const start = range.start - DAY_MS;
  return { key: 'custom', start, end: start + span };
}

/** Instant → bucket key for a granularity. Weekly keys are the Saturday that opens the week. */
function bucketKeyOf(ms, tz, granularity) {
  if (granularity === 'hour') return hourKey(ms, tz);
  if (granularity === 'week') return dateKey(startOfWeek(ms, tz), tz);
  if (granularity === 'month') return jalaliMonthKey(ms, tz);
  return dateKey(ms, tz);
}

/** Every bucket the range touches, in order, including empty ones (a trend line must not skip quiet days). */
function bucketStarts(start, end, tz, granularity) {
  const out = [];
  let cursor = startOfBucket(start, tz, granularity);
  let guard = 0;
  while (cursor < end && guard++ < MAX_BUCKETS * 4) {
    out.push(cursor);
    cursor = nextBucket(cursor, tz, granularity);
  }
  return out;
}

function startOfBucket(ms, tz, granularity) {
  // An hour bucket is floored to the top of the *local* hour, not the UTC one: for a half-hour offset like Tehran
  // (+03:30) a UTC floor would snap back to the previous local hour and mislabel the first point.
  if (granularity === 'hour') {
    const p = localParts(ms, tz);
    return fromLocal(p.y, p.m, p.d, p.h, 0, tz);
  }
  if (granularity === 'week') return startOfWeek(ms, tz);
  if (granularity === 'month') return startOfJalaliMonth(ms, tz);
  return startOfDay(ms, tz);
}

function nextBucket(ms, tz, granularity) {
  if (granularity === 'hour') return ms + HOUR_MS;
  if (granularity === 'week') return ms + 7 * DAY_MS;
  // A Jalali month is 29–31 days; step from its own start so the cursor can never land inside the month it is
  // already in (which used to stall the walk). The first day of the next month is strictly later than `ms`.
  if (granularity === 'month') return startOfJalaliMonth(startOfNextDay(ms, tz), tz);
  return startOfNextDay(ms, tz);
}

// ---------------------------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------------------------

const sum = arr => arr.reduce((a, b) => a + b, 0);

/** Median of a list of numbers (average of the two middle values for an even count). null when empty. */
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round2(n) {
  return n === null || n === undefined ? null : Math.round(n * 100) / 100;
}

function bucketize(amounts, edges) {
  const labels = [];
  const bounds = [0, ...edges];
  for (let i = 0; i < bounds.length; i++) {
    const lo = bounds[i];
    const hi = i + 1 < bounds.length ? bounds[i + 1] : null;
    labels.push({ from: lo, to: hi, count: 0, usd: 0 });
  }
  for (const a of amounts) {
    let idx = bounds.length - 1;
    for (let i = 0; i < bounds.length; i++) {
      const hi = i + 1 < bounds.length ? bounds[i + 1] : Infinity;
      if (a >= bounds[i] && a < hi) {
        idx = i;
        break;
      }
    }
    labels[idx].count++;
    labels[idx].usd += a;
  }
  return labels.map(b => ({
    ...b,
    label: b.to === null ? `≥$${b.from}` : `$${b.from}–$${b.to}`,
    usd: round2(b.usd)
  }));
}

const share = (part, whole) => (whole > 0 ? Math.round((part / whole) * 10000) / 100 : 0);

// ---------------------------------------------------------------------------------------------
// The aggregation itself
// ---------------------------------------------------------------------------------------------

/**
 * Compute the whole dashboard payload from a set of normalized items.
 *
 * @param {object[]} rawItems            items (already stored; duplicates are tolerated)
 * @param {object}   options
 * @param {'today'|'week'|'month'|'custom'} options.range
 * @param {number}   options.now         reference instant (defaults to Date.now())
 * @param {number}   options.tz          minutes east of UTC used for every boundary
 * @param {string}   [options.from]      custom range start (date or ISO string)
 * @param {string}   [options.to]        custom range end (inclusive calendar day)
 * @param {object}   [options.rate]      { value, manual, source, updatedAt } as the app already reports it
 * @param {object}   [options.coverage]  { from, to, events, truncated, oldestRolledDay }
 * @param {number[]} [options.bucketEdges]
 * @param {boolean}  [options.includeTests] include test/preview events (default: only real donations)
 */
function computeAnalytics(rawItems, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const tz = Number.isFinite(options.tz) ? options.tz : 0;
  const includeTests = !!options.includeTests;
  const edges = Array.isArray(options.bucketEdges) ? options.bucketEdges : DEFAULT_BUCKET_EDGES;
  const range = resolveRange(options.range, {
    now,
    tz,
    from: options.from,
    to: options.to
  });

  const notes = [];
  const reasons = Object.create(null);
  const all = [];
  for (const raw of Array.isArray(rawItems) ? rawItems : []) {
    const { item, reason } = normalizeItem(raw);
    if (!item) {
      reasons[reason] = (reasons[reason] || 0) + 1;
      continue;
    }
    all.push(item);
  }
  const { items: uniqueItems, duplicates } = dedupeItems(all);
  if (duplicates) notes.push({ code: 'duplicates', count: duplicates });

  const kept = uniqueItems.filter(it => includeTests || (!it.test && !it.preview));
  const excluded = uniqueItems.length - kept.length;
  const donorFirstSeen = options.donorFirstSeen instanceof Map ? options.donorFirstSeen : buildFirstSeen(kept);

  const inRange = kept.filter(it => it.ts !== null && it.ts >= range.start && it.ts < range.end);
  const undated = kept.filter(it => it.ts === null).length;
  if (undated) notes.push({ code: 'undated', count: undated });

  const stats = summarize(inRange, { tz, donorFirstSeen, edges });
  const series = buildSeries(inRange, range, tz);
  const heatmap = buildHeatmap(inRange, tz, options.minHeatmapEvents ?? MIN_HEATMAP_EVENTS);
  const topDonors = buildTopDonors(inRange, options.topN || TOP_N);

  // Previous period: same elapsed length, immediately before the range. Null when history does not reach back that
  // far (the UI then hides the comparison instead of inventing a baseline).
  const prev = previousRange(range, tz);
  const previous = computePrevious(kept, prev, { tz, donorFirstSeen, edges, coverage: options.coverage });

  const rate = rateInfo(options.rate);
  // Months older than KEEP_DETAIL_MONTHS are collapsed into per-month summaries and their detail is dropped, so those
  // donations are not in `items` and cannot appear in any bucket. A range that OVERLAPS that summary-only window would
  // otherwise look complete while quietly missing them — the one thing the payload is not allowed to do. Overlap, not
  // "starts before its end": a range entirely inside the detailed months must stay silent.
  if (options.coverage && options.coverage.rolledMonths > 0) {
    const winFrom = options.coverage.rolledWindowFrom;
    const winTo = options.coverage.rolledWindowTo;
    const before = parseTimestamp(winFrom ?? options.coverage.rolledFrom);
    const after = parseTimestamp(winTo);
    if (before !== null && after !== null && range.start < after && range.end > before)
      notes.push({ code: 'rolled-up', count: options.coverage.rolledMonths, from: options.coverage.rolledFrom || null });
  }
  if (!rate.usable && stats.totals.convertedCount === 0 && stats.totals.count > 0)
    notes.push({ code: 'no-rate', count: stats.totals.count });
  if (stats.totals.unconvertedCount > 0) notes.push({ code: 'unconverted', count: stats.totals.unconvertedCount });
  for (const key of Object.keys(reasons)) notes.push({ code: 'bad-data', reason: key, count: reasons[key] });
  if (options.coverage && options.coverage.truncated) notes.push({ code: 'truncated', count: options.coverage.events });

  notes.push({ code: 'no-historic-rate' }); // the conversion always uses the current rate; say so in the UI

  return {
    ok: true,
    generatedAt: new Date(now).toISOString(),
    range: {
      key: range.key,
      start: new Date(range.start).toISOString(),
      end: new Date(range.end).toISOString(),
      startMs: range.start,
      endMs: range.end,
      dayCount: range.dayCount,
      spanHours: range.spanHours,
      granularity: range.granularity,
      tzOffsetMin: tz
    },
    rate,
    coverage: options.coverage || null,
    totals: stats.totals,
    breakdown: stats.breakdown,
    series,
    distribution: bucketize(
      inRange.filter(it => it.currency === 'USD').map(it => it.amount),
      edges
    ),
    topDonors,
    heatmap,
    activity: stats.activity,
    previous,
    sequences: stats.sequences,
    notes,
    excluded: { test: excluded, undated, invalid: sum(Object.values(reasons)), duplicates }
  };
}

function rateInfo(rate) {
  const r = rate && typeof rate === 'object' ? rate : {};
  const value = finiteOrNull(r.manual) > 0 ? Number(r.manual) : finiteOrNull(r.value) || 0;
  return {
    value: value || null,
    manual: finiteOrNull(r.manual) > 0,
    source: r.source || null,
    updatedAt: r.updatedAt || null,
    usable: !!value
  };
}

/** name → first instant they were ever seen (over the whole history handed in), for new-vs-returning donors. */
function buildFirstSeen(items) {
  const map = new Map();
  for (const it of items) {
    if (it.ts === null) continue;
    const prev = map.get(it.name);
    if (prev === undefined || it.ts < prev) map.set(it.name, it.ts);
  }
  return map;
}

function summarize(items, { tz, donorFirstSeen, edges }) {
  const usd = items.filter(it => it.currency === 'USD');
  const tomanItems = items.filter(it => it.toman !== null);
  const amountUsd = sum(usd.map(it => it.amount));
  const amountToman = sum(tomanItems.map(it => it.toman));
  const usdValues = usd.map(it => it.amount);
  const tomanValues = tomanItems.map(it => it.toman);

  const donors = new Map();
  for (const it of items) {
    const d = donors.get(it.name) || { name: it.name, count: 0, usd: 0, toman: 0, last: 0 };
    d.count++;
    if (it.currency === 'USD') d.usd += it.amount;
    if (it.toman !== null) d.toman += it.toman;
    if (it.ts && it.ts > d.last) d.last = it.ts;
    donors.set(it.name, d);
  }
  const donorList = [...donors.values()];
  const repeatDonors = donorList.filter(d => d.count > 1).length;
  let newDonors = 0;
  for (const d of donorList) {
    const first = donorFirstSeen.get(d.name);
    if (first === undefined) continue;
    // "new" means: no donation from this donor is older than the range we are looking at
    const firstInRange = items.some(it => it.name === d.name && it.ts === first);
    if (firstInRange) newDonors++;
  }

  const tomanSorted = [...donorList].filter(d => d.toman > 0).sort((a, b) => b.toman - a.toman);
  const shareOf = n => share(sum(tomanSorted.slice(0, n).map(d => d.toman)), amountToman);

  const largestToman = tomanValues.length ? Math.max(...tomanValues) : null;
  const largestUsd = usdValues.length ? Math.max(...usdValues) : null;
  const biggest = tomanItems.find(it => it.toman === largestToman) || tomanItems[0] || null;

  const activity = buildActivity(items, tz);

  // Gaps between consecutive donations, in minutes — "donation frequency" in the sense a streamer reads it.
  const stamps = items
    .map(it => it.ts)
    .filter(t => t !== null)
    .sort((a, b) => a - b);
  const sequences = buildSequences(stamps, tomanValues);

  return {
    totals: {
      count: items.length,
      uniqueDonors: donorList.length,
      repeatDonors,
      newDonors,
      returningDonors: donorList.length - newDonors,
      usdCount: usd.length,
      convertedCount: tomanItems.length,
      unconvertedCount: items.filter(it => it.toman === null).length,
      amountUsd: round2(amountUsd),
      amountToman: amountToman || null,
      usdEquivalent: null, // filled below when a rate is known
      avgUsd: usd.length ? round2(amountUsd / usd.length) : null,
      avgToman: tomanItems.length ? Math.round(amountToman / tomanItems.length) : null,
      medianUsd: median(usdValues),
      medianToman: median(tomanValues),
      maxUsd: usdValues.length ? round2(Math.max(...usdValues)) : null,
      maxToman: tomanValues.length ? Math.max(...tomanValues) : null,
      minUsd: usdValues.length ? round2(Math.min(...usdValues)) : null,
      minToman: tomanValues.length ? Math.min(...tomanValues) : null,
      largestDonor: biggest ? biggest.name : null,
      largestAt: biggest && biggest.ts ? new Date(biggest.ts).toISOString() : null,
      topShare: { top1: shareOf(1), top5: shareOf(5), top10: shareOf(10) },
      perDay: null, // filled after the range is known, below
      perWeek: null
    },
    breakdown: {
      byCurrency: groupBy(
        items,
        it => it.currency,
        it => it,
        (it, g) => {
          g.count++;
          g.amount = round2((g.amount || 0) + (it.currency === 'USD' ? it.amount : 0));
          g.amountToman = (g.amountToman || 0) + (it.toman || 0);
        }
      ),
      byKind: groupBy(
        items,
        it => it.kind,
        it => it,
        (it, g) => {
          g.count++;
          g.amountToman = (g.amountToman || 0) + (it.toman || 0);
          g.amountUsd = round2((g.amountUsd || 0) + (it.currency === 'USD' ? it.amount : 0));
        }
      ),
      bySource: groupBy(
        items,
        it => it.source,
        it => it,
        (it, g) => {
          g.count++;
          g.amountToman = (g.amountToman || 0) + (it.toman || 0);
          g.amountUsd = round2((g.amountUsd || 0) + (it.currency === 'USD' ? it.amount : 0));
          if (it.played === false) g.skipped++;
          if (it.played !== false) g.played++;
        }
      )
    },
    activity,
    sequences
  };
}

function groupBy(items, keyOf, initOf, add) {
  const map = new Map();
  for (const it of items) {
    const k = keyOf(it);
    const g = map.get(k) || { key: k, count: 0, amount: 0, amountToman: 0, amountUsd: 0, skipped: 0, played: 0 };
    add(it, g);
    map.set(k, g);
  }
  return [...map.values()].sort((a, b) => b.count - a.count || b.amountToman - a.amountToman);
}

function buildActivity(items, tz) {
  const byDay = new Map();
  const byHourPortion = new Array(24).fill(0);
  const tomanByDay = new Map();
  for (const it of items) {
    if (it.ts === null) continue;
    const key = dateKey(it.ts, tz);
    byDay.set(key, (byDay.get(key) || 0) + 1);
    tomanByDay.set(key, (tomanByDay.get(key) || 0) + (it.toman || 0));
    byHourPortion[localParts(it.ts, tz).h]++;
  }
  const pick = (map, cmp) => {
    let best = null;
    for (const [key, value] of map) if (best === null || cmp(value, best.value)) best = { key, value };
    return best;
  };
  const busiestDay = pick(byDay, (v, b) => v > b);
  const richestDay = pick(tomanByDay, (v, b) => v > b);
  let busiestHour = null;
  for (let h = 0; h < 24; h++)
    if (byHourPortion[h] && (!busiestHour || byHourPortion[h] > byHourPortion[busiestHour])) busiestHour = h;
  return {
    busiestDay: busiestDay ? { key: busiestDay.key, count: busiestDay.value } : null,
    richestDay: richestDay && richestDay.value > 0 ? { key: richestDay.key, toman: richestDay.value } : null,
    busiestHour: busiestHour === null ? null : { hour: busiestHour, count: byHourPortion[busiestHour] },
    activeDays: byDay.size,
    byHour: byHourPortion
  };
}

function buildSeries(items, range, tz) {
  // An hourly series covers the whole local day it ends in: the trend is read as a day's shape, with the hours that
  // have not happened yet shown as explicit zeros rather than silently truncated. A range that already ends on a day
  // boundary (today resolves to "now", but a custom range ends at local midnight) is left alone, so a one-day custom
  // range stays 24 points instead of gaining a second day of zeros.
  let seriesEnd = range.end;
  if (range.granularity === 'hour' && startOfDay(range.end, tz) !== range.end) seriesEnd = startOfNextDay(range.end, tz);
  const starts = bucketStarts(range.start, seriesEnd, tz, range.granularity);
  const byKey = new Map();
  for (const it of items) {
    if (it.ts === null) continue;
    const key = bucketKeyOf(it.ts, tz, range.granularity);
    const b = byKey.get(key) || { count: 0, usd: 0, toman: 0, converted: 0 };
    b.count++;
    if (it.currency === 'USD') b.usd += it.amount;
    if (it.toman !== null) {
      b.toman += it.toman;
      b.converted++;
    }
    byKey.set(key, b);
  }
  return {
    granularity: range.granularity,
    points: starts.map(startMs => {
      const key = bucketKeyOf(startMs, tz, range.granularity);
      const b = byKey.get(key) || { count: 0, usd: 0, toman: 0, converted: 0 };
      return {
        key,
        startMs,
        start: new Date(startMs).toISOString(),
        count: b.count,
        usd: round2(b.usd),
        toman: b.toman,
        converted: b.converted
      };
    })
  };
}

function buildTopDonors(items, topN) {
  const map = new Map();
  for (const it of items) {
    const d = map.get(it.name) || { name: it.name, count: 0, usd: 0, toman: 0, converted: 0, largest: 0, last: 0 };
    d.count++;
    if (it.currency === 'USD') d.usd += it.amount;
    if (it.toman !== null) d.toman += it.toman;
    d.largest = Math.max(d.largest, it.toman || it.amount);
    if (it.ts && it.ts > d.last) d.last = it.ts;
    map.set(it.name, d);
  }
  return [...map.values()]
    .sort((a, b) => b.toman - a.toman || b.usd - a.usd || b.count - a.count)
    .slice(0, topN)
    .map(d => ({
      name: d.name,
      count: d.count,
      usd: round2(d.usd),
      toman: d.toman || null,
      avgUsd: round2(d.usd / d.count),
      avgToman: d.toman ? Math.round(d.toman / d.count) : null,
      largest: d.largest,
      last: d.last ? new Date(d.last).toISOString() : null
    }));
}

function buildSequences(stamps, amountToman) {
  const gaps = [];
  for (let i = 1; i < stamps.length; i++) gaps.push((stamps[i] - stamps[i - 1]) / 60000);
  const medianGap = median(gaps);
  const spanMs = stamps.length > 1 ? stamps[stamps.length - 1] - stamps[0] : 0;
  const medianToman = median(amountToman);
  return {
    gapCount: gaps.length,
    medianGapMin: medianGap === null ? null : Math.round(medianGap * 10) / 10,
    medianToman: medianToman === null ? null : Math.round(medianToman),
    // donations per active hour: a rate the streamer can act on, not a raw gap
    perHour: spanMs > 0 ? Math.round((stamps.length / (spanMs / HOUR_MS)) * 100) / 100 : null,
    spanHours: spanMs > 0 ? Math.round((spanMs / HOUR_MS) * 10) / 10 : null
  };
}

function buildHeatmap(items, tz, minEvents) {
  const cells = Array.from({ length: 7 }, () => new Array(24).fill(0));
  let dated = 0;
  for (const it of items) {
    if (it.ts === null) continue;
    const p = localParts(it.ts, tz);
    cells[(p.dow + 1) % 7][p.h]++; // row 0 = Saturday, matching the Iranian week
    dated++;
  }
  const max = Math.max(0, ...cells.flat());
  return {
    // A heatmap over a handful of donations is a random pattern presented as insight: report it as unavailable.
    available: dated >= minEvents && max > 0,
    minEvents,
    dated,
    max,
    cells,
    days: ['شنبه', 'یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه']
  };
}

function computePrevious(kept, prev, { tz, coverage }) {
  if (coverage && coverage.from) {
    const coveredFrom = parseTimestamp(coverage.from);
    if (coveredFrom !== null && coveredFrom > prev.start) return null; // history does not reach the previous window
  }
  const items = kept.filter(it => it.ts !== null && it.ts >= prev.start && it.ts < prev.end);
  if (!items.length) return null;
  const amountToman = sum(items.filter(it => it.toman !== null).map(it => it.toman));
  const amountUsd = sum(items.filter(it => it.currency === 'USD').map(it => it.amount));
  return {
    range: { start: new Date(prev.start).toISOString(), end: new Date(prev.end).toISOString() },
    count: items.length,
    amountUsd: round2(amountUsd),
    amountToman: amountToman || null,
    uniqueDonors: new Set(items.map(it => it.name)).size
  };
}

/** Attach per-day/per-week rates that depend on the range length. */
function withRates(result) {
  const days = Math.max(result.range.dayCount || 1, 1);
  const t = result.totals;
  t.perDay = t.count ? Math.round((t.count / days) * 100) / 100 : 0;
  t.perWeek = t.count ? Math.round((t.count / (days / 7)) * 100) / 100 : 0;
  t.tomanPerDay = t.amountToman ? Math.round(t.amountToman / days) : null;
  if (result.rate && result.rate.value && t.amountToman) t.usdEquivalent = round2(t.amountToman / result.rate.value);
  else if (result.rate && result.rate.value && t.amountUsd) t.usdEquivalent = round2(t.amountUsd);
  return result;
}

module.exports = {
  computeAnalytics: (items, options) => withRates(computeAnalytics(items, options)),
  // exported for tests and for the store, which uses the same calendar rules
  resolveRange,
  previousRange,
  granularityFor,
  startOfDay,
  startOfNextDay,
  startOfWeek,
  startOfJalaliMonth,
  startOfPreviousJalaliMonth,
  jalaliMonthKey,
  dateKey,
  hourKey,
  localParts,
  parseTimestamp,
  normalizeItem,
  dedupeItems,
  buildFirstSeen,
  median,
  bucketize,
  DEFAULT_BUCKET_EDGES,
  MAX_BUCKETS,
  MIN_HEATMAP_EVENTS
};
