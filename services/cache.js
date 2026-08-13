const { dbGet, dbRun } = require("../db/schema");

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Analyst targets change slowly — refresh at most every 3 days (was 24h). */
const TARGET_TTL_MS = 3 * 24 * 60 * 60 * 1000;
/** Earnings calendar — refresh weekly unless date is past. */
const EARNINGS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const FALLBACK_SUMMARY_SNIPPET = "wasn't available";

function isFresh(isoTimestamp, ttlMs = CACHE_TTL_MS) {
  if (!isoTimestamp) return false;
  const then = Date.parse(isoTimestamp);
  if (Number.isNaN(then)) return false;
  return Date.now() - then < ttlMs;
}

function emptyFreshness() {
  return {
    priceUpdatedAt: null,
    targetUpdatedAt: null,
    newsUpdatedAt: null,
    earningsUpdatedAt: null,
    identityCheckedAt: null,
  };
}

function freshnessFromData(data) {
  const f = data?.freshness || {};
  return {
    priceUpdatedAt: f.priceUpdatedAt || null,
    targetUpdatedAt: f.targetUpdatedAt || null,
    newsUpdatedAt: f.newsUpdatedAt || null,
    earningsUpdatedAt: f.earningsUpdatedAt || null,
    identityCheckedAt: f.identityCheckedAt || null,
  };
}

/** True when quote has post-merge short+long indicator windows. */
function hasSharedIndicatorShape(data) {
  const ind = data?.quote?.indicators;
  return Boolean(ind && typeof ind === "object" && ind.short && ind.long);
}

function isPriceFresh(data) {
  return (
    Boolean(data?.quote) &&
    hasSharedIndicatorShape(data) &&
    isFresh(freshnessFromData(data).priceUpdatedAt)
  );
}

function isTargetFresh(data) {
  const overview = data?.fundamentals?.overview || {};
  const price = overview.analystTargetPrice;
  // Null / missing target is never "fresh" — otherwise OVERVIEW misses stick for 3 days.
  if (price == null || !Number.isFinite(Number(price))) return false;
  // Live target is Alpha Vantage only — stale twelve_data labels must re-fetch via AV.
  if (
    overview.analystTargetSource &&
    overview.analystTargetSource !== "alpha_vantage"
  ) {
    return false;
  }
  return isFresh(freshnessFromData(data).targetUpdatedAt, TARGET_TTL_MS);
}

function isNewsFresh(data) {
  return isFresh(freshnessFromData(data).newsUpdatedAt);
}

function isEarningsDatePast(earningsDate) {
  if (!earningsDate) return true;
  const first = String(earningsDate).split(",")[0].trim();
  const t = Date.parse(first);
  if (Number.isNaN(t)) return true;
  const day = new Date(t);
  day.setHours(23, 59, 59, 999);
  return day.getTime() < Date.now();
}

function isEarningsFresh(data) {
  const overview = data?.fundamentals?.overview || {};
  const date = overview.earningsDate;
  if (!date || isEarningsDatePast(date)) return false;
  return isFresh(freshnessFromData(data).earningsUpdatedAt, EARNINGS_TTL_MS);
}

/** Fully skippable only when price, target, news, and earnings are all fresh. */
function isFullyFresh(data) {
  return (
    isPriceFresh(data) &&
    isTargetFresh(data) &&
    isNewsFresh(data) &&
    isEarningsFresh(data)
  );
}

function latestFreshnessIso(data) {
  const f = freshnessFromData(data);
  const times = [
    f.priceUpdatedAt,
    f.targetUpdatedAt,
    f.newsUpdatedAt,
    f.earningsUpdatedAt,
  ]
    .filter(Boolean)
    .map((t) => Date.parse(t))
    .filter((n) => !Number.isNaN(n));
  if (!times.length) return null;
  return new Date(Math.max(...times)).toISOString();
}

/** Board stale window: no field refresh within 48h while still on the live board. */
const BOARD_STALE_MS = 48 * 60 * 60 * 1000;

/**
 * True when none of the tracked fields (price/target/news/earnings/analysis)
 * have refreshed within BOARD_STALE_MS.
 */
function isBoardStale(data, analysisGeneratedAt = null) {
  const f = freshnessFromData(data || {});
  const times = [
    f.priceUpdatedAt,
    f.targetUpdatedAt,
    f.newsUpdatedAt,
    f.earningsUpdatedAt,
    analysisGeneratedAt,
  ]
    .filter(Boolean)
    .map((t) => Date.parse(t))
    .filter((n) => !Number.isNaN(n));
  if (!times.length) return true;
  return Date.now() - Math.max(...times) > BOARD_STALE_MS;
}

/**
 * Load shared cache row by ticker. Mode is display-only — ignored for storage.
 */
async function getStockCacheEntry(ticker, _mode) {
  const symbol = String(ticker).toUpperCase();
  const row = await dbGet(
    `SELECT data_json, last_updated FROM stock_reports WHERE ticker = ?`,
    [symbol]
  );

  if (!row) return null;

  try {
    const data = JSON.parse(row.data_json);
    let freshness = freshnessFromData(data);

    if (!data.freshness && row.last_updated && data.quote) {
      freshness = {
        priceUpdatedAt: row.last_updated,
        targetUpdatedAt:
          data?.fundamentals?.overview?.analystTargetPrice != null
            ? row.last_updated
            : null,
        newsUpdatedAt:
          Array.isArray(data?.fundamentals?.news) &&
          data.fundamentals.news.length > 0
            ? row.last_updated
            : null,
      };
      data.freshness = freshness;
    }

    return {
      data,
      lastUpdated: row.last_updated,
      freshness,
    };
  } catch {
    return null;
  }
}

