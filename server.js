require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");
const cron = require("node-cron");

const { getDb } = require("./db/schema");
const { getStockReport, buildReport } = require("./services/getStockReport");
const { getCachedStock, getCachedSummary } = require("./services/cache");
const {
  refreshBoard,
  resolveOldRecommendations,
  getTrackRecord,
} = require("./jobs/refreshBoard");
const { getApiUsageToday, nextMidnightPacificIso } = require("./services/usage");
const { AlphaVantageError } = require("./services/dataFetch");

const app = express();
const PORT = 3000;
const DAILY_AV_LIMIT = 25;

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

function reportFromCache(ticker, mode) {
  const raw = getCachedStock(ticker, mode);
  const analysis = getCachedSummary(ticker, mode);
  if (!raw) return null;

  return {
    ...buildReport(ticker, mode, raw, analysis),
    trackRecord: getTrackRecord(ticker),
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

// GET /api/usage
app.get("/api/usage", (req, res) => {
  try {
    return res.json({
      used: getApiUsageToday(),
      limit: DAILY_AV_LIMIT,
      resetsAt: nextMidnightPacificIso(),
    });
  } catch (err) {
    console.error("[GET /api/usage]", err.message);
    return res.status(500).json({ error: "Failed to load usage." });
  }
});

// GET /api/search?ticker=XXX&mode=long&password=
app.get("/api/search", async (req, res) => {
  try {
    const ticker = String(req.query.ticker || "")
      .trim()
      .toUpperCase();
    const mode = normalizeMode(req.query.mode);

    if (!ticker) {
      return res.status(400).json({ error: "Query param 'ticker' is required." });
    }

    // Always try cache first — no password required on hit
    const cachedStock = getCachedStock(ticker, mode);
    const cachedSummary = getCachedSummary(ticker, mode);
    if (cachedStock && cachedSummary) {
      return res.json({
        ...buildReport(ticker, mode, cachedStock, cachedSummary),
        trackRecord: getTrackRecord(ticker),
      });
    }

    // Fresh Alpha Vantage pull needed when stock cache is missing
    if (!cachedStock && !searchPasswordOk(req.query.password)) {
      return res.status(401).json({ error: "locked" });
    }

    const report = await getStockReport(ticker, mode);
    if (!report) {
      return res.status(404).json({ error: "invalid_ticker" });
    }

    return res.json({ ...report, trackRecord: getTrackRecord(ticker) });
  } catch (err) {
    if (err instanceof AlphaVantageError) {
      if (err.code === "rate_limit") {
        return res.status(429).json({
          error: "rate_limit",
          resetsAt: err.resetsAt || nextMidnightPacificIso(),
          used: getApiUsageToday(),
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

// GET /api/board?mode=long — board_picks + cached report data
app.get("/api/board", (req, res) => {
  try {
    const mode = normalizeMode(req.query.mode);
    const db = getDb();
    const picks = db
      .prepare(
        `SELECT ticker, status, added_at, sector FROM board_picks ORDER BY added_at DESC`
      )
      .all();

    const board = picks.map((pick) => ({
      ...pick,
      report: reportFromCache(pick.ticker, mode),
    }));

    return res.json(board);
  } catch (err) {
    console.error("[GET /api/board]", err.message);
    return res.status(500).json({ error: "Failed to load board picks." });
  }
});

// GET /api/recent — 10 most recently updated stock_cache rows
app.get("/api/recent", (req, res) => {
  try {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT ticker, mode, data_json, last_updated
         FROM stock_cache
         ORDER BY last_updated DESC
         LIMIT 10`
      )
      .all();

    const recent = rows.map((row) => {
      const raw = parseJsonSafe(row.data_json);
      const report = reportFromCache(row.ticker, row.mode);
      return {
        ticker: row.ticker,
        mode: row.mode,
        lastUpdated: row.last_updated,
        report,
        raw,
      };
    });

    return res.json(recent);
  } catch (err) {
    console.error("[GET /api/recent]", err.message);
    return res.status(500).json({ error: "Failed to load recent stocks." });
  }
});

// POST /api/watchlist — body { ticker }
app.post("/api/watchlist", (req, res) => {
  try {
    const ticker = String(req.body?.ticker || "")
      .trim()
      .toUpperCase();

    if (!ticker) {
      return res.status(400).json({ error: "Body field 'ticker' is required." });
    }

    const db = getDb();
    db.prepare(
      `INSERT OR REPLACE INTO watchlist (ticker, starred_at) VALUES (?, ?)`
    ).run(ticker, new Date().toISOString());

    return res.status(201).json({
      ticker,
      starredAt: new Date().toISOString(),
      message: `${ticker} added to watchlist.`,
    });
  } catch (err) {
    console.error("[POST /api/watchlist]", err.message);
    return res.status(500).json({ error: "Failed to add to watchlist." });
  }
});

// GET /api/watchlist — starred tickers + cached data
app.get("/api/watchlist", (req, res) => {
  try {
    const mode = normalizeMode(req.query.mode);
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT ticker, starred_at FROM watchlist ORDER BY starred_at DESC`
      )
      .all();

    const watchlist = rows.map((row) => ({
      ticker: row.ticker,
      starredAt: row.starred_at,
      report: reportFromCache(row.ticker, mode),
    }));

    return res.json(watchlist);
  } catch (err) {
    console.error("[GET /api/watchlist]", err.message);
    return res.status(500).json({ error: "Failed to load watchlist." });
  }
});

app.listen(PORT, () => {
  console.log(`Ledger server listening on http://localhost:${PORT}`);

  cron.schedule("0 7 * * *", () => {
    refreshBoard().catch((err) => {
      console.error("[cron refreshBoard]", err.message);
    });
    resolveOldRecommendations().catch((err) => {
      console.error("[cron resolveOldRecommendations]", err.message);
    });
  });
  console.log(
    "[cron] Scheduled refreshBoard + resolveOldRecommendations daily at 07:00"
  );

  try {
    const count = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM board_picks`)
      .get().n;
    if (count === 0) {
      console.log("[startup] board_picks empty — running refreshBoard once");
      refreshBoard().catch((err) => {
        console.error("[startup refreshBoard]", err.message);
      });
    } else {
      console.log(
        `[startup] board_picks already has ${count} row(s) — skip refresh`
      );
    }
  } catch (err) {
    console.error("[startup] Could not check board_picks:", err.message);
  }
});
