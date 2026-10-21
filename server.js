const express = require("express");
const path = require("path");
const crypto = require("crypto");
const app = express();

// Local dev only: read .env if present. On Render, set the variables in the dashboard instead.
try {
  for (const l of require("fs").readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
} catch {}

// Single-admin login (HTTP Basic over Render's HTTPS). Fails closed if no password is configured.
const ADMIN_USER = process.env.ADMIN_USER || "admin", ADMIN_PASS = process.env.ADMIN_PASS;
if (!ADMIN_PASS) { console.error("ADMIN_PASS is not set. Copy .env.example to .env and set it, or add it in Render."); process.exit(1); }
const hash = v => crypto.createHash("sha256").update(String(v)).digest();
const same = (a, b) => crypto.timingSafeEqual(hash(a), hash(b));
const fails = new Map(); // ip -> { n, until }
app.set("trust proxy", 1);
function auth(req, res, next) {
  const f = fails.get(req.ip) || { n: 0, until: 0 };
  if (f.until > Date.now())
    return res.status(429).set("Retry-After", String(Math.ceil((f.until - Date.now()) / 1000))).send("Too many attempts. Try again later.");
  const m = (req.headers.authorization || "").match(/^Basic (.+)$/i);
  if (m) {
    const [u, ...rest] = Buffer.from(m[1], "base64").toString().split(":");
    if (same(u, ADMIN_USER) & same(rest.join(":"), ADMIN_PASS)) { fails.delete(req.ip); return next(); }
    if (fails.size > 1000) fails.clear();
    f.n += 1;
    if (f.n >= 5) { f.n = 0; f.until = Date.now() + 15 * 60 * 1000; }
    fails.set(req.ip, f);
  }
  res.set("WWW-Authenticate", 'Basic realm="Gold desk", charset="UTF-8"').status(401).send("Authentication required");
}
app.use(auth);
const UA = { "User-Agent": "Mozilla/5.0 (gold-dashboard)" };
const memo = {}, ticks = new Map();
let cache = { t: 0, data: null };

// Per-source cache so fast sources can refresh every second without hammering slow ones.
async function cached(key, ttl, fn) {
  const m = memo[key];
  if (m && Date.now() - m.t < ttl) return m.v;
  try { const v = await fn(); memo[key] = { t: Date.now(), v }; return v; }
  catch (e) { if (m && Date.now() - m.t < 60000) return m.v; throw e; }
}
async function yahoo(sym) {
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=1d`;
  const r = await fetch(u, { headers: UA });
  if (!r.ok) throw new Error(sym + " " + r.status);
  const m = (await r.json()).chart.result[0];
  const ts = m.timestamp || [], cl = m.indicators.quote[0].close || [], pts = [];
  for (let i = 0; i < ts.length; i++) if (cl[i] != null) pts.push([ts[i], cl[i]]);
  return { price: m.meta.regularMarketPrice, prev: m.meta.chartPreviousClose ?? m.meta.previousClose,
    high: m.meta.regularMarketDayHigh, low: m.meta.regularMarketDayLow,
    t: (m.meta.regularMarketTime || 0) * 1000 || Date.now(), pts, src: "Yahoo Finance" };
}
async function goldApi() {
  const r = await fetch("https://api.gold-api.com/price/XAU", { headers: UA });
  if (!r.ok) throw new Error("gold-api " + r.status);
  const j = await r.json();
  return { price: j.price, t: Date.parse(j.updatedAt) || Date.now(), src: "gold-api.com" };
}
async function swissquote() {
  const r = await fetch("https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD", { headers: UA });
  if (!r.ok) throw new Error("swissquote " + r.status);
  const q = (await r.json())[0], list = q.spreadProfilePrices || [];
  const p = list.find(x => x.spreadProfile === "prime") || list[0];
  return { price: (p.bid + p.ask) / 2, t: q.ts || Date.now(), src: "Swissquote" };
}
const down = (a, n) => { const k = Math.ceil(a.length / n); return k > 1 ? a.filter((_, i) => i % k === 0 || i === a.length - 1) : a; };
// One shape for every quote. High and low come from the same data the terrain plots, so they always agree.
function shape(q, full, price) {
  const v = [...full, price];
  return { price, prev: q.prev ?? null, t: q.t, src: q.src, derived: !!q.derived,
    high: Math.max(...v, q.high ?? -Infinity), low: Math.min(...v, q.low ?? Infinity),
    series: v.slice(-120), day: down(v, 240) };
}
// Spot with no history feed: real ticks this server has seen, earlier minutes backfilled from futures minus the premium.
function buildSpot(best, fut) {
  const mk = Math.floor(Date.now() / 60000);
  ticks.set(mk, best.price);
  for (const k of ticks.keys()) if (k < mk - 1440) ticks.delete(k);
  const basis = fut ? fut.price - best.price : 0, m = new Map();
  if (fut) for (const [t, c] of fut.pts) m.set(Math.floor(t / 60), c - basis);
  for (const [k, v] of ticks) m.set(k, v);
  const vals = [...m.keys()].sort((a, b) => a - b).map(k => m.get(k));
  return shape({ prev: fut && fut.prev != null ? fut.prev - basis : null, t: best.t, src: best.src, derived: true }, vals, best.price);
}

app.get("/api/quotes", async (_req, res) => {
  if (cache.data && Date.now() - cache.t < 1000) return res.json(cache.data);
  const [fut, sq, ga, sy] = await Promise.allSettled([
    cached("fut", 3000, () => yahoo("GC=F")), cached("sq", 800, swissquote),
    cached("ga", 1000, goldApi), cached("sy", 30000, () => yahoo("XAUUSD=X"))]);
  const F = fut.value || null;
  const live = [sq.value, ga.value].filter(x => x && typeof x.price === "number");
  const best = live.sort((a, b) => b.t - a.t)[0] || null; // freshest spot source wins
  const Y = sy.value && sy.value.pts.length > 2 ? sy.value : null;
  let S = null;
  if (best && Y) S = shape({ ...Y, t: best.t, src: best.src + " + Yahoo history" }, Y.pts.map(p => p[1]), best.price);
  else if (best) S = buildSpot(best, F);
  const out = { ts: Date.now(), fut: F ? shape(F, F.pts.map(p => p[1]), F.price) : null, spot: S };
  if (!out.fut && !out.spot) return res.status(502).json({ error: "upstream unavailable" });
  cache = { t: Date.now(), data: out };
  res.json(out);
});

app.use(express.static(path.join(__dirname, "public")));
app.listen(process.env.PORT || 3000, () => console.log("gold-dashboard up"));