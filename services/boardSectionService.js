/**
 * Board section persistence + integrity self-check.
 *
 * Classification itself lives ONLY in lib/rankingStability.assessBoardPlacement.
 * This module persists the result, optionally backfills thin price history,
 * reclassifies the live board, and validates invariants after jobs.
 */

require("dotenv").config();

const { dbGet, dbAll, dbRun } = require("../db/schema");
const {
  assessBoardPlacement,
  BOARD_SECTIONS,
  SHORT_MIN_PRICE_BARS,
  statusFromBoardSection,
} = require("../lib/rankingStability");
const {
  getStockCacheEntry,
  saveStockToCache,
  getCachedSummary,
} = require("./cache");
const { buildReport } = require("./getStockReport");
const { getQuoteAndIndicators } = require("./dataFetch");
const { listLiveBoardPicks, getPick } = require("../lib/boardPicks");
const { setSetting, getSetting } = require("./usage");
const { recordJobRun } = require("./jobRuns");

const VALID_SECTIONS = new Set(Object.values(BOARD_SECTIONS));

function reportNeedsHistoryBackfill(report) {
  if (!report) return true;
  const bars =
    report.historyBars != null
      ? Number(report.historyBars)
      : Array.isArray(report.priceHistory)
        ? report.priceHistory.length
        : 0;
  const hasSma200 = (() => {
    const ind = report.indicators || {};
    const long = ind.long || ind;
    const v = long?.sma?.sma200 ?? long?.sma200;
    return v != null && Number.isFinite(Number(v));
  })();
  const ipo = report.ipoDate;
  const ipoOk = ipo && Number.isFinite(Date.parse(String(ipo)));
  // Backfill when we lack enough closes to classify reliably and have no IPO/SMA proof.
  return bars < SHORT_MIN_PRICE_BARS && !hasSma200 && !ipoOk;
}

async function buildReportForTicker(ticker, mode = "long") {
  const entry = await getStockCacheEntry(ticker);
  if (!entry?.data?.quote) return null;
  const analysis = await getCachedSummary(ticker);
  return buildReport(
    ticker,
    mode,
    entry.data,
    analysis,
    entry.data?.freshness?.priceUpdatedAt || entry.lastUpdated
  );
}

/**
 * Backfill up to ~252 daily bars via Twelve/AV quote path when cache is too thin.
 */
async function backfillPriceHistory(ticker) {
  const symbol = String(ticker).toUpperCase();
  console.log(`[boardSection] backfilling price history for ${symbol}`);
  const quote = await getQuoteAndIndicators(symbol);
  if (!quote) {
    return { ok: false, ticker: symbol, error: "quote_fetch_failed" };
  }
  const entry = await getStockCacheEntry(symbol);
  const raw = entry?.data || {
    quote: null,
    fundamentals: { overview: {}, news: [] },
    peers: [],
    freshness: {},
  };
  raw.quote = quote;
  raw.freshness = {
    ...(raw.freshness || {}),
    priceUpdatedAt: new Date().toISOString(),
  };
  await saveStockToCache(symbol, null, raw);
  return {
    ok: true,
    ticker: symbol,
    historyBars: quote.historyBars ?? quote.priceHistory?.length ?? null,
  };
}

async function persistBoardSection(ticker, boardSection) {
  const symbol = String(ticker).toUpperCase();
  if (!VALID_SECTIONS.has(boardSection)) {
    throw new Error(`invalid boardSection ${boardSection} for ${symbol}`);
  }
  await dbRun(`UPDATE board_picks SET board_section = ? WHERE ticker = ?`, [
    boardSection,
    symbol,
  ]);
}

/**
 * Classify one ticker via assessBoardPlacement (sole classifier) and persist.
 */
