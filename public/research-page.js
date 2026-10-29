/* ==========================================================================
   research-page.js : behaviour of the Research page
   --------------------------------------------------------------------------
   Flow:  controls change -> loadSessions() asks the server for one row per
          past session -> calculate() turns rows into statistics -> render*()
          draws them. Distance, "counted when" and risk inputs skip the server
          and recalculate instantly from the rows already in memory.

   Sections: 1 Helpers  2 State  3 Theme  4 Controls  5 Loading sessions
             6 Statistics  7 Rendering (text, tables, charts)  8 Data panel
             9 Start-up
   ========================================================================== */

/* ---------- 1. Helpers ---------- */
const $ = selector => document.querySelector(selector);
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const root = document.documentElement;

// 12345.678 -> "12,346" (or with `digits` decimals)
const fmt = (n, digits = 0) => n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });

// Reads a CSS colour variable so canvases follow the light/dark theme.
const cssColor = name => getComputedStyle(root).getPropertyValue(name).trim();

// Value at percentile p (0 to 1) of an ascending-sorted array.
const percentile = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;

// How many values in an ascending-sorted array are >= x (binary search).
function countAtLeast(sorted, x) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < x) lo = mid + 1; else hi = mid; }
  return sorted.length - lo;
}

// Sizes a canvas for the screen (pixel ratio capped for speed) and returns [context, cssWidth].
function fitCanvas(canvas, height) {
  const ratio = Math.min(devicePixelRatio || 1, 1.5), width = canvas.clientWidth;
  canvas.width = width * ratio; canvas.height = height * ratio; canvas.style.height = height + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return [ctx, width];
}

/* ---------- 2. State ---------- */
const state = {
  inst: 'xau',                              // 'xau' spot or 'gc' futures
  weekdays: new Set([0, 1, 2, 3, 4, 5, 6]), // local weekdays included (0 = Sunday)
  response: null,                           // last answer from /api/research/sessions
  rows: []                                  // sessions: [startUTC, startPrice, maxUp, maxDown, closeMove]
};
let stats = {};   // everything derived from rows + current inputs (see calculate)

/* ---------- 3. Theme (shares the Desk's "th" setting) ---------- */
function setTheme(theme) {
  root.dataset.theme = theme;
  try { localStorage.setItem('th', theme); } catch (e) {}
  $('#th').textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
  renderCharts();   // canvases need the new colours
}
$('#th').onclick = () => setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark');

/* ---------- 4. Controls ---------- */

// Weekday chips (Mon first). Clicking one toggles it and reloads.
function renderWeekdayChips() {
  $('#dow').innerHTML = '<span class="note days-label">Days:</span>' +
    [1, 2, 3, 4, 5, 6, 0].map(d => `<button data-d="${d}" class="${state.weekdays.has(d) ? 'on' : ''}">${DAY_NAMES[d]}</button>`).join('');
}
$('#dow').onclick = e => {
  if (e.target.dataset.d == null) return;
  const d = +e.target.dataset.d;
  state.weekdays.has(d) ? state.weekdays.delete(d) : state.weekdays.add(d);
  renderWeekdayChips(); loadSessions();
};

// Instrument switch.
$('#inst').onclick = e => {
  if (!e.target.dataset.i) return;
  state.inst = e.target.dataset.i;
  [...$('#inst').children].forEach(b => b.classList.toggle('on', b === e.target));
  loadSessions();
};

// Inputs that change WHICH sessions are studied -> ask the server again.
['f', 't', 'tz', 'yr'].forEach(id => $('#' + id).onchange = loadSessions);
// Inputs that only change how sessions are COUNTED or priced -> recalculate instantly.
['thr', 'md', 'lots', 'cs', 'bal'].forEach(id => $('#' + id).oninput = calculate);

