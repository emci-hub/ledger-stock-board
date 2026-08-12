require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");
const cron = require("node-cron");

const { initSchema, dbGet, dbAll, dbRun } = require("./db/schema");
const { getStockReport, buildReport } = require("./services/getStockReport");
const {
  getStockCacheEntry,
  getCachedSummary,
  isFullyFresh,
  isPriceFresh,
} = require("./services/cache");
const {
  refreshBoard,
  resolveOldRecommendations,
  getTrackRecord,
} = require("./jobs/refreshBoard");
const {
  getApiUsageToday,
  getUsageToday,
  nextMidnightPacificIso,
  getSetting,
  PROVIDERS,
} = require("./services/usage");
const { AlphaVantageError } = require("./services/dataFetch");

const app = express();
const PORT = 3000;
const DAILY_AV_LIMIT = 25;
/** Alpha Vantage is mostly reserved for NEWS_SENTIMENT (~1 call / search when news is stale). */
const AV_CALLS_PER_SEARCH_NEWS = 1;
const DAILY_TWELVE_LIMIT = 800;
/** Typical Twelve Data cost per search: time_series (+ optional price_target when plan allows). */
const TWELVE_CALLS_PER_SEARCH = 1;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function reportFromCache(ticker, mode) {
  const entry = await getStockCacheEntry(ticker, mode);
  const analysis = await getCachedSummary(ticker, mode);
  if (!entry || !entry.data?.quote) return null;

  return {
    ...buildReport(
      ticker,
      mode,
      entry.data,
      analysis,
      entry.data?.freshness?.priceUpdatedAt || entry.lastUpdated
    ),
    trackRecord: await getTrackRecord(ticker),
  };
}

function normalizeMode(mode) {
  return mode === "short" ? "short" : "long";
}

function searchPasswordOk(provided) {
  const expected = process.env.SEARCH_PASSWORD;
  if (!expected) return false;
  return String(provided || "") === expected;
}

async function buildStatusPayload() {
  const alphaUsed = await getUsageToday(PROVIDERS.ALPHA);
  const twelveUsed = await getUsageToday(PROVIDERS.TWELVE);
  const finnhubUsed = await getUsageToday(PROVIDERS.FINNHUB);
  const finnhubDelayTriggered = await getUsageToday(PROVIDERS.FINNHUB_DELAY);
  const alphaRemaining = Math.max(0, DAILY_AV_LIMIT - alphaUsed);
  const twelveRemaining = Math.max(0, DAILY_TWELVE_LIMIT - twelveUsed);
  const twelveAvailable = Boolean(process.env.TWELVE_DATA_API_KEY);

  // Price path is Twelve-first; AV is mainly news (+ rare price/target fallback).
  const twelveBudgetSearches = twelveAvailable
    ? Math.floor(twelveRemaining / TWELVE_CALLS_PER_SEARCH)
    : 0;
  const avNewsBudgetSearches = Math.floor(
    alphaRemaining / AV_CALLS_PER_SEARCH_NEWS
  );
  // Searches can still succeed with news pending, so Twelve budget is the main gate.
  // When Twelve is exhausted, allow a few AV-only price fallbacks if AV remains.
  const newSearchesAvailableToday = twelveAvailable
    ? twelveBudgetSearches
    : avNewsBudgetSearches;

  return {
    alphaVantageUsedToday: alphaUsed,
    alphaVantageLimit: DAILY_AV_LIMIT,
    alphaVantageRole: "news_primary_price_target_fallback",
    twelveDataUsedToday: twelveUsed,
    twelveDataLimit: DAILY_TWELVE_LIMIT,
    twelveDataRole: "price_indicators_target_primary",
    finnhubUsedToday: finnhubUsed,
    finnhubLimitPerMinute: 60,
    finnhubSoftCapPerMinute: 50,
    finnhubRateDelayTriggeredToday: finnhubDelayTriggered,
    finnhubRole: "news_sentiment_and_peers",
    newSearchesAvailableToday,
    lastBoardRefresh: await getSetting("lastBoardRefresh"),
    boardRefreshStatus: await getSetting("lastBoardRefreshStatus"),
    resetsAt: nextMidnightPacificIso(),
  };
}

