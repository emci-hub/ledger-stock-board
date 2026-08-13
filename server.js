require("dotenv").config();

const path = require("path");
const crypto = require("crypto");
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
const {
  forceRefreshAll,
  getForceRefreshState,
} = require("./jobs/forceRefreshAll");
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
const { DATA_SOURCES, hasSourceKey, sourcesLegend, sourceRole, smartRefreshReserve } = require("./lib/dataSources");
const { getLastCapabilityProbe } = require("./jobs/capabilityProbe");
const { discoverHotStocks } = require("./jobs/discoverHotStocks");
const {
  listArchivedBoardPicks,
  BOARD_MAX_SIZE,
  countLiveBoard,
} = require("./lib/boardPicks");
const { LIVE_BOARD_STATUSES } = require("./lib/boardTickers");
const { getMarketMood, loadMood } = require("./services/marketMood");
const { getTodaysTidbit } = require("./services/didYouKnow");
const {
  getDeeperLook,
  requestDeeperLook,
  ensureDeeperLookTable,
} = require("./services/deeperLook");
const { resolveProviderId, listProviders } = require("./lib/aiProvider");
const {
  ensureApiCallLogTable,
  getRecentApiCalls,
  getLastCallByProvider,
} = require("./services/apiCallLog");
const { listJobStatuses, recordJobRun } = require("./services/jobRuns");

const app = express();
const PORT = 3000;
const DAILY_AV_LIMIT = DATA_SOURCES.alpha_vantage.rateLimit.limit;
/** Alpha Vantage is mostly reserved for NEWS_SENTIMENT (~1 call / search when news is stale). */
const AV_CALLS_PER_SEARCH_NEWS = 1;
const DAILY_TWELVE_LIMIT = DATA_SOURCES.twelve_data.rateLimit.limit;
const DAILY_MARKETAUX_LIMIT = DATA_SOURCES.marketaux.rateLimit.limit;
/** Typical Twelve Data cost per search: time_series (+ optional price_target when plan allows). */
const TWELVE_CALLS_PER_SEARCH = 1;

