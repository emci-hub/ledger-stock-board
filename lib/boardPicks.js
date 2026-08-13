/**
 * Board pick helpers: live vs archived, cap enforcement, momentum ranking.
 */

const {
  BOARD_TICKERS,
  BOARD_MAX_SIZE,
  ARCHIVE_MAX_SIZE,
  ARCHIVE_RETENTION_DAYS,
  LIVE_BOARD_STATUSES,
} = require("../lib/boardTickers");
const { getStockCacheEntry } = require("../services/cache");
const { dbGet, dbAll, dbRun } = require("../db/schema");

function liveStatusSql() {
  return LIVE_BOARD_STATUSES.map(() => "?").join(", ");
}

async function listLiveBoardPicks() {
  return dbAll(
    `SELECT ticker, status, added_at, sector, archived_at, source
     FROM board_picks
     WHERE status IN (${liveStatusSql()})
     ORDER BY added_at DESC`,
    LIVE_BOARD_STATUSES
  );
}

async function listArchivedBoardPicks() {
  return dbAll(
    `SELECT ticker, status, added_at, sector, archived_at, source
     FROM board_picks
     WHERE status = 'archived'
     ORDER BY archived_at DESC, added_at DESC`
  );
}

async function listAllBoardTickers() {
  const rows = await dbAll(`SELECT ticker FROM board_picks`);
  return (rows || []).map((r) => String(r.ticker).toUpperCase());
}

async function countLiveBoard() {
  const row = await dbGet(
    `SELECT COUNT(*) AS n FROM board_picks WHERE status IN (${liveStatusSql()})`,
    LIVE_BOARD_STATUSES
  );
  return Number(row?.n || 0);
}

/**
 * Live board tickers for refresh. Falls back to seed list when empty.
 */
async function getActiveBoardTickers() {
  const picks = await listLiveBoardPicks();
  if (picks.length) {
    return picks.map((p) => String(p.ticker).toUpperCase());
  }
  return BOARD_TICKERS.map((t) => String(t).toUpperCase());
}

async function getPick(ticker) {
  return dbGet(`SELECT * FROM board_picks WHERE ticker = ?`, [
    String(ticker).toUpperCase(),
  ]);
}

async function momentumScoreForTicker(ticker) {
  const entry = await getStockCacheEntry(ticker);
  const pct = Number(entry?.data?.quote?.price?.changePercent);
  if (Number.isFinite(pct)) return pct;
  return null;
}

/**
 * Weakest live board name = lowest changePercent (most negative / least hot).
 * Ties broken by oldest added_at.
 */
async function findWeakestLivePick(excludeTickers = []) {
  const exclude = new Set(
    (excludeTickers || []).map((t) => String(t).toUpperCase())
  );
  const picks = (await listLiveBoardPicks()).filter(
    (p) => !exclude.has(String(p.ticker).toUpperCase())
  );
  if (!picks.length) return null;

  let weakest = null;
  for (const pick of picks) {
    const score = await momentumScoreForTicker(pick.ticker);
    const candidate = {
      ...pick,
      momentum: score,
    };
    if (!weakest) {
      weakest = candidate;
      continue;
    }
    const a = weakest.momentum;
    const b = candidate.momentum;
    if (a == null && b == null) {
      if (String(candidate.added_at) < String(weakest.added_at)) weakest = candidate;
    } else if (a == null) {
      weakest = candidate;
    } else if (b == null) {
      // keep weakest
    } else if (b < a) {
      weakest = candidate;
    } else if (b === a && String(candidate.added_at) < String(weakest.added_at)) {
      weakest = candidate;
    }
  }
  return weakest;
}

async function archivePick(ticker, { reason = "board_cap" } = {}) {
  const symbol = String(ticker).toUpperCase();
  const now = new Date().toISOString();
  await dbRun(
    `UPDATE board_picks
     SET status = 'archived', archived_at = ?
     WHERE ticker = ? AND status IN (${liveStatusSql()})`,
    [now, symbol, ...LIVE_BOARD_STATUSES]
  );
  console.log(`[boardPicks] Archived ${symbol} (${reason}) at ${now}`);
  return { ticker: symbol, archivedAt: now, reason };
}

async function promotePick(
  ticker,
  { status = "watch", sector = null, source = "discovery" } = {}
) {
  const symbol = String(ticker).toUpperCase();
  const now = new Date().toISOString();
  const existing = await getPick(symbol);
  await dbRun(
    `INSERT OR REPLACE INTO board_picks
      (ticker, status, added_at, sector, archived_at, source)
     VALUES (?, ?, ?, ?, NULL, ?)`,
    [
      symbol,
      status,
      now,
      sector ?? existing?.sector ?? null,
      existing?.source || source,
    ]
  );
  console.log(`[boardPicks] Promoted/added ${symbol} as ${status}`);
  return { ticker: symbol, status, addedAt: now };
}

/**
 * Ensure room under BOARD_MAX_SIZE by archiving weakest live picks.
 * Never deletes rows or cache.
 */
