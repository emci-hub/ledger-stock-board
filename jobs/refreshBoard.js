const { dbGet, dbAll, dbRun } = require("../db/schema");
const { getStockReport } = require("../services/getStockReport");
const {
  getCachedStock,
  getStockCacheEntry,
  getCachedSummary,
  isFullyFresh,
} = require("../services/cache");
const { setSetting } = require("../services/usage");
const { AlphaVantageError } = require("../services/dataFetch");
const { ensureJokePool } = require("../services/jokes");
const { BOARD_TICKERS } = require("../lib/boardTickers");
const { runCapabilityProbe } = require("./capabilityProbe");
const {
  getActiveBoardTickers,
  listAllBoardTickers,
  promotePick,
  getPick,
  cleanupArchive,
} = require("../lib/boardPicks");

/** Neutral "roughly flat" band vs logged price (±3%). */
const FLAT_BAND = 0.03;

/** Stale off-board cache retention before cleanup. */
const STALE_CACHE_DAYS = 30;

function statusFromAnalysis(lean, risk) {
  const l = String(lean || "").toLowerCase();
  const r = String(risk || "").toLowerCase();

  if (l === "bearish" || r === "high") return "watch";
  if (l === "bullish" || (l === "neutral" && r === "low")) return "recommended";
  // Neutral/medium and other middling outcomes still belong on the board as watch.
  return "watch";
}

async function logRecommendation(ticker, price, lean) {
  await dbRun(
    `INSERT INTO recommendation_log (ticker, logged_price, lean, logged_at, resolved, hit_target)
     VALUES (?, ?, ?, ?, 0, NULL)`,
    [
      String(ticker).toUpperCase(),
      Number(price),
      String(lean || "neutral").toLowerCase(),
      new Date().toISOString(),
    ]
  );
}

async function getCurrentPrice(ticker) {
  const symbol = String(ticker).toUpperCase();
  const cached = await getCachedStock(symbol);
  if (cached?.quote?.price?.current != null) {
    return Number(cached.quote.price.current);
  }
  return null;
}

function directionHit(lean, loggedPrice, currentPrice) {
  if (
    loggedPrice == null ||
    currentPrice == null ||
    !Number.isFinite(loggedPrice) ||
    !Number.isFinite(currentPrice) ||
    loggedPrice === 0
  ) {
    return 0;
  }

  const changePct = (currentPrice - loggedPrice) / Math.abs(loggedPrice);
  const l = String(lean || "").toLowerCase();

  if (l === "bullish") return changePct > 0 ? 1 : 0;
  if (l === "bearish") return changePct < 0 ? 1 : 0;
  return Math.abs(changePct) <= FLAT_BAND ? 1 : 0;
}

async function resolveOldRecommendations() {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const rows = await dbAll(
    `SELECT id, ticker, logged_price, lean, logged_at
     FROM recommendation_log
     WHERE resolved = 0 AND logged_at < ?
     ORDER BY logged_at ASC`,
    [cutoff]
  );

  console.log(
    `[resolveOldRecommendations] ${rows.length} row(s) older than 30d at ${new Date().toISOString()}`
  );

  let resolved = 0;
  let skipped = 0;

  for (const row of rows) {
    try {
      const currentPrice = await getCurrentPrice(row.ticker);
      if (currentPrice == null) {
        skipped += 1;
        continue;
      }

      const hit = directionHit(row.lean, row.logged_price, currentPrice);
      await dbRun(
        `UPDATE recommendation_log SET resolved = 1, hit_target = ? WHERE id = ?`,
        [hit, row.id]
      );
      resolved += 1;
    } catch (err) {
      console.error(
        `[resolveOldRecommendations] Failed id=${row.id} ${row.ticker}:`,
        err.message
      );
      skipped += 1;
    }
  }

  console.log(
    `[resolveOldRecommendations] Done — resolved=${resolved}, skipped=${skipped}`
  );
}

