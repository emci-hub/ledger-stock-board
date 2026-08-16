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

  // Snapshot exclusions before wiping the table so a full-roster reload
  // doesn't silently un-exclude previously confirmed-inactive symbols
  // (e.g. ADGI) and waste a future promote slot on them again.
  const exclusionRows = await dbAll(
    `SELECT symbol, excluded, excluded_at, exclude_reason
     FROM discovery_universe
     WHERE excluded = 1`
  );
  const exclusionMap = new Map(
    (exclusionRows || []).map((r) => [String(r.symbol).toUpperCase(), r])
  );

  await dbRun(`DELETE FROM discovery_universe`);

  const chunkSize = 80;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const placeholders = chunk
      .map(() => `(?, ?, ?, ?, ?, ?, ?, ?, 'twelve_data', ?, NULL, ?, ?, ?)`)
      .join(", ");
    const args = [];
    for (const row of chunk) {
      const isMajor = isUniverseMajorExchange(row.exchange) ? 1 : 0;
      if (isMajor) major += 1;
      const prevExclusion = exclusionMap.get(String(row.symbol).toUpperCase());
      args.push(
        row.symbol,
        row.name,
        row.exchange,
        row.mic_code,
        row.currency,
        row.type,
        row.country,
        isMajor,
        fetchedAt,
        prevExclusion ? 1 : 0,
        prevExclusion ? prevExclusion.excluded_at : null,
        prevExclusion ? prevExclusion.exclude_reason : null
      );
    }
    await dbRun(
      `INSERT INTO discovery_universe
        (symbol, name, exchange, mic_code, currency, type, country,
         is_major, source, fetched_at, last_considered_at,
         excluded, excluded_at, exclude_reason)
       VALUES ${placeholders}`,
      args
    );
  }

  if (exclusionMap.size) {
    console.log(
      `[discoveryUniverse] preserved ${exclusionMap.size} exclusion(s) across refresh`
    );
  }

  await setSetting(UNIVERSE_FETCHED_AT_SETTING_KEY, fetchedAt);
  // NOTE: cursor is intentionally NOT reset here. The cursor comparison
  // (symbol > cursor) is robust to a full roster reload on its own — it just
  // needs some symbol alphabetically greater than the cursor to exist, which
  // is true on any roster of this size. Resetting here was a real bug: since
  // Stage 0 refreshes ~daily (roster always >24h stale by the next cron run),
  // resetting on every refresh meant the cursor never advanced past its very
  // first batch, ever — confirmed in production by every discovered universe
  // candidate clustering at the start of the alphabet (ADI/ADEA/ADIL/ADGM/ADGI).

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
 * Advance a per-TIER alphabetical cursor over is_major=1 symbols, wrapping once.
 * tier=null keeps the original untiered behavior (back-compat / tier-3 fallback
 * uses tier param explicitly, so null is only for callers not using tiers yet).
 */
/**
 * Advance a per-TIER cursor over is_major=1 symbols, ordered by priority_rank
 * (lower = better/older-established, e.g. S&P "date added" — older members
 * rank lower) then symbol as a tiebreaker. Rows with no priority_rank sort
 * LAST within their tier (honest fallback to effectively-alphabetical order
 * for tiers that don't have a free ranking signal yet, rather than pretending
 * false precision). Uses proper (rank, symbol) keyset pagination — sorting by
 * rank while only comparing the cursor by symbol would silently skip/repeat
 * rows, so the cursor tracks both.
 */
const NO_RANK_SENTINEL = 999999999;

