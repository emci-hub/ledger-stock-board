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
  cleanupStaleCache,
  resolveOldRecommendations,
  getTrackRecord,
} = require("./jobs/refreshBoard");
const { invalidateBoardStaleCaches } = require("./jobs/invalidateBoardCache");
const {
  getApiUsageToday,
  getUsageToday,
  nextMidnightPacificIso,
  getSetting,
  setSetting,
  PROVIDERS,
} = require("./services/usage");
const { AlphaVantageError } = require("./services/dataFetch");
const { DATA_SOURCES, hasSourceKey } = require("./lib/dataSources");

const app = express();
const PORT = 3000;
const DAILY_AV_LIMIT = DATA_SOURCES.alpha_vantage.rateLimit.limit;
/** Alpha Vantage is mostly reserved for NEWS_SENTIMENT (~1 call / search when news is stale). */
const AV_CALLS_PER_SEARCH_NEWS = 1;
const DAILY_TWELVE_LIMIT = DATA_SOURCES.twelve_data.rateLimit.limit;
const DAILY_MARKETAUX_LIMIT = DATA_SOURCES.marketaux.rateLimit.limit;
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
  const marketauxUsed = await getUsageToday(PROVIDERS.MARKETAUX);
  const geminiUsed = await getUsageToday(PROVIDERS.GEMINI);
  const alphaRemaining = Math.max(0, DAILY_AV_LIMIT - alphaUsed);
  const twelveRemaining = Math.max(0, DAILY_TWELVE_LIMIT - twelveUsed);
  const twelveAvailable = hasSourceKey("twelve_data");

  const twelveBudgetSearches = twelveAvailable
    ? Math.floor(twelveRemaining / TWELVE_CALLS_PER_SEARCH)
    : 0;
  const avNewsBudgetSearches = Math.floor(
    alphaRemaining / AV_CALLS_PER_SEARCH_NEWS
  );
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
    finnhubLimitPerMinute: DATA_SOURCES.finnhub.rateLimit.limit,
    finnhubSoftCapPerMinute: DATA_SOURCES.finnhub.rateLimit.softCap,
    finnhubRateDelayTriggeredToday: finnhubDelayTriggered,
    finnhubRole: "news_sentiment_and_peers",
    marketauxUsedToday: marketauxUsed,
    marketauxLimit: DAILY_MARKETAUX_LIMIT,
    marketauxRole: "news_sentiment",
    marketauxConfigured: hasSourceKey("marketaux"),
    geminiUsedToday: geminiUsed,
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
    const mode = normalizeMode(req.query.mode);
    const rows = await dbAll(
      `SELECT ticker, data_json, last_updated
       FROM stock_reports
       ORDER BY last_updated DESC
       LIMIT 10`
    );

    const recent = [];
    for (const row of rows) {
      recent.push({
        ticker: row.ticker,
        mode,
        lastUpdated: row.last_updated,
        report: await reportFromCache(row.ticker, mode),
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
        // One shared report per ticker (short + long takes in the same Gemini call).
        await refreshBoard();
        await resolveOldRecommendations();
      })().catch((err) => {
        console.error("[cron refreshBoard]", err.message);
      });
    });
    console.log(
      "[cron] Scheduled refreshBoard (shared) + resolveOldRecommendations daily at 07:00"
    );

    cron.schedule("0 4 1 * *", () => {
      (async () => {
        await cleanupStaleCache();
      })().catch((err) => {
        console.error("[cron cleanupStaleCache]", err.message);
      });
    });
    console.log(
      "[cron] Scheduled cleanupStaleCache + joke pool top-up monthly (1st, 04:00)"
    );

    // One-shot heal after shared-fetch merge: drop fallback ai_reports, mark flat
    // prices stale (keep quotes), restore any wiped quotes from legacy cache, then refresh.
    (async () => {
      const healKey = "sharedCacheHeal_v2";
      const already = await getSetting(healKey);
      if (already) {
        console.log(`[startup] ${healKey} already done at ${already}`);
        const row = await dbGet(`SELECT COUNT(*) AS n FROM board_picks`);
        const count = Number(row?.n || 0);
        if (count === 0) {
          console.log("[startup] board_picks empty — running refreshBoard once");
          await refreshBoard();
        }
        return;
      }

      console.log(
        "[startup] Running shared-cache heal v2 (invalidate fallbacks, restore quotes, refreshBoard)"
      );
      console.log(
        `[startup] twelve_data key present=${hasSourceKey("twelve_data")} marketaux=${hasSourceKey("marketaux")} gemini=${hasSourceKey("gemini")}`
      );
      const result = await invalidateBoardStaleCaches();
      await refreshBoard();
      await setSetting(healKey, new Date().toISOString());
      console.log(
        `[startup] shared-cache heal v2 complete — aiDeleted=${result.aiDeleted}, priceInvalidated=${result.priceInvalidated}, quotesRestored=${result.quotesRestored}`
      );
    })().catch((err) => {
      console.error("[startup] shared-cache heal failed:", err.message);
    });
  });
}

start().catch((err) => {
  console.error("[startup] Failed to start server:", err.message);
  process.exit(1);
});
