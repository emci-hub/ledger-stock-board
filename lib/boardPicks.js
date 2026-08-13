/**
 * Board pick helpers: live vs archived, cap enforcement, momentum ranking.
 */

const {
  BOARD_TICKERS,
  BOARD_MAX_SIZE,
  ARCHIVE_MAX_SIZE,
  ARCHIVE_RETENTION_DAYS,
  LIVE_BOARD_STATUSES,
  CANDIDATE_POOL_CAP,
  CANDIDATE_MISS_STREAK_LIMIT,
  DISCOVERY_PROMOTE_HARD_CAP,
  isMajorExchange,
  isPennyPrice,
} = require("../lib/boardTickers");
const { getStockCacheEntry } = require("../services/cache");
const { dbGet, dbAll, dbRun } = require("../db/schema");

function liveStatusSql() {
  return LIVE_BOARD_STATUSES.map(() => "?").join(", ");
}

async function listLiveBoardPicks() {
  return dbAll(
    `SELECT ticker, status, added_at, sector, archived_at, source,
            name, price, percent_change, exchange, discovered_at, last_seen_at,
            miss_streak, flags_json
     FROM board_picks
     WHERE status IN (${liveStatusSql()})
     ORDER BY added_at DESC`,
    LIVE_BOARD_STATUSES
  );
}

async function listArchivedBoardPicks() {
  return dbAll(
    `SELECT ticker, status, added_at, sector, archived_at, source,
            name, price, percent_change, exchange, discovered_at, last_seen_at,
            miss_streak, flags_json
     FROM board_picks
     WHERE status = 'archived'
     ORDER BY archived_at DESC, added_at DESC`
  );
}

async function listCandidatePicks() {
  return dbAll(
    `SELECT ticker, status, added_at, sector, archived_at, source,
            name, price, percent_change, exchange, discovered_at, last_seen_at,
            miss_streak, flags_json
     FROM board_picks
     WHERE status = 'candidate'
     ORDER BY ABS(COALESCE(percent_change, 0)) DESC, last_seen_at DESC`
  );
}

async function countCandidates() {
  const row = await dbGet(
    `SELECT COUNT(*) AS n FROM board_picks WHERE status = 'candidate'`
  );
  return Number(row?.n || 0);
}

