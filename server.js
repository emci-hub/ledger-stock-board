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
  previewSmartRefresh,
} = require("./jobs/forceRefreshAll");
const { invalidateBoardStaleCaches } = require("./jobs/invalidateBoardCache");
const { getAdminActionLock } = require("./services/adminActionLock");
const {
  getApiUsageToday,
  getUsageToday,
  nextMidnightPacificIso,
  getSetting,
  setSetting,
  PROVIDERS,
} = require("./services/usage");
const { AlphaVantageError } = require("./services/dataFetch");
const {
  DATA_SOURCES,
  hasSourceKey,
  sourcesLegend,
  sourcesRegistryRows,
  sourceRole,
  smartRefreshReserve,
} = require("./lib/dataSources");
const { getLastCapabilityProbe } = require("./jobs/capabilityProbe");
const { discoverHotStocks, previewDiscovery, computePromotionBudget } = require("./jobs/discoverHotStocks");
const {
  listArchivedBoardPicks,
  listArchiveBrowse,
  listLiveBoardPicks,
  listBoardDisplayPicks,
  BOARD_MAX_SIZE,
  countLiveBoard,
  countCandidates,
  getActiveBoardTickers,
  CANDIDATE_POOL_CAP,
  getPick,
} = require("./lib/boardPicks");
const {
  getAnalyzeAvailability,
  analyzeTickers,
  analyzeNext,
  analyzeAllRemaining,
} = require("./jobs/manualAnalyze");
const { retryMorningFailures } = require("./jobs/retryMorningFailures");
const { LIVE_BOARD_STATUSES } = require("./lib/boardTickers");
const {
  assessBoardPlacement,
  BOARD_SECTIONS,
  partitionBoardBySection,
  buildSectionPayload,
} = require("./lib/rankingStability");
const { getMarketMood, loadMood } = require("./services/marketMood");
const { getTodaysTidbit } = require("./services/didYouKnow");
const {
  getDeeperLook,
  requestDeeperLook,
  ensureDeeperLookTable,
  isDeeperLookEnabled,
  getDeeperLookSetting,
  setDeeperLookEnabled,
  clearFailedDeeperLooks,
} = require("./services/deeperLook");
const { resolveProviderId, listProviders } = require("./lib/aiProvider");
const {
  ensureApiCallLogTable,
  getRecentApiCalls,
  getLastCallByProvider,
} = require("./services/apiCallLog");
const { listJobStatuses, recordJobRun } = require("./services/jobRuns");
const {
  getBoardSectionHealth,
  validateBoardSectionIntegrity,
  reclassifyLiveBoard,
  syncBoardSectionsAfterJob,
} = require("./services/boardSectionService");

