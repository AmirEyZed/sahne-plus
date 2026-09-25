// Sahne Plus — donation history store for the Analytics page.
//
// Why this file exists: before Analytics, the application kept no donation history at all. `played.json` stores ids
// only (so a re-synced queue is not shown twice), `recent` is an in-memory list of the last 30 alerts, and the log
// rotates at 5 MB. None of those can answer "how much did I receive this month", so Analytics needs one more
// append-only file. This is the smallest extension that makes the metrics real — no database, no schema migration,
// no change to how donation events flow through the queue.
//
// Shape on disk: one JSON object per line, grouped one file per month, e.g.
//   <data dir>/analytics-2026-09.ndjson
// A line is intentionally flat and short: { id, at, name, amount, currency, toman, rate, kind, source, tags, test, played }
// `test` marks a test/preview alert: it is stored (so the history is complete) but the engine excludes it from the
// page unless the caller explicitly asks for it.
// The month file is derived from the local calendar date of the event (see analytics.js for the timezone rules).
//
// Growth is bounded on two axes:
//   * at most MAX_PER_DAY lines per local day (a flood or a bug cannot fill the disk);
//   * only the newest KEEP_DETAIL_MONTHS months stay detailed. Older months are rolled up into a per-month summary
//     that keeps the totals, the per-day series and the donor count, then the detailed file is removed.
// Rolling up therefore trades per-donor detail of old months for a bounded file count, and the analytics payload
// says so in its `notes` so the UI never presents an aggregated number as if it were a precise one.
'use strict';
const fs = require('fs');
const path = require('path');
const { dateKey, parseTimestamp } = require('./analytics');

const KEEP_DETAIL_MONTHS = 3; // "today" and the last few months stay detailed for exact metrics
const MAX_RECORDS = 20000; // hard ceiling for a single query, keeps the UI responsive on huge histories
const MAX_PER_DAY = 5000; // a single local day can never store more than this many events
const MAX_DONORS = 20000; // bound for the donor index (name → first seen)
const FILE_PREFIX = 'analytics-';
const DONOR_FILE = 'analytics-donors.json';
const ROLLUP_DIR = 'analytics-rollup';
const APPEND_DEBOUNCE_MS = 400;

/**
 * @param {string} dataDir  the application data directory (Documents\Sahne Plus)
 * @param {object} [opts]   { tz: minutes east of UTC, now: () => ms } — injectable for tests
 */
