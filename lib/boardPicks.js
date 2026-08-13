/**
 * Board pick helpers: live vs archived, cap enforcement, momentum ranking.
 */

const { dbGet, dbAll, dbRun } = require("../db/schema");
const {
  BOARD_TICKERS,
  BOARD_MAX_SIZE,
  LIVE_BOARD_STATUSES,
} = require("../lib/boardTickers");
const { getStockCacheEntry } = require("../services/cache");

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
  BOARD_MAX_SIZE,
  LIVE_BOARD_STATUSES,
};
