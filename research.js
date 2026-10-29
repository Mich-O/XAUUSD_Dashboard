'use strict';
/* ==========================================================================
   research.js  (server side)
   --------------------------------------------------------------------------
   Powers the Research page. It does four jobs:

     1. STORE    Keeps OHLC bars (open, high, low, close) for XAUUSD spot and
                 COMEX gold futures in memory, backed by CSV files in /data.
     2. WINDOW   Keeps a rolling window: once the data spans more than
                 5 years + 2 months, the oldest bars are trimmed so it spans
                 5 years again.
     3. REFRESH  Pulls the latest bars from Yahoo Finance (on start, then
                 every 3 hours, or on demand) and merges them in.
     4. QUERY    Replays every past session of a time window and returns, per
                 session, how far price travelled up and down from its start.

   Wire it into server.js AFTER the login gate and BEFORE express.static:
       require("./research")(app);

   Load years of history once from a CSV (see the CLI at the bottom):
       node research.js import xau path/to/xauusd_h1.csv

   Uses Node built-ins only, so no new dependencies are needed.
   ========================================================================== */

const fs = require('fs');
const path = require('path');
const https = require('https');

/* ---------- 1. Configuration ------------------------------------------- */

const DATA_DIR = path.join(__dirname, 'data');
const MINUTE = 60000;
const DAY = 86400000;

// Rolling window rule: when span > KEEP_MAX, trim back to KEEP.
const KEEP = Math.round(5 * 365.25 * DAY);   // 5 years
const KEEP_MAX = KEEP + 61 * DAY;            // 5 years + about 2 months

// The two instruments. `sym` is the Yahoo Finance symbol used for refreshes.
const INSTRUMENTS = {
  xau: { file: 'xauusd.csv', sym: 'XAUUSD=X', name: 'XAUUSD spot' },
  gc:  { file: 'gc.csv',     sym: 'GC=F',     name: 'COMEX gold futures' }
};

/* ---------- 2. In-memory store ----------------------------------------- */

// One entry per instrument. Bars are kept as parallel arrays sorted by time:
//   t[i] = bar start (UTC ms), o/h/l/c[i] = open/high/low/close.
// `step` is the bar length in ms (detected from the data).
const store = {};
for (const k in INSTRUMENTS) {
  store[k] = { t: new Float64Array(0), o: [], h: [], l: [], c: [], step: 0, refreshed: null, err: null };
}

/* ---------- 3. CSV parsing --------------------------------------------- */

// Turns many timestamp styles into UTC milliseconds:
//   1700000000 (seconds), 1700000000000 (ms), "2024-01-15 10:00:00",
//   "2024-01-15T10:00:00Z", "15.01.2024 10:00:00" (Dukascopy style).
// Timestamps without a time zone are treated as UTC.
function parseTime(v) {
  v = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(v)) { const n = +v; return n < 1e11 ? n * 1000 : n; }
  const m = v.match(/^(\d\d)\.(\d\d)\.(\d{4}) (\d\d):(\d\d):(\d\d)/);
  if (m) return Date.UTC(+m[3], m[2] - 1, +m[1], +m[4], +m[5], +m[6]);
  if (!/[zZ]|[+-]\d\d:?\d\d$/.test(v)) v = v.replace(' ', 'T') + 'Z';
  return Date.parse(v);
}

