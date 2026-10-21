# Gold desk

Live XAUUSD and COMEX gold futures dashboard with a trade calculator and risk model.

## Run locally
    npm install && npm start     # http://localhost:3000

## Deploy on Render
1. Push this folder to a GitHub repo.
2. Render dashboard > New > Blueprint (reads render.yaml), or New > Web Service with
   Build `npm install` and Start `node server.js`.
3. Open the .onrender.com URL. The free plan sleeps after idle, so the first load can take ~30s.

## Data
The server proxies gold-api.com (spot) and Yahoo Finance (GC=F futures, XAUUSD=X series), caches for 2s,
and the page polls every 3s. These are unofficial free feeds and can be delayed or rate limited.
For production-grade ticks, swap the fetchers in server.js for a paid provider.

## Admin login
A styled sign-in page protects the whole site, including /api/quotes. A successful login sets a signed,
HttpOnly cookie that lasts 7 days; the Sign out button clears it.
- Local: copy `.env.example` to `.env` and set `ADMIN_PASS`. Never commit `.env`.
- Render: set `ADMIN_USER` and `ADMIN_PASS` under Environment. `SESSION_SECRET` is generated for you.
- The server refuses to start without `ADMIN_PASS`. Five wrong attempts from one IP lock it out for 15 minutes.
- Changing `ADMIN_PASS`, `ADMIN_USER` or `SESSION_SECRET` signs every session out.

The webpage is live at https://gold-dashboard-snz9.onrender.com