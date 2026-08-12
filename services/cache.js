const { dbGet, dbRun } = require("../db/schema");

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function isFresh(isoTimestamp) {
  if (!isoTimestamp) return false;
  const then = Date.parse(isoTimestamp);
  if (Number.isNaN(then)) return false;
  return Date.now() - then < CACHE_TTL_MS;
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
  // Legacy rows only had stock_cache.last_updated — treat as price timestamp.
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
 * Load cache row if present. Does not apply TTL — callers check per-field freshness.
 */
async function getStockCacheEntry(ticker, mode) {
  const row = await dbGet(
    `SELECT data_json, last_updated FROM stock_cache WHERE ticker = ? AND mode = ?`,
    [String(ticker).toUpperCase(), mode]
  );

  if (!row) return null;

  try {
    const data = JSON.parse(row.data_json);
    let freshness = freshnessFromData(data);

    // Migrate legacy single-timestamp rows into per-field freshness once.
    if (
      !data.freshness &&
      row.last_updated &&
      data.quote
    ) {
      freshness = {
        priceUpdatedAt: row.last_updated,
        targetUpdatedAt: data?.fundamentals?.overview?.analystTargetPrice != null
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

/**
 * Returns entry only when price is fresh (usable quote for display / free search gate).
 * Prefer getStockCacheEntry + isFullyFresh for refresh skip logic.
 */
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

async function saveStockToCache(ticker, mode, data) {
  const freshness = freshnessFromData(data);
  data.freshness = freshness;
  const now =
    latestFreshnessIso(data) || new Date().toISOString();

  await dbRun(
    `INSERT OR REPLACE INTO stock_cache (ticker, mode, data_json, last_updated)
     VALUES (?, ?, ?, ?)`,
    [String(ticker).toUpperCase(), mode, JSON.stringify(data), now]
  );
  return now;
}

async function getCachedSummary(ticker, mode) {
  const row = await dbGet(
    `SELECT summary_json, generated_at FROM ai_summaries WHERE ticker = ? AND mode = ?`,
    [String(ticker).toUpperCase(), mode]
  );

  if (!row || !isFresh(row.generated_at)) return null;

  try {
    return JSON.parse(row.summary_json);
  } catch {
    return null;
  }
}

async function saveSummaryToCache(ticker, mode, summary) {
  await dbRun(
    `INSERT OR REPLACE INTO ai_summaries (ticker, mode, summary_json, generated_at)
     VALUES (?, ?, ?, ?)`,
    [
      String(ticker).toUpperCase(),
      mode,
      JSON.stringify(summary),
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
};