/** Dev-status gate — separate from SEARCH_PASSWORD. Never sent to the client. */
function expectedDevPassword() {
  return process.env.DEV_STATUS_PASSWORD || "lazyemci";
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function makeDevToken() {
  return crypto
    .createHmac("sha256", expectedDevPassword())
    .update("ledger-dev-status-v1")
    .digest("hex");
}

function providedDevPassword(req) {
  return (
    req.headers["x-dev-password"] ||
    req.body?.password ||
    req.query?.password ||
    ""
  );
}

function devAuthOk(req) {
  const cookies = parseCookies(req);
  if (cookies.ledger_dev && cookies.ledger_dev === makeDevToken()) return true;
  return String(providedDevPassword(req)) === expectedDevPassword();
}

function rejectDevUnauthorized(res) {
  return res.status(401).json({ error: "unauthorized" });
}

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
    alphaVantageRole:
      sourceRole("alpha_vantage") || "analyst_target_specialist_news_fallback",
    twelveDataUsedToday: twelveUsed,
    twelveDataLimit: DAILY_TWELVE_LIMIT,
    twelveDataRole:
      sourceRole("twelve_data") || "price_indicators_discovery_primary",
    twelveDataConfigured: twelveAvailable,
    finnhubUsedToday: finnhubUsed,
    finnhubLimitPerMinute: DATA_SOURCES.finnhub.rateLimit.limit,
    finnhubSoftCapPerMinute: DATA_SOURCES.finnhub.rateLimit.softCap,
    finnhubRateDelayTriggeredToday: finnhubDelayTriggered,
    finnhubRole: sourceRole("finnhub") || "peers_and_earnings_primary",
    marketauxUsedToday: marketauxUsed,
    marketauxLimit: DAILY_MARKETAUX_LIMIT,
    marketauxRole: sourceRole("marketaux") || "news_primary",
    marketauxConfigured: hasSourceKey("marketaux"),
    geminiUsedToday: geminiUsed,
    geminiLimit: null,
    geminiRole: sourceRole("gemini") || "synthesis_default",
    geminiLimitNote:
      "Free-tier daily limit unclear externally — tracked empirically via api_usage",
    claudeUsedToday: await getUsageToday(PROVIDERS.CLAUDE),
    claudeConfigured: hasSourceKey("claude"),
    claudeRole: sourceRole("claude") || "manual_deeper_look_only",
    aiProviderDefault: resolveProviderId(),
    aiProviders: listProviders(),
    newSearchesAvailableToday,
    sourcesLegend: sourcesLegend(),
    lastBoardRefresh: await getSetting("lastBoardRefresh"),
    boardRefreshStatus: await getSetting("lastBoardRefreshStatus"),
    lastCapabilityProbe: await getLastCapabilityProbe(),
    lastCapabilityProbeAt: await getSetting("lastCapabilityProbeAt"),
    boardMaxSize: BOARD_MAX_SIZE,
    boardLiveCount: await countLiveBoard(),
    lastHotStockDiscoveryAt: await getSetting("lastHotStockDiscoveryAt"),
    lastHotStockDiscoveryStatus: await getSetting("lastHotStockDiscoveryStatus"),
    // Cached only — never spend Gemini on status polls
    marketMood: await loadMood(),
    didYouKnow: await getTodaysTidbit().catch(() => null),
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
    const placeholders = LIVE_BOARD_STATUSES.map(() => "?").join(", ");
    const picks = await dbAll(
      `SELECT ticker, status, added_at, sector, source, discovery_blurb
       FROM board_picks
       WHERE status IN (${placeholders})
       ORDER BY added_at DESC`,
      LIVE_BOARD_STATUSES
    );

    const board = [];
    for (const pick of picks) {
      const report = await reportFromCache(pick.ticker, mode);
      if (report) {
        report.discoveryBlurb = pick.discovery_blurb || null;
        report.source = pick.source || null;
        const deeper = await getDeeperLook(pick.ticker);
        report.deeperLook = deeper
          ? {
              provider: deeper.provider,
              generatedAt: deeper.generatedAt,
              analysis: deeper.long || deeper.short,
            }
          : null;
      }
      board.push({
        ...pick,
        report,
      });
    }

    return res.json(board);
  } catch (err) {
    console.error("[GET /api/board]", err.message);
    return res.status(500).json({ error: "Failed to load board picks." });
  }
});

app.post("/api/stock/:ticker/deeper-look", async (req, res) => {
  try {
    const ticker = String(req.params.ticker || "")
      .trim()
      .toUpperCase();
    if (!ticker) {
      return res.status(400).json({ error: "Ticker is required." });
    }
    const mode = normalizeMode(req.body?.mode || req.query.mode);
    const result = await requestDeeperLook(ticker, { mode });
    return res.json(result);
  } catch (err) {
    console.error("[POST deeper-look]", err.message);
    if (err.code === "not_configured") {
      return res.status(503).json({ error: err.message, code: err.code });
    }
    if (err.code === "no_data") {
      return res.status(404).json({ error: err.message, code: err.code });
    }
    return res.status(500).json({
      error: "Deeper look failed.",
      detail: err.message,
    });
  }
});

app.get("/api/stock/:ticker/deeper-look", async (req, res) => {
  try {
    const ticker = String(req.params.ticker || "")
      .trim()
      .toUpperCase();
    const deeper = await getDeeperLook(ticker);
    if (!deeper) return res.status(404).json({ error: "No deeper look yet." });
    return res.json(deeper);
  } catch (err) {
    console.error("[GET deeper-look]", err.message);
    return res.status(500).json({ error: "Failed to load deeper look." });
  }
});

app.get("/api/archive", async (req, res) => {
  try {
    const mode = normalizeMode(req.query.mode);
    const picks = await listArchivedBoardPicks();
    const archive = [];
    for (const pick of picks) {
      archive.push({
        ...pick,
        report: await reportFromCache(pick.ticker, mode),
      });
    }
    return res.json(archive);
  } catch (err) {
    console.error("[GET /api/archive]", err.message);
    return res.status(500).json({ error: "Failed to load archive." });
  }
});

