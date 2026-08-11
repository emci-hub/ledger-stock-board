const { getDb } = require("../db/schema");

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function isFresh(isoTimestamp) {
  if (!isoTimestamp) return false;
  const then = Date.parse(isoTimestamp);
  if (Number.isNaN(then)) return false;
  return Date.now() - then < CACHE_TTL_MS;
}

function getCachedStock(ticker, mode) {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT data_json, last_updated FROM stock_cache WHERE ticker = ? AND mode = ?`
    )
    .get(String(ticker).toUpperCase(), mode);

  if (!row || !isFresh(row.last_updated)) return null;

  try {
    return JSON.parse(row.data_json);
  } catch {
    return null;
  }
}

function saveStockToCache(ticker, mode, data) {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO stock_cache (ticker, mode, data_json, last_updated)
     VALUES (?, ?, ?, ?)`
  ).run(
    String(ticker).toUpperCase(),
    mode,
    JSON.stringify(data),
    new Date().toISOString()
  );
}

function getCachedSummary(ticker, mode) {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT summary_json, generated_at FROM ai_summaries WHERE ticker = ? AND mode = ?`
    )
    .get(String(ticker).toUpperCase(), mode);

  if (!row || !isFresh(row.generated_at)) return null;

  try {
    return JSON.parse(row.summary_json);
  } catch {
    return null;
  }
}

function saveSummaryToCache(ticker, mode, summary) {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO ai_summaries (ticker, mode, summary_json, generated_at)
     VALUES (?, ?, ?, ?)`
  ).run(
    String(ticker).toUpperCase(),
    mode,
    JSON.stringify(summary),
    new Date().toISOString()
  );
}

module.exports = {
  getCachedStock,
  saveStockToCache,
  getCachedSummary,
  saveSummaryToCache,
};
