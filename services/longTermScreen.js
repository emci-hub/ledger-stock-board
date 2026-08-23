/**
 * Long-term screen candidate assembly + verdict resolution.
 *
 * Pure orchestration: resolves the TRADE->PRIMARY listing, gathers
 * PRIMARY-listing fundamentals, the 90-day dated event, and drop/stopped-
 * worsening math, then hands everything to lib/longTermVerdict.js's
 * resolveLongTermVerdict(). No AI call anywhere in this path — Gate 5
 * (stock-alert-spec.md's "fear is temporary" check) is the deterministic
 * keyword scan inside resolveLongTermVerdict itself. This is deliberately
 * separate from services/analyze.js, which stays scoped to the Gemini
 * dual-analysis pipeline used by the short-term screen.
 */

const { resolveListing } = require("../lib/listingMap");
const {
  computeDropSignals,
  computeStoppedWorsening,
  HIGH_WINDOW_BARS,
  EVENT_WINDOW_TRADING_DAYS,
} = require("../lib/dropMath");
const { resolveLongTermVerdict } = require("../lib/longTermVerdict");
const { findDatedEvent } = require("./newsEvents");
const {
  getAnalystTargetFromAlphaOverview,
  getCashFlowFromAlpha,
  getBalanceSheetFromAlpha,
  getCompanyProfileFromFmp,
  getDailyBarsForPrimary,
  QuotaSkippedError,
} = require("./dataFetch");
const { getRecentCloses, backfillFromBars } = require("./priceHistoryLog");
const {
  getLongTermFundamentalsCache,
  saveLongTermFundamentalsCache,
  isLongFundamentalsFresh,
} = require("./cache");

/** Minimum trailing closes needed for the 63-day-high + T+5 event window. */
const MIN_CLOSES_NEEDED = HIGH_WINDOW_BARS + EVENT_WINDOW_TRADING_DAYS;

async function softFail(promise, label, primaryTicker) {
  try {
    return await promise;
  } catch (err) {
    if (err instanceof QuotaSkippedError) {
      console.warn(`[screenLongTermCandidate] ${label} skipped for ${primaryTicker} — no quota`);
      return null;
    }
    console.error(`[screenLongTermCandidate] ${label} failed for ${primaryTicker}:`, err.message);
    return null;
  }
}

/**
 * Ensure price_history_log has enough trailing PRIMARY closes for the drop
 * math; backfills once from a fresh daily bar fetch if the logged history
 * is too thin (e.g. the first time this ticker is screened).
 */
async function ensureHistory(primaryTicker) {
  let closes = await getRecentCloses(primaryTicker);
  if (closes.length >= MIN_CLOSES_NEEDED) return closes;

  const bars = await softFail(
    getDailyBarsForPrimary(primaryTicker),
    "history backfill",
    primaryTicker
  );
  if (Array.isArray(bars) && bars.length) {
    await backfillFromBars(primaryTicker, bars);
    closes = await getRecentCloses(primaryTicker);
  }
  return closes;
}

/**
 * Long-term screen's AV fundamentals (cap, profit margin, revenue growth,
 * cash flow, debt, dilution) — 7-day cache (services/cache.js's
 * LONG_FUNDAMENTALS_TTL_MS), since these are sourced from quarterly filings
 * and don't change between them. A cache hit skips all three AV calls
 * (OVERVIEW/CASH_FLOW/BALANCE_SHEET) entirely — this is the actual fix for
 * Alpha Vantage being the Long screen's daily quota bottleneck.
 */