async function classifyAndPersistTicker(ticker, options = {}) {
  const symbol = String(ticker).toUpperCase();
  let pick = options.pick || (await getPick(symbol));
  if (!pick) pick = { ticker: symbol };

  let report = options.report || (await buildReportForTicker(symbol));
  let backfilled = false;

  if (
    options.allowBackfill !== false &&
    (!report || reportNeedsHistoryBackfill(report))
  ) {
    const bf = await backfillPriceHistory(symbol);
    backfilled = Boolean(bf.ok);
    report = (await buildReportForTicker(symbol)) || report;
  }

  if (!report) {
    // No data at all → penny/volatile (insufficient history).
    const placement = assessBoardPlacement(pick, {
      price: pick.price ?? null,
      changePercent: pick.percent_change ?? null,
      exchange: pick.exchange || null,
      priceHistory: [],
      historyBars: 0,
    });
    await persistBoardSection(symbol, placement.boardSection);
    return {
      ticker: symbol,
      boardSection: placement.boardSection,
      sectionRank: placement.sectionRank,
      backfilled,
      placement,
      error: "no_report",
    };
  }

  const placement = assessBoardPlacement(pick, report);
  await persistBoardSection(symbol, placement.boardSection);

  // Align live status with section (penny never recommended).
  if (options.updateStatus && report.analysis) {
    const status = statusFromBoardSection(
      report.analysis.lean,
      report.analysis.risk,
      placement.boardSection
    );
    await dbRun(`UPDATE board_picks SET status = ? WHERE ticker = ?`, [
      status,
      symbol,
    ]);
  }

  return {
    ticker: symbol,
    boardSection: placement.boardSection,
    sectionRank: placement.sectionRank,
    backfilled,
    placement,
  };
}

/**
 * Reclassify every live board ticker from cache (backfill only when too thin).
 */
async function reclassifyLiveBoard(options = {}) {
  const startedAt = new Date().toISOString();
  const picks = await listLiveBoardPicks();
  const results = [];
  const counts = { long: 0, short: 0, penny: 0 };

  for (const pick of picks) {
    try {
      const row = await classifyAndPersistTicker(pick.ticker, {
        pick,
        allowBackfill: options.allowBackfill !== false,
        updateStatus: options.updateStatus === true,
      });
      results.push(row);
      if (counts[row.boardSection] != null) counts[row.boardSection] += 1;
    } catch (err) {
      console.error(
        `[boardSection] reclassify failed ${pick.ticker}:`,
        err.message
      );
      results.push({
        ticker: pick.ticker,
        error: err.message,
        boardSection: null,
      });
    }
  }

  const summary = {
    ok: true,
    startedAt,
    finishedAt: new Date().toISOString(),
    total: picks.length,
    counts,
    backfilled: results.filter((r) => r.backfilled).map((r) => r.ticker),
    bySection: {
      long: results.filter((r) => r.boardSection === "long").map((r) => r.ticker),
      short: results
        .filter((r) => r.boardSection === "short")
        .map((r) => r.ticker),
      penny: results
        .filter((r) => r.boardSection === "penny")
        .map((r) => r.ticker),
    },
    errors: results.filter((r) => r.error).map((r) => ({
      ticker: r.ticker,
      error: r.error,
    })),
  };

  await setSetting("lastBoardSectionReclassify", JSON.stringify(summary));
  await setSetting("lastBoardSectionReclassifyAt", summary.finishedAt);
  return summary;
}

/**
 * Integrity self-check: every live ticker has exactly one valid section;
 * no penny/volatile signals sitting in long/short.
 */