/* ---------- 5. Loading sessions from the server ---------- */
let loadTimer;
function loadSessions() {
  clearTimeout(loadTimer);                       // wait for typing to settle
  loadTimer = setTimeout(async () => {
    const query = new URLSearchParams({
      inst: state.inst, from: $('#f').value, to: $('#t').value,
      tz: $('#tz').value, years: $('#yr').value, dow: [...state.weekdays].join(',')
    });
    let res = null;
    try { res = await fetch('/api/research/sessions?' + query); } catch (e) {}

    if (res && res.status === 401) return (location.href = '/login');
    if (!res || !res.ok) {                       // explain what is wrong instead of staying blank
      $('#say').innerHTML = !res
        ? 'Cannot reach the server. Open this page through the Node server, not as a file or Live Server.'
        : 'The research routes are not installed. Add <b>require("./research")(app);</b> to server.js after the login middleware, then restart.';
      $('#kpi').innerHTML = '';
      return;
    }
    state.response = await res.json();
    state.rows = state.response.rows;
    calculate();
  }, 200);
}

/* ---------- 6. Statistics ---------- */

// Turns the session rows into everything the page shows.
function calculate() {
  const threshold = +$('#thr').value || 0;
  const touch = $('#md').value === 'touch';      // true: any time in window, false: at the end
  const rows = state.rows, n = rows.length;

  // Per session: how far up / down it went (touch mode) or where it ended (close mode).
  const up = rows.map(r => touch ? r[2] : Math.max(0, r[4]));
  const down = rows.map(r => touch ? r[3] : Math.max(0, -r[4]));
  const largest = up.map((u, i) => Math.max(u, down[i]));

  // Classify each session: u = reached +distance, d = reached -distance, b = both, n = neither.
  const kind = rows.map((_, i) => {
    const hitUp = up[i] >= threshold, hitDown = down[i] >= threshold;
    return hitUp && hitDown ? 'b' : hitUp ? 'u' : hitDown ? 'd' : 'n';
  });
  const count = { u: 0, d: 0, b: 0, n: 0 };
  kind.forEach(k => count[k]++);

  const ascending = a => a.slice().sort((x, y) => x - y);
  stats = {
    n, rows, threshold, touch, up, down, kind, count,
    hits: count.u + count.d + count.b,
    sortedUp: ascending(up), sortedDown: ascending(down), sortedLargest: ascending(largest)
  };

  renderHeadline();
  renderRiskTable();
  renderBreakdowns();
  renderCharts();
}

/* ---------- 7. Rendering ---------- */

/* 7a. Headline sentence, snap note and summary numbers */
function renderHeadline() {
  const { n, threshold, touch, hits, count, sortedLargest } = stats;
  const from = $('#f').value, to = $('#t').value, tz = +$('#tz').value;
  const zone = tz === 3 ? 'EAT' : 'UTC' + (tz >= 0 ? '+' : '') + tz;
  const name = state.inst === 'xau' ? 'XAUUSD' : 'COMEX gold';

  $('#say').innerHTML = n
    ? `Across <b>${n}</b> sessions, ${name} moved $${threshold} or more from its ${from} ${zone} price ` +
      `${touch ? 'at some point before' : 'by'} ${to} on <b>${hits}</b> of them (<b>${fmt(hits / n * 100, 1)}%</b>): ` +
      `${count.u} up, ${count.d} down, ${count.b} both.`
    : 'No data to study yet. The server has no bars for this instrument, so import history (npm run import) or press Refresh latest bars in the Data section. If it stays empty, the Data section shows why.';

  const r = state.response || {};
  $('#snap').textContent = n
    ? `${r.skipped || 0} sessions skipped for missing bars (weekends, holidays, gaps). Bars are ${r.step} min, so the window is ${fmt(r.from / 60, 2)}h–${fmt(r.to / 60, 2)}h local.`
    : '';

  const tile = (value, label) => `<div><div class="v">${value}</div><div class="k">${label}</div></div>`;
  $('#kpi').innerHTML = n
    ? tile(n, 'sessions') + tile(fmt(hits / n * 100, 1) + '%', 'reached distance') +
      tile(fmt(count.u + count.b), 'reached up') + tile(fmt(count.d + count.b), 'reached down') +
      tile('$' + fmt(percentile(sortedLargest, .5), 2), 'median largest move') +
      tile('$' + fmt(percentile(sortedLargest, .9), 2), '90th percentile')
    : '';
}

