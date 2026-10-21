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

// Single-admin login with a signed session cookie. Fails closed if no password is configured.
const ADMIN_USER = process.env.ADMIN_USER || "admin", ADMIN_PASS = process.env.ADMIN_PASS;
if (!ADMIN_PASS) { console.error("ADMIN_PASS is not set. Copy .env.example to .env and set it, or add it in Render."); process.exit(1); }
const SESSION_MS = 7 * 24 * 3600 * 1000, COOKIE = "gd_session";
const hash = v => crypto.createHash("sha256").update(String(v)).digest();
const same = (a, b) => crypto.timingSafeEqual(hash(a), hash(b));
// Signing key: SESSION_SECRET if set, else derived from the admin password (changing it signs everyone out).
const KEY = hash("gold-desk-session:" + (process.env.SESSION_SECRET || ADMIN_PASS));
const sign = p => crypto.createHmac("sha256", KEY).update(p).digest("base64url");
function readSession(req) {
  const m = (req.headers.cookie || "").match(new RegExp("(?:^|;\\s*)" + COOKIE + "=([^;]+)"));
  if (!m) return false;
  const [p, sig] = m[1].split(".");
  if (!p || !sig) return false;
  const a = Buffer.from(sig), b = Buffer.from(sign(p));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try { const d = JSON.parse(Buffer.from(p, "base64url").toString()); return d.u === ADMIN_USER && d.exp > Date.now(); }
  catch { return false; }
}
const setCookie = (req, res, v, maxAge) => res.set("Set-Cookie",
  `${COOKIE}=${v}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${req.secure ? "; Secure" : ""}`);
const loginHtml = require("fs").readFileSync(path.join(__dirname, "login.html"), "utf8");
const page = msg => loginHtml.replace("<!--MSG-->", msg ? `<p class="err" role="alert">${msg}</p>` : "");
const fails = new Map(); // ip -> { n, until }
app.set("trust proxy", 1);
app.use((_req, res, next) => { res.set({ "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin" }); next(); });

app.get("/login", (req, res) => {
  if (readSession(req)) return res.redirect("/");
  res.set("Cache-Control", "no-store").type("html").send(page(""));
});
app.post("/login", express.urlencoded({ extended: false, limit: "2kb" }), (req, res) => {
  res.set("Cache-Control", "no-store");
  const f = fails.get(req.ip) || { n: 0, until: 0 };
  if (f.until > Date.now())
    return res.status(429).type("html").send(page(`Too many attempts. Try again in ${Math.ceil((f.until - Date.now()) / 60000)} min.`));
  const { username = "", password = "" } = req.body || {};
  if (same(username, ADMIN_USER) & same(password, ADMIN_PASS)) {
    fails.delete(req.ip);
    const p = Buffer.from(JSON.stringify({ u: ADMIN_USER, exp: Date.now() + SESSION_MS })).toString("base64url");
    setCookie(req, res, p + "." + sign(p), SESSION_MS / 1000);
    return res.redirect(303, "/");
  }
  if (fails.size > 1000) fails.clear();
  if (++f.n >= 5) { f.n = 0; f.until = Date.now() + 15 * 60 * 1000; }
  fails.set(req.ip, f);
  res.status(401).type("html").send(page("Wrong username or password."));
});
app.post("/logout", (req, res) => { setCookie(req, res, "", 0); res.redirect(303, "/login"); });
// Everything below this line needs a valid session.
app.use((req, res, next) => {
  if (readSession(req)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "sign in required" });
  res.redirect("/login");
});
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