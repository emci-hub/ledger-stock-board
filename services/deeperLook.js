/**
 * Manual Claude "Deeper Look" — never automatic; paid credits only on user action.
 */

const { dbGet, dbRun, dbExecute } = require("../db/schema");
const { analyzeStock } = require("./analyze");
const { getStockCacheEntry, pickAnalysisTake, normalizeDualAnalysis } = require("./cache");
const { hasSourceKey } = require("../lib/dataSources");
const { getSetting, setSetting } = require("./usage");

const DEEPER_LOOK_SETTING = "deeperLookEnabled";

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

function claudeConfigured() {
  return hasSourceKey("claude");
}

/**
 * Public feature flag. Explicit app_settings value wins; otherwise defaults
 * to on only when ANTHROPIC_API_KEY is present.
 */
async function isDeeperLookEnabled() {
  const raw = await getSetting(DEEPER_LOOK_SETTING);
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return claudeConfigured();
}

async function getDeeperLookSetting() {
  const raw = await getSetting(DEEPER_LOOK_SETTING);
  const enabled = await isDeeperLookEnabled();
  return {
    enabled,
    explicit: raw === "0" || raw === "1" || raw === "true" || raw === "false",
    claudeConfigured: claudeConfigured(),
    source:
      raw === "1" || raw === "true" || raw === "0" || raw === "false"
        ? "app_settings"
        : "default_from_anthropic_key",
  };
}

/**
 * Persist on/off. Enabling without a Claude key is rejected.
 */
async function setDeeperLookEnabled(enabled) {
  const on = Boolean(enabled);
  if (on && !claudeConfigured()) {
    const err = new Error(
      "Cannot enable Deeper Look — ANTHROPIC_API_KEY is not configured."
    );
    err.code = "not_configured";
    throw err;
  }
  await setSetting(DEEPER_LOOK_SETTING, on ? "1" : "0");
  return getDeeperLookSetting();
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
  if (!(await isDeeperLookEnabled())) {
    const err = new Error("Deeper Look is disabled.");
    err.code = "disabled";
    throw err;
  }
  if (!claudeConfigured()) {
    const err = new Error("Claude is not configured (ANTHROPIC_API_KEY missing).");
    err.code = "not_configured";
    throw err;
  }

  const symbol = String(ticker).toUpperCase();
  const entry = await getStockCacheEntry(symbol);
  if (!entry?.data?.quote) {
    const err = new Error(
      `No cached stock data for ${symbol} — look it up on the board first.`
    );
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
  isDeeperLookEnabled,
  getDeeperLookSetting,
  setDeeperLookEnabled,
  DEEPER_LOOK_SETTING,
};
