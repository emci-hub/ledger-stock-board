require("dotenv").config();

const { createClient } = require("@libsql/client");

let client = null;
let initPromise = null;

function getDb() {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;
    if (!url) {
      throw new Error("TURSO_DATABASE_URL is not set in .env");
    }
    client = createClient({ url, authToken });
  }
  return client;
}

async function dbExecute(sql, args = []) {
  return getDb().execute({ sql, args });
}

async function dbGet(sql, args = []) {
  const result = await dbExecute(sql, args);
  return result.rows[0] || null;
}

async function dbAll(sql, args = []) {
  const result = await dbExecute(sql, args);
  return result.rows;
}

async function dbRun(sql, args = []) {
  return dbExecute(sql, args);
}

function preferModeRank(mode) {
  if (mode === "long") return 0;
  if (mode === "short") return 1;
  return 2;
}

/** One-time copy from legacy (ticker, mode) cache into ticker-keyed shared tables. */
async function migrateLegacyModeCache() {
  const legacyStock = await dbGet(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='stock_cache'`
  );
  if (legacyStock) {
    const rows = await dbAll(
      `SELECT ticker, mode, data_json, last_updated FROM stock_cache`
    );
    const best = new Map();
    for (const row of rows) {
      const prev = best.get(row.ticker);
      if (
        !prev ||
        preferModeRank(row.mode) < preferModeRank(prev.mode) ||
        (preferModeRank(row.mode) === preferModeRank(prev.mode) &&
          String(row.last_updated) > String(prev.last_updated))
      ) {
        best.set(row.ticker, row);
      }
    }
    for (const row of best.values()) {
      await dbRun(
        `INSERT OR IGNORE INTO stock_reports (ticker, data_json, last_updated)
         VALUES (?, ?, ?)`,
        [row.ticker, row.data_json, row.last_updated]
      );
    }
  }

  const legacyAi = await dbGet(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='ai_summaries'`
  );
  if (legacyAi) {
    const rows = await dbAll(
      `SELECT ticker, mode, summary_json, generated_at FROM ai_summaries`
    );
    const best = new Map();
    for (const row of rows) {
      const prev = best.get(row.ticker);
      if (
        !prev ||
        preferModeRank(row.mode) < preferModeRank(prev.mode) ||
        (preferModeRank(row.mode) === preferModeRank(prev.mode) &&
          String(row.generated_at) > String(prev.generated_at))
      ) {
        best.set(row.ticker, row);
      }
    }
    for (const row of best.values()) {
      await dbRun(
        `INSERT OR IGNORE INTO ai_reports (ticker, summary_json, generated_at)
         VALUES (?, ?, ?)`,
        [row.ticker, row.summary_json, row.generated_at]
      );
    }
  }
}

async function initSchema() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    getDb();

    await dbExecute(`
      CREATE TABLE IF NOT EXISTS stock_reports (
        ticker TEXT PRIMARY KEY,
        data_json TEXT NOT NULL,
        last_updated TEXT NOT NULL
      )
    `);

    await dbExecute(`
      CREATE TABLE IF NOT EXISTS ai_reports (
        ticker TEXT PRIMARY KEY,
        summary_json TEXT NOT NULL,
        generated_at TEXT NOT NULL
      )
    `);

    await dbExecute(`
      CREATE TABLE IF NOT EXISTS stock_cache (
        ticker TEXT NOT NULL,
        mode TEXT NOT NULL,
        data_json TEXT NOT NULL,
        last_updated TEXT NOT NULL,
        PRIMARY KEY (ticker, mode)
      )
    `);

    await dbExecute(`
      CREATE TABLE IF NOT EXISTS ai_summaries (
        ticker TEXT NOT NULL,
        mode TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        PRIMARY KEY (ticker, mode)
      )
    `);

    await dbExecute(`
      CREATE TABLE IF NOT EXISTS board_picks (
        ticker TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('recommended', 'watch', 'not_recommended')),
        added_at TEXT NOT NULL,
        sector TEXT
      )
    `);

    await dbExecute(`
      CREATE TABLE IF NOT EXISTS recommendation_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker TEXT NOT NULL,
        logged_price REAL NOT NULL,
        lean TEXT NOT NULL,
        logged_at TEXT NOT NULL,
        resolved INTEGER NOT NULL DEFAULT 0,
        hit_target INTEGER DEFAULT NULL
      )
    `);

    await dbExecute(`
      CREATE TABLE IF NOT EXISTS watchlist (
        ticker TEXT PRIMARY KEY,
        starred_at TEXT NOT NULL
      )
    `);

    await dbExecute(`
      CREATE TABLE IF NOT EXISTS api_usage (
        date TEXT NOT NULL,
        provider TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (date, provider)
      )
    `);

    await dbExecute(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    await dbExecute(`
      CREATE TABLE IF NOT EXISTS price_history_log (
        ticker TEXT NOT NULL,
        date TEXT NOT NULL,
        close REAL NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY (ticker, date)
      )
    `);

    await dbExecute(`
      CREATE TABLE IF NOT EXISTS joke_pool (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        joke_text TEXT NOT NULL UNIQUE,
        fetched_at TEXT NOT NULL
      )
    `);

    try {
      await migrateLegacyModeCache();
    } catch (err) {
      console.warn("[db] Legacy cache migration skipped:", err.message);
    }

    console.log("[db] Turso schema ready");
  })();

  return initPromise;
}

module.exports = {
  getDb,
  initSchema,
  dbExecute,
  dbGet,
  dbAll,
  dbRun,
};
