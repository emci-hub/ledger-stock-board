/**
 * Recent per-call API log for /dev-status (last ~30 shown).
 */
const { dbRun, dbAll, dbGet, dbExecute } = require("../db/schema");
const { getCallContextTicker } = require("./callContext");

let tableReady = null;

async function ensureApiCallLogTable() {
  if (tableReady) return tableReady;
  tableReady = (async () => {
    await dbExecute(`
      CREATE TABLE IF NOT EXISTS api_call_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        called_at TEXT NOT NULL,
        provider TEXT NOT NULL,
        action TEXT,
        ticker TEXT,
        success INTEGER NOT NULL DEFAULT 1,
        detail TEXT
      )
    `);
    await dbExecute(
      `CREATE INDEX IF NOT EXISTS idx_api_call_log_called_at ON api_call_log(called_at DESC)`
    );
  })();
  return tableReady;
}

/**
 * Append one call. Safe to call often; failures are swallowed so logging
 * never blocks live fetches.
 */
async function logApiCall({
  provider,
  action = null,
  ticker = null,
  success = true,
  detail = null,
} = {}) {
  try {
    await ensureApiCallLogTable();
    const symbol =
      ticker != null
        ? String(ticker).toUpperCase()
        : getCallContextTicker();
    await dbRun(
      `INSERT INTO api_call_log (called_at, provider, action, ticker, success, detail)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        new Date().toISOString(),
        String(provider || "unknown"),
        action ? String(action).slice(0, 120) : null,
        symbol,
        success ? 1 : 0,
        detail ? String(detail).slice(0, 400) : null,
      ]
    );
  } catch (err) {
    console.warn("[apiCallLog]", err.message);
  }
}

async function getRecentApiCalls(limit = 30) {
  await ensureApiCallLogTable();
  const n = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const rows = await dbAll(
    `SELECT id, called_at, provider, action, ticker, success, detail
     FROM api_call_log
     ORDER BY id DESC
     LIMIT ?`,
    [n]
  );
  return (rows || []).map((r) => ({
    id: r.id,
    calledAt: r.called_at,
    provider: r.provider,
    action: r.action,
    ticker: r.ticker,
    success: Boolean(r.success),
    detail: r.detail,
  }));
}

/** Latest successful call per provider (for status cards). */
async function getLastSuccessByProvider() {
  await ensureApiCallLogTable();
  const rows = await dbAll(
    `SELECT provider, called_at, action, ticker, detail
     FROM api_call_log
     WHERE success = 1
     ORDER BY id DESC
     LIMIT 200`
  );
  const out = {};
  for (const r of rows || []) {
    if (out[r.provider]) continue;
    out[r.provider] = {
      calledAt: r.called_at,
      action: r.action,
      ticker: r.ticker,
      detail: r.detail,
      success: true,
    };
  }
  return out;
}

/** Latest call (any outcome) per provider. */
async function getLastCallByProvider() {
  await ensureApiCallLogTable();
  const rows = await dbAll(
    `SELECT provider, called_at, action, ticker, success, detail
     FROM api_call_log
     ORDER BY id DESC
     LIMIT 200`
  );
  const out = {};
  for (const r of rows || []) {
    if (out[r.provider]) continue;
    out[r.provider] = {
      calledAt: r.called_at,
      action: r.action,
      ticker: r.ticker,
      success: Boolean(r.success),
      detail: r.detail,
    };
  }
  return out;
}

async function countApiCallLog() {
  await ensureApiCallLogTable();
  const row = await dbGet(`SELECT COUNT(*) AS n FROM api_call_log`);
  return Number(row?.n || 0);
}

module.exports = {
  ensureApiCallLogTable,
  logApiCall,
  getRecentApiCalls,
  getLastSuccessByProvider,
  getLastCallByProvider,
  countApiCallLog,
};
