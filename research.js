'use strict';
// Research engine: stores OHLC bars for XAUUSD and COMEX (GC), keeps a rolling
// 5y2m window (trims back to 5y when it overflows), refreshes from Yahoo, and
// serves per-session window studies. Built-ins only, no new dependencies.
const fs = require('fs'), path = require('path'), https = require('https');
const DIR = path.join(__dirname, 'data'), DAY = 864e5, MIN = 6e4;
const KEEP = Math.round(5 * 365.25 * DAY);   // trim target: 5 years
const KEEP_MAX = KEEP + 61 * DAY;            // trim trigger: 5 years + 2 months
const CFG = {
  xau: { file: 'xauusd.csv', sym: 'XAUUSD=X', name: 'XAUUSD spot' },
  gc:  { file: 'gc.csv',     sym: 'GC=F',     name: 'COMEX gold futures' }
};
const S = {};
for (const k in CFG) S[k] = { t: new Float64Array(0), o: [], h: [], l: [], c: [], step: 0, refreshed: null, err: null };

// Convert supported CSV timestamps to UTC milliseconds.
function parseTime(v) {
  v = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(v)) { const n = +v; return n < 1e11 ? n * 1000 : n; }
  const m = v.match(/^(\d\d)\.(\d\d)\.(\d{4}) (\d\d):(\d\d):(\d\d)/);   // dd.mm.yyyy hh:mm:ss
  if (m) return Date.UTC(+m[3], m[2] - 1, +m[1], +m[4], +m[5], +m[6]);
  if (!/[zZ]|[+-]\d\d:?\d\d$/.test(v)) v = v.replace(' ', 'T') + 'Z';   // no zone means UTC
  return Date.parse(v);
}

// Read OHLC CSV rows and merge them into the in-memory instrument series.
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error('CSV has no rows');
  const d = [',', ';', '\t'].sort((a, b) => lines[0].split(b).length - lines[0].split(a).length)[0];
  const hd = lines[0].toLowerCase().split(d).map(s => s.replace(/["']/g, '').trim());
  const ix = re => hd.findIndex(x => re.test(x));
  const [it, io, ih, il, ic] = [ix(/time|date|stamp/), ix(/^open/), ix(/^high/), ix(/^low/), ix(/^close/)];
  if ([it, io, ih, il, ic].some(i => i < 0)) throw new Error('Header must name time, open, high, low, close');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(d);
    const r = [parseTime(p[it]), +p[io], +p[ih], +p[il], +p[ic]];
    if (r.every(Number.isFinite) && r[0] > 0) rows.push(r);
  }
  return rows;
}

function merge(k, rows) {
  const s = S[k], m = new Map();
  for (let i = 0; i < s.t.length; i++) m.set(s.t[i], [s.o[i], s.h[i], s.l[i], s.c[i]]);
  const before = m.size;
  for (const r of rows) m.set(r[0], r.slice(1));
  let ts = [...m.keys()].sort((a, b) => a - b);
  if (ts.length && ts[ts.length - 1] - ts[0] > KEEP_MAX) {
    const cut = ts[ts.length - 1] - KEEP;
    ts = ts.filter(t => t >= cut);
  }
  s.t = Float64Array.from(ts);
  s.o = ts.map(t => m.get(t)[0]); s.h = ts.map(t => m.get(t)[1]);
  s.l = ts.map(t => m.get(t)[2]); s.c = ts.map(t => m.get(t)[3]);
  const tail = ts.slice(-1000), df = [];
  for (let i = 1; i < tail.length; i++) df.push(tail[i] - tail[i - 1]);
  df.sort((a, b) => a - b);
  s.step = df.length ? df[df.length >> 1] : 0;
  return Math.max(0, m.size - before);
}

// Persist the normalized series and restore it during server startup.
function save(k) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const s = S[k], out = ['time,open,high,low,close'];
    for (let i = 0; i < s.t.length; i++) out.push(`${new Date(s.t[i]).toISOString()},${s.o[i]},${s.h[i]},${s.l[i]},${s.c[i]}`);
    fs.writeFileSync(path.join(DIR, CFG[k].file), out.join('\n'));
  } catch (e) { S[k].err = 'save: ' + e.message; }
}

function load(k) {
  const f = path.join(DIR, CFG[k].file);
  if (fs.existsSync(f)) try { merge(k, parseCSV(fs.readFileSync(f, 'utf8'))); } catch (e) { S[k].err = 'load: ' + e.message; }
}

// Fetch and merge the latest bars from Yahoo Finance.
function getJSON(url) {
  return new Promise((res, rej) => {
    const q = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 }, r => {
      let b = ''; r.on('data', c => b += c);
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(new Error('bad JSON from feed')); } });
    });
    q.on('timeout', () => q.destroy(new Error('timeout'))); q.on('error', rej);
  });
}

