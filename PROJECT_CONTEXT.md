# Ledger

**Purpose:** A compact family stock information board — not a trading platform.

**Tech stack:** Node.js, Express, Turso (libSQL / `@libsql/client`), Alpha Vantage API, Finnhub API, Gemini API, optional Twelve Data

---

## How to run

1. Copy `.env.example` to `.env` and fill in `ALPHA_VANTAGE_API_KEY`, `FINNHUB_API_KEY`, `GEMINI_API_KEY`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` (optional: `GEMINI_MODEL`, `TWELVE_DATA_API_KEY`, `SEARCH_PASSWORD`).
2. `npm install`
3. `node server.js`
4. Open [http://localhost:3000](http://localhost:3000)

---

## What the app does

Ledger is a small family-facing stock **information** board. It is not a broker and does not place trades.

- **Board:** A fixed list of large-cap tickers is refreshed daily (7:00 AM). Each name is analyzed (price, indicators, news/sentiment, peers, Gemini summary) and placed on the board as `recommended` or `watch`.
- **Lookup:** Search any ticker; results are cached in Turso for 24 hours (`stock_cache` + `ai_summaries`) so repeat views do not re-hit paid/rate-limited APIs.
- **Track record:** When a name is recommended, a row is logged; after 30 days the outcome is scored so the UI can show a simple hit-rate (or “building” until enough history exists).
- **Watchlist:** Star tickers from the UI; stored in Turso.
- **UI:** Static `public/index.html` talks to the Express JSON API on port 3000.

---

## Progress Log

- **Step 1 complete:** Project initialized (`npm init -y`), dependencies installed (express, cors, dotenv, axios, better-sqlite3, technicalindicators, node-cron), `.gitignore` created, and this context file established.
- **Step 3 complete:** SQLite schema at `db/schema.js` (`./data/ledger.db` via better-sqlite3). Tables: `stock_cache`, `ai_summaries`, `board_picks`, `recommendation_log`, `watchlist`. Exports `getDb()`.
- **Step 4 complete:** `services/dataFetch.js` — `getQuoteAndIndicators` (Alpha Vantage price + SMA/RSI/MACD/BBANDS; daily for short / weekly for long), `getFundamentalsAndNews` (overview + 5 news articles), `getPeers` (Finnhub, 3–5 peers). Each returns `null` on failure.
- **Step 5 complete:** `services/cache.js` — `getCachedStock` / `saveStockToCache` (`stock_cache`, 24h TTL) and `getCachedSummary` / `saveSummaryToCache` (`ai_summaries`, 24h TTL).
- **Step 6 complete:** `services/analyze.js` — `analyzeStock` calls Gemini (single request + optional one model fallback) for fixed JSON `{ lean, risk, tags, summary }`; safe neutral fallback on parse/API failure.
- **Model / Gemini fallback:** Uses `process.env.GEMINI_MODEL` (default `gemini-2.5-flash`); on model-not-found/deprecated only, retries once with `gemini-flash-latest`.
- **Step 7 complete:** `services/getStockReport.js` — cache-first report builder; fetches/analyzes only on miss; 24h TTL.
- **Step 8 complete:** `server.js` Express app on port 3000 (cors + static `public/`). Endpoints: `GET /api/search`, `GET /api/board`, `GET /api/recent`, `POST /api/watchlist`, `GET /api/watchlist`.
- **Test seed (temporary):** `scripts/seedTestCache.js` seeds AAPL/MSFT/JNJ/KO/NVDA for Steps 8–11 UI/API work without Alpha Vantage quota.
- **Step 9 complete:** `jobs/refreshBoard.js` daily board refresh (cron 07:00 + startup if empty). Tickers: AAPL, MSFT, GOOGL, NVDA, AVGO, JNJ, UNH, PFE, ABBV, KO, PG, WMT, COST, JPM, BAC, V, XOM, CVX.
- **Step 10 complete:** Recommendation log + 30-day resolve + `getTrackRecord` on API payloads.
- **Step 11 complete:** `public/index.html` wired to live APIs; mockup visuals unchanged.
- **Step 12 / end-to-end review:** No API keys hardcoded in source (only `.env`, gitignored). All Express routes have try/catch JSON errors. Gemini allows at most one model-availability fallback (no retry loops). Cache hardened: full hits skip all live APIs; partial miss only fills what’s missing; verified second AAPL lookup makes zero Alpha/Finnhub/Gemini calls. Fundamentals AV calls serialized; recommendation resolve uses cache-only prices.
- **Quota / search gate:** `getQuoteAndIndicators` uses 1 Alpha Vantage time-series call + local SMA/RSI/MACD/BBANDS. `api_usage` table + `GET /api/usage`. Search returns `rate_limit` / `invalid_ticker` / `locked`; password (`SEARCH_PASSWORD`) required only on cache-miss fresh pulls.
- **Health check:** `GET /healthz` returns `{ status: "ok", time }` with no DB or external API calls — for uptime monitoring.
- **Seed cleared + 8-ticker live board:** Deleted `scripts/seedTestCache.js` and wiped `stock_cache` / `ai_summaries` / `board_picks`. `BOARD_TICKERS` trimmed to 8: AAPL, MSFT, JNJ, UNH, KO, PG, JPM, V. Forced `refreshBoard()` ran but Alpha Vantage returned daily rate-limit on all 8 (local `api_usage` +8; board empty until AV quota resets ~midnight PT, then re-run refresh).
- **API hardening + status UI:** All AV/Finnhub calls go through `callAlphaVantage` / `callFinnhub` (per-provider usage counters). In-flight `getStockReport` dedupe by ticker/mode. Board refresh skips Finnhub peers + skips still-fresh (<24h) tickers. Twelve Data price-history fallback on AV rate-limit (`TWELVE_DATA_API_KEY`). `GET /api/status` + header “Board last refreshed” / “New stock searches available today”; cards show `as of [last_updated]`.
- **Turso migration (persistent DB):** Replaced local `better-sqlite3` (`./data/ledger.db`) with hosted Turso via `@libsql/client` because Render’s free tier uses an ephemeral filesystem — local SQLite was wiped on every redeploy, restart, or sleep/wake, so cache, board, watchlist, and usage counters did not survive. `db/schema.js` now creates a libSQL client from `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN`, runs async `initSchema()` for the same tables (`stock_cache`, `ai_summaries`, `board_picks`, `recommendation_log`, `watchlist`, `api_usage`, `app_settings`), and exports async `dbGet` / `dbAll` / `dbRun`. All callers (`cache`, `usage`, `getStockReport`, `dataFetch` usage increments, `refreshBoard`, `server.js` routes) await the async API; server starts only after `initSchema()`.
