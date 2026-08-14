/**
 * Broad-universe discovery source: Twelve Data US Common Stock list,
 * cached in discovery_universe, cursor-batched into board_picks candidates.
 *
 * Not a classifier — feeds the same Stage 2 promote → assessBoardPlacement path.
 */

const { dbAll, dbGet, dbRun } = require("../db/schema");
const { getSetting, setSetting } = require("./usage");
const { getUsCommonStocksFromTwelve } = require("./dataFetch");
const {
  UNIVERSE_MAJOR_EXCHANGES,
  UNIVERSE_REFRESH_MAX_AGE_MS,
  UNIVERSE_CANDIDATE_BATCH,
  UNIVERSE_CURSOR_SETTING_KEY,
  UNIVERSE_FETCHED_AT_SETTING_KEY,
  DISCOVERY_UNIVERSE_SOURCE,
  CANDIDATE_POOL_CAP,
  isMajorExchange,
} = require("../lib/boardTickers");

function boardPicks() {
  // Lazy require — avoid circular init with lib/boardPicks ↔ jobs/discoverHotStocks.
  return require("../lib/boardPicks");
}

function hasTwelveKey() {
  return Boolean(process.env.TWELVE_DATA_API_KEY);
}

function isUniverseMajorExchange(exchange) {
  const ex = String(exchange || "")
    .trim()
    .toUpperCase();
  if (!ex) return false;
  if (UNIVERSE_MAJOR_EXCHANGES.includes(ex)) return true;
  // Defensive: also accept anything isMajorExchange already treats as major
  // when it matches the configured short names.
  return isMajorExchange(ex) && (ex === "NASDAQ" || ex === "NYSE" || ex === "AMEX");
}

async function countUniverseRows({ majorOnly = false } = {}) {
  const row = await dbGet(
    majorOnly
      ? `SELECT COUNT(*) AS n FROM discovery_universe WHERE is_major = 1`
      : `SELECT COUNT(*) AS n FROM discovery_universe`
  );
  return Number(row?.n || 0);
}

async function getUniverseFetchedAt() {
  const fromSetting = await getSetting(UNIVERSE_FETCHED_AT_SETTING_KEY);
  if (fromSetting) return String(fromSetting);
  const row = await dbGet(
    `SELECT MAX(fetched_at) AS fetched_at FROM discovery_universe`
  );
  return row?.fetched_at ? String(row.fetched_at) : null;
}

async function universeCacheIsFresh(maxAgeMs = UNIVERSE_REFRESH_MAX_AGE_MS) {
  const fetchedAt = await getUniverseFetchedAt();
  if (!fetchedAt) return false;
  const majorCount = await countUniverseRows({ majorOnly: true });
  if (majorCount < 100) return false;
  const age = Date.now() - new Date(fetchedAt).getTime();
  return Number.isFinite(age) && age >= 0 && age < maxAgeMs;
}

/**
 * Stage 0 — refresh discovery_universe from Twelve Data when stale/missing.
 * Cost: 1 TD credit when a refresh runs.
 */