async function refresh(k) {
  const s = S[k], sm = s.step / MIN;
  const iv = !s.step ? '1h' : sm <= 1 ? '1m' : sm <= 5 ? '5m' : sm <= 15 ? '15m' : '1h';
  const range = !s.step ? '730d' : iv === '1m' ? '5d' : '1mo';
  try {
    const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(CFG[k].sym)}?interval=${iv}&range=${range}`);
    const r = j.chart.result[0], q = r.indicators.quote[0], rows = [];
    r.timestamp.forEach((t, i) => { const a = [t * 1000, q.open[i], q.high[i], q.low[i], q.close[i]]; if (a.every(Number.isFinite)) rows.push(a); });
    const added = merge(k, rows); if (added) save(k);
    s.refreshed = Date.now(); s.err = null; return added;
  } catch (e) { s.err = 'refresh: ' + e.message; return 0; }
}

// Locate session start bars quickly in a sorted timestamp series.
const lb = (a, x) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; };

// One row per session: [startUTC, startPrice, maxUp, maxDown, closeMove]
function query(k, { from, to, tz, years, dow }) {
  const s = S[k], n = s.t.length;
  if (!n || !s.step) return { rows: [], skipped: 0, step: 0 };
  const sm = Math.max(1, s.step / MIN);
  let f = Math.floor(from / sm) * sm, e = Math.ceil(to / sm) * sm;
  if (e <= f) e += 1440;
  const need = Math.round((e - f) / sm), last = s.t[n - 1];
  const lo = Math.max(s.t[0], last - years * 365.25 * DAY);
  const d0 = Math.floor((lo + tz * 36e5) / DAY), d1 = Math.floor((last + tz * 36e5) / DAY);
  const rows = []; let skipped = 0;
  for (let d = d0; d <= d1; d++) {
    const st = d * DAY + f * MIN - tz * 36e5;
    if (st < lo || st + (e - f) * MIN > last + s.step) continue;
    if (dow && !dow.includes(new Date(st + tz * 36e5).getUTCDay())) continue;
    const i = lb(s.t, st);
    if (s.t[i] !== st || i + need > n || s.t[i + need - 1] !== st + (need - 1) * s.step) { skipped++; continue; }
    let hi = -Infinity, low = Infinity;
    for (let j = i; j < i + need; j++) { if (s.h[j] > hi) hi = s.h[j]; if (s.l[j] < low) low = s.l[j]; }
    const o = s.o[i], r2 = x => Math.round(x * 100) / 100;
    rows.push([st, o, r2(hi - o), r2(o - low), r2(s.c[i + need - 1] - o)]);
  }
  return { rows, skipped, step: sm, from: f, to: e % 1440 };
}

// Summarize available data and expose the research API routes.
function meta() {
  const o = {};
  for (const k in S) { const s = S[k], n = s.t.length;
    o[k] = { name: CFG[k].name, bars: n, first: n ? s.t[0] : null, last: n ? s.t[n - 1] : null, stepMin: s.step / MIN, refreshed: s.refreshed, err: s.err,
             spanYears: n ? +((s.t[n - 1] - s.t[0]) / (365.25 * DAY)).toFixed(2) : 0 }; }
  return { inst: o, keep: { targetYears: 5, triggerMonths: 62 } };
}

module.exports = function mount(app) {
  for (const k in CFG) load(k);
  app.get('/research', (q, r) => r.sendFile(path.join(__dirname, 'public', 'research.html')));
  app.get('/api/research/meta', (q, r) => r.json(meta()));
  app.get('/api/research/sessions', (q, r) => {
    const k = CFG[q.query.inst] ? q.query.inst : 'xau', hm = v => { const [h, m] = String(v || '0:0').split(':'); return (+h || 0) * 60 + (+m || 0); };
    const dow = q.query.dow ? String(q.query.dow).split(',').map(Number).filter(x => x >= 0 && x <= 6) : null;
    r.json(Object.assign({ inst: k }, query(k, { from: hm(q.query.from), to: hm(q.query.to), tz: +q.query.tz || 0, years: Math.min(6, +q.query.years || 5), dow })));
  });
  app.post('/api/research/refresh', async (q, r) => { const a = {}; for (const k in CFG) a[k] = await refresh(k); r.json({ added: a, meta: meta() }); });
  const tick = () => Promise.all(Object.keys(CFG).map(refresh)).catch(() => {});
  setTimeout(tick, 5000); setInterval(tick, 3 * 3600e3).unref();
};
module.exports._t = { parseCSV, merge, query, S, meta };

// CLI import: node research.js import <xau|gc> <file.csv>
if (require.main === module && process.argv[2] === 'import') {
  const k = process.argv[3], f = process.argv[4];
  if (!CFG[k] || !f) { console.log('usage: node research.js import <xau|gc> <file.csv>'); process.exit(1); }
  load(k); const rows = parseCSV(fs.readFileSync(f, 'utf8')); merge(k, rows); save(k);
  const m = meta().inst[k]; console.log(`${m.name}: ${m.bars} bars, ${m.spanYears} years, ${m.stepMin} min bars, ${new Date(m.first).toISOString()} to ${new Date(m.last).toISOString()}`);
}