async function getFundamentals(primaryTicker) {
  const cached = await getLongTermFundamentalsCache(primaryTicker);
  if (cached && isLongFundamentalsFresh(cached.fetchedAt)) {
    console.log(
      `[screenLongTermCandidate] fundamentals cache hit for ${primaryTicker} (fetched ${cached.fetchedAt})`
    );
    return { ...cached.data, fetchedAt: cached.fetchedAt };
  }

  const [overview, cashFlow, balanceSheet] = await Promise.all([
    softFail(getAnalystTargetFromAlphaOverview(primaryTicker), "overview", primaryTicker),
    softFail(getCashFlowFromAlpha(primaryTicker), "cash flow", primaryTicker),
    softFail(getBalanceSheetFromAlpha(primaryTicker), "balance sheet", primaryTicker),
  ]);

  const revenueGrowthPct =
    overview?.quarterlyRevenueGrowthYoy != null
      ? overview.quarterlyRevenueGrowthYoy * 100
      : null;

  const fundamentals = {
    marketCapUsd: overview?.marketCap ?? null,
    profitMargin: overview?.profitMargin ?? null,
    revenueGrowthPct,
    operatingCashFlow: cashFlow?.operatingCashFlow ?? null,
    freeCashFlowTrend: cashFlow?.freeCashFlowTrend ?? null,
    dilutionFlag: balanceSheet?.dilutionFlag ?? null,
    totalDebt: balanceSheet?.totalDebt ?? null,
    cashAndEquivalents: balanceSheet?.cashAndEquivalents ?? null,
  };

  const gotSomething = Object.values(fundamentals).some((v) => v != null);
  if (gotSomething) {
    const fetchedAt = await saveLongTermFundamentalsCache(primaryTicker, fundamentals);
    return { ...fundamentals, fetchedAt };
  }

  // Refetch attempt came back empty (e.g. AV quota exhausted right as the
  // 7-day cache expired) — an expired-but-real stale entry beats locking in
  // an all-null result for another 7 days. Cache is left untouched so the
  // next run tries a real refetch again instead of extending a null result.
  if (cached) {
    console.warn(
      `[screenLongTermCandidate] fundamentals refetch failed for ${primaryTicker} — reusing stale cache from ${cached.fetchedAt}`
    );
    return { ...cached.data, fetchedAt: cached.fetchedAt };
  }

  return { ...fundamentals, fetchedAt: null };
}

/**
 * Screen one TRADE ticker against stock-alert-spec.md. Returns
 * resolveLongTermVerdict()'s result plus the assembled listing/candidate
 * context for display.
 */
async function screenLongTermCandidate(tradeTicker) {
  const listing = resolveListing(tradeTicker);
  const { primaryTicker } = listing;

  const [fundamentals, profileAlt, event, closes] = await Promise.all([
    getFundamentals(primaryTicker),
    softFail(getCompanyProfileFromFmp(primaryTicker), "FMP profile", primaryTicker),
    softFail(findDatedEvent(primaryTicker), "news event", primaryTicker),
    ensureHistory(primaryTicker),
  ]);

  const dropSignals = event
    ? computeDropSignals(closes, event.date)
    : { high63: null, eventWindow: null, dropFlag: false, decidable: true };

  const { sessionsSinceNewLow, closesAboveSma20Count } = computeStoppedWorsening(closes);

  const candidate = {
    marketCapUsd: fundamentals.marketCapUsd,
    marketCapUsdAlt: profileAlt?.marketCap ?? null,
    profitable: fundamentals.profitMargin != null ? fundamentals.profitMargin > 0 : null,
    revenueGrowthPct: fundamentals.revenueGrowthPct,
    // No analyst-estimate-revision data source exists in this codebase yet —
    // always null, which resolveLongTermVerdict treats as "not a material cut."
    earningsEstimateCutPct: null,
    operatingCashFlow: fundamentals.operatingCashFlow,
    freeCashFlowTrend: fundamentals.freeCashFlowTrend,
    dilutionFlag: fundamentals.dilutionFlag,
    // Display-only (not consumed by any verdict gate) — spec's "cash, debt,
    // dilution" output line, same PRIMARY-sourced BALANCE_SHEET fetch.
    totalDebt: fundamentals.totalDebt,
    cashAndEquivalents: fundamentals.cashAndEquivalents,
    // Display-only — when these fundamentals were actually fetched from AV
    // (services/cache.js's 7-day cache), so the board can show real "as of"
    // freshness instead of implying every field is fetched fresh each run.
    fundamentalsFetchedAt: fundamentals.fetchedAt ?? null,
    event,
    dropSignals,
    eventText: event?.headline || "",
    sessionsSinceNewLow,
    closesAboveSma20Count,
  };

  const verdict = resolveLongTermVerdict(candidate);

  return {
    tradeTicker: listing.tradeTicker,
    primaryTicker: listing.primaryTicker,
    primaryExchange: listing.primaryExchange,
    tradeCurrency: listing.tradeCurrency,
    sameListing: listing.sameListing,
    candidate,
    ...verdict,
  };
}

module.exports = { screenLongTermCandidate };