async function refreshDiscoveryUniverse(options = {}) {
  const force = Boolean(options.force);
  const dryRun = Boolean(options.dryRun);
  const startedAt = new Date().toISOString();

  if (!hasTwelveKey()) {
    return {
      ok: false,
      skipped: true,
      reason: "no_twelve_key",
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  const fresh = force ? false : await universeCacheIsFresh();
  if (fresh) {
    return {
      ok: true,
      skipped: true,
      reason: "cache_fresh",
      fetchedAt: await getUniverseFetchedAt(),
      total: await countUniverseRows(),
      major: await countUniverseRows({ majorOnly: true }),
      startedAt,
      finishedAt: new Date().toISOString(),
      twelveDataCalls: 0,
    };
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      wouldRefresh: true,
      fetchedAt: await getUniverseFetchedAt(),
      total: await countUniverseRows(),
      major: await countUniverseRows({ majorOnly: true }),
      startedAt,
      finishedAt: new Date().toISOString(),
      twelveDataCalls: 1,
    };
  }

  const rows = await getUsCommonStocksFromTwelve();
  const fetchedAt = new Date().toISOString();
  let major = 0;

  await dbRun(`DELETE FROM discovery_universe`);

  const chunkSize = 80;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const placeholders = chunk
      .map(() => `(?, ?, ?, ?, ?, ?, ?, ?, 'twelve_data', ?, NULL)`)
      .join(", ");
    const args = [];
    for (const row of chunk) {
      const isMajor = isUniverseMajorExchange(row.exchange) ? 1 : 0;
      if (isMajor) major += 1;
      args.push(
        row.symbol,
        row.name,
        row.exchange,
        row.mic_code,
        row.currency,
        row.type,
        row.country,
        isMajor,
        fetchedAt
      );
    }
    await dbRun(
      `INSERT INTO discovery_universe
        (symbol, name, exchange, mic_code, currency, type, country,
         is_major, source, fetched_at, last_considered_at)
       VALUES ${placeholders}`,
      args
    );
  }

  await setSetting(UNIVERSE_FETCHED_AT_SETTING_KEY, fetchedAt);
  // Reset cursor when the roster is fully replaced so we don't strand mid-alphabet.
  await setSetting(UNIVERSE_CURSOR_SETTING_KEY, "");

  console.log(
    `[discoveryUniverse] refreshed ${rows.length} symbols (${major} major) at ${fetchedAt}`
  );

  return {
    ok: true,
    skipped: false,
    fetchedAt,
    total: rows.length,
    major,
    startedAt,
    finishedAt: new Date().toISOString(),
    twelveDataCalls: 1,
  };
}

async function markUniverseConsidered(symbols, consideredAt) {
  const now = consideredAt || new Date().toISOString();
  const list = [...new Set((symbols || []).map((s) => String(s).toUpperCase()))];
  for (const symbol of list) {
    await dbRun(
      `UPDATE discovery_universe SET last_considered_at = ? WHERE symbol = ?`,
      [now, symbol]
    );
  }
}

/**
 * Advance alphabetical cursor over is_major=1 symbols, wrapping once.
 */
async function takeUniverseBatchFromCursor(limit = UNIVERSE_CANDIDATE_BATCH) {
  const batchSize = Math.max(1, Number(limit) || UNIVERSE_CANDIDATE_BATCH);
  const cursorRaw = (await getSetting(UNIVERSE_CURSOR_SETTING_KEY)) || "";
  const cursor = String(cursorRaw).trim().toUpperCase();

  let rows = await dbAll(
    `SELECT symbol, name, exchange, mic_code, currency, type, country, is_major
     FROM discovery_universe
     WHERE is_major = 1 AND symbol > ?
     ORDER BY symbol ASC
     LIMIT ?`,
    [cursor, batchSize]
  );

  if ((rows || []).length < batchSize) {
    const need = batchSize - (rows || []).length;
    const wrap = await dbAll(
      `SELECT symbol, name, exchange, mic_code, currency, type, country, is_major
       FROM discovery_universe
       WHERE is_major = 1
       ORDER BY symbol ASC
       LIMIT ?`,
      [need]
    );
    const seen = new Set((rows || []).map((r) => r.symbol));
    for (const row of wrap || []) {
      if (seen.has(row.symbol)) continue;
      rows = [...(rows || []), row];
      if (rows.length >= batchSize) break;
    }
  }

  const list = rows || [];
  const lastSymbol = list.length
    ? String(list[list.length - 1].symbol).toUpperCase()
    : cursor;
  return {
    rows: list,
    cursorBefore: cursor,
    cursorAfter: lastSymbol,
    wrapped: Boolean(cursor) && list.some((r) => String(r.symbol) <= cursor),
  };
}

/**
 * Stage 1b — cursor batch into board_picks as status=candidate.
 * Zero market-data API cost (local table + board_picks only).
 */