async function ensureBoardCapacity(neededSlots = 1, { protect = [] } = {}) {
  const archived = [];
  let live = await countLiveBoard();
  const need = Math.max(0, Number(neededSlots) || 0);
  while (live + need > BOARD_MAX_SIZE) {
    const weak = await findWeakestLivePick(protect);
    if (!weak) break;
    archived.push(await archivePick(weak.ticker, { reason: "board_cap" }));
    live = await countLiveBoard();
  }
  return { liveCount: live, archived, max: BOARD_MAX_SIZE };
}

/**
 * Delete cache + AI rows for tickers that are no longer on board_picks at all.
 */
async function purgeTickerData(tickers) {
  const list = [
    ...new Set((tickers || []).map((t) => String(t).toUpperCase()).filter(Boolean)),
  ];
  if (!list.length) return 0;
  const placeholders = list.map(() => "?").join(", ");
  const tables = [
    "stock_reports",
    "ai_reports",
    "stock_cache",
    "ai_summaries",
    "ai_deeper_looks",
  ];
  let removed = 0;
  for (const table of tables) {
    try {
      const before = await dbGet(
        `SELECT COUNT(*) AS n FROM ${table} WHERE ticker IN (${placeholders})`,
        list
      );
      await dbRun(
        `DELETE FROM ${table} WHERE ticker IN (${placeholders})`,
        list
      );
      const after = await dbGet(
        `SELECT COUNT(*) AS n FROM ${table} WHERE ticker IN (${placeholders})`,
        list
      );
      removed += Number(before?.n || 0) - Number(after?.n || 0);
    } catch (err) {
      console.warn(`[boardPicks] purge ${table}:`, err.message);
    }
  }
  return removed;
}

/**
 * Fully remove archived stocks untouched (never re-promoted) for 90+ days.
 */
async function purgeOldArchived({
  retentionDays = ARCHIVE_RETENTION_DAYS,
} = {}) {
  const days = Math.max(1, Number(retentionDays) || ARCHIVE_RETENTION_DAYS);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const rows = await dbAll(
    `SELECT ticker, archived_at FROM board_picks
     WHERE status = 'archived'
       AND archived_at IS NOT NULL
       AND archived_at < ?
     ORDER BY archived_at ASC`,
    [cutoff]
  );
  const tickers = (rows || []).map((r) => String(r.ticker).toUpperCase());
  if (!tickers.length) {
    return { removed: [], dataRowsDeleted: 0, retentionDays: days };
  }
  const placeholders = tickers.map(() => "?").join(", ");
  await dbRun(
    `DELETE FROM board_picks
     WHERE status = 'archived' AND ticker IN (${placeholders})`,
    tickers
  );
  const dataRowsDeleted = await purgeTickerData(tickers);
  console.log(
    `[boardPicks] Purged ${tickers.length} archived ticker(s) older than ${days}d: ${tickers.join(", ")}`
  );
  return { removed: tickers, dataRowsDeleted, retentionDays: days };
}

/**
 * Trim archive to ARCHIVE_MAX_SIZE by fully removing oldest archived names first.
 */
async function trimArchiveToCap({ max = ARCHIVE_MAX_SIZE } = {}) {
  const cap = Math.max(1, Number(max) || ARCHIVE_MAX_SIZE);
  const archived = await listArchivedBoardPicks();
  if (archived.length <= cap) {
    return { trimmed: [], kept: archived.length, max: cap, dataRowsDeleted: 0 };
  }
  const overflow = archived.slice(cap); // list is newest-first; drop oldest at end
  const tickers = overflow.map((r) => String(r.ticker).toUpperCase());
  const placeholders = tickers.map(() => "?").join(", ");
  await dbRun(
    `DELETE FROM board_picks
     WHERE status = 'archived' AND ticker IN (${placeholders})`,
    tickers
  );
  const dataRowsDeleted = await purgeTickerData(tickers);
  console.log(
    `[boardPicks] Trimmed archive to ${cap}: removed ${tickers.join(", ")}`
  );
  return {
    trimmed: tickers,
    kept: cap,
    max: cap,
    dataRowsDeleted,
  };
}

/**
 * Monthly archive safeguard: 90-day purge then enforce 40-cap.
 */
async function cleanupArchive() {
  const purged = await purgeOldArchived();
  const trimmed = await trimArchiveToCap();
  return { purged, trimmed };
}

module.exports = {
  listLiveBoardPicks,
  listArchivedBoardPicks,
  listAllBoardTickers,
  countLiveBoard,
  getActiveBoardTickers,
  getPick,
  momentumScoreForTicker,
  findWeakestLivePick,
  archivePick,
  promotePick,
  ensureBoardCapacity,
  purgeOldArchived,
  trimArchiveToCap,
  cleanupArchive,
  purgeTickerData,
  BOARD_MAX_SIZE,
  ARCHIVE_MAX_SIZE,
  ARCHIVE_RETENTION_DAYS,
  LIVE_BOARD_STATUSES,
};
