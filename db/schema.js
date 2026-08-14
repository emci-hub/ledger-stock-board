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

/**
 * Recreate board_picks so CHECK allows 'archived' and optional columns exist.
 * Idempotent via app_settings flag when the new columns are already present.
 */

/**
 * Recreate board_picks so CHECK allows 'candidate' + cheap FMP signal columns.
 * Idempotent via app_settings flag when candidate status + columns are present.
 */
async function migrateBoardPicksCandidateSupport() {
  const cols = await dbAll(`PRAGMA table_info(board_picks)`);
  const names = new Set((cols || []).map((c) => c.name));
  const needsCols =
    !names.has("discovered_at") ||
    !names.has("last_seen_at") ||
    !names.has("miss_streak") ||
    !names.has("flags_json") ||
    !names.has("percent_change") ||
    !names.has("exchange") ||
    !names.has("price") ||
    !names.has("name");

  // Detect whether CHECK already includes candidate by probing insert capability
  // via app_settings flag (safer than parsing sqlite_master).
  const flag = await dbGet(
    `SELECT value FROM app_settings WHERE key = ?`,
    ["boardPicksCandidateMigration_v1"]
  );
  if (flag?.value && !needsCols) return;

  await dbExecute(`
    CREATE TABLE IF NOT EXISTS board_picks_candidate_mig (
      ticker TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('recommended', 'watch', 'not_recommended', 'archived', 'candidate')),
      added_at TEXT NOT NULL,
      sector TEXT,
      archived_at TEXT,
      source TEXT,
      discovery_blurb TEXT,
      name TEXT,
      price REAL,
      percent_change REAL,
      exchange TEXT,
      discovered_at TEXT,
      last_seen_at TEXT,
      miss_streak INTEGER DEFAULT 0,
      flags_json TEXT,
      tracked_since TEXT
    )
  `);

  const existing = await dbAll(`SELECT * FROM board_picks`);
  for (const row of existing || []) {
    const status =
      row.status === "candidate" ||
      row.status === "archived" ||
      row.status === "recommended" ||
      row.status === "watch" ||
      row.status === "not_recommended"
        ? row.status
        : "watch";
    await dbExecute(
      `INSERT OR REPLACE INTO board_picks_candidate_mig
        (ticker, status, added_at, sector, archived_at, source, discovery_blurb,
         name, price, percent_change, exchange, discovered_at, last_seen_at,
         miss_streak, flags_json, tracked_since)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.ticker,
        status,
        row.added_at,
        row.sector ?? null,
        row.archived_at ?? null,
        row.source ?? "seed",
        row.discovery_blurb ?? null,
        row.name ?? null,
        row.price ?? null,
        row.percent_change ?? null,
        row.exchange ?? null,
        row.discovered_at ?? null,
        row.last_seen_at ?? null,
        Number(row.miss_streak || 0),
        row.flags_json ?? null,
        row.tracked_since ??
          (status === "recommended" || status === "watch"
            ? row.added_at
            : null),
      ]
    );
  }

  await dbExecute(`DROP TABLE IF EXISTS board_picks`);
  await dbExecute(
    `ALTER TABLE board_picks_candidate_mig RENAME TO board_picks`
  );

  await dbExecute(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ["boardPicksCandidateMigration_v1", new Date().toISOString()]
  );
  console.log("[db] board_picks candidate tier migrated");
}

async function migrateBoardPicksArchiveSupport() {
  const cols = await dbAll(`PRAGMA table_info(board_picks)`);
  const names = new Set((cols || []).map((c) => c.name));
  const needsCols = !names.has("archived_at") || !names.has("source");

  const flag = await dbGet(
    `SELECT value FROM app_settings WHERE key = ?`,
    ["boardPicksArchiveMigration_v1"]
  );
  if (flag?.value && !needsCols) return;

  await dbExecute(`
    CREATE TABLE IF NOT EXISTS board_picks_archive_mig (
      ticker TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('recommended', 'watch', 'not_recommended', 'archived')),
      added_at TEXT NOT NULL,
      sector TEXT,
      archived_at TEXT,
      source TEXT
    )
  `);

  const existing = await dbAll(`SELECT * FROM board_picks`);
  for (const row of existing || []) {
    await dbExecute(
      `INSERT OR REPLACE INTO board_picks_archive_mig
        (ticker, status, added_at, sector, archived_at, source)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        row.ticker,
        row.status === "archived" ? "archived" : row.status,
        row.added_at,
        row.sector ?? null,
        row.archived_at ?? null,
        row.source ?? "seed",
      ]
    );
  }

  await dbExecute(`DROP TABLE IF EXISTS board_picks`);
  await dbExecute(`ALTER TABLE board_picks_archive_mig RENAME TO board_picks`);

  await dbExecute(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ["boardPicksArchiveMigration_v1", new Date().toISOString()]
  );
  console.log("[db] board_picks archive support migrated");
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
        status TEXT NOT NULL CHECK (status IN ('recommended', 'watch', 'not_recommended', 'archived', 'candidate')),
        added_at TEXT NOT NULL,
        sector TEXT,
        archived_at TEXT,
        source TEXT,
        name TEXT,
        price REAL,
        percent_change REAL,
        exchange TEXT,
        discovered_at TEXT,
        last_seen_at TEXT,
        miss_streak INTEGER DEFAULT 0,
        flags_json TEXT
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

    try {
      await migrateBoardPicksArchiveSupport();
    } catch (err) {
      console.warn("[db] board_picks archive migration skipped:", err.message);
    }

    try {
      await migrateBoardPicksCandidateSupport();
    } catch (err) {
      console.warn("[db] board_picks candidate migration skipped:", err.message);
    }

    try {
      await dbExecute(
        `ALTER TABLE board_picks ADD COLUMN discovery_blurb TEXT`
      );
    } catch (err) {
      // Column already exists — ignore
      if (!/duplicate column/i.test(err.message || "")) {
        console.warn("[db] discovery_blurb column:", err.message);
      }
    }

    for (const col of [
      "name TEXT",
      "price REAL",
      "percent_change REAL",
      "exchange TEXT",
      "discovered_at TEXT",
      "last_seen_at TEXT",
      "miss_streak INTEGER DEFAULT 0",
      "flags_json TEXT",
      "tracked_since TEXT",
      "board_section TEXT",
    ]) {
      try {
        await dbExecute(`ALTER TABLE board_picks ADD COLUMN ${col}`);
      } catch (err) {
        if (!/duplicate column/i.test(err.message || "")) {
          console.warn(`[db] board_picks add ${col}:`, err.message);
        }
      }
    }

    // Backfill tracked_since for live rows from added_at (one-shot safe UPDATE).
    try {
      await dbExecute(
        `UPDATE board_picks
         SET tracked_since = added_at
         WHERE tracked_since IS NULL
           AND status IN ('recommended', 'watch')
           AND added_at IS NOT NULL`
      );
    } catch (err) {
      console.warn("[db] tracked_since backfill:", err.message);
    }

    await dbExecute(`
      CREATE TABLE IF NOT EXISTS ai_deeper_looks (
        ticker TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        generated_at TEXT NOT NULL
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
