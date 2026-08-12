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

async function initSchema() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    getDb();

    await dbExecute(`
      CREATE TABLE IF NOT EXISTS stock_cache (
        ticker TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('short', 'long')),
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