async function takeUniverseBatchFromCursor(limit = UNIVERSE_CANDIDATE_BATCH, tier = null, options = {}) {
  const persist = options.persist !== false; // default true; orchestrator passes false for dry-run
  const batchSize = Math.max(1, Number(limit) || UNIVERSE_CANDIDATE_BATCH);
  const cursorKey =
    tier != null
      ? `${UNIVERSE_CURSOR_SETTING_KEY}_tier${tier}`
      : UNIVERSE_CURSOR_SETTING_KEY;
  const cursorRaw = (await getSetting(cursorKey)) || "";
  const [cursorRankRaw, cursorSymbolRaw] = String(cursorRaw).split("|");
  const cursorRank = Number.isFinite(Number(cursorRankRaw)) ? Number(cursorRankRaw) : -1;
  const cursorSymbol = String(cursorSymbolRaw || "").trim().toUpperCase();
  const tierClause = tier != null ? "AND tier = ?" : "";
  const baseArgs = tier != null ? [tier] : [];
  const rankExpr = `COALESCE(priority_rank, ${NO_RANK_SENTINEL})`;

  let rows = await dbAll(
    `SELECT symbol, name, exchange, mic_code, currency, type, country, is_major, tier,
            ${rankExpr} AS effective_rank
     FROM discovery_universe
     WHERE is_major = 1 AND COALESCE(excluded, 0) = 0 ${tierClause}
       AND (${rankExpr} > ? OR (${rankExpr} = ? AND symbol > ?))
     ORDER BY effective_rank ASC, symbol ASC
     LIMIT ?`,
    [...baseArgs, cursorRank, cursorRank, cursorSymbol, batchSize]
  );

  if ((rows || []).length < batchSize) {
    const need = batchSize - (rows || []).length;
    const wrap = await dbAll(
      `SELECT symbol, name, exchange, mic_code, currency, type, country, is_major, tier,
              ${rankExpr} AS effective_rank
       FROM discovery_universe
       WHERE is_major = 1 AND COALESCE(excluded, 0) = 0 ${tierClause}
       ORDER BY effective_rank ASC, symbol ASC
       LIMIT ?`,
      [...baseArgs, need]
    );
    const seen = new Set((rows || []).map((r) => r.symbol));
    for (const row of wrap || []) {
      if (seen.has(row.symbol)) continue;
      rows = [...(rows || []), row];
      if (rows.length >= batchSize) break;
    }
  }

  const list = rows || [];
  const lastRow = list.length ? list[list.length - 1] : null;
  const lastCursor = lastRow
    ? `${lastRow.effective_rank}|${String(lastRow.symbol).toUpperCase()}`
    : cursorRaw;
  if (list.length && persist) {
    await setSetting(cursorKey, lastCursor);
  }
  return {
    rows: list,
    cursorBefore: cursorRaw,
    cursorAfter: persist ? lastCursor : cursorRaw,
    cursorKey,
    tier,
    wrapped:
      Boolean(cursorRaw) &&
      list.some(
        (r) =>
          r.effective_rank < cursorRank ||
          (r.effective_rank === cursorRank && String(r.symbol) <= cursorSymbol)
      ),
  };
}

/**
 * Weighted allocation across the 3 tiers. 65/25/10 by default (config-
 * overridable). If a tier is "saturated" today — every row it considered was
 * already live/candidate/archived, zero genuinely new inserts — its unused
 * allocation rolls forward to the next tier in the SAME run, so speed never
 * goes to waste once a small tier (e.g. ~500-name S&P 500) cycles through.
 */
const TIER_WEIGHTS = Object.freeze({
  1: Number(process.env.UNIVERSE_TIER1_WEIGHT) || 0.65,
  2: Number(process.env.UNIVERSE_TIER2_WEIGHT) || 0.25,
  3: Number(process.env.UNIVERSE_TIER3_WEIGHT) || 0.1,
});

function computeTierAllocation(totalBatchSize) {
  const t1 = Math.round(totalBatchSize * TIER_WEIGHTS[1]);
  const t2 = Math.round(totalBatchSize * TIER_WEIGHTS[2]);
  const t3 = Math.max(0, totalBatchSize - t1 - t2); // remainder, avoids rounding drift
  return { 1: t1, 2: t2, 3: t3 };
}