function parseFlags(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

function buildCandidateFlags(mover) {
  const price = mover?.last ?? mover?.price ?? null;
  const exchange = mover?.exchange || null;
  return {
    penny: isPennyPrice(price),
    nonMajorExchange: !isMajorExchange(exchange),
  };
}

/**
 * Stage 1 upsert: save cheap FMP signal as status=candidate.
 * Never demotes live or archived rows — only refreshes their signal fields.
 */
async function upsertCandidateFromMover(mover) {
  const symbol = String(mover?.ticker || "")
    .trim()
    .toUpperCase();
  if (!symbol) return { action: "skipped_invalid" };

  const now = new Date().toISOString();
  const name = mover.name || null;
  const price =
    mover.last != null
      ? Number(mover.last)
      : mover.price != null
        ? Number(mover.price)
        : null;
  const percentChange =
    mover.percentChange != null ? Number(mover.percentChange) : null;
  const exchange = mover.exchange || null;
  const flags = buildCandidateFlags(mover);
  const flagsJson = JSON.stringify(flags);
  const existing = await getPick(symbol);

  if (existing && LIVE_BOARD_STATUSES.includes(existing.status)) {
    await dbRun(
      `UPDATE board_picks
       SET name = COALESCE(?, name),
           price = ?,
           percent_change = ?,
           exchange = COALESCE(?, exchange),
           last_seen_at = ?,
           miss_streak = 0,
           flags_json = ?
       WHERE ticker = ?`,
      [name, price, percentChange, exchange, now, flagsJson, symbol]
    );
    return { action: "refreshed_live", ticker: symbol, flags };
  }

  if (existing && existing.status === "archived") {
    await dbRun(
      `UPDATE board_picks
       SET name = COALESCE(?, name),
           price = ?,
           percent_change = ?,
           exchange = COALESCE(?, exchange),
           last_seen_at = ?,
           miss_streak = 0,
           flags_json = ?
       WHERE ticker = ?`,
      [name, price, percentChange, exchange, now, flagsJson, symbol]
    );
    return { action: "refreshed_archived", ticker: symbol, flags };
  }

  const discoveredAt = existing?.discovered_at || now;
  await dbRun(
    `INSERT INTO board_picks
      (ticker, status, added_at, sector, archived_at, source,
       name, price, percent_change, exchange, discovered_at, last_seen_at,
       miss_streak, flags_json)
     VALUES (?, 'candidate', ?, NULL, NULL, 'discovery',
             ?, ?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT(ticker) DO UPDATE SET
       status = 'candidate',
       name = excluded.name,
       price = excluded.price,
       percent_change = excluded.percent_change,
       exchange = excluded.exchange,
       last_seen_at = excluded.last_seen_at,
       miss_streak = 0,
       flags_json = excluded.flags_json,
       source = COALESCE(board_picks.source, 'discovery'),
       discovered_at = COALESCE(board_picks.discovered_at, excluded.discovered_at),
       archived_at = NULL`,
    [
      symbol,
      existing?.added_at || now,
      name,
      price,
      percentChange,
      exchange,
      discoveredAt,
      now,
      flagsJson,
    ]
  );
  return {
    action: existing?.status === "candidate" ? "updated" : "inserted",
    ticker: symbol,
    flags,
    percentChange,
  };
}

/**
 * Bump miss_streak for candidates not in today's FMP set; delete when over limit.
 */
async function pruneMissingCandidates(
  seenTickers,
  { missLimit = CANDIDATE_MISS_STREAK_LIMIT } = {}
) {
  const seen = new Set(
    (seenTickers || []).map((t) => String(t).toUpperCase()).filter(Boolean)
  );
  const candidates = await listCandidatePicks();
  const bumped = [];
  const removed = [];
  const limit = Math.max(1, Number(missLimit) || CANDIDATE_MISS_STREAK_LIMIT);

  for (const row of candidates) {
    const ticker = String(row.ticker).toUpperCase();
    if (seen.has(ticker)) continue;
    const next = Number(row.miss_streak || 0) + 1;
    if (next >= limit) {
      await dbRun(
        `DELETE FROM board_picks WHERE ticker = ? AND status = 'candidate'`,
        [ticker]
      );
      removed.push(ticker);
    } else {
      await dbRun(
        `UPDATE board_picks SET miss_streak = ? WHERE ticker = ? AND status = 'candidate'`,
        [next, ticker]
      );
      bumped.push({ ticker, miss_streak: next });
    }
  }
  return { bumped, removed, missLimit: limit };
}

/**
 * Trim candidate pool to cap — drop weakest |%change| / oldest last_seen first.
 * Prefer trimming flagged (penny / non-major) before clean majors when tied.
 */
async function trimCandidatePool({ max = CANDIDATE_POOL_CAP } = {}) {
  const cap = Math.max(50, Number(max) || CANDIDATE_POOL_CAP);
  const candidates = await listCandidatePicks();
  if (candidates.length <= cap) {
    return { trimmed: [], kept: candidates.length, max: cap };
  }

  const scored = candidates.map((row) => {
    const flags = parseFlags(row.flags_json);
    const strength = Math.abs(Number(row.percent_change) || 0);
    const flagged = Boolean(flags.penny || flags.nonMajorExchange);
    return { row, strength, flagged, lastSeen: row.last_seen_at || "" };
  });
  // Keep strongest first; when trimming, remove from the end.
  scored.sort((a, b) => {
    if (a.flagged !== b.flagged) return a.flagged ? 1 : -1; // flagged sort later (trimmed first)
    if (b.strength !== a.strength) return b.strength - a.strength;
    return String(b.lastSeen).localeCompare(String(a.lastSeen));
  });

  const overflow = scored.slice(cap);
  const tickers = overflow.map((s) => String(s.row.ticker).toUpperCase());
  if (tickers.length) {
    const placeholders = tickers.map(() => "?").join(", ");
    await dbRun(
      `DELETE FROM board_picks
       WHERE status = 'candidate' AND ticker IN (${placeholders})`,
      tickers
    );
  }
  console.log(
    `[boardPicks] Trimmed candidate pool to ${cap}: removed ${tickers.length}`
  );
  return { trimmed: tickers, kept: cap, max: cap };
}

/**
 * Rank candidates for Stage 2 promotion: main long/short pool first
 * (major exchange, non-penny), then by |percent_change|.
 */
function rankCandidatesForPromotion(rows) {
  return (rows || [])
    .map((row) => {
      const flags = parseFlags(row.flags_json);
      const strength = Math.abs(Number(row.percent_change) || 0);
      const mainPool = !flags.penny && !flags.nonMajorExchange;
      return { ...row, flags, strength, mainPool };
    })
    .sort((a, b) => {
      if (a.mainPool !== b.mainPool) return a.mainPool ? -1 : 1;
      if (b.strength !== a.strength) return b.strength - a.strength;
      return String(b.last_seen_at || "").localeCompare(
        String(a.last_seen_at || "")
      );
    });
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
  if (existing) {
    await dbRun(
      `UPDATE board_picks
       SET status = ?,
           added_at = ?,
           sector = COALESCE(?, sector),
           archived_at = NULL,
           source = ?,
           miss_streak = 0
       WHERE ticker = ?`,
      [
        status,
        now,
        sector ?? null,
        existing.source === "seed" ? existing.source : source,
        symbol,
      ]
    );
  } else {
    await dbRun(
      `INSERT INTO board_picks
        (ticker, status, added_at, sector, archived_at, source, miss_streak)
       VALUES (?, ?, ?, ?, NULL, ?, 0)`,
      [symbol, status, now, sector ?? null, source]
    );
  }
  console.log(`[boardPicks] Promoted/added ${symbol} as ${status}`);
  return { ticker: symbol, status, addedAt: now };
}

/**
 * Preview who would be archived to free `neededSlots` without mutating.
 */
async function previewArchivesForSlots(neededSlots = 1, { protect = [] } = {}) {
  const exclude = new Set(
    (protect || []).map((t) => String(t).toUpperCase())
  );
  const wouldArchive = [];
  let live = await countLiveBoard();
  const need = Math.max(0, Number(neededSlots) || 0);
  const alreadyListed = new Set();
  while (live + need - wouldArchive.length > BOARD_MAX_SIZE) {
    const weak = await findWeakestLivePick([
      ...exclude,
      ...alreadyListed,
    ]);
    if (!weak) break;
    const ticker = String(weak.ticker).toUpperCase();
    wouldArchive.push({
      ticker,
      momentum: weak.momentum,
      added_at: weak.added_at,
      reason: "board_cap",
    });
    alreadyListed.add(ticker);
    if (wouldArchive.length > BOARD_MAX_SIZE) break;
  }
  return {
    liveCount: live,
    max: BOARD_MAX_SIZE,
    neededSlots: need,
    wouldArchive,
  };
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
  listCandidatePicks,
  listAllBoardTickers,
  countLiveBoard,
  countCandidates,
  getActiveBoardTickers,
  getPick,
  momentumScoreForTicker,
  findWeakestLivePick,
  archivePick,
  promotePick,
  upsertCandidateFromMover,
  pruneMissingCandidates,
  trimCandidatePool,
  rankCandidatesForPromotion,
  parseFlags,
  buildCandidateFlags,
  ensureBoardCapacity,
  previewArchivesForSlots,
  purgeOldArchived,
  trimArchiveToCap,
  cleanupArchive,
  purgeTickerData,
  BOARD_MAX_SIZE,
  ARCHIVE_MAX_SIZE,
  ARCHIVE_RETENTION_DAYS,
  LIVE_BOARD_STATUSES,
  CANDIDATE_POOL_CAP,
  CANDIDATE_MISS_STREAK_LIMIT,
  DISCOVERY_PROMOTE_HARD_CAP,
};