/* 7b. "Into your risk": worst-case window moves priced with your size */
function renderRiskTable() {
  if (!stats.n) { $('#rk').innerHTML = ''; return; }
  const ounces = (+$('#lots').value || 0) * (+$('#cs').value || 0);
  const balance = +$('#bal').value || 1;

  const line = (label, sorted, p) => {
    const move = percentile(sorted, p);
    return `<tr><td>${label}</td><td>$${fmt(move, 2)}</td><td>$${fmt(move * ounces)}</td><td>${fmt(move * ounces / balance * 100, 1)}%</td></tr>`;
  };
  const block = (title, sorted) =>
    `<tr><th colspan="4" style="text-align:left;color:var(--ink)">${title}</th></tr>` +
    [[.75, 'Worst 25%'], [.9, 'Worst 10%'], [.95, 'Worst 5%'], [.99, 'Worst 1%']].map(([p, l]) => line(l, sorted, p)).join('');

  $('#rk').innerHTML =
    '<tr><th>Worst share of sessions</th><th>Move</th><th>Loss</th><th>% of balance</th></tr>' +
    block('Long position: down move', stats.sortedDown) +
    block('Short position: up move', stats.sortedUp) +
    block('Either direction: largest move', stats.sortedLargest);
}

/* 7c. Share of sessions reaching the distance, by year and by weekday */
function renderBreakdowns() {
  const { n, rows, threshold, up, down } = stats, tz = +$('#tz').value;
  const byYear = {}, byDay = {};       // key -> [hits, sessions]

  rows.forEach((r, i) => {
    const local = new Date(r[0] + tz * 36e5);          // session start in the chosen time zone
    const hit = up[i] >= threshold || down[i] >= threshold;
    for (const [bucket, key] of [[byYear, local.getUTCFullYear()], [byDay, local.getUTCDay()]]) {
      const cell = bucket[key] || (bucket[key] = [0, 0]);
      cell[1]++; if (hit) cell[0]++;
    }
  });

  const bars = (bucket, label) => Object.keys(bucket).sort().map(k =>
    `<div class="bar"><span class="mono">${label(k)}</span>` +
    `<span class="track"><i style="width:${bucket[k][0] / bucket[k][1] * 100}%"></i></span>` +
    `<span class="mono count">${bucket[k][0]}/${bucket[k][1]}</span></div>`).join('');

  $('#by').innerHTML = n ? bars(byYear, k => k) : '';
  $('#bw').innerHTML = n ? bars(byDay, k => DAY_NAMES[k]) : '';
}

/* 7d. Charts */
function renderCharts() {
  if (stats.n === undefined) return;     // nothing calculated yet
  drawSessionDots();
  drawOddsCurve();
}

// Every session as a dot: one row per year, x = day of year, colour = outcome.
function drawSessionDots() {
  const canvas = $('#dm'), { rows, kind } = stats, tz = +$('#tz').value;
  if (!stats.n) { fitCanvas(canvas, 40); return; }

  const years = [...new Set(rows.map(r => new Date(r[0] + tz * 36e5).getUTCFullYear()))].sort();
  const rowHeight = 22, left = 44;
  const [ctx, width] = fitCanvas(canvas, years.length * rowHeight + 8);
  const plotWidth = width - left - 8, radius = Math.max(1.1, Math.min(2.6, plotWidth / 366 * .42));
  const colors = { u: cssColor('--up'), d: cssColor('--dn'), b: cssColor('--gold'), n: cssColor('--faint') };

  ctx.font = '11px IBM Plex Mono'; ctx.fillStyle = cssColor('--mute');
  years.forEach((y, i) => ctx.fillText(y, 0, i * rowHeight + rowHeight / 2 + 4));

  // One pass per colour = one fill per colour (much faster than a fill per dot).
  ['n', 'u', 'd', 'b'].forEach(k => {
    ctx.fillStyle = colors[k]; ctx.beginPath();
    rows.forEach((r, i) => {
      if (kind[i] !== k) return;
      const d = new Date(r[0] + tz * 36e5), year = d.getUTCFullYear();
      const dayOfYear = (d - Date.UTC(year, 0, 1)) / 864e5;
      const x = left + dayOfYear / 366 * plotWidth, y = years.indexOf(year) * rowHeight + rowHeight / 2;
      ctx.moveTo(x + radius, y); ctx.arc(x, y, radius, 0, 6.283);
    });
    ctx.fill();
  });
}