async function validateBoardSectionIntegrity(options = {}) {
  const startedAt = new Date().toISOString();
  const picks = await listLiveBoardPicks();
  const mismatches = [];
  const missing = [];
  const invalid = [];
  const okRows = [];

  for (const pick of picks) {
    const report = await buildReportForTicker(pick.ticker);
    const placement = assessBoardPlacement(pick, report || {});
    const stored = pick.board_section || pick.boardSection || null;

    if (!stored) {
      missing.push({
        ticker: pick.ticker,
        computed: placement.boardSection,
      });
    } else if (!VALID_SECTIONS.has(stored)) {
      invalid.push({ ticker: pick.ticker, stored });
    } else if (stored !== placement.boardSection) {
      mismatches.push({
        ticker: pick.ticker,
        stored,
        computed: placement.boardSection,
        reason: {
          penny: placement.signals.penny,
          extremeMove: placement.signals.extremeMove,
          insufficientToClassify: placement.signals.insufficientToClassify,
          enoughRealHistory: placement.signals.enoughRealHistory,
        },
      });
    } else {
      okRows.push(pick.ticker);
    }

    // Hard invariant: penny criteria must never sit in long/short (computed).
    if (
      (placement.signals.penny ||
        placement.signals.extremeMove ||
        placement.signals.insufficientToClassify) &&
      placement.boardSection !== BOARD_SECTIONS.PENNY
    ) {
      mismatches.push({
        ticker: pick.ticker,
        stored,
        computed: placement.boardSection,
        fatal: true,
        detail: "penny/volatile criteria but not boardSection=penny",
      });
    }
  }

  const ok =
    mismatches.length === 0 && missing.length === 0 && invalid.length === 0;

  const result = {
    ok,
    startedAt,
    finishedAt: new Date().toISOString(),
    liveCount: picks.length,
    checkedOk: okRows.length,
    missing,
    invalid,
    mismatches,
  };

  if (!ok) {
    console.error(
      "[boardSection:SELF_CHECK_FAIL]",
      JSON.stringify({
        missing: missing.length,
        invalid: invalid.length,
        mismatches: mismatches.length,
        sample: mismatches.slice(0, 5),
      })
    );
  } else {
    console.log(
      `[boardSection:SELF_CHECK_OK] live=${picks.length} all sections consistent`
    );
  }

  await setSetting("lastBoardSectionSelfCheck", JSON.stringify(result));
  await setSetting("lastBoardSectionSelfCheckAt", result.finishedAt);
  await setSetting(
    "lastBoardSectionSelfCheckStatus",
    ok ? "ok" : "mismatch"
  );

  if (options.recordJob !== false) {
    await recordJobRun("board_section_self_check", {
      ok,
      summary: ok
        ? `ok · ${picks.length} tickers`
        : `FAIL · missing=${missing.length} mismatch=${mismatches.length} invalid=${invalid.length}`,
      detail: result,
    });
  }

  return result;
}

/**
 * Run after refresh/discovery/smart-refresh: re-persist sections then self-check.
 */
async function syncBoardSectionsAfterJob(jobLabel = "job") {
  try {
    const reclass = await reclassifyLiveBoard({
      allowBackfill: false,
      updateStatus: false,
    });
    const check = await validateBoardSectionIntegrity({ recordJob: true });
    console.log(
      `[boardSection] after ${jobLabel}: counts=${JSON.stringify(reclass.counts)} selfCheck=${check.ok ? "ok" : "FAIL"}`
    );
    return { reclass, check };
  } catch (err) {
    console.error(`[boardSection] sync after ${jobLabel} failed:`, err.message);
    await setSetting("lastBoardSectionSelfCheckStatus", "error");
    await setSetting(
      "lastBoardSectionSelfCheck",
      JSON.stringify({
        ok: false,
        error: err.message,
        finishedAt: new Date().toISOString(),
      })
    );
    return { error: err.message };
  }
}

async function getBoardSectionHealth() {
  const status = await getSetting("lastBoardSectionSelfCheckStatus");
  const at = await getSetting("lastBoardSectionSelfCheckAt");
  let detail = null;
  try {
    detail = JSON.parse((await getSetting("lastBoardSectionSelfCheck")) || "null");
  } catch {
    detail = null;
  }
  let reclass = null;
  try {
    reclass = JSON.parse(
      (await getSetting("lastBoardSectionReclassify")) || "null"
    );
  } catch {
    reclass = null;
  }
  return {
    status: status || "unknown",
    checkedAt: at || null,
    ok: status === "ok",
    detail,
    lastReclassify: reclass,
  };
}

module.exports = {
  classifyAndPersistTicker,
  reclassifyLiveBoard,
  validateBoardSectionIntegrity,
  syncBoardSectionsAfterJob,
  getBoardSectionHealth,
  backfillPriceHistory,
  reportNeedsHistoryBackfill,
  buildReportForTicker,
};
