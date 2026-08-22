const { dbGet, dbAll, dbRun } = require("../db/schema");
const { getStockReport } = require("../services/getStockReport");
const {
  getCachedStock,
  getStockCacheEntry,
  getCachedSummary,
  isFullyFresh,
} = require("../services/cache");
const { setSetting } = require("../services/usage");
const { saveMorningRefreshFailures } = require("../services/morningFailures");
const { AlphaVantageError } = require("../services/dataFetch");
const { ensureJokePool } = require("../services/jokes");
const { BOARD_TICKERS } = require("../lib/boardTickers");
const {
  assessBoardPlacement,
  statusFromBoardSection,
  BOARD_SECTIONS,
} = require("../lib/rankingStability");
const { screenLongTermCandidate } = require("../services/longTermScreen");
const { runCapabilityProbe } = require("./capabilityProbe");
const {
  getActiveBoardTickers,
  listAllBoardTickers,
  promotePick,
  getPick,
  cleanupArchive,
} = require("../lib/boardPicks");
const { syncBoardSectionsAfterJob } = require("../services/boardSectionService");
const {
  createQuotaBudget,
  runWithBudget,
} = require("../services/quotaBudget");
const {
  tryAcquireAdminLock,
  releaseAdminLock,
} = require("../services/adminActionLock");

/** Neutral "roughly flat" band vs logged price (±3%). */
const FLAT_BAND = 0.03;

/** Stale off-board cache retention before cleanup. */
const STALE_CACHE_DAYS = 30;

/**
 * Status from analysis lean/risk + boardSection (not a shared ungated flag).
 * options.pick + options.report resolve section when boardSection omitted.
 */