app.get("/healthz", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

app.get("/api/usage", async (req, res) => {
  try {
    return res.json({
      used: await getApiUsageToday(),
      limit: DAILY_AV_LIMIT,
      resetsAt: nextMidnightPacificIso(),
    });
  } catch (err) {
    console.error("[GET /api/usage]", err.message);
    return res.status(500).json({ error: "Failed to load usage." });
  }
});

app.get("/api/status", async (req, res) => {
  try {
    return res.json(await buildStatusPayload());
  } catch (err) {
    console.error("[GET /api/status]", err.message);
    return res.status(500).json({ error: "Failed to load status." });
  }
});

app.get("/api/search", async (req, res) => {
  try {
    const ticker = String(req.query.ticker || "")
      .trim()
      .toUpperCase();
    const mode = normalizeMode(req.query.mode);

    if (!ticker) {
      return res.status(400).json({ error: "Query param 'ticker' is required." });
    }

    const entry = await getStockCacheEntry(ticker, mode);
    const cachedSummary = await getCachedSummary(ticker, mode);
    if (entry && isFullyFresh(entry.data) && cachedSummary) {
      return res.json({
        ...buildReport(
          ticker,
          mode,
          entry.data,
          cachedSummary,
          entry.data?.freshness?.priceUpdatedAt || entry.lastUpdated
        ),
        trackRecord: await getTrackRecord(ticker),
      });
    }

    // Password gate for live pulls; allow without password if we already have a fresh price cache.
    if (
      !(entry && isPriceFresh(entry.data)) &&
      !searchPasswordOk(req.query.password)
    ) {
      return res.status(401).json({ error: "locked" });
    }

    const report = await getStockReport(ticker, mode);
    if (!report) {
      return res.status(404).json({ error: "invalid_ticker" });
    }

    return res.json({
      ...report,
      trackRecord: await getTrackRecord(ticker),
    });
  } catch (err) {
    if (err instanceof AlphaVantageError) {
      if (err.code === "rate_limit") {
        return res.status(429).json({
          error: "rate_limit",
          resetsAt: err.resetsAt || nextMidnightPacificIso(),
          used: await getApiUsageToday(),
          limit: DAILY_AV_LIMIT,
        });
      }
      if (err.code === "invalid_ticker") {
        return res.status(404).json({ error: "invalid_ticker" });
      }
    }
    console.error("[GET /api/search]", err.message);
    return res.status(500).json({ error: "Failed to search stock." });
  }
});

app.get("/api/board", async (req, res) => {
  try {
    const mode = normalizeMode(req.query.mode);
    const picks = await dbAll(
      `SELECT ticker, status, added_at, sector FROM board_picks ORDER BY added_at DESC`
    );

    const board = [];
    for (const pick of picks) {
      board.push({
        ...pick,
        report: await reportFromCache(pick.ticker, mode),
      });
    }

    return res.json(board);
  } catch (err) {
    console.error("[GET /api/board]", err.message);
    return res.status(500).json({ error: "Failed to load board picks." });
  }
});

app.get("/api/recent", async (req, res) => {
  try {
    const rows = await dbAll(
      `SELECT ticker, mode, data_json, last_updated
       FROM stock_cache
       ORDER BY last_updated DESC
       LIMIT 10`
    );

    const recent = [];
    for (const row of rows) {
      recent.push({
        ticker: row.ticker,
        mode: row.mode,
        lastUpdated: row.last_updated,
        report: await reportFromCache(row.ticker, row.mode),
        raw: parseJsonSafe(row.data_json),
      });
    }

    return res.json(recent);
  } catch (err) {
    console.error("[GET /api/recent]", err.message);
    return res.status(500).json({ error: "Failed to load recent stocks." });
  }
});

app.post("/api/watchlist", async (req, res) => {
  try {
    const ticker = String(req.body?.ticker || "")
      .trim()
      .toUpperCase();

    if (!ticker) {
      return res.status(400).json({ error: "Body field 'ticker' is required." });
    }

    const starredAt = new Date().toISOString();
    await dbRun(
      `INSERT OR REPLACE INTO watchlist (ticker, starred_at) VALUES (?, ?)`,
      [ticker, starredAt]
    );

    return res.status(201).json({
      ticker,
      starredAt,
      message: `${ticker} added to watchlist.`,
    });
  } catch (err) {
    console.error("[POST /api/watchlist]", err.message);
    return res.status(500).json({ error: "Failed to add to watchlist." });
  }
});

app.get("/api/watchlist", async (req, res) => {
  try {
    const mode = normalizeMode(req.query.mode);
    const rows = await dbAll(
      `SELECT ticker, starred_at FROM watchlist ORDER BY starred_at DESC`
    );

    const watchlist = [];
    for (const row of rows) {
      watchlist.push({
        ticker: row.ticker,
        starredAt: row.starred_at,
        report: await reportFromCache(row.ticker, mode),
      });
    }

    return res.json(watchlist);
  } catch (err) {
    console.error("[GET /api/watchlist]", err.message);
    return res.status(500).json({ error: "Failed to load watchlist." });
  }
});

async function start() {
  await initSchema();

  app.listen(PORT, () => {
    console.log(`Ledger server listening on http://localhost:${PORT}`);

    cron.schedule("0 7 * * *", () => {
      (async () => {
        // Warm both modes; long last so board_picks status reflects long-term lean.
        await refreshBoard("short");
        await refreshBoard("long");
        await resolveOldRecommendations();
      })().catch((err) => {
        console.error("[cron refreshBoard]", err.message);
      });
    });
    console.log(
      "[cron] Scheduled refreshBoard(short+long) + resolveOldRecommendations daily at 07:00"
    );

    dbGet(`SELECT COUNT(*) AS n FROM board_picks`)
      .then((row) => {
        const count = Number(row?.n || 0);
        if (count === 0) {
          console.log("[startup] board_picks empty — running refreshBoard once");
          return refreshBoard();
        }
        console.log(
          `[startup] board_picks already has ${count} row(s) — skip refresh`
        );
      })
      .catch((err) => {
        console.error("[startup] Could not check board_picks:", err.message);
      });
  });
}

start().catch((err) => {
  console.error("[startup] Failed to start server:", err.message);
  process.exit(1);
});