// Odds curve: x = distance, y = share of sessions that reached at least that far.
function drawOddsCurve() {
  const canvas = $('#cv'), height = 300, padL = 44, padB = 26, padT = 10, padR = 10;
  const [ctx, width] = fitCanvas(canvas, height);
  if (!stats.n) return;

  const { sortedUp, sortedDown, sortedLargest, threshold, n } = stats;
  const maxX = Math.max(60, threshold * 2, Math.ceil(sortedLargest[Math.floor(n * .99)] || 0));
  const X = v => padL + v / maxX * (width - padL - padR);
  const Y = p => padT + (1 - p) * (height - padT - padB);
  const share = (sorted, v) => countAtLeast(sorted, v) / n;

  // Grid and axis labels
  ctx.font = '11px IBM Plex Mono'; ctx.fillStyle = cssColor('--mute'); ctx.strokeStyle = cssColor('--line'); ctx.lineWidth = 1;
  for (let p = 0; p <= 1.001; p += .25) {
    ctx.beginPath(); ctx.moveTo(padL, Y(p)); ctx.lineTo(width - padR, Y(p)); ctx.stroke();
    ctx.fillText(Math.round(p * 100) + '%', 4, Y(p) + 4);
  }
  const tick = Math.ceil(maxX / 6 / 10) * 10;
  for (let v = 0; v <= maxX; v += tick) ctx.fillText('$' + v, X(v) - 10, height - 8);

  // Three curves: down, up, either direction
  [[sortedDown, '--dn'], [sortedUp, '--up'], [sortedLargest, '--gold']].forEach(([sorted, color]) => {
    ctx.strokeStyle = cssColor(color); ctx.lineWidth = 2; ctx.beginPath();
    for (let v = 0; v <= maxX; v += maxX / 160) {
      const x = X(v), y = Y(share(sorted, v));
      v ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
  });

  // Marker at the chosen distance
  ctx.strokeStyle = cssColor('--ink'); ctx.setLineDash([2, 4]);
  ctx.beginPath(); ctx.moveTo(X(threshold), padT); ctx.lineTo(X(threshold), height - padB); ctx.stroke(); ctx.setLineDash([]);
  const either = share(sortedLargest, threshold);
  ctx.fillStyle = cssColor('--gold'); ctx.beginPath(); ctx.arc(X(threshold), Y(either), 4, 0, 6.283); ctx.fill();
  ctx.fillStyle = cssColor('--ink');
  ctx.fillText(fmt(either * 100, 1) + '% at $' + threshold, Math.min(X(threshold) + 8, width - 110), Y(either) - 8);
}

/* ---------- 8. Data panel ---------- */
async function loadMeta() {
  let meta;
  try {
    const res = await fetch('/api/research/meta');
    if (!res.ok) throw 0;
    meta = await res.json();
  } catch (e) { $('#meta').textContent = 'Research API not reachable.'; return; }

  const day = ms => new Date(ms).toISOString().slice(0, 10);
  $('#meta').innerHTML = Object.values(meta.inst).map(i =>
    `<div><b>${i.name}</b>: ` +
    (i.bars ? `${fmt(i.bars)} bars of ${i.stepMin} min, ${i.spanYears} years, ${day(i.first)} to ${day(i.last)}` : 'no data loaded') +
    (i.err ? ` <span class="err">${i.err}</span>` : '') + '</div>').join('') +
    '<div>Stored window: trims back to 5 years once it passes 5 years 2 months. New bars are pulled every 3 hours.</div>';
}

$('#rf').onclick = async e => {
  e.target.textContent = 'Refreshing…';
  await fetch('/api/research/refresh', { method: 'POST' });
  e.target.textContent = 'Refresh latest bars';
  await loadMeta(); loadSessions();
};

/* ---------- 9. Start-up ---------- */
$('#th').textContent = root.dataset.theme === 'dark' ? 'Light mode' : 'Dark mode';
addEventListener('resize', renderCharts);
renderWeekdayChips();
loadMeta();
loadSessions();