// Reads a CSV with a header row naming time, open, high, low and close
// (any order, any of , ; or tab as separator). Returns [[t,o,h,l,c], ...].
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error('CSV has no rows');
  const sep = [',', ';', '\t'].sort((a, b) => lines[0].split(b).length - lines[0].split(a).length)[0];
  const head = lines[0].toLowerCase().split(sep).map(s => s.replace(/["']/g, '').trim());
  const col = re => head.findIndex(x => re.test(x));
  const [iT, iO, iH, iL, iC] = [col(/time|date|stamp/), col(/^open/), col(/^high/), col(/^low/), col(/^close/)];
  if ([iT, iO, iH, iL, iC].some(i => i < 0)) throw new Error('Header must name time, open, high, low, close');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(sep);
    const r = [parseTime(p[iT]), +p[iO], +p[iH], +p[iL], +p[iC]];
    if (r.every(Number.isFinite) && r[0] > 0) rows.push(r);   // skip malformed lines
  }
  return rows;
}

/* ---------- 4. Merging, rolling window and persistence ----------------- */

// Adds rows to an instrument. Same timestamp = newer row wins, so repeated
// imports and refreshes never create duplicates. Applies the rolling-window
// trim and re-detects the bar length. Returns how many new bars were added.
function merge(k, rows) {
  const s = store[k], bars = new Map();
  for (let i = 0; i < s.t.length; i++) bars.set(s.t[i], [s.o[i], s.h[i], s.l[i], s.c[i]]);
  const before = bars.size;
  for (const r of rows) bars.set(r[0], r.slice(1));

  let times = [...bars.keys()].sort((a, b) => a - b);
  if (times.length && times[times.length - 1] - times[0] > KEEP_MAX) {
    const cutoff = times[times.length - 1] - KEEP;           // back to 5 years
    times = times.filter(t => t >= cutoff);
  }

  s.t = Float64Array.from(times);
  s.o = times.map(t => bars.get(t)[0]);
  s.h = times.map(t => bars.get(t)[1]);
  s.l = times.map(t => bars.get(t)[2]);
  s.c = times.map(t => bars.get(t)[3]);

  // Bar length = median gap between the last 1000 bars (ignores weekend gaps).
  const gaps = [], tail = times.slice(-1000);
  for (let i = 1; i < tail.length; i++) gaps.push(tail[i] - tail[i - 1]);
  gaps.sort((a, b) => a - b);
  s.step = gaps.length ? gaps[gaps.length >> 1] : 0;
  return Math.max(0, bars.size - before);
}

// Writes the instrument's bars to data/<file>.csv (best effort: on hosts with
// a temporary disk the file is rebuilt from the committed copy on restart).
function save(k) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const s = store[k], out = ['time,open,high,low,close'];
    for (let i = 0; i < s.t.length; i++) {
      out.push(`${new Date(s.t[i]).toISOString()},${s.o[i]},${s.h[i]},${s.l[i]},${s.c[i]}`);
    }
    fs.writeFileSync(path.join(DATA_DIR, INSTRUMENTS[k].file), out.join('\n'));
  } catch (e) { store[k].err = 'save: ' + e.message; }
}

// Loads data/<file>.csv into memory if it exists.
function load(k) {
  const file = path.join(DATA_DIR, INSTRUMENTS[k].file);
  if (!fs.existsSync(file)) return;
  try { merge(k, parseCSV(fs.readFileSync(file, 'utf8'))); }
  catch (e) { store[k].err = 'load: ' + e.message; }
}

/* ---------- 5. Refresh from Yahoo Finance ------------------------------ */

function getJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('bad JSON from feed')); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// Fetches recent bars at the SAME bar length as the stored data (so resolutions
// are never mixed) and merges them. With an empty store it asks for ~2 years of
// hourly bars, which is the most Yahoo offers at that resolution.
async function refresh(k) {
  const s = store[k], stepMin = s.step / MINUTE;
  const interval = !s.step ? '1h' : stepMin <= 1 ? '1m' : stepMin <= 5 ? '5m' : stepMin <= 15 ? '15m' : '1h';
  const range = !s.step ? '730d' : interval === '1m' ? '5d' : '1mo';
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(INSTRUMENTS[k].sym)}?interval=${interval}&range=${range}`;
    const result = (await getJSON(url)).chart.result[0], q = result.indicators.quote[0], rows = [];
    result.timestamp.forEach((t, i) => {
      const r = [t * 1000, q.open[i], q.high[i], q.low[i], q.close[i]];
      if (r.every(Number.isFinite)) rows.push(r);          // Yahoo returns nulls for empty bars
    });
    const added = merge(k, rows);
    if (added) save(k);
    s.refreshed = Date.now(); s.err = null;
    return added;
  } catch (e) { s.err = 'refresh: ' + e.message; return 0; }
}

/* ---------- 6. The window study ---------------------------------------- */

// First index in sorted array `a` whose value is >= x.
function lowerBound(a, x) {
  let lo = 0, hi = a.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}

// For every calendar day (in the user's time zone) inside the lookback, look at
// the window [from, to) and report one row per COMPLETE session:
//   [startUTC, startPrice, maxUp, maxDown, closeMove]
//   maxUp     = highest high in the window minus the start price
//   maxDown   = start price minus the lowest low in the window
//   closeMove = last close minus the start price
// Sessions with missing bars (weekends, holidays, gaps) are counted as skipped.
//   from, to : minutes after local midnight      tz : UTC offset in hours
//   years    : lookback length                   dow: allowed local weekdays (0 = Sunday)
function query(k, { from, to, tz, years, dow }) {
  const s = store[k], n = s.t.length;
  if (!n || !s.step) return { rows: [], skipped: 0, step: 0 };

  const barMin = Math.max(1, s.step / MINUTE);
  const start = Math.floor(from / barMin) * barMin;         // snap to the bar grid
  let end = Math.ceil(to / barMin) * barMin;
  if (end <= start) end += 1440;                            // window crosses midnight
  const need = Math.round((end - start) / barMin);          // bars per session

  const lastT = s.t[n - 1];
  const lo = Math.max(s.t[0], lastT - years * 365.25 * DAY);
  const firstDay = Math.floor((lo + tz * 36e5) / DAY);
  const lastDay = Math.floor((lastT + tz * 36e5) / DAY);

  const rows = []; let skipped = 0;
  for (let day = firstDay; day <= lastDay; day++) {
    const t0 = day * DAY + start * MINUTE - tz * 36e5;      // session start in UTC
    if (t0 < lo || t0 + (end - start) * MINUTE > lastT + s.step) continue;
    if (dow && !dow.includes(new Date(t0 + tz * 36e5).getUTCDay())) continue;

    const i = lowerBound(s.t, t0);
    const complete = s.t[i] === t0 && i + need <= n && s.t[i + need - 1] === t0 + (need - 1) * s.step;
    if (!complete) { skipped++; continue; }

    let high = -Infinity, low = Infinity;
    for (let j = i; j < i + need; j++) { if (s.h[j] > high) high = s.h[j]; if (s.l[j] < low) low = s.l[j]; }
    const open = s.o[i], r2 = x => Math.round(x * 100) / 100;
    rows.push([t0, open, r2(high - open), r2(open - low), r2(s.c[i + need - 1] - open)]);
  }
  return { rows, skipped, step: barMin, from: start, to: end % 1440 };
}

/* ---------- 7. Data summary for the page ------------------------------- */

function meta() {
  const inst = {};
  for (const k in store) {
    const s = store[k], n = s.t.length;
    inst[k] = {
      name: INSTRUMENTS[k].name, bars: n,
      first: n ? s.t[0] : null, last: n ? s.t[n - 1] : null,
      stepMin: s.step / MINUTE, refreshed: s.refreshed, err: s.err,
      spanYears: n ? +((s.t[n - 1] - s.t[0]) / (365.25 * DAY)).toFixed(2) : 0
    };
  }
  return { inst, keep: { targetYears: 5, triggerMonths: 62 } };
}

/* ---------- 8. Express routes ------------------------------------------ */

module.exports = function mount(app) {
  for (const k in INSTRUMENTS) load(k);

  // The page itself (its CSS and JS are served from /public by express.static).
  app.get('/research', (req, res) => res.sendFile(path.join(__dirname, 'public', 'research.html')));

  app.get('/api/research/meta', (req, res) => res.json(meta()));

  // GET /api/research/sessions?inst=xau&from=02:00&to=03:00&tz=3&years=5&dow=1,2,3,4,5
  app.get('/api/research/sessions', (req, res) => {
    const q = req.query, k = INSTRUMENTS[q.inst] ? q.inst : 'xau';
    const toMinutes = v => { const [h, m] = String(v || '0:0').split(':'); return (+h || 0) * 60 + (+m || 0); };
    const dow = q.dow ? String(q.dow).split(',').map(Number).filter(x => x >= 0 && x <= 6) : null;
    res.json(Object.assign({ inst: k }, query(k, {
      from: toMinutes(q.from), to: toMinutes(q.to), tz: +q.tz || 0,
      years: Math.min(6, +q.years || 5), dow
    })));
  });

  // POST /api/research/refresh pulls the latest bars right now.
  app.post('/api/research/refresh', async (req, res) => {
    const added = {};
    for (const k in INSTRUMENTS) added[k] = await refresh(k);
    res.json({ added, meta: meta() });
  });

  // Automatic refresh: shortly after start, then every 3 hours.
  const tick = () => Promise.all(Object.keys(INSTRUMENTS).map(refresh)).catch(() => {});
  setTimeout(tick, 5000);
  setInterval(tick, 3 * 3600e3).unref();
};

// Exposed for tests.
module.exports._t = { parseCSV, merge, query, store, meta };

/* ---------- 9. Command line import ------------------------------------- */
// node research.js import <xau|gc> <file.csv>
// Merges a CSV of bars into data/<file>.csv. Commit that file so the server
// starts with the full history even when the host disk resets.
if (require.main === module && process.argv[2] === 'import') {
  const [k, file] = [process.argv[3], process.argv[4]];
  if (!INSTRUMENTS[k] || !file) { console.log('usage: node research.js import <xau|gc> <file.csv>'); process.exit(1); }
  load(k);
  merge(k, parseCSV(fs.readFileSync(file, 'utf8')));
  save(k);
  const m = meta().inst[k];
  console.log(`${m.name}: ${m.bars} bars, ${m.spanYears} years, ${m.stepMin} min bars, ` +
              `${new Date(m.first).toISOString()} to ${new Date(m.last).toISOString()}`);
}