async function getTrackRecord(ticker) {
  const row = await dbGet(
    `SELECT
       COUNT(*) AS resolvedCount,
       SUM(CASE WHEN hit_target = 1 THEN 1 ELSE 0 END) AS hits
     FROM recommendation_log
     WHERE ticker = ? AND resolved = 1`,
    [String(ticker).toUpperCase()]
  );

  const resolvedCount = Number(row?.resolvedCount || 0);
  const hits = Number(row?.hits || 0);

  if (resolvedCount < 3) {
    return { building: true, resolvedCount };
  }

  const hitRate = Math.round((hits / resolvedCount) * 100);
  return { building: false, hitRate, hits, resolvedCount };
}

/**
 * Delete shared + legacy cache rows for tickers not on the board whose
 * last_updated / generated_at is older than 30 days. Tops up JokeAPI pool.
 */
async function cleanupStaleCache() {
  const cutoff = new Date(
    Date.now() - STALE_CACHE_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  // Protect seed list + every board_picks row (live and archived) so history stays intact.
  const fromPicks = await listAllBoardTickers();
  const board = [
    ...new Set([
      ...BOARD_TICKERS.map((t) => String(t).toUpperCase()),
      ...fromPicks,
    ]),
  ];
  if (!board.length) {
    console.warn("[cleanupStaleCache] BOARD_TICKERS empty — refusing to delete");
    return { deleted: 0, skipped: true };
  }

  const placeholders = board.map(() => "?").join(", ");
  const targets = [
    { table: "stock_reports", timeCol: "last_updated" },
    { table: "ai_reports", timeCol: "generated_at" },
    { table: "stock_cache", timeCol: "last_updated" },
    { table: "ai_summaries", timeCol: "generated_at" },
  ];

  let deleted = 0;

  for (const { table, timeCol } of targets) {
    try {
      const before = await dbGet(`SELECT COUNT(*) AS n FROM ${table}`);
      await dbRun(
        `DELETE FROM ${table}
         WHERE ${timeCol} < ?
           AND ticker NOT IN (${placeholders})`,
        [cutoff, ...board]
      );
      const after = await dbGet(`SELECT COUNT(*) AS n FROM ${table}`);
      const removed =
        Number(before?.n || 0) - Number(after?.n || 0);
      if (removed > 0) {
        deleted += removed;
        console.log(
          `[cleanupStaleCache] ${table}: removed ${removed} row(s) older than ${STALE_CACHE_DAYS}d (off-board)`
        );
      } else {
        console.log(`[cleanupStaleCache] ${table}: nothing to remove`);
      }
    } catch (err) {
      console.warn(`[cleanupStaleCache] ${table}:`, err.message);
    }
  }

  try {
    await ensureJokePool(true);
  } catch (err) {
    console.warn("[cleanupStaleCache] ensureJokePool failed:", err.message);
  }

  let capabilityProbe = null;
  try {
    capabilityProbe = await runCapabilityProbe();
  } catch (err) {
    console.warn("[cleanupStaleCache] capabilityProbe failed:", err.message);
  }

  let archiveCleanup = null;
  try {
    archiveCleanup = await cleanupArchive();
    console.log(
      `[cleanupStaleCache] archive — purged=${archiveCleanup?.purged?.removed?.length || 0} trimmed=${archiveCleanup?.trimmed?.trimmed?.length || 0}`
    );
  } catch (err) {
    console.warn("[cleanupStaleCache] cleanupArchive failed:", err.message);
  }

  const finishedAt = new Date().toISOString();
  await setSetting("lastStaleCacheCleanup", finishedAt);

  console.log(
    `[cleanupStaleCache] Done — deleted≈${deleted} at ${finishedAt}`
  );

  return { deleted, finishedAt, capabilityProbe, archiveCleanup };
}

/**
 * Refresh the board universe once per ticker (shared report).
 * Mode arg is ignored — board_picks status always comes from the long take.
 */
async function refreshBoard(_modeOrOptions) {
  const existingAll = await listAllBoardTickers();
  if (!existingAll.length) {
    for (const t of BOARD_TICKERS) {
      await promotePick(t, { status: "watch", source: "seed" });
    }
  }
  const tickers = await getActiveBoardTickers();

  console.log(
    `[refreshBoard] Starting shared refresh for ${tickers.length} live tickers at ${new Date().toISOString()}`
  );

  let recommended = 0;
  let watch = 0;
  let skipped = 0;
  let fetched = 0;
  let cacheReused = 0;
  let rateLimited = false;
  let successes = 0;

  async function upsertLiveStatus(ticker, status, sector) {
    const prev = await getPick(ticker);
    await dbRun(
      `INSERT OR REPLACE INTO board_picks
        (ticker, status, added_at, sector, archived_at, source)
       VALUES (?, ?, ?, ?, NULL, ?)`,
      [
        ticker,
        status,
        prev?.added_at || new Date().toISOString(),
        sector || null,
        prev?.source || "seed",
      ]
    );
  }

  for (const ticker of tickers) {
    try {
      const entry = await getStockCacheEntry(ticker);
      const summaryFresh = await getCachedSummary(ticker);
      const fullyFresh = entry && isFullyFresh(entry.data);

      if (fullyFresh && summaryFresh) {
        cacheReused += 1;
        console.log(
          `[refreshBoard] ${ticker} price+target+news+earnings fresh — skipping live fetch`
        );
        // Display mode long so board status uses the long-term take.
        const report = await getStockReport(ticker, "long", { skipPeers: false });
        if (!report) {
          skipped += 1;
          continue;
        }
        const lean = report.analysis?.lean;
        const risk = report.analysis?.risk;
        const status = statusFromAnalysis(lean, risk);
        if (!status) {
          skipped += 1;
          continue;
        }
        await upsertLiveStatus(ticker, status, report.sector || null);
        if (status === "recommended") recommended += 1;
        else watch += 1;
        successes += 1;
        continue;
      }

      if (entry && !fullyFresh) {
        console.log(
          `[refreshBoard] ${ticker} partial stale — will refresh missing pieces only`
        );
      }

      fetched += 1;
      const report = await getStockReport(ticker, "long", {
        skipPeers: false,
      });
      if (!report) {
        console.warn(`[refreshBoard] No report for ${ticker} — leaving out`);
        skipped += 1;
        continue;
      }

      const lean = report.analysis?.lean;
      const risk = report.analysis?.risk;
      const status = statusFromAnalysis(lean, risk);

      if (!status) {
        console.log(
          `[refreshBoard] ${ticker} lean=${lean} risk=${risk} — no board status, leaving out`
        );
        skipped += 1;
        continue;
      }

      await upsertLiveStatus(ticker, status, report.sector || null);

      if (status === "recommended") {
        recommended += 1;
        if (report.price != null) {
          await logRecommendation(ticker, report.price, lean);
        }
      } else {
        watch += 1;
      }

      successes += 1;
      console.log(
        `[refreshBoard] ${ticker} → ${status} (long lean=${lean}, risk=${risk})`
      );
    } catch (err) {
      if (err instanceof AlphaVantageError && err.code === "rate_limit") {
        rateLimited = true;
      }
      console.error(`[refreshBoard] Failed for ${ticker}:`, err.message);
      skipped += 1;
    }
  }

  let boardRefreshStatus = "full_success";
  if (successes === 0 && rateLimited) boardRefreshStatus = "failed_rate_limit";
  else if (successes === 0) boardRefreshStatus = "failed";
  else if (skipped > 0 || rateLimited) boardRefreshStatus = "partial";

  const finishedAt = new Date().toISOString();
  await setSetting("lastBoardRefresh", finishedAt);
  await setSetting("lastBoardRefreshStatus", boardRefreshStatus);
  await setSetting("lastBoardRefreshMode", "long");

  console.log(
    `[refreshBoard] Done — recommended=${recommended}, watch=${watch}, skipped=${skipped}, fetched=${fetched}, cacheReused=${cacheReused}, status=${boardRefreshStatus}`
  );

  return {
    mode: "long",
    recommended,
    watch,
    skipped,
    fetched,
    cacheReused,
    boardRefreshStatus,
    successes,
    tickerCount: tickers.length,
  };
}

module.exports = {
  BOARD_TICKERS,
  refreshBoard,
  cleanupStaleCache,
  statusFromAnalysis,
  logRecommendation,
  resolveOldRecommendations,
  getTrackRecord,
};
