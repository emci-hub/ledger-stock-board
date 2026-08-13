/**
 * Hot-stock discovery via FMP free-tier movers
 * (/stable/biggest-gainers, /stable/biggest-losers, /stable/most-actives).
 * Compares movers to the live board, re-promotes archived hits, and
 * adds genuinely new candidates under BOARD_MAX_SIZE (archiving weakest).
 *
 * Scheduled daily right after the 7am board refresh (see server.js).
 * Never calls Alpha Vantage or Twelve Data for movers.
 */

const { setSetting, getUsageToday, PROVIDERS } = require("../services/usage");
const { getDiscoveryMoversBundle } = require("../services/dataFetch");
const { getStockReport } = require("../services/getStockReport");
const { hasSourceKey, smartRefreshReserve, DATA_SOURCES } = require("../lib/dataSources");
const {
  generateDiscoveryWriteUp,
  saveDiscoveryBlurb,
} = require("../services/discoveryWriteUp");
const {
  listLiveBoardPicks,
  listArchivedBoardPicks,
  ensureBoardCapacity,
  previewArchivesForSlots,
  promotePick,
  BOARD_MAX_SIZE,
} = require("../lib/boardPicks");
const {
  tryAcquireAdminLock,
  releaseAdminLock,
} = require("../services/adminActionLock");

/** Max brand-new tickers to onboard per discovery run (limits API spend). */
const MAX_NEW_PER_RUN = Math.max(
  1,
  Number.parseInt(process.env.DISCOVERY_MAX_NEW || "3", 10) || 3
);

/** FMP calls for gainers + losers + most-actives. */
const MOVERS_FMP_CALLS = 3;

function statusFromAnalysis(lean, risk) {
  const l = String(lean || "").toLowerCase();
  const r = String(risk || "").toLowerCase();
  if (l === "bearish" || r === "high") return "watch";
  if (l === "bullish" || (l === "neutral" && r === "low")) return "recommended";
  return "watch";
}

function hasFmp() {
  return hasSourceKey("fmp");
}

function pickStatusFromReport(report) {
  const lean = report?.analysis?.lean;
  const risk = report?.analysis?.risk;
  return statusFromAnalysis(lean, risk);
}

function fmpLimit() {
  return Number(DATA_SOURCES.fmp?.rateLimit?.limit) || 250;
}

function fmpReserve() {
  return smartRefreshReserve("fmp");
}

async function fmpQuotaSnapshot() {
  const used = await getUsageToday(PROVIDERS.FMP);
  const limit = fmpLimit();
  const remaining = Math.max(0, limit - Number(used || 0));
  const reserve = fmpReserve();
  const spendable = Math.max(0, remaining - reserve);
  return { used, limit, remaining, reserve, spendable };
}

/**
 * Conservative estimate for a full discovery run:
 * 3 FMP movers + warm-report side effects for up to maxNew names.
 * Warm reports may use TD/MX/FH/Gemini — not FMP. Discovery never uses AV.
 */
function estimateDiscoveryCalls(maxNew = MAX_NEW_PER_RUN) {
  const n = Math.max(1, Number(maxNew) || MAX_NEW_PER_RUN);
  return {
    fmp: MOVERS_FMP_CALLS,
    twelve_data: n, // possible price warm for new tickers
    alpha_vantage: 0,
    finnhub: n,
    marketaux: n,
    gemini: n,
    claude: 0,
  };
}

function blockReasonForFmp(snapshot, need) {
  if (snapshot.remaining < need) return "no_quota";
  if (snapshot.spendable < need) return "reserve_protected";
  return null;
}

/**
 * Zero-cost discovery preview — no movers fetch, no promotions.
 */
