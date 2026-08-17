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
const { assessBoardPlacement, BOARD_SECTIONS } = require("../lib/rankingStability");
const { ensureTickerIdentity } = require("./tickerIdentity");

async function alphaVantageSpendable() {
  const used = await getUsageToday(PROVIDERS.ALPHA);
  const limit = Number(DATA_SOURCES.alpha_vantage?.rateLimit?.limit) || 25;
  const reserve = Number(smartRefreshReserve("alpha_vantage") || 0);
  const remaining = Math.max(0, limit - Number(used || 0));
  const spendable = Math.max(0, remaining - reserve);
  return { used, limit, remaining, reserve, spendable };
}

/**
 * Priority rank for scarce fills (lower = sooner):
 * 0 long, 1 short (general), 2 penny, 3 unclassified/needs-backfill last.
 */
function scarceFillPriority(pick, reportLike = {}) {
  const placement = assessBoardPlacement(pick, reportLike);
  if (placement.boardSection === BOARD_SECTIONS.LONG) {
    return { tier: 0, label: "long_term_track" };
  }
  if (placement.boardSection === BOARD_SECTIONS.PENNY) {
    return { tier: 2, label: "penny" };
  }
  if (placement.boardSection === BOARD_SECTIONS.UNCLASSIFIED) {
    return { tier: 3, label: "needs_backfill" };
  }
  return { tier: 1, label: "short_general" };
}

/**
 * Immediate catch-up after a ticker is promoted to the live board.
 * Identity (name/sector/description) + price + news always attempted.
 * Target only if AV spendable > 0.
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
    identity: false,
    price: false,
    news: false,
    target: false,
    targetQueued: false,
    skippedTargetReason: null,
  };

  try {
    const idResult = await ensureTickerIdentity(symbol, {
      name: options.name || null,
      sector: options.sector || null,
      description: options.description || null,
      exchange: options.exchange || null,
      force: options.forceIdentity === true,
    });
    result.identity = Boolean(idResult?.identity?.name);
    result.identityMeta = idResult;
  } catch (err) {
    console.warn(`[warmNewlyPromoted] identity ${symbol}:`, err.message);
  }

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

  // Cheap pre-check: the price pull above already tells us how many real
  // bars we have, at zero extra cost. If a candidate is SO thin (well
  // under Short's own real-data requirement) that it's essentially certain
  // to land Unclassified regardless of what else we fetch, skip the
  // expensive scarce spend (AV target, Marketaux/AV news retry, Gemini
  // analysis) THIS cycle rather than spending it on a report nobody can
  // act on yet. Nothing is lost — the next daily refresh naturally
  // re-attempts once more real bars have accumulated, and a genuinely
  // established company (real SMA200 already available) is exempted so a
  // legitimately fast-track-eligible Long candidate is never deferred.
  const DEFER_ANALYSIS_BAR_FLOOR = Math.max(
    1,
    Number.parseInt(process.env.DEFER_ANALYSIS_BAR_FLOOR || "5", 10) || 5
  );
  try {
    const preEntry = await getStockCacheEntry(symbol);
    const bars = Number(preEntry?.data?.quote?.historyBars);
    const hasSma200 = Boolean(
      preEntry?.data?.quote?.indicators?.long?.sma200 ??
        preEntry?.data?.fundamentals?.overview?.sma200
    );
    if (
      Number.isFinite(bars) &&
      bars < DEFER_ANALYSIS_BAR_FLOOR &&
      !hasSma200
    ) {
      result.deferredAnalysis = true;
      result.deferredAnalysisReason = `only ${bars} real bar(s) tracked — deferring scarce spend until more accumulate`;
      console.log(
        `[warmNewlyPromoted] ${symbol}: deferring AV/Gemini spend — ${bars} bars < floor ${DEFER_ANALYSIS_BAR_FLOOR}, no SMA200 fallback`
      );
      return result;
    }
  } catch (err) {
    // Pre-check failing must never block the normal path — fall through
    // to the full warm exactly as before if we can't read the cache yet.
    console.warn(`[warmNewlyPromoted] defer pre-check ${symbol}:`, err.message);
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
    // Re-check identity after report (OVERVIEW may have enriched fields).
    if (!result.identity) {
      const idAfter = await ensureTickerIdentity(symbol, {
        name: report?.name || report?.companyName || options.name || null,
        sector: report?.sector || options.sector || null,
        description: report?.description || options.description || null,
      });
      result.identity = Boolean(idAfter?.identity?.name);
      result.identityMeta = idAfter;
    }
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
 * Fill scarce per-ticker fields (AV analyst target) across the live board
 * in long → short → penny/extreme order.
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
