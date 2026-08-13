/**
 * Promotion catch-up + priority-tiered scarce-resource filling.
 *
 * - On promote: immediately warm price + news; attempt AV target only when
 *   spendable AV (above reserve) remains, else queue for priority fill.
 * - Scarce per-ticker resources (AV analyst target today) fill in order:
 *   (1) long-term-track active, (2) short/momentum active, (3) penny/high-vol last.
 */

const { getStockReport } = require("./getStockReport");
const { prefetchBoardNewsAndPrices } = require("./boardBatchPrefetch");
const {
  getStockCacheEntry,
  isPriceFresh,
  isTargetFresh,
  isNewsFresh,
} = require("./cache");
const { getUsageToday, PROVIDERS } = require("./usage");
const { DATA_SOURCES, smartRefreshReserve } = require("../lib/dataSources");
const {
  listLiveBoardPicks,
} = require("../lib/boardPicks");
const { assessLongTermPlacement } = require("../lib/rankingStability");
const { isPennyPrice, isExtremeMove } = require("../lib/boardTickers");

async function alphaVantageSpendable() {
  const used = await getUsageToday(PROVIDERS.ALPHA);
  const limit = Number(DATA_SOURCES.alpha_vantage?.rateLimit?.limit) || 25;
  const reserve = Number(smartRefreshReserve("alpha_vantage") || 0);
  const remaining = Math.max(0, limit - Number(used || 0));
  const spendable = Math.max(0, remaining - reserve);
  return { used, limit, remaining, reserve, spendable };
}

/**
 * Immediate catch-up after a ticker is promoted to the live board.
 * Price + news always attempted (batched helpers). Target only if AV spendable > 0.
 */
async function warmNewlyPromotedTicker(ticker, options = {}) {
  const symbol = String(ticker || "")
    .trim()
    .toUpperCase();
  if (!symbol) {
    return { ok: false, error: "invalid_ticker" };
  }

  const result = {
    ok: true,
    ticker: symbol,
    price: false,
    news: false,
    target: false,
    targetQueued: false,
    skippedTargetReason: null,
  };

  try {
    await prefetchBoardNewsAndPrices([symbol], {
      forceNews: options.forceNews !== false,
      forcePrice: options.forcePrice !== false,
    });
    result.price = true;
    result.news = true;
  } catch (err) {
    console.warn(`[warmNewlyPromoted] prefetch ${symbol}:`, err.message);
  }

  const av = await alphaVantageSpendable();
  const entry = await getStockCacheEntry(symbol);
  const needsTarget = !isTargetFresh(entry?.data);

  if (needsTarget && av.spendable <= 0) {
    result.targetQueued = true;
    result.skippedTargetReason =
      av.remaining <= 0 ? "no_quota" : "reserve_protected";
  }

  try {
    // Full report fill: respects freshness; target fetch only happens if stale
    // and AV helpers have quota (QuotaSkipped → null without throwing).
    const report = await getStockReport(symbol, "long", {
      skipPeers: options.skipPeers === true,
      // Do not use smartRefresh budget here — promotion catch-up is intentional spend
      // from remaining daily headroom (AV still self-guards via callAlphaVantage).
    });
    result.report = report || null;
    result.hasReport = Boolean(report);
    const after = await getStockCacheEntry(symbol);
    result.price = isPriceFresh(after?.data);
    result.news = isNewsFresh(after?.data);
    result.target = isTargetFresh(after?.data);
    if (needsTarget && !result.target && !result.targetQueued) {
      result.targetQueued = true;
      result.skippedTargetReason = result.skippedTargetReason || "fetch_miss";
    }
  } catch (err) {
    console.warn(`[warmNewlyPromoted] getStockReport ${symbol}:`, err.message);
    result.ok = false;
    result.error = err.message;
  }

  return result;
}

/**
 * Priority rank for scarce fills (lower = sooner):
 * 0 long-term-track active, 1 momentum/short-track non-penny, 2 penny/extreme last.
 */