app.post("/api/discovery/run", async (req, res) => {
  try {
    const dryRun = Boolean(req.body?.dryRun);
    const result = await discoverHotStocks({
      dryRun,
      maxNew: req.body?.maxNew,
      warmReports: req.body?.warmReports !== false,
    });
    try {
      await recordJobRun("weekly_discovery", {
        ok: Boolean(result?.ok !== false),
        summary: dryRun
          ? `manual dryRun · ${JSON.stringify(result?.summary || result).slice(0, 180)}`
          : `manual run · ${JSON.stringify(result?.summary || result).slice(0, 180)}`,
        detail: result,
      });
    } catch {
      /* ignore */
    }
    return res.json(result);
  } catch (err) {
    console.error("[POST /api/discovery/run]", err.message);
    return res.status(500).json({ error: "Discovery run failed.", detail: err.message });
  }
});

app.get("/archive", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "archive.html"));
});

/** Dev-only status page (password gated via API; HTML itself has no password). */
app.get("/dev-status", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dev-status.html"));
});

app.post("/api/dev/login", (req, res) => {
  if (String(req.body?.password || "") !== expectedDevPassword()) {
    return rejectDevUnauthorized(res);
  }
  const token = makeDevToken();
  res.setHeader(
    "Set-Cookie",
    `ledger_dev=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`
  );
  return res.json({ ok: true });
});

app.post("/api/dev/logout", (req, res) => {
  res.setHeader(
    "Set-Cookie",
    "ledger_dev=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
  );
  return res.json({ ok: true });
});