/**
 * Stage 1b — weighted 3-tier cursor batch into board_picks as status=candidate.
 * Zero market-data API cost (local table + board_picks only).
 *
 * Tier 1 (S&P 500) / Tier 2 (S&P 400+600+Nasdaq-100) / Tier 3 (rest) each get
 * their own alphabetical cursor and their own allocation of today's batch
 * (default 65/25/10). If a tier is "saturated" today — every row it considered
 * was already live/candidate/archived, zero genuinely new inserts — its unused
 * allocation rolls forward to the next tier in this SAME run, so a small tier
 * (e.g. ~500-name S&P 500) doesn't waste slots once it's fully cycled.
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

  const allocation = computeTierAllocation(batchSize);
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
  const tierBreakdown = {};
  let insertsLeft = headroom;
  let carryOver = 0;
  const cursorResults = {};

  async function processRow(row) {
    const symbol = String(row.symbol).toUpperCase();
    considered.push(symbol);

    const existing = await getPick(symbol);
    if (existing?.status === "recommended" || existing?.status === "watch") {
      stats.skippedLive += 1;
      stats.skippedExisting += 1;
      return { inserted: false };
    }
    if (existing?.status === "archived") {
      stats.skippedArchived += 1;
      stats.skippedExisting += 1;
      return { inserted: false };
    }
    if (existing?.status === "candidate") {
      stats.skippedExisting += 1;
      if (!dryRun) {
        await upsertCandidateFromUniverse({
          ticker: symbol,
          name: row.name,
          exchange: row.exchange,
          tier: row.tier,
        });
        stats.updated += 1;
      }
      return { inserted: false };
    }

    if (insertsLeft <= 0) {
      stats.skippedNoHeadroom += 1;
      return { inserted: false };
    }

    wouldInsert.push(symbol);
    if (!dryRun) {
      const res = await upsertCandidateFromUniverse({
        ticker: symbol,
        name: row.name,
        exchange: row.exchange,
        tier: row.tier,
      });
      if (res.action === "inserted") {
        stats.inserted += 1;
        insertsLeft -= 1;
        return { inserted: true };
      } else if (res.action === "updated") {
        stats.updated += 1;
      } else if (res.action === "refreshed_live") {
        stats.skippedLive += 1;
      } else if (res.action === "refreshed_archived") {
        stats.skippedArchived += 1;
      }
      return { inserted: false };
    }
    stats.inserted += 1;
    insertsLeft -= 1;
    return { inserted: true };
  }

  for (const tier of [1, 2, 3]) {
    const tierBatchSize = allocation[tier] + carryOver;
    carryOver = 0;
    if (tierBatchSize <= 0) {
      tierBreakdown[tier] = { allocated: allocation[tier], considered: 0, inserted: 0, saturated: false };
      continue;
    }
    const taken = await takeUniverseBatchFromCursor(tierBatchSize, tier, { persist: !dryRun });
    cursorResults[tier] = taken;
    let insertedThisTier = 0;
    for (const row of taken.rows) {
      const outcome = await processRow(row);
      if (outcome.inserted) insertedThisTier += 1;
    }
    // Saturated: we looked at real rows but genuinely inserted none — the
    // tier has nothing new left today. Roll its allocation to the next tier.
    const saturated = taken.rows.length > 0 && insertedThisTier === 0;
    if (saturated) {
      carryOver = allocation[tier];
    }
    tierBreakdown[tier] = {
      allocated: allocation[tier],
      considered: taken.rows.length,
      inserted: insertedThisTier,
      saturated,
    };
  }

  if (!dryRun) {
    await markUniverseConsidered(considered, consideredAt);
    // Per-tier cursors already persisted themselves inside
    // takeUniverseBatchFromCursor — nothing to do here.
  }

  return {
    ok: true,
    dryRun,
    source: DISCOVERY_UNIVERSE_SOURCE,
    batchSize,
    allocation,
    tierBreakdown,
    headroom,
    target,
    considered: considered.length,
    consideredTickers: considered,
    wouldInsert,
    cursors: cursorResults,
    ...stats,
    poolSizeAfter: dryRun ? currentCandidates : await countCandidates(),
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

/**
 * Mark a universe symbol excluded (e.g. FMP confirmed isActivelyTrading=false
 * at promote time) so the cursor stops re-considering it every cycle. Keeps
 * the row (does not delete) so exclusion survives future Stage 0 refreshes.
 * Safe no-op if the symbol isn't in discovery_universe (e.g. a movers-sourced
 * ticker with no universe row).
 */
