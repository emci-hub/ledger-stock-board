const { dbGet, dbRun } = require("../db/schema");

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function isFresh(isoTimestamp) {
  if (!isoTimestamp) return false;
  const then = Date.parse(isoTimestamp);
  if (Number.isNaN(then)) return false;
  return Date.now() - then < CACHE_TTL_MS;
}

async function getCachedStockRow(ticker, mode) {
  const row = await dbGet(
    `SELECT data_json, last_updated FROM stock_cache WHERE ticker = ? AND mode = ?`,
    [String(ticker).toUpperCase(), mode]
  );

  if (!row || !isFresh(row.last_updated)) return null;

  try {
    return {
      data: JSON.parse(row.data_json),
      lastUpdated: row.last_updated,
    };
  } catch {
    return null;
  }
}

async function getCachedStock(ticker, mode) {
  const row = await getCachedStockRow(ticker, mode);
  return row ? row.data : null;
}

async function saveStockToCache(ticker, mode, data) {
  const now = new Date().toISOString();
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
  getCachedStock,
  getCachedStockRow,
  saveStockToCache,
  getCachedSummary,
  saveSummaryToCache,
};