async function previewDiscovery(options = {}) {
  const maxNew = options.maxNew ?? MAX_NEW_PER_RUN;
  const startedAt = new Date().toISOString();

  if (!hasFmp()) {
    return {
      ok: false,
      preview: true,
      spendsNothing: true,
      error: "FMP_API_KEY not configured",
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  const live = await listLiveBoardPicks();
  const archived = await listArchivedBoardPicks();
  const liveCount = live.length;
  const freeSlots = Math.max(0, BOARD_MAX_SIZE - liveCount);
  const fmp = await fmpQuotaSnapshot();
  const estimatedCalls = estimateDiscoveryCalls(maxNew);
  const needFmp = estimatedCalls.fmp;
  const skipReason = blockReasonForFmp(fmp, needFmp);

  const archivePreview = await previewArchivesForSlots(maxNew, { protect: [] });

  const mxUsed = await getUsageToday(PROVIDERS.MARKETAUX);
  const avUsed = await getUsageToday(PROVIDERS.ALPHA);
  const tdUsed = await getUsageToday(PROVIDERS.TWELVE);
  const mxLimit = Number(DATA_SOURCES.marketaux?.rateLimit?.limit) || 100;
  const avLimit = Number(DATA_SOURCES.alpha_vantage?.rateLimit?.limit) || 25;
  const tdLimitVal = Number(DATA_SOURCES.twelve_data?.rateLimit?.limit) || 800;
  const mxRem = Math.max(0, mxLimit - Number(mxUsed || 0));
  const avRem = Math.max(0, avLimit - Number(avUsed || 0));
  const tdRem = Math.max(0, tdLimitVal - Number(tdUsed || 0));

  const remainingAfter = {
    fmp: skipReason ? fmp.remaining : Math.max(0, fmp.remaining - needFmp),
    twelve_data: Math.max(
      0,
      tdRem - (skipReason ? 0 : estimatedCalls.twelve_data || 0)
    ),
    alpha_vantage: avRem,
    marketaux: Math.max(
      0,
      mxRem - (skipReason ? 0 : estimatedCalls.marketaux || 0)
    ),
    finnhub: null,
    gemini: null,
    claude: null,
  };

  return {
    ok: true,
    preview: true,
    spendsNothing: true,
    mode: "discovery_preview",
    message: skipReason
      ? skipReason === "reserve_protected"
        ? "Skipped — reserve protected: FMP spendable headroom is below this run's estimate."
        : "Skipped — no quota: FMP remaining is below this run's estimate."
      : "Preview only — no API calls spent. Exact new tickers are unknown until confirm (movers not fetched). Confirm to run for real.",
    startedAt,
    finishedAt: new Date().toISOString(),
    board: {
      liveCount,
      max: BOARD_MAX_SIZE,
      freeSlots,
      archivedCount: archived.length,
      maxNew,
    },
    wouldAdd: {
      note: "Determined at confirm from FMP movers (gainers + losers + most-actives). Up to maxNew brand-new names.",
      upTo: maxNew,
      tickers: null,
    },
    wouldRePromote: {
      note: "Archived movers that appear hot again are re-promoted first (count unknown until movers fetch).",
      tickers: null,
    },
    wouldArchive: archivePreview.wouldArchive,
    estimatedCalls,
    totalEstimatedCalls: Object.values(estimatedCalls).reduce((a, b) => a + b, 0),
    quota: {
      remainingBefore: {
        fmp: fmp.remaining,
        twelve_data: tdRem,
        alpha_vantage: avRem,
        marketaux: mxRem,
        finnhub: null,
        gemini: null,
        claude: null,
      },
      remainingAfter,
      spendableBefore: {
        fmp: fmp.spendable,
        twelve_data: Math.max(0, tdRem - smartRefreshReserve("twelve_data")),
        alpha_vantage: Math.max(
          0,
          avRem - smartRefreshReserve("alpha_vantage")
        ),
      },
      reserves: {
        fmp: fmp.reserve,
        twelve_data: smartRefreshReserve("twelve_data"),
        alpha_vantage: smartRefreshReserve("alpha_vantage"),
      },
      usedToday: {
        fmp: fmp.used,
        twelve_data: tdUsed,
        alpha_vantage: avUsed,
        marketaux: mxUsed,
      },
    },
    skipFlags: skipReason
      ? [
          {
            source: "fmp",
            reason: skipReason,
            detail:
              skipReason === "reserve_protected"
                ? `need≈${needFmp} FMP · spendable=${fmp.spendable} (reserve ${fmp.reserve})`
                : `need≈${needFmp} FMP · remaining=${fmp.remaining}`,
          },
        ]
      : [],
    wouldSkipEntireRun: Boolean(skipReason),
    alphaVantageTouched: false,
    note: "Discovery never touches Alpha Vantage. Movers use FMP only; warm reports may use TD/MX/FH/Gemini for new names.",
  };
}

/**
 * discoverHotStocks() — main entry.
 * Real runs share the admin in-progress lock with Smart Refresh.
 * @param {{ dryRun?: boolean, maxNew?: number, warmReports?: boolean, fetchMovers?: boolean, previewOnly?: boolean }} options
 *
 * Order-safety with Smart Refresh:
 * - When warmReports is on (default), newly added / re-promoted tickers are filled via
 *   getStockReport, so a following Smart Refresh sees those fields as fresh
 *   (already_current) and does not re-fetch them.
 * - Tickers Discovery did not touch are evaluated solely on their own freshness TTLs.
 * - Gaps left when a warm fails remain "missing/stale" so Smart Refresh can fill them.
 */
async function discoverHotStocks(options = {}) {
  const dryRun = Boolean(options.dryRun);
  const maxNew = options.maxNew ?? MAX_NEW_PER_RUN;
  const warmReports = options.warmReports !== false;

  const startedAt = new Date().toISOString();
  console.log(
    `[discoverHotStocks] start at ${startedAt} dryRun=${dryRun} maxNew=${maxNew} boardMax=${BOARD_MAX_SIZE}`
  );

  // dryRun / preview path: zero-cost, no lock.
  if (dryRun && options.previewOnly !== false && options.fetchMovers !== true) {
    return previewDiscovery({ maxNew });
  }

  if (!hasFmp()) {
    const result = {
      ok: false,
      error: "FMP_API_KEY not configured",
      startedAt,
      finishedAt: new Date().toISOString(),
    };
    await setSetting("lastHotStockDiscovery", JSON.stringify(result));
    await setSetting("lastHotStockDiscoveryAt", result.finishedAt);
    await setSetting("lastHotStockDiscoveryStatus", "failed_no_key");
    return result;
  }

  // Quota-aware gate: refuse to start if FMP spendable headroom cannot cover movers.
  const fmp = await fmpQuotaSnapshot();
  const estimatedCalls = estimateDiscoveryCalls(maxNew);
  const needFmp = estimatedCalls.fmp;
  const skipReason = blockReasonForFmp(fmp, needFmp);
  if (skipReason) {
    const result = {
      ok: false,
      skipped: true,
      reason: skipReason,
      message:
        skipReason === "reserve_protected"
          ? "Skipped — reserve protected for fmp"
          : "Skipped — no quota for fmp",
      detail: `need≈${needFmp} · remaining=${fmp.remaining} · spendable=${fmp.spendable} · reserve=${fmp.reserve}`,
      estimatedCalls,
      quota: fmp,
      startedAt,
      finishedAt: new Date().toISOString(),
      alphaVantageTouched: false,
    };
    await setSetting("lastHotStockDiscovery", JSON.stringify(result));
    await setSetting("lastHotStockDiscoveryAt", result.finishedAt);
    await setSetting(
      "lastHotStockDiscoveryStatus",
      skipReason === "reserve_protected" ? "skipped_reserve" : "skipped_no_quota"
    );
    console.warn(`[discoverHotStocks] ${result.message} (${result.detail})`);
    return result;
  }

  const acquired = tryAcquireAdminLock("discovery");
  if (!acquired.ok) {
    const result = {
      ok: false,
      alreadyRunning: true,
      action: acquired.action,
      startedAt: acquired.startedAt,
      message: acquired.message,
      finishedAt: new Date().toISOString(),
    };
    console.warn(`[discoverHotStocks] ${result.message}`);
    return result;
  }

  try {
    return await discoverHotStocksInner({
      dryRun,
      maxNew,
      warmReports,
      startedAt: acquired.startedAt,
    });
  } finally {
    releaseAdminLock("discovery");
  }
}

async function discoverHotStocksInner({
  dryRun,
  maxNew,
  warmReports,
  startedAt,
}) {
  let movers;
  try {
    movers = await getDiscoveryMoversBundle();
  } catch (err) {
    const result = {
      ok: false,
      error: err.message,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
    await setSetting("lastHotStockDiscovery", JSON.stringify(result));
    await setSetting("lastHotStockDiscoveryAt", result.finishedAt);
    await setSetting("lastHotStockDiscoveryStatus", "failed_movers");
    console.error("[discoverHotStocks] movers fetch failed:", err.message);
    return result;
  }

  const live = await listLiveBoardPicks();
  const archived = await listArchivedBoardPicks();
  const liveSet = new Set(live.map((p) => String(p.ticker).toUpperCase()));
  const archivedSet = new Set(
    archived.map((p) => String(p.ticker).toUpperCase())
  );
  const moverTickers = movers.all.map((m) => m.ticker);
  const moverByTicker = new Map(movers.all.map((m) => [m.ticker, m]));

  const rePromoteCandidates = moverTickers.filter((t) => archivedSet.has(t));
  const newCandidates = movers.all
    .filter((m) => !liveSet.has(m.ticker) && !archivedSet.has(m.ticker))
    .sort(
      (a, b) =>
        Math.abs(Number(b.percentChange) || 0) -
        Math.abs(Number(a.percentChange) || 0)
    );

  const rePromoted = [];
  const added = [];
  const archivedOut = [];
  const skipped = [];

  // 1) Re-promote archived names that are hot again
  for (const ticker of rePromoteCandidates) {
    const mover = moverByTicker.get(ticker);
    if (dryRun) {
      rePromoted.push({ ticker, dryRun: true, mover });
      continue;
    }
    const cap = await ensureBoardCapacity(1, {
      protect: rePromoteCandidates,
    });
    archivedOut.push(...(cap.archived || []));

    let report = null;
    if (warmReports) {
      try {
        report = await getStockReport(ticker, "long", { skipPeers: false });
      } catch (err) {
        console.warn(
          `[discoverHotStocks] warm report failed for re-promote ${ticker}:`,
          err.message
        );
      }
    }
    const status = report ? pickStatusFromReport(report) : "watch";
    await promotePick(ticker, {
      status,
      sector: report?.sector || null,
      source: "discovery_repromote",
    });
    rePromoted.push({ ticker, status, mover });
    liveSet.add(ticker);
    archivedSet.delete(ticker);
  }

  // 2) Add genuinely new movers under the board cap
  let addedCount = 0;
  for (const mover of newCandidates) {
    if (addedCount >= maxNew) {
      skipped.push({ ticker: mover.ticker, reason: "max_new_per_run" });
      continue;
    }
    if (dryRun) {
      added.push({ ticker: mover.ticker, dryRun: true, mover });
      addedCount += 1;
      continue;
    }

    const cap = await ensureBoardCapacity(1, {
      protect: [...rePromoteCandidates, ...added.map((a) => a.ticker)],
    });
    archivedOut.push(...(cap.archived || []));

    let report = null;
    if (warmReports) {
      try {
        report = await getStockReport(mover.ticker, "long", {
          skipPeers: false,
        });
      } catch (err) {
        console.warn(
          `[discoverHotStocks] warm report failed for ${mover.ticker}:`,
          err.message
        );
      }
    }

    const status = report ? pickStatusFromReport(report) : "watch";
    await promotePick(mover.ticker, {
      status,
      sector: report?.sector || null,
      source: "discovery",
    });

    let discoveryBlurb = null;
    try {
      discoveryBlurb = await generateDiscoveryWriteUp({
        ticker: mover.ticker,
        name: mover.name || report?.companyName || report?.name,
        sector: report?.sector || null,
        percentChange: mover.percentChange,
        mover,
      });
      await saveDiscoveryBlurb(mover.ticker, discoveryBlurb);
    } catch (err) {
      console.warn(
        `[discoverHotStocks] discovery write-up failed for ${mover.ticker}:`,
        err.message
      );
    }

    added.push({
      ticker: mover.ticker,
      status,
      name: mover.name,
      percentChange: mover.percentChange,
      discoveryBlurb,
    });
    addedCount += 1;
    liveSet.add(mover.ticker);
  }

  const finishedAt = new Date().toISOString();
  const result = {
    ok: true,
    dryRun,
    startedAt,
    finishedAt,
    boardMax: BOARD_MAX_SIZE,
    movers: {
      gainers: movers.gainers.length,
      losers: movers.losers.length,
      mostActiveTop: movers.mostActive.slice(0, 10).map((m) => m.ticker),
      unique: movers.all.length,
    },
    liveBefore: live.length,
    liveAfter: liveSet.size,
    rePromoted,
    added,
    archived: archivedOut,
    skipped,
    newCandidateCount: newCandidates.length,
    alphaVantageTouched: false,
  };

  await setSetting("lastHotStockDiscovery", JSON.stringify(result));
  await setSetting("lastHotStockDiscoveryAt", finishedAt);
  await setSetting(
    "lastHotStockDiscoveryStatus",
    dryRun ? "dry_run" : "success"
  );

  console.log(
    `[discoverHotStocks] done — added=${added.length} rePromoted=${rePromoted.length} archived=${archivedOut.length}`
  );
  return result;
}

module.exports = {
  discoverHotStocks,
  previewDiscovery,
  estimateDiscoveryCalls,
  MAX_NEW_PER_RUN,
  MOVERS_FMP_CALLS,
};