function statusFromAnalysis(lean, risk, options = {}) {
  let section = options.boardSection || null;
  if (!section && options.pick) {
    section = assessBoardPlacement(options.pick, options.report || {})
      .boardSection;
  }
  return statusFromBoardSection(lean, risk, section || "short");
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
 *
 * Shares the admin action lock with Discovery / Smart Refresh / Manual Analyze.
 * Uses createQuotaBudget() so forced pulls cannot dip into smartRefreshReserve
 * (same gate as Smart Refresh). Still supports forceRefresh Gemini rewrite +
 * morning failure handoff.
 */
async function refreshBoard(_modeOrOptions) {
  const opts =
    _modeOrOptions && typeof _modeOrOptions === "object" && !Array.isArray(_modeOrOptions)
      ? _modeOrOptions
      : {};
  /** Morning cron passes force:true — one full daily refresh of the active board. */
  const force = Boolean(opts.force);

  const acquired = tryAcquireAdminLock("board_refresh");
  if (!acquired.ok) {
    console.warn(`[refreshBoard] ${acquired.message}`);
    return {
      ok: false,
      alreadyRunning: true,
      action: acquired.action,
      startedAt: acquired.startedAt,
      message: acquired.message,
      force,
      boardRefreshStatus: "skipped_locked",
      successes: 0,
      tickerCount: 0,
      failures: [],
    };
  }

  try {
    return await refreshBoardInner({ force });
  } finally {
    releaseAdminLock("board_refresh");
  }
}

async function refreshBoardInner({ force }) {
  const existingAll = await listAllBoardTickers();
  if (!existingAll.length) {
    for (const t of BOARD_TICKERS) {
      await promotePick(t, { status: "watch", source: "seed" });
    }
  }
  const tickers = await getActiveBoardTickers();

  // Daily Dip Watch pre-scan (2026-08-17) — once per refresh cycle, BEFORE
  // the main per-ticker loop, using only already-cached data (zero new API
  // cost). Ranks all real triggers by severity and stores the top N so the
  // loop below only sends "triggered" to Gemini for genuinely the most
  // severe candidates — bounds AI spend on Dip Watch even during a real
  // market-wide selloff with many stocks dipping simultaneously. Never
  // blocks the refresh on failure — if this fails, the per-ticker gate
  // (getTodaysDipWatchShortlist returning null) fails OPEN, not closed.
  try {
    const { computeDailyDipWatchShortlist } = require("../lib/rankingStability");
    await computeDailyDipWatchShortlist(tickers);
  } catch (err) {
    console.warn("[refreshBoard] Dip Watch shortlist pre-scan failed (non-fatal):", err.message);
  }

  const { prefetchBoardNewsAndPrices } = require("../services/boardBatchPrefetch");

  const budget = await createQuotaBudget();
  const budgetSnap = budget.snapshot();
  console.log(
    `[refreshBoard] Starting shared refresh for ${tickers.length} live tickers at ${new Date().toISOString()} force=${force} · AV spendable=${budgetSnap.spendable.alpha_vantage} (reserve=${budgetSnap.reserves.alpha_vantage}) TD spendable=${budgetSnap.spendable.twelve_data} MX spendable=${budgetSnap.spendable.marketaux}`
  );

  let batchPrefetch = null;
  let recommended = 0;
  let watch = 0;
  let skipped = 0;
  let fetched = 0;
  let cacheReused = 0;
  let rateLimited = false;
  let successes = 0;
  const failures = [];
  const reserveSkips = [];
  const noQuotaSkips = [];

  async function upsertLiveStatus(ticker, status, sector, boardSection = null) {
    const prev = await getPick(ticker);
    const wasLive =
      prev && ["recommended", "watch"].includes(String(prev.status || ""));
    const trackedSince = wasLive
      ? prev.tracked_since || prev.added_at || new Date().toISOString()
      : new Date().toISOString();
    const symbol = String(ticker).toUpperCase();
    if (prev) {
      await dbRun(
        `UPDATE board_picks
         SET status = ?,
             sector = COALESCE(?, sector),
             archived_at = NULL,
             tracked_since = ?,
             board_section = COALESCE(?, board_section)
         WHERE ticker = ?`,
        [status, sector || null, trackedSince, boardSection, symbol]
      );
    } else {
      await dbRun(
        `INSERT INTO board_picks
          (ticker, status, added_at, sector, archived_at, source, tracked_since, board_section)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
        [
          symbol,
          status,
          new Date().toISOString(),
          sector || null,
          "seed",
          trackedSince,
          boardSection,
        ]
      );
    }
  }

  /**
   * Long-term screen (stock-alert-spec.md), Long-classified tickers only.
   * Runs inside the same runWithBudget() callback as the caller so its
   * internal AV/FMP/MX/TD calls stay under the shared quota budget.
   * Never fails the refresh — non-fatal on error, matching this file's style.
   */
  async function persistLongTermVerdict(ticker) {
    try {
      const result = await screenLongTermCandidate(ticker);
      await dbRun(
        `UPDATE board_picks
         SET long_term_verdict = ?,
             primary_ticker = ?,
             primary_exchange = ?,
             long_term_detail_json = ?
         WHERE ticker = ?`,
        [
          result.verdict,
          result.primaryTicker,
          result.primaryExchange,
          JSON.stringify({
            gates: result.gates,
            reasons: result.reasons,
            killSwitch: result.killSwitch,
            capMismatchPct: result.capMismatchPct,
            event: result.candidate.event,
            dropSignals: result.candidate.dropSignals,
            tradeCurrency: result.tradeCurrency,
            sameListing: result.sameListing,
            fundamentals: {
              marketCapUsd: result.candidate.marketCapUsd,
              marketCapUsdAlt: result.candidate.marketCapUsdAlt,
              profitable: result.candidate.profitable,
              revenueGrowthPct: result.candidate.revenueGrowthPct,
              operatingCashFlow: result.candidate.operatingCashFlow,
              freeCashFlowTrend: result.candidate.freeCashFlowTrend,
              dilutionFlag: result.candidate.dilutionFlag,
            },
          }),
          String(ticker).toUpperCase(),
        ]
      );
      console.log(`[refreshBoard] ${ticker} long-term verdict=${result.verdict}`);
    } catch (err) {
      console.warn(
        `[refreshBoard] long-term verdict failed for ${ticker} (non-fatal):`,
        err.message
      );
    }
  }

  const runOutcomes = {
    refreshedFields: [],
    skippedNoQuota: [],
    skippedReserveProtected: [],
  };

  await runWithBudget(budget, runOutcomes, async () => {
    // Batch news (MX+AV) and TD prices once for the active board before the
    // per-ticker getStockReport loop — under the same quota budget/reserve gate.
    try {
      batchPrefetch = await prefetchBoardNewsAndPrices(tickers, {
        forceNews: force,
        forcePrice: force,
      });
      console.log(
        `[refreshBoard] batch prefetch — MX=${batchPrefetch.httpCalls.marketaux} AV=${batchPrefetch.httpCalls.alpha_vantage} TD_http=${batchPrefetch.httpCalls.twelve_data} TD_credits=${batchPrefetch.twelveCredits}`
      );
    } catch (err) {
      console.warn(`[refreshBoard] batch prefetch failed:`, err.message);
      if (err?.reason === "reserve_protected" || err?.code === "reserve_protected") {
        console.warn(`[refreshBoard] skipped — reserve protected (${err.provider || "batch"})`);
        reserveSkips.push({
          stage: "batch_prefetch",
          provider: err.provider || null,
          detail: err.message,
        });
      }
    }

    for (const ticker of tickers) {
      const tickerOutcomes = {
        refreshedFields: [],
        skippedNoQuota: [],
        skippedReserveProtected: [],
      };
      try {
        await runWithBudget(budget, tickerOutcomes, async () => {
          const entry = await getStockCacheEntry(ticker);
          const summaryFresh = await getCachedSummary(ticker);
          const fullyFresh = entry && isFullyFresh(entry.data);

          if (!force && fullyFresh && summaryFresh) {
            cacheReused += 1;
            console.log(
              `[refreshBoard] ${ticker} price+target+news+earnings fresh — skipping live fetch`
            );
            const report = await getStockReport(ticker, "long", {
              skipPeers: false,
              smartRefresh: true,
            });
            if (!report) {
              skipped += 1;
              return;
            }
            const lean = report.analysis?.lean;
            const risk = report.analysis?.risk;
            const pick = (await getPick(ticker)) || { ticker };
            const placement = assessBoardPlacement(pick, report);
            if (placement.boardSection === BOARD_SECTIONS.LONG) {
              await persistLongTermVerdict(ticker);
            }
            const status = statusFromAnalysis(lean, risk, {
              pick,
              report,
              boardSection: placement.boardSection,
            });
            if (!status) {
              skipped += 1;
              return;
            }
            await upsertLiveStatus(
              ticker,
              status,
              report.sector || null,
              placement.boardSection
            );
            if (status === "recommended") recommended += 1;
            else watch += 1;
            successes += 1;
            return;
          }

          if (entry && !fullyFresh) {
            console.log(
              `[refreshBoard] ${ticker} partial stale — will refresh missing pieces only`
            );
          }

          fetched += 1;
          // forceRefresh keeps morning Gemini rewrite; smartRefresh enables
          // createQuotaBudget / smartRefreshReserve skips in dataFetch helpers.
          const report = await getStockReport(ticker, "long", {
            skipPeers: false,
            smartRefresh: true,
            ...(force ? { forceRefresh: true } : {}),
          });
          if (!report) {
            console.warn(`[refreshBoard] No report for ${ticker} — leaving out`);
            skipped += 1;
            failures.push({
              ticker: String(ticker).toUpperCase(),
              error: "no_report",
              code: "no_report",
            });
            return;
          }

          const lean = report.analysis?.lean;
          const risk = report.analysis?.risk;
          const pick = (await getPick(ticker)) || { ticker };
          const placement = assessBoardPlacement(pick, report);
          if (placement.boardSection === BOARD_SECTIONS.LONG) {
            await persistLongTermVerdict(ticker);
          }
          const status = statusFromAnalysis(lean, risk, {
            pick,
            report,
            boardSection: placement.boardSection,
          });

          if (!status) {
            console.log(
              `[refreshBoard] ${ticker} lean=${lean} risk=${risk} — no board status, leaving out`
            );
            skipped += 1;
            return;
          }

          await upsertLiveStatus(
            ticker,
            status,
            report.sector || null,
            placement.boardSection
          );

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
        });

        for (const s of tickerOutcomes.skippedReserveProtected || []) {
          console.warn(
            `[refreshBoard] ${ticker} skipped — reserve protected (${s.provider || s.field})`
          );
          reserveSkips.push({ ticker, ...s });
        }
        for (const s of tickerOutcomes.skippedNoQuota || []) {
          console.warn(
            `[refreshBoard] ${ticker} skipped — no quota (${s.provider || s.field})`
          );
          noQuotaSkips.push({ ticker, ...s });
        }
      } catch (err) {
        if (err instanceof AlphaVantageError && err.code === "rate_limit") {
          rateLimited = true;
        }
        if (err?.reason === "reserve_protected" || err?.code === "reserve_protected") {
          console.warn(
            `[refreshBoard] ${ticker} skipped — reserve protected (${err.provider || "unknown"})`
          );
          reserveSkips.push({
            ticker: String(ticker).toUpperCase(),
            provider: err.provider || null,
            detail: err.message,
          });
          skipped += 1;
          continue;
        }
        if (err?.reason === "no_quota" || err?.code === "no_quota") {
          console.warn(
            `[refreshBoard] ${ticker} skipped — no quota (${err.provider || "unknown"})`
          );
          noQuotaSkips.push({
            ticker: String(ticker).toUpperCase(),
            provider: err.provider || null,
            detail: err.message,
          });
          skipped += 1;
          continue;
        }
        console.error(`[refreshBoard] Failed for ${ticker}:`, err.message);
        skipped += 1;
        failures.push({
          ticker: String(ticker).toUpperCase(),
          error: err.message,
          code: err.code || null,
        });
      }
    }
  });

  // Surface any batch-level budget skips that weren't attributed per ticker.
  for (const s of budget.skips || []) {
    if (s.reason === "reserve_protected") {
      const already = reserveSkips.some(
        (r) => r.provider === s.provider && r.ticker === s.ticker
      );
      if (!already) {
        console.warn(
          `[refreshBoard] skipped — reserve protected (${s.provider}${s.ticker ? ` · ${s.ticker}` : ""})`
        );
        reserveSkips.push(s);
      }
    } else if (s.reason === "no_quota") {
      const already = noQuotaSkips.some(
        (r) => r.provider === s.provider && r.ticker === s.ticker
      );
      if (!already) noQuotaSkips.push(s);
    }
  }

  let boardRefreshStatus = "full_success";
  if (successes === 0 && rateLimited) boardRefreshStatus = "failed_rate_limit";
  else if (successes === 0 && (reserveSkips.length || noQuotaSkips.length)) {
    boardRefreshStatus = reserveSkips.length ? "partial" : "failed";
  } else if (successes === 0) boardRefreshStatus = "failed";
  else if (skipped > 0 || rateLimited || reserveSkips.length || noQuotaSkips.length) {
    boardRefreshStatus = "partial";
  }

  const finishedAt = new Date().toISOString();
  await setSetting("lastBoardRefresh", finishedAt);
  await setSetting("lastBoardRefreshStatus", boardRefreshStatus);
  await setSetting("lastBoardRefreshMode", "long");

  // Persist failures for the 1pm lightweight retry (morning force pass only).
  if (force) {
    try {
      await saveMorningRefreshFailures({
        force: true,
        boardRefreshStatus,
        failures,
        successes,
        tickerCount: tickers.length,
      });
    } catch (err) {
      console.warn(`[refreshBoard] saveMorningRefreshFailures:`, err.message);
    }
  }

  console.log(
    `[refreshBoard] Done — recommended=${recommended}, watch=${watch}, skipped=${skipped}, fetched=${fetched}, cacheReused=${cacheReused}, failures=${failures.length}, reserveSkips=${reserveSkips.length}, noQuotaSkips=${noQuotaSkips.length}, status=${boardRefreshStatus}`
  );

  let boardSectionSync = null;
  try {
    boardSectionSync = await syncBoardSectionsAfterJob("refresh_board");
  } catch (err) {
    console.warn(
      "[refreshBoard] board section sync failed:",
      err?.message || err
    );
  }

  // Per-category cap enforcement (2026-08-19) — runs here specifically
  // because section data is guaranteed fresh right after the sync above.
  // Deliberately kept SEPARATE from the promotion flow (where a ticker's
  // target section isn't known yet at capacity-clearing time) rather than
  // restructuring that already-tested sequence. Free (DB-only), no API
  // cost, same as the underlying ensureSectionCapacity it calls.
  let sectionCapResults = null;
  try {
    const { ensureSectionCapacity } = require("../lib/boardPicks");
    const { BOARD_SECTIONS } = require("../lib/rankingStability");
    sectionCapResults = {};
    for (const section of [
      BOARD_SECTIONS.LONG,
      BOARD_SECTIONS.SHORT,
      BOARD_SECTIONS.PENNY,
    ]) {
      sectionCapResults[section] = await ensureSectionCapacity(section, 0);
    }
    const totalArchived = Object.values(sectionCapResults).reduce(
      (sum, r) => sum + (r.archived?.length || 0),
      0
    );
    if (totalArchived > 0) {
      console.log(
        `[refreshBoard] Per-category cap enforcement: archived ${totalArchived} total (` +
          Object.entries(sectionCapResults)
            .map(([s, r]) => `${s}=${r.archived?.length || 0}`)
            .join(", ") +
          ")"
      );
    }
  } catch (err) {
    console.warn(
      "[refreshBoard] per-category cap enforcement failed (non-fatal):",
      err?.message || err
    );
  }

  return {
    ok: true,
    mode: "long",
    recommended,
    watch,
    skipped,
    fetched,
    cacheReused,
    boardRefreshStatus,
    successes,
    tickerCount: tickers.length,
    sectionCapResults,
    failures,
    batchPrefetch,
    force,
    boardSectionSync,
    quota: budget.snapshot(),
    reserveSkips,
    noQuotaSkips,
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
