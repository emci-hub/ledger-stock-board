/**
 * Manual / bulk "Analyze this stock" for archive + candidate browsing.
 * Uses batched news/price prefetch, then analyzes in waves of ~5–10.
 * Respects Smart Refresh / Discovery reserves and the shared admin lock.
 */

const { getStockReport } = require("../services/getStockReport");
const { prefetchBoardNewsAndPrices } = require("../services/boardBatchPrefetch");
const {
  computePromotionBudget,
  WARM_COST_PER_TICKER,
} = require("./discoverHotStocks");
const {
  listCandidatePicks,
  listArchivedBoardPicks,
  rankCandidatesForPromotion,
  getPick,
} = require("../lib/boardPicks");
const {
  tryAcquireAdminLock,
  releaseAdminLock,
  getAdminActionLock,
} = require("../services/adminActionLock");
const {
  createQuotaBudget,
  runWithBudget,
} = require("../services/quotaBudget");
const {
  getCachedSummary,
} = require("../services/cache");

/** Concurrent Gemini/report builds per wave. */
const ANALYZE_WAVE_SIZE = Math.max(
  1,
  Math.min(
    10,
    Number.parseInt(process.env.ANALYZE_WAVE_SIZE || "5", 10) || 5
  )
);

async function getAnalyzeAvailability() {
  const budget = await computePromotionBudget();
  const lock = getAdminActionLock();
  return {
    available: budget.maxPromote,
    bindingSource: budget.bindingSource,
    hardCap: budget.hardCap,
    perTicker: budget.perTicker || WARM_COST_PER_TICKER,
    sources: budget.sources,
    caps: budget.caps,
    lock,
    message:
      budget.maxPromote > 0
        ? `${budget.maxPromote} full analyses available today`
        : `No full analyses available — bound by ${budget.bindingSource || "quota"}`,
  };
}

function chunk(list, size) {
  const n = Math.max(1, size);
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/**
 * Resolve which tickers to analyze.
 * @param {{ tickers?: string[], count?: number, allRemaining?: boolean }} options
 */
async function resolveAnalyzeTargets(options = {}) {
  if (Array.isArray(options.tickers) && options.tickers.length) {
    return [
      ...new Set(
        options.tickers.map((t) => String(t || "").toUpperCase()).filter(Boolean)
      ),
    ];
  }

  const candidates = rankCandidatesForPromotion(await listCandidatePicks());
  const archived = await listArchivedBoardPicks();
  // Prefer candidates (main pool first), then archived without a fresh summary.
  const wants = [];
  for (const row of candidates) {
    const summary = await getCachedSummary(row.ticker);
    if (!summary) wants.push(String(row.ticker).toUpperCase());
  }
  for (const row of archived) {
    const t = String(row.ticker).toUpperCase();
    if (wants.includes(t)) continue;
    const summary = await getCachedSummary(t);
    if (!summary) wants.push(t);
  }

  if (options.allRemaining) return wants;
  const n = Math.max(1, Number(options.count) || ANALYZE_WAVE_SIZE);
  return wants.slice(0, n);
}

/**
 * Build full reports for tickers using batched fetches + Gemini waves.
 */
async function analyzeTickers(tickers, options = {}) {
  const startedAt = new Date().toISOString();
  const list = [
    ...new Set(
      (tickers || []).map((t) => String(t || "").toUpperCase()).filter(Boolean)
    ),
  ];

  if (!list.length) {
    return {
      ok: false,
      error: "No tickers to analyze",
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  const availability = await getAnalyzeAvailability();
  if (availability.available <= 0) {
    return {
      ok: false,
      skipped: true,
      reason: "no_quota",
      message: availability.message,
      availability,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  const capped = list.slice(0, availability.available);
  const deferred = list.slice(availability.available);

  const acquired = tryAcquireAdminLock("manual_analyze");
  if (!acquired.ok) {
    return {
      ok: false,
      alreadyRunning: true,
      action: acquired.action,
      startedAt: acquired.startedAt,
      message: acquired.message,
      finishedAt: new Date().toISOString(),
    };
  }

  const budget = await createQuotaBudget();
  const analyzed = [];
  const failed = [];

  try {
    // Stage A: batch news + price for the whole capped set (1 MX + 1 AV + few TD).
    await runWithBudget(budget, { refreshedFields: [] }, () =>
      prefetchBoardNewsAndPrices(capped, {
        forceNews: true,
        forcePrice: true,
      })
    );

    // Stage B: Gemini / full report in waves of ~5–10 (not all at once, not 1-by-1).
    const waves = chunk(capped, ANALYZE_WAVE_SIZE);
    for (const wave of waves) {
      const outcomes = await Promise.all(
        wave.map(async (ticker) => {
          try {
            const report = await runWithBudget(
              budget,
              { refreshedFields: [], skippedNoQuota: [], skippedReserveProtected: [] },
              () =>
                getStockReport(ticker, "long", {
                  skipPeers: false,
                  smartRefresh: true,
                  forceRefresh: true,
                })
            );
            if (!report) {
              return { ticker, ok: false, error: "no_report" };
            }
            const pick = await getPick(ticker);
            return {
              ticker,
              ok: true,
              status: pick?.status || null,
              companyName: report.companyName || report.name || null,
              price: report.price ?? null,
              lean: report.analysis?.lean || null,
            };
          } catch (err) {
            return { ticker, ok: false, error: err.message };
          }
        })
      );
      for (const o of outcomes) {
        if (o.ok) analyzed.push(o);
        else failed.push(o);
      }
    }
  } finally {
    releaseAdminLock("manual_analyze");
  }

  const finishedAt = new Date().toISOString();
  return {
    ok: failed.length === 0,
    startedAt,
    finishedAt,
    requested: list.length,
    attempted: capped.length,
    analyzed,
    failed,
    deferred: deferred.map((t) => ({
      ticker: t,
      reason: "promotion_budget_exhausted",
    })),
    availability: await getAnalyzeAvailability(),
    waveSize: ANALYZE_WAVE_SIZE,
    message: `Analyzed ${analyzed.length}/${capped.length}${
      deferred.length ? ` · ${deferred.length} deferred (quota)` : ""
    }${failed.length ? ` · ${failed.length} failed` : ""}`,
  };
}

async function analyzeNext(count = ANALYZE_WAVE_SIZE) {
  const tickers = await resolveAnalyzeTargets({ count });
  return analyzeTickers(tickers);
}

async function analyzeAllRemaining() {
  const tickers = await resolveAnalyzeTargets({ allRemaining: true });
  return analyzeTickers(tickers);
}

module.exports = {
  ANALYZE_WAVE_SIZE,
  getAnalyzeAvailability,
  resolveAnalyzeTargets,
  analyzeTickers,
  analyzeNext,
  analyzeAllRemaining,
};