async function buildDevStatusPayload() {
  const sources = [];
  for (const src of Object.values(DATA_SOURCES)) {
    const used = await getUsageToday(src.id);
    const limit = src.rateLimit?.limit ?? null;
    const reserve = smartRefreshReserve(src.id);
    const remaining =
      limit == null ? null : Math.max(0, Number(limit) - Number(used || 0));
    const smartAvailable =
      remaining == null ? null : Math.max(0, remaining - reserve);
    sources.push({
      id: src.id,
      label: src.label,
      shortCode: src.shortCode,
      role: src.role,
      used,
      limit,
      remaining,
      smartRefreshReserve: reserve,
      smartRefreshAvailable: smartAvailable,
      configured: hasSourceKey(src.id),
      notes: src.notes || null,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    lastBoardRefresh: await getSetting("lastBoardRefresh"),
    boardRefreshStatus: await getSetting("lastBoardRefreshStatus"),
    lastSmartRefresh: await getSetting("lastSmartRefresh"),
    lastSmartRefreshStatus: await getSetting("lastSmartRefreshStatus"),
    lastForceRefresh: await getSetting("lastForceRefresh"),
    lastForceRefreshStatus: await getSetting("lastForceRefreshStatus"),
    forceRefresh: getForceRefreshState(),
    smartRefresh: getForceRefreshState(),
    sources,
    lastCallByProvider: await getLastCallByProvider(),
    recentCalls: await getRecentApiCalls(30),
    jobs: await listJobStatuses(),
    boardLiveCount: await countLiveBoard(),
    boardMaxSize: BOARD_MAX_SIZE,
    resetsAt: nextMidnightPacificIso(),
  };
}

app.get("/api/dev/status", async (req, res) => {
  if (!devAuthOk(req)) return rejectDevUnauthorized(res);
  try {
    return res.json(await buildDevStatusPayload());
  } catch (err) {
    console.error("[GET /api/dev/status]", err.message);
    return res.status(500).json({ error: "Failed to load dev status." });
  }
});

async function handleSmartRefresh(req, res) {
  if (!devAuthOk(req)) return rejectDevUnauthorized(res);
  try {
    const state = getForceRefreshState();
    if (state.inProgress) {
      return res.status(409).json({
        ok: false,
        alreadyRunning: true,
        startedAt: state.startedAt,
        message: "Smart refresh already in progress.",
        lastResult: state.lastResult,
      });
    }
    const result = await forceRefreshAll();
    if (result.alreadyRunning) {
      return res.status(409).json(result);
    }
    return res.json(result);
  } catch (err) {
    console.error("[POST smart-refresh]", err.message);
    return res.status(500).json({
      ok: false,
      error: "Smart refresh failed.",
      detail: err.message,
    });
  }
}

app.post("/api/admin/force-refresh", handleSmartRefresh);
app.post("/api/admin/smart-refresh", handleSmartRefresh);

app.get("/api/admin/force-refresh", async (req, res) => {
  if (!devAuthOk(req)) return rejectDevUnauthorized(res);
  return res.json(getForceRefreshState());
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
  try {
    await ensureDeeperLookTable();
  } catch (err) {
    console.warn("[startup] deeper look table:", err.message);
  }
  try {
    await ensureApiCallLogTable();
  } catch (err) {
    console.warn("[startup] api_call_log table:", err.message);
  }

  app.listen(PORT, () => {
    console.log(`Ledger server listening on http://localhost:${PORT}`);

    cron.schedule("0 7 * * *", () => {
      (async () => {
        // One shared report per ticker (short + long takes in the same Gemini call).
        const board = await refreshBoard();
        await resolveOldRecommendations();
        let moodOk = true;
        let tidbitOk = true;
        try {
          const { refreshMarketMood } = require("./services/marketMood");
          await refreshMarketMood();
        } catch (err) {
          moodOk = false;
          console.error("[cron marketMood]", err.message);
        }
        try {
          const { ensureTidbitBatch } = require("./services/didYouKnow");
          await ensureTidbitBatch();
        } catch (err) {
          tidbitOk = false;
          console.error("[cron didYouKnow]", err.message);
        }
        await recordJobRun("daily_board_refresh", {
          ok: board?.boardRefreshStatus !== "failed" &&
            board?.boardRefreshStatus !== "failed_rate_limit",
          summary: `board=${board?.boardRefreshStatus}; ok=${board?.successes}/${board?.tickerCount}; mood=${moodOk ? "ok" : "fail"}; tidbits=${tidbitOk ? "ok" : "fail"}`,
          detail: {
            board,
            moodOk,
            tidbitOk,
          },
        });
      })().catch(async (err) => {
        console.error("[cron refreshBoard]", err.message);
        try {
          await recordJobRun("daily_board_refresh", {
            ok: false,
            summary: `failed: ${err.message}`,
          });
        } catch {
          /* ignore */
        }
      });
    });
    console.log(
      "[cron] Scheduled refreshBoard + resolve + marketMood + didYouKnow batch check daily at 07:00"
    );

    cron.schedule("0 4 1 * *", () => {
      (async () => {
        const result = await cleanupStaleCache();
        await recordJobRun("monthly_cleanup_probe", {
          ok: true,
          summary: `deleted≈${result?.deleted ?? "?"} · probe=${result?.capabilityProbe ? "ran" : "n/a"}`,
          detail: result,
        });
      })().catch(async (err) => {
        console.error("[cron cleanupStaleCache]", err.message);
        try {
          await recordJobRun("monthly_cleanup_probe", {
            ok: false,
            summary: `failed: ${err.message}`,
          });
        } catch {
          /* ignore */
        }
      });
    });
    console.log(
      "[cron] Scheduled cleanupStaleCache + joke pool + capabilityProbe monthly (1st, 04:00)"
    );

    // Weekly hot-stock discovery (Sundays 06:00) — OFF until manually enabled.
    // Uses Twelve Data market_movers; archives weakest when over BOARD_MAX_SIZE.
    // cron.schedule("0 6 * * 0", () => {
    //   discoverHotStocks()
    //     .then((r) => console.log("[cron discoverHotStocks]", r?.ok ? "ok" : r?.error))
    //     .catch((err) => console.error("[cron discoverHotStocks]", err.message));
    // });
    console.log(
      "[cron] discoverHotStocks weekly schedule is DISABLED (commented) — enable when ready"
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
