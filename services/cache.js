const { dbGet, dbRun } = require("../db/schema");

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

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
  };
}

function freshnessFromData(data) {
  const f = data?.freshness || {};
  return {
    priceUpdatedAt: f.priceUpdatedAt || null,
    targetUpdatedAt: f.targetUpdatedAt || null,
    newsUpdatedAt: f.newsUpdatedAt || null,
  };
}

function isPriceFresh(data) {
  return Boolean(data?.quote) && isFresh(freshnessFromData(data).priceUpdatedAt);
}

function isTargetFresh(data) {
  return isFresh(freshnessFromData(data).targetUpdatedAt);
}

function isNewsFresh(data) {
  return isFresh(freshnessFromData(data).newsUpdatedAt);
}

/** Fully skippable only when price, target, and news are all under 24h. */
function isFullyFresh(data) {
  return isPriceFresh(data) && isTargetFresh(data) && isNewsFresh(data);
}

function latestFreshnessIso(data) {
  const f = freshnessFromData(data);
  const times = [f.priceUpdatedAt, f.targetUpdatedAt, f.newsUpdatedAt]
    .filter(Boolean)
    .map((t) => Date.parse(t))
    .filter((n) => !Number.isNaN(n));
  if (!times.length) return null;
  return new Date(Math.max(...times)).toISOString();
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
 * Normalize dual-mode analysis (short + long + quip). Legacy single takes become both modes.
 */
function normalizeDualAnalysis(parsed) {
  if (!parsed || typeof parsed !== "object") return null;

  if (parsed.short && parsed.long) {
    return {
      short: parsed.short,
      long: parsed.long,
      quip:
        typeof parsed.quip === "string" && parsed.quip.trim()
          ? parsed.quip.trim()
          : null,
    };
  }

  if (parsed.lean && parsed.summary) {
    const take = {
      lean: parsed.lean,
      risk: parsed.risk || "medium",
      tags: Array.isArray(parsed.tags) ? parsed.tags : [],
      summary: parsed.summary,
      deepDive: parsed.deepDive || null,
    };
    return {
      short: take,
      long: take,
      quip:
        typeof parsed.quip === "string" && parsed.quip.trim()
          ? parsed.quip.trim()
          : null,
    };
  }

  return null;
}

function pickAnalysisTake(dual, mode) {
  const m = mode === "short" ? "short" : "long";
  if (!dual) return null;
  return dual[m] || dual.long || dual.short || null;
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
    return normalizeDualAnalysis(JSON.parse(row.summary_json));
  } catch {
    return null;
  }
}

async function saveSummaryToCache(ticker, _mode, summary) {
  const dual = normalizeDualAnalysis(summary) || summary;
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
  isFresh,
  emptyFreshness,
  freshnessFromData,
  isPriceFresh,
  isTargetFresh,
  isNewsFresh,
  isFullyFresh,
  latestFreshnessIso,
  getStockCacheEntry,
  getCachedStock,
  getCachedStockRow,
  saveStockToCache,
  getCachedSummary,
  saveSummaryToCache,
  normalizeDualAnalysis,
  pickAnalysisTake,
};