async function getCachedStockRow(ticker, mode) {
  const entry = await getStockCacheEntry(ticker, mode);
  if (!entry || !isPriceFresh(entry.data)) return null;
  return {
    data: entry.data,
    lastUpdated: entry.freshness.priceUpdatedAt || entry.lastUpdated,
    freshness: entry.freshness,
  };
}

async function getCachedStock(ticker, mode) {
  const row = await getCachedStockRow(ticker, mode);
  return row ? row.data : null;
}

async function saveStockToCache(ticker, _mode, data) {
  const symbol = String(ticker).toUpperCase();
  const freshness = freshnessFromData(data);
  data.freshness = freshness;
  const now = latestFreshnessIso(data) || new Date().toISOString();

  await dbRun(
    `INSERT OR REPLACE INTO stock_reports (ticker, data_json, last_updated)
     VALUES (?, ?, ?)`,
    [symbol, JSON.stringify(data), now]
  );
  return now;
}

/**
 * Normalize dual-mode analysis (short + long + quip + mode ranks).
 * Legacy single takes become both modes.
 */
function normalizeDualAnalysis(parsed) {
  if (!parsed || typeof parsed !== "object") return null;

  const {
    normalizeLabel,
    normalizeLabelList,
  } = require("../lib/indicatorTags");
  const { parseRank, heuristicRank } = require("../lib/aiShape");

  function normalizeTake(take) {
    if (!take || typeof take !== "object") return null;
    return {
      lean: take.lean || "neutral",
      risk: take.risk || "medium",
      tags: normalizeLabelList(take.tags, 3),
      summary: take.summary,
      deepDive: take.deepDive || null,
    };
  }

  if (parsed.short && parsed.long) {
    const short = normalizeTake(parsed.short);
    const long = normalizeTake(parsed.long);
    return {
      short,
      long,
      quip: normalizeLabel(parsed.quip),
      shortTermRank:
        parseRank(parsed.shortTermRank) ?? heuristicRank(short),
      longTermRank: parseRank(parsed.longTermRank) ?? heuristicRank(long),
    };
  }

  if (parsed.lean && parsed.summary) {
    const take = normalizeTake({
      lean: parsed.lean,
      risk: parsed.risk || "medium",
      tags: Array.isArray(parsed.tags) ? parsed.tags : [],
      summary: parsed.summary,
      deepDive: parsed.deepDive || null,
    });
    const rank =
      parseRank(parsed.shortTermRank) ??
      parseRank(parsed.longTermRank) ??
      heuristicRank(take);
    return {
      short: take,
      long: take,
      quip: normalizeLabel(parsed.quip),
      shortTermRank: parseRank(parsed.shortTermRank) ?? rank,
      longTermRank: parseRank(parsed.longTermRank) ?? rank,
    };
  }

  return null;
}

function pickAnalysisTake(dual, mode) {
  const m = mode === "short" ? "short" : "long";
  if (!dual) return null;
  return dual[m] || dual.long || dual.short || null;
}

/** True when cached analysis is the canned Gemini failure fallback — must not block re-analyze. */
function isFallbackAnalysis(dual) {
  if (!dual) return true;
  const take = pickAnalysisTake(dual, "long") || pickAnalysisTake(dual, "short");
  const summary = String(take?.summary || "");
  if (!summary.trim()) return true;
  if (summary.toLowerCase().includes(FALLBACK_SUMMARY_SNIPPET)) return true;
  return false;
}

async function getCachedSummary(ticker, _mode) {
  const row = await dbGet(
    `SELECT summary_json, generated_at FROM ai_reports WHERE ticker = ?`,
    [String(ticker).toUpperCase()]
  );

  if (!row || !isFresh(row.generated_at)) {
    return null;
  }

  try {
    const dual = normalizeDualAnalysis(JSON.parse(row.summary_json));
    if (!dual || isFallbackAnalysis(dual)) {
      return null;
    }
    dual.generatedAt = row.generated_at || null;
    return dual;
  } catch {
    return null;
  }
}

async function saveSummaryToCache(ticker, _mode, summary) {
  const dual = normalizeDualAnalysis(summary) || summary;
  // Do not persist pure fallbacks as "fresh" analysis — leave miss so next pass retries.
  if (isFallbackAnalysis(dual)) {
    console.warn(
      `[cache] Refusing to cache fallback analysis for ${String(ticker).toUpperCase()}`
    );
    await dbRun(`DELETE FROM ai_reports WHERE ticker = ?`, [
      String(ticker).toUpperCase(),
    ]);
    return;
  }
  await dbRun(
    `INSERT OR REPLACE INTO ai_reports (ticker, summary_json, generated_at)
     VALUES (?, ?, ?)`,
    [
      String(ticker).toUpperCase(),
      JSON.stringify(dual),
      new Date().toISOString(),
    ]
  );
}

module.exports = {
  CACHE_TTL_MS,
  TARGET_TTL_MS,
  EARNINGS_TTL_MS,
  BOARD_STALE_MS,
  isFresh,
  emptyFreshness,
  freshnessFromData,
  hasSharedIndicatorShape,
  isPriceFresh,
  isTargetFresh,
  isNewsFresh,
  isEarningsFresh,
  isEarningsDatePast,
  isFullyFresh,
  latestFreshnessIso,
  isBoardStale,
  getStockCacheEntry,
  getCachedStock,
  getCachedStockRow,
  saveStockToCache,
  getCachedSummary,
  saveSummaryToCache,
  normalizeDualAnalysis,
  pickAnalysisTake,
  isFallbackAnalysis,
};