const app = express();
const PORT = 3000;
const DAILY_AV_LIMIT = DATA_SOURCES.alpha_vantage.rateLimit.limit;
/** Alpha Vantage is mostly reserved for NEWS_SENTIMENT (~1 call / search when news is stale). */
const AV_CALLS_PER_SEARCH_NEWS = 1;
const DAILY_TWELVE_LIMIT = DATA_SOURCES.twelve_data.rateLimit.limit;
const DAILY_MARKETAUX_LIMIT = DATA_SOURCES.marketaux.rateLimit.limit;
/** Typical Twelve Data cost per search: time_series only (target is Alpha Vantage OVERVIEW). */
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
  const fmpUsed = await getUsageToday(PROVIDERS.FMP);
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

  // Registry-driven usage rows — footer legend + header usage stay automatic.
  const sourcesUsage = [];
  for (const row of sourcesRegistryRows()) {
    const used = await getUsageToday(row.id);
    sourcesUsage.push({
      ...row,
      used,
      remaining:
        row.limit == null ? null : Math.max(0, Number(row.limit) - Number(used || 0)),
    });
  }

  return {
    alphaVantageUsedToday: alphaUsed,
    alphaVantageLimit: DAILY_AV_LIMIT,
    alphaVantageRole:
      sourceRole("alpha_vantage") || "analyst_target_and_parallel_news",
    twelveDataUsedToday: twelveUsed,
    twelveDataLimit: DAILY_TWELVE_LIMIT,
    twelveDataRole: sourceRole("twelve_data") || "price_indicators_primary",
    twelveDataConfigured: twelveAvailable,
    fmpUsedToday: fmpUsed,
    fmpLimit: DATA_SOURCES.fmp.rateLimit.limit,
    fmpRole: sourceRole("fmp") || "discovery_primary",
    fmpConfigured: hasSourceKey("fmp"),
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
    deeperLookEnabled: await isDeeperLookEnabled(),
    aiProviderDefault: resolveProviderId(),
    aiProviders: listProviders(),
    newSearchesAvailableToday,
    sourcesLegend: sourcesLegend(),
    sourcesUsage,
    lastBoardRefresh: await getSetting("lastBoardRefresh"),
    boardRefreshStatus: await getSetting("lastBoardRefreshStatus"),
    lastCapabilityProbe: await getLastCapabilityProbe(),
    lastCapabilityProbeAt: await getSetting("lastCapabilityProbeAt"),
    boardMaxSize: BOARD_MAX_SIZE,
    boardLiveCount: await countLiveBoard(),
    boardCandidateCount: await countCandidates(),
    candidatePoolCap: CANDIDATE_POOL_CAP,
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

/**
 * Attach boardSection placement onto a live pick + report.
 * Category-local sectionRank only — never cross-wire ranks between sections.
 */
function applyPlacementToBoardRow(pick, report, mode) {
  const placement = assessBoardPlacement(pick, report || {});
  if (report) {
    report.discoveryBlurb = pick.discovery_blurb || null;
    report.source = pick.source || null;
    report.exchange = pick.exchange || report.exchange || null;
    report.boardSection = placement.boardSection;
    report.sectionRank = placement.sectionRank;
    report.longTermRankRaw = placement.longTermRankRaw;
    report.longTermRank = placement.longTermRankAdjusted;
    report.shortTermRank =
      report.shortTermRank != null
        ? Number(report.shortTermRank)
        : placement.shortTermRank;
    report.pennyVolatileRank = placement.pennyVolatileRank;
    report.longTermEligible = placement.longTermEligible;
    report.momentumSection = placement.momentumSection;
    report.stabilityWarnings = placement.warnings;
    report.trackedSince = placement.trackedSince;
    report.trackedDays = placement.trackedDays;
    report.longTermPenalties = placement.penalties;
    // Display rankScore is always this row's own sectionRank (never another category's).
    report.rankScore = placement.sectionRank;

    // Long-term screen (stock-alert-spec.md) — ignore/watch/add/avoid verdict,
    // computed by jobs/refreshBoard.js (services/longTermScreen.js) and read
    // here from board_picks, never computed live in this request path.
    if (placement.boardSection === BOARD_SECTIONS.LONG) {
      report.longTermVerdict = pick.long_term_verdict || null;
      report.primaryTicker = pick.primary_ticker || pick.ticker;
      report.primaryExchange = pick.primary_exchange || null;
      report.longTermDetail = null;
      if (pick.long_term_detail_json) {
        try {
          report.longTermDetail = JSON.parse(pick.long_term_detail_json);
        } catch {
          report.longTermDetail = null;
        }
      }
    }
  }
  return {
    ...pick,
    tracked_since: pick.tracked_since || pick.added_at || null,
    boardSection: placement.boardSection,
    sectionRank: placement.sectionRank,
    longTermEligible: placement.longTermEligible,
    momentumSection: placement.momentumSection,
    stabilityWarnings: placement.warnings,
    report,
  };
}

/**
 * Long-term screen sort key (stock-alert-spec.md): largest qualifying drop
 * first, replacing the retired AI-generated longTermRank. Uses whichever
 * drop measure is larger in magnitude (63-day-high vs. T-1→T+5 event window)
 * — the one stock-pipeline.md's ASSESS stage ranks Long candidates by.
 */
function longTermDropRankValue(detail) {
  const eventPct = detail?.dropSignals?.eventWindow?.pctChange;
  const highPct = detail?.dropSignals?.high63?.pctBelowHigh;
  const magnitudes = [eventPct, highPct]
    .filter((n) => Number.isFinite(n))
    .map((n) => Math.abs(n));
  return magnitudes.length ? Math.max(...magnitudes) : 0;
}

/** Re-sort a buildSectionPayload() result's fresh items by drop size — Long only. */
function resortLongSectionByDrop(section) {
  const sorted = [...section.items].sort(
    (a, b) =>
      longTermDropRankValue(b.report?.longTermDetail) -
      longTermDropRankValue(a.report?.longTermDetail)
  );
  return {
    ...section,
    items: sorted,
    spotlight: sorted.slice(0, 3),
    rest: sorted.slice(3),
  };
}

app.get("/api/board", async (req, res) => {
  try {
    const mode = normalizeMode(req.query.mode);
    // Display universe = live + archived (boardSection organizes). Not candidates.
    const picks = await listBoardDisplayPicks();
    const deeperEnabled = await isDeeperLookEnabled();

    // PERFORMANCE FIX (2026-08-17): was a sequential for-loop, doing 3 DB
    // round-trips per ticker one at a time. Raising ARCHIVE_MAX_SIZE to 200
    // earlier tonight meant this could become 600+ sequential round-trips
    // per page load. Parallelized with Promise.all — each ticker's fetch is
    // fully independent (no shared state between iterations), so this is
    // safe: same per-ticker logic, same final order (Promise.all preserves
    // array index order regardless of which fetch finishes first).
    const boardRows = await Promise.all(
      picks.map(async (pick) => {
        const report = await reportFromCache(pick.ticker, mode);
        // Skip rows with no cached report — candidates shouldn't appear;
        // archived without cache would only create empty/unclassifiable
        // placeholders.
        if (!report) return null;
        if (deeperEnabled) {
          const deeper = await getDeeperLook(pick.ticker);
          report.deeperLook = deeper
            ? {
                provider: deeper.provider,
                generatedAt: deeper.generatedAt,
                analysis: deeper.long || deeper.short,
              }
            : null;
        } else {
          report.deeperLook = null;
        }
        return applyPlacementToBoardRow(pick, report, mode);
      })
    );
    const board = boardRows.filter(Boolean);

    const partitioned = partitionBoardBySection(board);
    const sections = {
      long: resortLongSectionByDrop(
        buildSectionPayload(partitioned[BOARD_SECTIONS.LONG])
      ),
      short: buildSectionPayload(partitioned[BOARD_SECTIONS.SHORT]),
      penny: buildSectionPayload(partitioned[BOARD_SECTIONS.PENNY]),
    };

    // Unclassified (needs backfill) stay off the three display buckets.
    const displayBoard = board.filter(
      (row) =>
        row.boardSection === BOARD_SECTIONS.LONG ||
        row.boardSection === BOARD_SECTIONS.SHORT ||
        row.boardSection === BOARD_SECTIONS.PENNY
    );

    return res.json({
      mode,
      sections,
      /** Flat list kept for diagnostics; UI must render from sections only. */
      board: displayBoard,
      unclassified: (partitioned[BOARD_SECTIONS.UNCLASSIFIED] || []).map(
        (row) => row.ticker
      ),
    });
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
    if (err.code === "disabled") {
      return res.status(403).json({ error: err.message, code: err.code });
    }
    if (err.code === "not_configured") {
      return res.status(503).json({ error: err.message, code: err.code });
    }
    if (err.code === "no_data") {
      return res.status(404).json({ error: err.message, code: err.code });
    }
    return res.status(500).json({
      error: "Deeper look failed.",
      detail: err.message,
      code: err.code || "claude_failed",
      kind: err.claudeKind || null,
      permanent: Boolean(err.claudePermanent),
    });
  }
});

app.get("/api/stock/:ticker/deeper-look", async (req, res) => {
  try {
    if (!(await isDeeperLookEnabled())) {
      return res.status(404).json({ error: "Deeper Look is disabled." });
    }
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
    // Cheap-signal browse: candidates + archived (zero live API cost).
    // Legacy ?legacy=1 returns the old archived+report shape.
    if (req.query.legacy === "1") {
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
    }
    const browse = await listArchiveBrowse();
    let availability = null;
    try {
      availability = await getAnalyzeAvailability();
    } catch (err) {
      console.warn("[GET /api/archive] availability:", err.message);
    }
    return res.json({ ...browse, availability });
  } catch (err) {
    console.error("[GET /api/archive]", err.message);
    return res.status(500).json({ error: "Failed to load archive." });
  }
});

app.get("/api/analyze/availability", async (req, res) => {
  try {
    return res.json(await getAnalyzeAvailability());
  } catch (err) {
    console.error("[GET /api/analyze/availability]", err.message);
    return res.status(500).json({ error: "Failed to load analyze availability." });
  }
});

/**
 * Manual / bulk Analyze — spends remaining promotion budget.
 * Auth: SEARCH_PASSWORD (same gate as live search pulls).
 * Body: { password, tickers?: string[], count?: number, allRemaining?: boolean }
 */
app.post("/api/analyze", async (req, res) => {
  if (!searchPasswordOk(req.body?.password || req.headers["x-search-password"])) {
    return res.status(401).json({ error: "locked" });
  }
  try {
    const lock = getAdminActionLock();
    if (lock.inProgress) {
      return res.status(409).json({
        ok: false,
        alreadyRunning: true,
        action: lock.action,
        startedAt: lock.startedAt,
        message: lock.message,
      });
    }

    let result;
    if (req.body?.allRemaining) {
      result = await analyzeAllRemaining();
    } else if (Array.isArray(req.body?.tickers) && req.body.tickers.length) {
      result = await analyzeTickers(req.body.tickers);
    } else if (req.body?.count != null || req.body?.next) {
      result = await analyzeNext(Number(req.body.count) || 5);
    } else {
      return res.status(400).json({
        error: "Provide tickers[], count, or allRemaining.",
      });
    }

    if (result?.alreadyRunning) {
      return res.status(409).json(result);
    }
    return res.json(result);
  } catch (err) {
    console.error("[POST /api/analyze]", err.message);
    return res.status(500).json({
      ok: false,
      error: "Analyze failed.",
      detail: err.message,
    });
  }
});

app.post("/api/discovery/run", async (req, res) => {
  if (!devAuthOk(req)) return rejectDevUnauthorized(res);
  try {
    const preview = Boolean(req.body?.preview || req.body?.dryRun);
    const confirm = Boolean(req.body?.confirm);
    if (preview && !confirm) {
      const result = await previewDiscovery({
        maxNew: req.body?.maxNew,
      });
      return res.json(result);
    }
    const result = await discoverHotStocks({
      dryRun: false,
      maxNew: req.body?.maxNew,
      warmReports: req.body?.warmReports !== false,
    });
    try {
      await recordJobRun("daily_discovery", {
        ok: Boolean(result?.ok !== false && !result?.skipped),
        summary: result?.skipped
          ? `manual skipped · ${result.reason || "quota"}`
          : `manual run · added=${Array.isArray(result?.added) ? result.added.length : 0}`,
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

app.post("/api/admin/discovery", async (req, res) => {
  if (!devAuthOk(req)) return rejectDevUnauthorized(res);
  try {
    const preview = Boolean(req.body?.preview) || !Boolean(req.body?.confirm);
    if (preview && !req.body?.confirm) {
      return res.json(await previewDiscovery({ maxNew: req.body?.maxNew }));
    }
    const lock = getAdminActionLock();
    if (lock.inProgress) {
      return res.status(409).json({
        ok: false,
        alreadyRunning: true,
        action: lock.action,
        startedAt: lock.startedAt,
        message: lock.message,
      });
    }
    const result = await discoverHotStocks({
      dryRun: false,
      maxNew: req.body?.maxNew,
      warmReports: req.body?.warmReports !== false,
    });
    if (result?.alreadyRunning) {
      return res.status(409).json(result);
    }
    try {
      await recordJobRun("daily_discovery", {
        ok: Boolean(result?.ok !== false && !result?.skipped),
        summary: result?.skipped
          ? `admin skipped · ${result.reason || "quota"}`
          : `admin run · added=${Array.isArray(result?.added) ? result.added.length : 0}`,
        detail: result,
      });
    } catch {
      /* ignore */
    }
    return res.json(result);
  } catch (err) {
    console.error("[POST /api/admin/discovery]", err.message);
    return res.status(500).json({
      ok: false,
      error: "Discovery run failed.",
      detail: err.message,
    });
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
  for (const row of sourcesRegistryRows()) {
    const used = await getUsageToday(row.id);
    const remaining =
      row.limit == null ? null : Math.max(0, Number(row.limit) - Number(used || 0));
    const smartAvailable =
      remaining == null
        ? null
        : Math.max(0, remaining - Number(row.smartRefreshReserve || 0));
    sources.push({
      ...row,
      used,
      remaining,
      smartRefreshAvailable: smartAvailable,
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
    adminActionLock: getAdminActionLock(),
    deeperLook: await getDeeperLookSetting(),
    sources,
    lastCallByProvider: await getLastCallByProvider(),
    recentCalls: await getRecentApiCalls(30),
    jobs: await listJobStatuses(),
    boardLiveCount: await countLiveBoard(),
    boardMaxSize: BOARD_MAX_SIZE,
    boardCandidateCount: await countCandidates(),
    candidatePoolCap: CANDIDATE_POOL_CAP,
    discoveryPromotionBudget: await computePromotionBudget().catch(() => null),
    lastHotStockDiscoveryAt: await getSetting("lastHotStockDiscoveryAt"),
    lastHotStockDiscoveryStatus: await getSetting("lastHotStockDiscoveryStatus"),
    lastHotStockDiscovery: await getSetting("lastHotStockDiscovery"),
    boardSectionHealth: await getBoardSectionHealth().catch((err) => ({
      status: "error",
      ok: false,
      error: err.message,
    })),
    categorySummary: await buildCategorySummary().catch((err) => ({
      error: err.message,
    })),
    nullPriceCandidates: await buildNullPriceCandidatesReport().catch((err) => ({
      error: err.message,
    })),
    resetsAt: nextMidnightPacificIso(),
  };
}

/**
 * Compact per-section ticker summary for /dev-status — reuses the exact same
 * data + classification functions as /api/board (listBoardDisplayPicks,
 * reportFromCache, applyPlacementToBoardRow, partitionBoardBySection), just
 * a second lightweight call, so this can never drift out of sync with what
 * the public board actually shows.
 */
/**
 * Diagnostic panel (2026-08-19), per explicit request — surfaces candidates
 * with null price/percent_change (mostly factor/tier-sourced candidates
 * that don't get a daily price refresh yet — a known, deliberately
 * deferred gap, not a bug). For manual review, not a functional fix.
 */
async function buildNullPriceCandidatesReport() {
  const rows = await dbAll(
    `SELECT ticker, source, tier, factor_tag, discovered_at, last_seen_at
     FROM board_picks
     WHERE status = 'candidate' AND (price IS NULL OR percent_change IS NULL)
     ORDER BY discovered_at DESC
     LIMIT 500`
  );
  return {
    count: rows.length,
    tickers: rows.map((r) => ({
      ticker: r.ticker,
      source: r.source,
      tier: r.tier,
      factorTag: r.factor_tag,
      discoveredAt: r.discovered_at,
      lastSeenAt: r.last_seen_at,
    })),
  };
}

async function buildCategorySummary() {
  const picks = await listBoardDisplayPicks();
  const board = [];
  for (const pick of picks) {
    const report = await reportFromCache(pick.ticker, "long");
    if (!report) continue;
    board.push(applyPlacementToBoardRow(pick, report, "long"));
  }
  const partitioned = partitionBoardBySection(board);
  const summarize = (rows) =>
    (rows || [])
      .slice()
      .sort((a, b) => (b.sectionRank || 0) - (a.sectionRank || 0))
      .map((r) => r.ticker);

  return {
    long: {
      count: (partitioned[BOARD_SECTIONS.LONG] || []).length,
      tickers: summarize(partitioned[BOARD_SECTIONS.LONG]),
    },
    short: {
      count: (partitioned[BOARD_SECTIONS.SHORT] || []).length,
      tickers: summarize(partitioned[BOARD_SECTIONS.SHORT]),
    },
    penny: {
      count: (partitioned[BOARD_SECTIONS.PENNY] || []).length,
      tickers: summarize(partitioned[BOARD_SECTIONS.PENNY]),
    },
    unclassified: {
      count: (partitioned[BOARD_SECTIONS.UNCLASSIFIED] || []).length,
      tickers: (partitioned[BOARD_SECTIONS.UNCLASSIFIED] || []).map(
        (r) => r.ticker
      ),
    },
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

/**
 * TEMPORARY — read-only check: which board_picks rows already have a
 * persisted long_term_verdict (i.e. refreshBoard has run against them since
 * the verdict pipeline shipped)? No external API calls, DB read only. Same
 * password gate as /api/dev/status. Remove once no longer needed.
 */
app.get("/api/dev/long-term-cache-check", async (req, res) => {
  if (!devAuthOk(req)) return rejectDevUnauthorized(res);
  try {
    const { dbAll } = require("./db/schema");
    const rows = await dbAll(
      `SELECT ticker, status, board_section, primary_ticker, primary_exchange,
              long_term_verdict, long_term_detail_json
       FROM board_picks
       WHERE long_term_verdict IS NOT NULL
       ORDER BY ticker
       LIMIT 10`
    );
    return res.json({
      count: rows.length,
      rows: rows.map((r) => ({
        ...r,
        long_term_detail_json: r.long_term_detail_json
          ? JSON.parse(r.long_term_detail_json)
          : null,
      })),
    });
  } catch (err) {
    console.error("[GET /api/dev/long-term-cache-check]", err.message);
    return res.status(500).json({ error: err.message });
  }
});

/** Reclassify live board from cache + run integrity self-check (dev only). */
app.post("/api/dev/board-section-check", async (req, res) => {
  if (!devAuthOk(req)) return rejectDevUnauthorized(res);
  try {
    const allowBackfill = Boolean(req.body?.allowBackfill);
    const reclass = await reclassifyLiveBoard({
      allowBackfill,
      updateStatus: Boolean(req.body?.updateStatus),
    });
    const check = await validateBoardSectionIntegrity({ recordJob: true });
    return res.json({ ok: check.ok, reclass, check });
  } catch (err) {
    console.error("[POST /api/dev/board-section-check]", err.message);
    return res.status(500).json({ error: err.message || "Board section check failed." });
  }
});

async function handleSmartRefresh(req, res) {
  if (!devAuthOk(req)) return rejectDevUnauthorized(res);
  try {
    const preview = Boolean(req.body?.preview) || !Boolean(req.body?.confirm);
    if (preview && !req.body?.confirm) {
      const result = await previewSmartRefresh();
      return res.json(result);
    }

    const lock = getAdminActionLock();
    if (lock.inProgress) {
      return res.status(409).json({
        ok: false,
        alreadyRunning: true,
        action: lock.action,
        startedAt: lock.startedAt,
        message: lock.message,
        lastResult: getForceRefreshState().lastResult,
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

app.post("/api/dev/deeper-look-enabled", async (req, res) => {
  if (!devAuthOk(req)) return rejectDevUnauthorized(res);
  try {
    const enabled = Boolean(req.body?.enabled);
    const result = await setDeeperLookEnabled(enabled);
    return res.json(result);
  } catch (err) {
    console.error("[POST /api/dev/deeper-look-enabled]", err.message);
    if (err.code === "not_configured") {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    if (err.code === "unhealthy") {
      return res.status(400).json({
        error: err.message,
        code: err.code,
        health: err.health || null,
      });
    }
    return res.status(500).json({ error: "Failed to update Deeper Look setting." });
  }
});

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
       LIMIT 20`
    );

    const recent = [];
    for (const row of rows) {
      const report = await reportFromCache(row.ticker, mode);
      if (!report) continue;
      let pick = null;
      try {
        pick = await getPick(row.ticker);
      } catch {
        pick = null;
      }
      const placement = assessBoardPlacement(pick || { ticker: row.ticker }, report);
      report.boardSection = placement.boardSection;
      report.sectionRank = placement.sectionRank;
      report.longTermEligible = placement.longTermEligible;

      // Gate recent list to the active tab's categories (no ungated cross-leak).
      if (mode === "long" && placement.boardSection !== BOARD_SECTIONS.LONG) {
        continue;
      }
      if (
        mode === "short" &&
        placement.boardSection !== BOARD_SECTIONS.SHORT &&
        placement.boardSection !== BOARD_SECTIONS.PENNY
      ) {
        continue;
      }

      recent.push({
        ticker: row.ticker,
        mode,
        boardSection: placement.boardSection,
        sectionRank: placement.sectionRank,
        lastUpdated: row.last_updated,
        report,
        raw: parseJsonSafe(row.data_json),
      });
      if (recent.length >= 10) break;
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
    await clearFailedDeeperLooks();
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
        // Discover first (board membership), then forced refresh fills/analyzes
        // the live set — same order as the intended Discover → Sort → Fetch pipeline.
        let discovery = null;
        try {
          discovery = await discoverHotStocks({ warmReports: true });
          console.log(
            "[cron discoverHotStocks]",
            discovery?.ok ? "ok" : discovery?.error || "done",
            discovery?.summary || ""
          );
          await recordJobRun("daily_discovery", {
            ok: Boolean(discovery?.ok !== false && !discovery?.error),
            summary: discovery?.error
              ? `failed: ${discovery.error}`
              : `added=${Array.isArray(discovery?.added) ? discovery.added.length : 0} · rePromoted=${Array.isArray(discovery?.rePromoted) ? discovery.rePromoted.length : 0} · archived=${Array.isArray(discovery?.archived) ? discovery.archived.length : 0}`,
            detail: discovery,
          });
        } catch (err) {
          console.error("[cron discoverHotStocks]", err.message);
          await recordJobRun("daily_discovery", {
            ok: false,
            summary: `failed: ${err.message}`,
          }).catch(() => {});
        }

        const board = await refreshBoard({ force: true });
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
          ok:
            board?.alreadyRunning !== true &&
            board?.boardRefreshStatus !== "failed" &&
            board?.boardRefreshStatus !== "failed_rate_limit",
          summary: `discovery=${discovery?.ok === false ? "fail" : "ok"}; board=${board?.boardRefreshStatus}; ok=${board?.successes}/${board?.tickerCount}; failures=${Array.isArray(board?.failures) ? board.failures.length : 0}; reserveSkips=${Array.isArray(board?.reserveSkips) ? board.reserveSkips.length : 0}; mood=${moodOk ? "ok" : "fail"}; tidbits=${tidbitOk ? "ok" : "fail"}`,
          detail: {
            discovery,
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
      "[cron] Scheduled discoverHotStocks then refreshBoard({force}) + resolve + marketMood + didYouKnow at 07:00 (quota-reserve + admin lock)"
    );

    // Lightweight 1pm retry — only morning failures, not a second full pass.
    cron.schedule("0 13 * * *", () => {
      (async () => {
        const result = await retryMorningFailures();
        console.log(
          "[cron retryMorningFailures]",
          result?.message || result?.reason || "done"
        );
      })().catch(async (err) => {
        console.error("[cron retryMorningFailures]", err.message);
        try {
          await recordJobRun("news_catchup_1pm", {
            ok: false,
            summary: `failed: ${err.message}`,
          });
        } catch {
          /* ignore */
        }
      });
    });
    console.log(
      "[cron] Scheduled 1pm morning-failure retry (retryMorningFailures) at 13:00"
    );

    // Standalone daily board-section integrity guardrail (cache-only; no market APIs).
    cron.schedule("15 8 * * *", () => {
      (async () => {
        const result = await syncBoardSectionsAfterJob("daily_cron");
        console.log(
          "[cron boardSectionSelfCheck]",
          result?.check?.ok === false
            ? "FAIL"
            : result?.error
              ? `error:${result.error}`
              : "ok",
          result?.reclass?.counts || ""
        );
      })().catch(async (err) => {
        console.error("[cron boardSectionSelfCheck]", err.message);
        try {
          await recordJobRun("board_section_self_check", {
            ok: false,
            summary: `failed: ${err.message}`,
          });
        } catch {
          /* ignore */
        }
      });
    });
    console.log(
      "[cron] Scheduled board section self-check daily at 08:15 (also runs after refresh/discovery/smart-refresh)"
    );

    cron.schedule("0 4 1 * *", () => {
      (async () => {
        const result = await cleanupStaleCache();
        await recordJobRun("monthly_cleanup_probe", {
          ok: true,
          summary: `deleted≈${result?.deleted ?? "?"} · archivePurged=${result?.archiveCleanup?.purged?.removed?.length ?? 0} · archiveTrimmed=${result?.archiveCleanup?.trimmed?.trimmed?.length ?? 0} · probe=${result?.capabilityProbe ? "ran" : "n/a"}`,
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
      } else {
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
      }

      // Heal live board tickers still missing a valid ai_reports row (e.g. JPM left
      // pending after an earlier fallback-heal). Price cache hits → Gemini only.
      const missHealKey = "missingAnalysisHeal_v1";
      const missAlready = await getSetting(missHealKey);
      if (missAlready) {
        console.log(`[startup] ${missHealKey} already done at ${missAlready}`);
        return;
      }
      const liveTickers = await getActiveBoardTickers();
      const missing = [];
      for (const ticker of liveTickers) {
        const summary = await getCachedSummary(ticker);
        if (!summary) missing.push(ticker);
      }
      if (!missing.length) {
        await setSetting(missHealKey, new Date().toISOString());
        console.log(`[startup] ${missHealKey}: nothing missing`);
        return;
      }
      console.log(
        `[startup] ${missHealKey}: re-analyzing ${missing.join(", ")}`
      );
      for (const ticker of missing) {
        try {
          await getStockReport(ticker, "long", { skipPeers: false });
        } catch (err) {
          console.warn(
            `[startup] ${missHealKey} failed for ${ticker}:`,
            err.message
          );
        }
      }
      await setSetting(missHealKey, new Date().toISOString());
      console.log(`[startup] ${missHealKey} complete`);
    })().catch((err) => {
      console.error("[startup] shared-cache heal failed:", err.message);
    });
  });
}

start().catch((err) => {
  console.error("[startup] Failed to start server:", err.message);
  process.exit(1);
});
