/**
 * Manual Claude "Deeper Look" — never automatic; paid credits only on user action.
 */

const { dbGet, dbRun, dbExecute } = require("../db/schema");
const { analyzeStock } = require("./analyze");
const { getStockCacheEntry, pickAnalysisTake, normalizeDualAnalysis } = require("./cache");
const { hasSourceKey } = require("../lib/dataSources");

async function ensureDeeperLookTable() {
  await dbExecute(`
    CREATE TABLE IF NOT EXISTS ai_deeper_looks (
      ticker TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      generated_at TEXT NOT NULL
    )
  `);
}

async function getDeeperLook(ticker) {
  await ensureDeeperLookTable();
  const symbol = String(ticker).toUpperCase();
  const row = await dbGet(
    `SELECT ticker, provider, summary_json, generated_at FROM ai_deeper_looks WHERE ticker = ?`,
    [symbol]
  );
  if (!row) return null;
  try {
    const dual = normalizeDualAnalysis(JSON.parse(row.summary_json));
    return {
      ticker: symbol,
      provider: row.provider,
      generatedAt: row.generated_at,
      dual,
      long: pickAnalysisTake(dual, "long"),
      short: pickAnalysisTake(dual, "short"),
    };
  } catch {
    return null;
  }
}

/**
 * Explicit user-triggered Claude analysis for one ticker.
 */
async function requestDeeperLook(ticker, { mode = "long" } = {}) {
  if (!hasSourceKey("claude") && !process.env.ANTHROPIC_API_KEY) {
    const err = new Error("Claude is not configured (ANTHROPIC_API_KEY missing).");
    err.code = "not_configured";
    throw err;
  }

  const symbol = String(ticker).toUpperCase();
  const entry = await getStockCacheEntry(symbol);
  if (!entry?.data?.quote) {
    const err = new Error(`No cached stock data for ${symbol} — look it up on the board first.`);
    err.code = "no_data";
    throw err;
  }

  await ensureDeeperLookTable();

  const analysis = await analyzeStock(
    symbol,
    entry.data.quote,
    entry.data.fundamentals,
    entry.data.peers || [],
    { provider: "claude" }
  );

  const now = new Date().toISOString();
  await dbRun(
    `INSERT OR REPLACE INTO ai_deeper_looks (ticker, provider, summary_json, generated_at)
     VALUES (?, ?, ?, ?)`,
    [symbol, "claude", JSON.stringify(analysis), now]
  );

  const dual = normalizeDualAnalysis(analysis);
  const take = pickAnalysisTake(dual, mode === "short" ? "short" : "long");

  return {
    ticker: symbol,
    provider: "claude",
    generatedAt: now,
    dual,
    analysis: take,
  };
}

module.exports = {
  ensureDeeperLookTable,
  getDeeperLook,
  requestDeeperLook,
};