async function upsertUniverseCandidateBatch(options = {}) {
  const dryRun = Boolean(options.dryRun);
  const batchSize = Math.max(
    1,
    Number(options.batchSize) || UNIVERSE_CANDIDATE_BATCH
  );
  const poolCap = Math.max(50, Number(options.poolCap) || CANDIDATE_POOL_CAP);
  const startedAt = new Date().toISOString();

  const majorCount = await countUniverseRows({ majorOnly: true });
  if (majorCount === 0) {
    return {
      ok: false,
      skipped: true,
      reason: "universe_empty",
      inserted: 0,
      updated: 0,
      skippedExisting: 0,
      considered: 0,
      batchSize,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  const { countCandidates, getPick, upsertCandidateFromUniverse } = boardPicks();
  const currentCandidates = await countCandidates();
  const headroom = Math.max(0, poolCap - currentCandidates);
  const target = Math.min(batchSize, headroom > 0 ? Math.max(headroom, 0) : 0);

  // Still advance cursor over a full batch of considerations even if headroom is
  // tight — but only upsert up to headroom. If headroom is 0, consider without insert.
  const taken = await takeUniverseBatchFromCursor(batchSize);
  const consideredAt = new Date().toISOString();
  const considered = [];
  const wouldInsert = [];
  const stats = {
    inserted: 0,
    updated: 0,
    skippedExisting: 0,
    skippedLive: 0,
    skippedArchived: 0,
    skippedNoHeadroom: 0,
  };

  let insertsLeft = headroom;

  for (const row of taken.rows) {
    const symbol = String(row.symbol).toUpperCase();
    considered.push(symbol);

    const existing = await getPick(symbol);
    if (existing?.status === "recommended" || existing?.status === "watch") {
      stats.skippedLive += 1;
      stats.skippedExisting += 1;
      continue;
    }
    if (existing?.status === "archived") {
      stats.skippedArchived += 1;
      stats.skippedExisting += 1;
      continue;
    }
    if (existing?.status === "candidate") {
      stats.skippedExisting += 1;
      // Refresh last_seen / exchange without counting as a new pool entry.
      if (!dryRun) {
        await upsertCandidateFromUniverse({
          ticker: symbol,
          name: row.name,
          exchange: row.exchange,
        });
        stats.updated += 1;
      }
      continue;
    }

    if (insertsLeft <= 0) {
      stats.skippedNoHeadroom += 1;
      continue;
    }

    wouldInsert.push(symbol);
    if (!dryRun) {
      const res = await upsertCandidateFromUniverse({
        ticker: symbol,
        name: row.name,
        exchange: row.exchange,
      });
      if (res.action === "inserted") {
        stats.inserted += 1;
        insertsLeft -= 1;
      } else if (res.action === "updated") {
        stats.updated += 1;
      } else if (res.action === "refreshed_live") {
        stats.skippedLive += 1;
      } else if (res.action === "refreshed_archived") {
        stats.skippedArchived += 1;
      }
    } else {
      stats.inserted += 1;
      insertsLeft -= 1;
    }
  }

  if (!dryRun) {
    await markUniverseConsidered(considered, consideredAt);
    await setSetting(UNIVERSE_CURSOR_SETTING_KEY, taken.cursorAfter || "");
  }

  return {
    ok: true,
    dryRun,
    source: DISCOVERY_UNIVERSE_SOURCE,
    batchSize,
    headroom,
    target,
    considered: considered.length,
    consideredTickers: considered,
    wouldInsert,
    cursorBefore: taken.cursorBefore,
    cursorAfter: dryRun ? taken.cursorBefore : taken.cursorAfter,
    wrapped: taken.wrapped,
    ...stats,
    poolSizeAfter: dryRun ? currentCandidates : await countCandidates(),
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

module.exports = {
  refreshDiscoveryUniverse,
  upsertUniverseCandidateBatch,
  takeUniverseBatchFromCursor,
  universeCacheIsFresh,
  countUniverseRows,
  getUniverseFetchedAt,
  isUniverseMajorExchange,
  markUniverseConsidered,
};