function scarceFillPriority(pick, reportLike = {}) {
  const placement = assessLongTermPlacement(pick, reportLike);
  const penny =
    placement.signals.penny ||
    isPennyPrice(reportLike.price ?? pick.price);
  const extreme =
    placement.signals.extremeMove ||
    isExtremeMove(reportLike.changePercent ?? pick.percent_change);

  if (placement.longTermEligible) return { tier: 0, label: "long_term_track" };
  if (penny || extreme) return { tier: 2, label: "penny_or_extreme_momentum" };
  return { tier: 1, label: "momentum_short_track" };
}

/**
 * Fill scarce per-ticker fields (AV analyst target) across the live board
 * in long-term → momentum → penny/extreme order.
 */
async function fillScarceFieldsByPriority(options = {}) {
  const startedAt = new Date().toISOString();
  const maxTargets =
    options.maxTargets != null
      ? Math.max(0, Number(options.maxTargets))
      : null;

  const picks = await listLiveBoardPicks();
  const candidates = [];

  for (const pick of picks) {
    const entry = await getStockCacheEntry(pick.ticker);
    const data = entry?.data || null;
    const reportLike = {
      price: data?.quote?.price?.current ?? pick.price,
      changePercent:
        data?.quote?.price?.changePercent ?? pick.percent_change,
      longTermRank: 50,
    };
    const needsTarget = !isTargetFresh(data);
    if (!needsTarget) continue;
    const pri = scarceFillPriority(pick, reportLike);
    candidates.push({
      ticker: String(pick.ticker).toUpperCase(),
      pick,
      tier: pri.tier,
      tierLabel: pri.label,
      needsTarget,
    });
  }

  candidates.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    return String(a.ticker).localeCompare(String(b.ticker));
  });

  const avStart = await alphaVantageSpendable();
  let seats =
    maxTargets != null
      ? Math.min(maxTargets, avStart.spendable)
      : avStart.spendable;

  const filled = [];
  const queued = [];
  const failed = [];

  for (const row of candidates) {
    if (seats <= 0) {
      queued.push({
        ticker: row.ticker,
        tier: row.tier,
        tierLabel: row.tierLabel,
        reason: "av_spendable_exhausted",
      });
      continue;
    }
    try {
      await getStockReport(row.ticker, "long", { skipPeers: true });
      const after = await getStockCacheEntry(row.ticker);
      const ok = isTargetFresh(after?.data);
      if (ok) {
        filled.push({
          ticker: row.ticker,
          tier: row.tier,
          tierLabel: row.tierLabel,
          field: "target",
        });
        seats -= 1;
      } else {
        // Spent or attempted; still no value (ticker may lack AV OVERVIEW target).
        failed.push({
          ticker: row.ticker,
          tier: row.tier,
          tierLabel: row.tierLabel,
          reason: "no_target_value",
        });
        // Still count an AV call likely spent on OVERVIEW.
        seats -= 1;
      }
    } catch (err) {
      failed.push({
        ticker: row.ticker,
        tier: row.tier,
        tierLabel: row.tierLabel,
        reason: err.message,
      });
    }
  }

  const avEnd = await alphaVantageSpendable();
  return {
    ok: true,
    startedAt,
    finishedAt: new Date().toISOString(),
    field: "target",
    provider: "alpha_vantage",
    priorityOrder: [
      "long_term_track",
      "momentum_short_track",
      "penny_or_extreme_momentum",
    ],
    considered: candidates.length,
    filled,
    queued,
    failed,
    quota: { before: avStart, after: avEnd },
    message: `Scarce target fill: filled=${filled.length} queued=${queued.length} failed=${failed.length}`,
  };
}

module.exports = {
  alphaVantageSpendable,
  warmNewlyPromotedTicker,
  scarceFillPriority,
  fillScarceFieldsByPriority,
};
