const { dbGet, dbRun } = require("../db/schema");
const { USAGE_KEYS } = require("../lib/dataSources");

/** Stable aliases used across the codebase (backed by the source registry). */
const PROVIDERS = {
  ALPHA: USAGE_KEYS.alpha_vantage,
  FINNHUB: USAGE_KEYS.finnhub,
  FINNHUB_DELAY: USAGE_KEYS.finnhub_rate_delay,
  TWELVE: USAGE_KEYS.twelve_data,
  MARKETAUX: USAGE_KEYS.marketaux,
  GEMINI: USAGE_KEYS.gemini,
  CLAUDE: USAGE_KEYS.claude,
};

function getPacificDateString(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
  }).format(date);
}

function nextMidnightPacificIso() {
  const now = new Date();
  const ptNow = new Date(
    now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" })
  );
  const next = new Date(ptNow);
  next.setHours(24, 0, 0, 0);
  return new Date(now.getTime() + (next.getTime() - ptNow.getTime())).toISOString();
}

async function incrementUsage(provider) {
  const date = getPacificDateString();
  await dbRun(
    `INSERT INTO api_usage (date, provider, count) VALUES (?, ?, 1)
     ON CONFLICT(date, provider) DO UPDATE SET count = count + 1`,
    [date, provider]
  );
}

async function getUsageToday(provider) {
  const date = getPacificDateString();
  const row = await dbGet(
    `SELECT count FROM api_usage WHERE date = ? AND provider = ?`,
    [date, provider]
  );
  return Number(row?.count || 0);
}

async function getApiUsageToday() {
  return getUsageToday(PROVIDERS.ALPHA);
}

async function incrementApiUsage() {
  return incrementUsage(PROVIDERS.ALPHA);
}

async function getSetting(key) {
  const row = await dbGet(`SELECT value FROM app_settings WHERE key = ?`, [key]);
  return row ? row.value : null;
}

async function setSetting(key, value) {
  await dbRun(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, String(value)]
  );
}

module.exports = {
  PROVIDERS,
  USAGE_KEYS,
  incrementUsage,
  getUsageToday,
  getApiUsageToday,
  incrementApiUsage,
  getPacificDateString,
  nextMidnightPacificIso,
  getSetting,
  setSetting,
};