async function markUniverseExcluded(symbol, reason = "not_actively_trading") {
  const sym = String(symbol || "")
    .trim()
    .toUpperCase();
  if (!sym) return { ok: false, reason: "no_symbol" };
  const now = new Date().toISOString();
  const result = await dbRun(
    `UPDATE discovery_universe
     SET excluded = 1, excluded_at = ?, exclude_reason = ?
     WHERE symbol = ?`,
    [now, reason, sym]
  );
  return { ok: true, symbol: sym, changes: result?.rowsAffected ?? null };
}

const INDEX_TIER_REFRESH_SETTING_KEY = "index_tier_refreshed_at";
const INDEX_TIER_REFRESH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // weekly — index membership rarely changes

async function indexTierCacheIsFresh() {
  const at = await getSetting(INDEX_TIER_REFRESH_SETTING_KEY);
  if (!at) return false;
  const age = Date.now() - new Date(at).getTime();
  return Number.isFinite(age) && age < INDEX_TIER_REFRESH_MAX_AGE_MS;
}

/**
 * Apply real S&P 500/400/600 membership (tier + priority_rank) onto existing
 * discovery_universe rows. Weekly cadence — index membership changes rarely,
 * no reason to hit Wikipedia daily. Never wipes tier data on a fetch failure
 * — a symbol not found in this run's membership map keeps whatever tier it
 * already had (default 3 for never-classified rows), so a transient Wikipedia
 * hiccup can't accidentally demote everyone to tier 3.
 */
async function refreshIndexTiers(options = {}) {
  const force = Boolean(options.force);
  if (!force && (await indexTierCacheIsFresh())) {
    return { ok: true, skipped: true, reason: "fresh" };
  }

  const { fetchAllIndexMembership } = require("./indexTiers");
  const { membership, results } = await fetchAllIndexMembership();

  if (membership.size === 0) {
    console.warn(
      "[indexTiers] All index sources failed or returned empty — keeping existing tier data unchanged",
      results
    );
    return { ok: false, applied: 0, results };
  }

  let applied = 0;
  let boardApplied = 0;
  for (const [symbol, info] of membership) {
    const res = await dbRun(
      `UPDATE discovery_universe SET tier = ?, priority_rank = ?, tier_updated_at = ?
       WHERE symbol = ?`,
      [info.tier, info.priorityRank, new Date().toISOString(), symbol]
    );
    if (res?.rowsAffected) applied += 1;

    // Also backfill board_picks directly — covers every ticker regardless of
    // how it entered the board (seed, movers, or the tiered universe path).
    // discovery_universe alone only reaches tickers found via that one path;
    // this closes the gap for seeded/movers-sourced tickers like the
    // original core-8, which never went through upsertCandidateFromUniverse.
    const boardRes = await dbRun(
      `UPDATE board_picks SET tier = ? WHERE ticker = ?`,
      [info.tier, symbol]
    );
    if (boardRes?.rowsAffected) boardApplied += 1;
  }

  await setSetting(INDEX_TIER_REFRESH_SETTING_KEY, new Date().toISOString());
  console.log(
    `[indexTiers] applied tier/rank to ${applied}/${membership.size} matched symbols (discovery_universe), ${boardApplied} on board_picks`,
    results
  );
  return { ok: true, applied, boardApplied, matched: membership.size, results };
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
  markUniverseExcluded,
  computeTierAllocation,
  TIER_WEIGHTS,
  refreshIndexTiers,
  indexTierCacheIsFresh,
};