function createAnalyticsStore(dataDir, opts = {}) {
  const tz = Number.isFinite(opts.tz) ? opts.tz : 0;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const rollupDir = path.join(dataDir, ROLLUP_DIR);
  const donorFile = path.join(dataDir, DONOR_FILE);
  const monthFile = month => path.join(dataDir, `${FILE_PREFIX}${month}.ndjson`);
  let pending = [];
  let flushTimer = null;
  let droppedToday = 0;
  let lastRollupMonth = null;
  let donorFirstSeen = null; // Map<name, firstAt ms> — survives rollup, so "new vs returning" stays correct

  const monthOfDay = day => day.slice(0, 7); // "2026-09-24" -> "2026-09"

  /** The first instant of the local month "YYYY-MM". */
  function startOfMonth(monthKey) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(monthKey || ''));
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, 1) - tz * 60000;
  }
  /** The first instant of the local month after "YYYY-MM". */
  function startOfNextMonth(monthKey) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(monthKey || ''));
    if (!m) return null;
    return Date.UTC(+m[1], +m[2], 1) - tz * 60000; // the month field is 0-based, so +m[2] is already the next month
  }

  function ensureRollupDir() {
    try {
      fs.mkdirSync(rollupDir, { recursive: true });
    } catch {}
  }

  /**
   * Record one donation event. Never throws: a history write must not be able to break the alert pipeline.
   * @param {object} e  { id, at, name, amount, currency, toman, rate, kind, source, tags, test, played, count }
   * @returns {boolean} true when the event was accepted for storage
   */
  function record(e) {
    if (!config.writable) return false;
    try {
      if (!e || typeof e !== 'object') return false;
      const id = String(e.id || '').trim();
      if (!id) return false;
      const at = Number.isFinite(e.at) ? e.at : dateFromAny(e.at) || now();
      const amount = Number(e.amount);
      if (!Number.isFinite(amount) || amount <= 0) return false; // zero/negative events are not donations
      const day = dateKey(at, tz);
      if (countFor(day) >= MAX_PER_DAY) {
        droppedToday++;
        config.dropped += 1;
        return false;
      }
      pending.push({
        id,
        at,
        day,
        name: String(e.name || '').slice(0, 80),
        amount: Math.round(amount * 100) / 100,
        currency: /^[A-Za-z]{3}$/.test(String(e.currency || '')) ? String(e.currency).toUpperCase() : 'USD',
        toman: Number.isFinite(e.toman) && e.toman > 0 ? Math.round(e.toman) : null,
        rate: Number.isFinite(e.rate) && e.rate > 0 ? Math.round(e.rate) : null,
        kind: ['tip', 'sub', 'gift'].includes(e.kind) ? e.kind : 'tip',
        source: String(e.source || 'other').slice(0, 24),
        count: Number.isFinite(e.count) ? e.count : null,
        tags: Array.isArray(e.tags) ? e.tags.slice(0, 8).map(t => String(t).slice(0, 24)) : [],
        test: !!e.test,
        played: e.played === undefined ? null : !!e.played
      });
      config.written += 1;
      pendingByDay.set(day, (pendingByDay.get(day) || 0) + 1);
      schedule();
      return true;
    } catch {
      return false;
    }
  }

  /** Update the alert outcome of an already recorded event (a tip can be skipped after it was recorded). */
  function markOutcome(id, played) {
    try {
      const key = String(id || '');
      if (!key) return false;
      for (const rec of pending)
        if (rec.id === key) {
          rec.played = !!played;
          return true;
        }
      return patchOnDisk(key, !!played);
    } catch {
      return false;
    }
  }

  /** Rewrite the single line of `id` with the new outcome. O(file size), and only called for skipped alerts. */
  function patchOnDisk(id, played) {
    const dirs = recentMonthFiles();
    for (const file of dirs) {
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (!text.includes(`"${id}"`)) continue;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes(`"${id}"`)) continue;
        try {
          const rec = JSON.parse(lines[i]);
          rec.played = played;
          lines[i] = JSON.stringify(rec);
        } catch {}
      }
      try {
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, lines.join('\n'));
        fs.renameSync(tmp, file);
      } catch {}
      cache = null; // the patched line is no longer what a memoized read holds
      return true;
    }
    return false;
  }

  let perDay = null;
  // Events accepted but not yet written. `perDay` only reflects what is on disk (it is rebuilt by load()), so a
  // burst that arrives between two flushes has to be counted from the pending queue as well — otherwise the
  // per-day cap would never fire for a flood that all lands inside one debounce window.
  const pendingByDay = new Map();
  /**
   * The per-day counts that are already on disk. `perDay` is built by load(), which nothing may have called yet on a
   * fresh start (opening the page is what triggers it), and every rollup/clear drops it. Rebuilding it on demand is
   * what makes the cap hold across a restart and after a rollup: otherwise a day whose lines were written in an
   * earlier run would accept another full MAX_PER_DAY, doubling the promised ceiling. load() is memoized, so this
   * costs one parse of the history, not one per record.
   */
  function ensurePerDay() {
    if (!perDay) load();
    return perDay;
  }

  function countFor(day) {
    const counts = ensurePerDay();
    return (counts ? counts.get(day) || 0 : 0) + (pendingByDay.get(day) || 0);
  }

  function schedule() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, APPEND_DEBOUNCE_MS);
    if (flushTimer.unref) flushTimer.unref();
  }

  function flush() {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    // The batch leaves the pending queue wholesale; what actually reached `perDay` is re-added per successful write
    // below, so the cap still sees the events that are already on disk.
    for (const rec of batch) {
      const n = (pendingByDay.get(rec.day) || 0) - 1;
      if (n > 0) pendingByDay.set(rec.day, n);
      else pendingByDay.delete(rec.day);
    }
    const byMonth = new Map();
    for (const rec of batch) {
      const month = monthOfDay(rec.day);
      if (!byMonth.has(month)) byMonth.set(month, []);
      byMonth.get(month).push(rec);
    }
    // Snapshot the on-disk counts BEFORE writing this batch: load() reads the files, so doing it after the append
    // would already see these lines and then re-add them below, double-counting the whole batch against the cap.
    const counts = ensurePerDay() || (perDay = new Map());
    for (const [month, recs] of byMonth) {
      const file = monthFile(month);
      try {
        if (!fs.existsSync(file)) ensureRollupDir(); // the data dir itself is created by the server
        fs.appendFileSync(
          file,
          recs
            .map(r =>
              JSON.stringify({
                id: r.id,
                at: r.at,
                day: r.day,
                name: r.name,
                amount: r.amount,
                currency: r.currency,
                toman: r.toman,
                rate: r.rate,
                kind: r.kind,
                source: r.source,
                count: r.count,
                tags: r.tags,
                test: r.test,
                played: r.played
              })
            )
            .join('\n') + '\n'
        );
        // The events are on disk now, so the counts must include them even when nothing had read the history yet:
        // a cap that forgets them would let each debounce window add another full MAX_PER_DAY.
        for (const r of recs) counts.set(r.day, (counts.get(r.day) || 0) + 1);
      } catch {}
    }
    // New bytes landed on disk, so any memoized read is now behind. (perDay stays warm.)
    cache = null;
  }

  // ---------------------------------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------------------------------

  const config = { writable: true, written: 0, dropped: 0 };
  let rolledUpTo = null;
  let cache = null;

  /** All month files that still hold detailed data, oldest first. */
  function recentMonthFiles() {
    let names = [];
    try {
      names = fs
        .readdirSync(dataDir)
        .filter(n => n.startsWith(FILE_PREFIX) && n.endsWith('.ndjson'))
        .map(n => n.slice(FILE_PREFIX.length, -'.ndjson'.length))
        .filter(n => /^\d{4}-\d{2}$/.test(n))
        .sort();
    } catch {}
    return names.map(monthFile);
  }

  function readLines(file) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    const out = [];
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        out.push(JSON.parse(s));
      } catch {} // a torn last line from an interrupted write is skipped, not fatal
    }
    return out;
  }

  /** Rolled-up summaries for months whose detail has been dropped, oldest first. */
  function readRollups() {
    const out = [];
    let names = [];
    try {
      names = fs.readdirSync(rollupDir).filter(n => /^\d{4}-\d{2}\.json$/.test(n));
    } catch {
      return out;
    }
    names.sort();
    for (const n of names) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(rollupDir, n), 'utf8'));
        if (j && j.month && j.days) out.push(j);
      } catch {}
    }
    return out;
  }

  function donors() {
    if (donorFirstSeen) return donorFirstSeen;
    donorFirstSeen = new Map();
    try {
      const raw = JSON.parse(fs.readFileSync(donorFile, 'utf8'));
      if (raw && typeof raw === 'object')
        for (const name of Object.keys(raw)) {
          const at = Number(raw[name]);
          if (Number.isFinite(at) && at > 0) donorFirstSeen.set(name, at);
        }
    } catch {}
    return donorFirstSeen;
  }

  /** First time each donor name was ever recorded. Bounded by MAX_DONORS (oldest entries are dropped last). */
  function rememberDonor(name, at) {
    if (!name || !Number.isFinite(at)) return;
    const map = donors();
    const prev = map.get(name);
    if (prev !== undefined && prev <= at) return;
    map.set(name, at);
    if (map.size > MAX_DONORS) {
      // drop the newest first-seen entries: the oldest donors are the ones that keep "returning" accurate
      const entries = [...map.entries()].sort((a, b) => a[1] - b[1]).slice(0, MAX_DONORS);
      donorFirstSeen = new Map(entries);
    }
    saveDonorsSoon();
  }

  let donorSaveT = null;
  function saveDonorsSoon() {
    if (donorSaveT) return;
    donorSaveT = setTimeout(() => {
      donorSaveT = null;
      saveDonorsNow();
    }, APPEND_DEBOUNCE_MS);
    if (donorSaveT.unref) donorSaveT.unref();
  }

  /** Write the index immediately. Used after a rollup: the detail it summarised is already gone, so the index that
   *  still knows about those donors must not be sitting in a debounce window if the process exits. */
  function saveDonorsNow() {
    clearTimeout(donorSaveT);
    donorSaveT = null;
    try {
      fs.writeFileSync(donorFile, JSON.stringify(Object.fromEntries(donors())));
    } catch {}
  }

  /** Rebuild the donor index from the stored detail; called once after a rollup removed old detail. */
  function rebuildDonors() {
    const map = new Map();
    // load().items are the raw stored records, which carry the instant under `at` (not the normalized `ts` the engine
    // uses). Reading `ts` here silently wrote undefined first-seen values and emptied the index.
    for (const it of load().items) {
      const at = Number.isFinite(it.at) ? it.at : null;
      if (at === null || !it.name) continue;
      const prev = map.get(it.name);
      if (prev === undefined || at < prev) map.set(it.name, at);
    }
    // keep any first-seen that is older than what the remaining detail shows (that is the whole point of the index)
    for (const [name, at] of donors()) {
      const cur = map.get(name);
      if (cur === undefined || at < cur) map.set(name, at);
    }
    donorFirstSeen = map;
    saveDonorsNow();
  }

  /**
   * Load everything Analytics needs.
   * @returns {{ items: object[], months: object[], coverage: object }}
   */
  function load() {
    if (cache) return cache;
    const files = recentMonthFiles();
    let items = [];
    for (const file of files) items.push(...readLines(file));
    // oldest → newest so that when we trim, the newest events survive
    items.sort((a, b) => (a.at || 0) - (b.at || 0));
    const truncated = items.length > MAX_RECORDS;
    if (truncated) items = items.slice(-MAX_RECORDS);

    perDay = new Map();
    let firstAt = null;
    for (const it of items) {
      const day = it.day || (it.at ? dateKey(it.at, tz) : null);
      if (!day) continue;
      perDay.set(day, (perDay.get(day) || 0) + 1);
      if (firstAt === null || it.at < firstAt) firstAt = it.at;
      rememberDonor(it.name, it.at);
    }

    const months = readRollups();
    // `rolledFrom` is the oldest record that was summarised (what the payload has always reported). The window
    // [rolledWindowFrom, rolledWindowTo) is what the summaries actually cover, month-aligned, and is what a caller
    // checks a range against: the donations in it are not in the detail and cannot appear in any bucket.
    const rolledFrom = months.length ? months[0].from : null;
    const rolledWindowFrom = months.length ? startOfMonth(months[0].month) : null;
    const rolledWindowTo = months.length ? startOfNextMonth(months[months.length - 1].month) : null;
    const coverage = {
      from: firstAt !== null ? new Date(firstAt).toISOString() : null,
      to: items.length ? new Date(items[items.length - 1].at).toISOString() : null,
      events: items.length,
      truncated,
      rolledMonths: months.length,
      rolledFrom,
      rolledWindowFrom,
      rolledWindowTo,
      detailMonths: files.length,
      droppedToday,
      dropped: config.dropped
    };
    cache = { items, months, coverage };
    return cache;
  }

  /** Invalidate the read cache (called after a rollup or when the file list changes). */
  function invalidate() {
    cache = null;
    perDay = null;
  }

  // ---------------------------------------------------------------------------------------------
  // Rollup — bound the on-disk size without losing the shape of the history
  // ---------------------------------------------------------------------------------------------

  /** Summarize every month older than KEEP_DETAIL_MONTHS into one JSON file, then delete its detail. */
  function rollup(force = false) {
    const currentMonth = monthOfDay(dateKey(now(), tz));
    if (!force && rolledUpTo === currentMonth) return;
    rolledUpTo = currentMonth;
    const files = recentMonthFiles();
    // Anchored to the calendar, not to the newest files: "the last three months" must mean three months, so a history
    // that happens to hold only old months still collapses instead of being kept in full forever. Anchoring to the
    // file list made KEEP_DETAIL_MONTHS a no-op whenever fewer months existed than the limit.
    const keep = new Set();
    const anchor = new Date(now() + tz * 60000);
    for (let i = 0; i < KEEP_DETAIL_MONTHS; i++) {
      const first = Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - i, 1) - tz * 60000;
      keep.add(monthOfDay(dateKey(first, tz)));
    }
    for (const file of files) {
      const month = path.basename(file).slice(FILE_PREFIX.length, -'.ndjson'.length);
      if (keep.has(month)) continue;
      const recs = readLines(file).filter(r => r && r.id && Number.isFinite(r.at));
      if (!recs.length) {
        try {
          fs.unlinkSync(file);
        } catch {}
        continue;
      }
      const days = {};
      const donors = new Set();
      const kinds = {};
      const sources = {};
      let usd = 0;
      let toman = 0;
      let oldest = Infinity;
      let newest = -Infinity;
      let tests = 0;
      for (const r of recs) {
        // A test/preview alert is stored for completeness but is not a donation, exactly as the detailed path treats
        // it (normalizeItem marks it and the engine filters it). Counting it here would make a rolled-up month show
        // money that the same month showed without while its detail still existed.
        if (r.test) {
          tests++;
          continue;
        }
        const day = r.day || dateKey(r.at, tz);
        const d = days[day] || { count: 0, usd: 0, toman: 0 };
        d.count++;
        if (r.currency === 'USD' && Number.isFinite(r.amount)) {
          d.usd += r.amount;
          usd += r.amount;
        }
        if (Number.isFinite(r.toman) && r.toman > 0) {
          d.toman += r.toman;
          toman += r.toman;
        }
        days[day] = d;
        if (r.name) donors.add(r.name);
        kinds[r.kind || 'tip'] = (kinds[r.kind || 'tip'] || 0) + 1;
        sources[r.source || 'other'] = (sources[r.source || 'other'] || 0) + 1;
        if (r.at < oldest) oldest = r.at;
        if (r.at > newest) newest = r.at;
      }
      if (oldest === Infinity) {
        // only test records in this month: nothing to summarise
        try {
          fs.unlinkSync(file);
        } catch {}
        continue;
      }
      for (const day of Object.keys(days)) {
        days[day].usd = Math.round(days[day].usd * 100) / 100;
        days[day].toman = Math.round(days[day].toman);
      }
      const summary = {
        month,
        from: new Date(oldest).toISOString(),
        to: new Date(newest).toISOString(),
        count: recs.length - tests,
        usd: Math.round(usd * 100) / 100,
        toman: Math.round(toman),
        donors: donors.size,
        days,
        kinds,
        sources,
        tests
      };
      try {
        ensureRollupDir();
        const out = path.join(rollupDir, month + '.json');
        const tmp = out + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(summary));
        fs.renameSync(tmp, out);
        fs.unlinkSync(file); // only after the summary is safely on disk
      } catch {}
    }
    invalidate();
    rebuildDonors(); // the removed detail is gone; the index has to be re-derived from what is left
  }

  /** Remove every file this store owns (used by "clear application data"). */
  function clear() {
    for (const file of recentMonthFiles()) {
      try {
        fs.unlinkSync(file);
      } catch {}
    }
    try {
      fs.rmSync(rollupDir, { recursive: true, force: true });
    } catch {}
    try {
      fs.unlinkSync(donorFile);
    } catch {}
    pending = [];
    pendingByDay.clear();
    config.dropped = 0;
    droppedToday = 0;
    donorFirstSeen = null;
    invalidate();
  }

  function flushNow() {
    clearTimeout(flushTimer);
    flushTimer = null;
    flush();
  }

  return {
    record,
    markOutcome,
    load,
    rollup,
    clear,
    invalidate,
    flush: flushNow,
    donors,
    donorFile,
    rollupDir,
    monthFile,
    get stats() {
      return {
        written: config.written,
        dropped: config.dropped,
        pending: pending.length,
        files: recentMonthFiles().length,
        rolledMonths: readRollups().length
      };
    },
    // test hooks: let a test drive the clock and force the day cap
    _internals: { monthOfDay, countFor, rollups: readRollups, MAX_PER_DAY, KEEP_DETAIL_MONTHS, MAX_RECORDS }
  };
}

/** Accept either a millisecond instant or an ISO/provider timestamp. */
function dateFromAny(v) {
  return parseTimestamp(v);
}

module.exports = { createAnalyticsStore, KEEP_DETAIL_MONTHS, MAX_RECORDS, MAX_PER_DAY, FILE_PREFIX, ROLLUP_DIR };
