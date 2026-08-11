const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const dataDir = path.join(__dirname, "..", "data");
const dbPath = path.join(dataDir, "ledger.db");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS stock_cache (
    ticker TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('short', 'long')),
    data_json TEXT NOT NULL,
    last_updated TEXT NOT NULL,
    PRIMARY KEY (ticker, mode)
  );

  CREATE TABLE IF NOT EXISTS ai_summaries (
    ticker TEXT NOT NULL,
    mode TEXT NOT NULL,
    summary_json TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    PRIMARY KEY (ticker, mode)
  );

  CREATE TABLE IF NOT EXISTS board_picks (
    ticker TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('recommended', 'watch', 'not_recommended')),
    added_at TEXT NOT NULL,
    sector TEXT
  );

  CREATE TABLE IF NOT EXISTS recommendation_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    logged_price REAL NOT NULL,
    lean TEXT NOT NULL,
    logged_at TEXT NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0,
    hit_target INTEGER DEFAULT NULL
  );

  CREATE TABLE IF NOT EXISTS watchlist (
    ticker TEXT PRIMARY KEY,
    starred_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS api_usage (
    date TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0
  );
`);

function getDb() {
  return db;
}

module.exports = { getDb };
