/**
 * Board section placement + category-local ranking.
 *
 * Three independent categories (no shared ranking across them):
 *   long  — established, stable names based on REAL market history (IPO age /
 *           fetched price bars / realized vol), major exchange, not penny,
 *           not an extreme single-day mover
 *   short — general short-term names that are not long-eligible and not penny/extreme
 *   penny — penny and/or extreme single-day movers (Short-term sub-category)
 *
 * Long eligibility does NOT use our internal board tenure (tracked_since).
 * Insufficient real price history (too thin to classify) → penny/volatile first.
 * A name with enough bars for short indicators but not long gates → short.
 *
 * Each section carries its own sectionRank. Never sort one section with another
 * section's score.
 */

const {
  EXTREME_MOVE_PCT,
  PENNY_PRICE_THRESHOLD,
  isExtremeMove,
  isPennyPrice,
  isMajorExchange,
} = require("./boardTickers");
const { warningLabelsFromFlags, parseFlags } = require("./boardPicks");

const BOARD_SECTIONS = Object.freeze({
  LONG: "long",
  SHORT: "short",
  PENNY: "penny",
});

/**
 * Minimum real daily closes required to judge long-term stability when IPO
 * date is missing. ~120 trading days ≈ 6 months.
 */
const LONG_MIN_PRICE_BARS = Math.max(
  60,
  Number.parseInt(process.env.LONG_MIN_PRICE_BARS || "120", 10) || 120
);

/**
 * Minimum daily closes to compute standard short-term indicators (SMA20/RSI).
 * Below this (and without IPO/SMA200 proof of history) → penny/volatile bucket
 * (insufficient to classify reliably).
 */
const SHORT_MIN_PRICE_BARS = Math.max(
  15,
  Number.parseInt(process.env.SHORT_MIN_PRICE_BARS || "20", 10) || 20
);

/** Minimum years since IPO/listing to count as established (when IPO known). */
const LONG_MIN_IPO_YEARS = Math.max(
  0.5,
  Number.parseFloat(process.env.LONG_MIN_IPO_YEARS || "1") || 1
);

/**
 * Max annualized realized vol (%) for long eligibility.
 * Generous enough for large growth names (e.g. NVDA); blocks only extreme vol.
 */
const LONG_MAX_ANNUALIZED_VOL_PCT = Math.max(
  30,
  Number.parseFloat(process.env.LONG_MAX_ANNUALIZED_VOL_PCT || "90") || 90
);

/**
 * When market cap is known, require at least this for long (USD).
 * Null/unknown market cap does not fail the gate by itself.
 */
const LONG_MIN_MARKET_CAP = Math.max(
  0,
  Number.parseFloat(process.env.LONG_MIN_MARKET_CAP || "1e9") || 1e9
);

/** Lookback window (closes) used for realized-vol estimate. */
const VOL_LOOKBACK_BARS = Math.max(
  40,
  Number.parseInt(process.env.LONG_VOL_LOOKBACK_BARS || "252", 10) || 252
);

/** Soft ceiling on longTermRank when real market history is too thin. */
const THIN_HISTORY_LONG_RANK_CAP = 45;

/** @deprecated board-tenure gate removed — kept as alias for thin-history soft-cap. */
const NEWLY_TRACKED_LONG_RANK_CAP = THIN_HISTORY_LONG_RANK_CAP;
/** @deprecated no longer used for eligibility; prefer LONG_MIN_PRICE_BARS. */
const LONG_TERM_MIN_TRACKED_DAYS = LONG_MIN_PRICE_BARS;

/** Deterministic longTermRank penalty amounts (long category score only). */
const LONG_TERM_PENALTIES = {
  extremeMove: 30,
  penny: 25,
  nonMajorExchange: 20,
  /** Real market history too thin to support long conviction. */
  thinMarketHistory: 20,
  highHistoricalVol: 15,
  missingFundamentals: 15,
};

function clampRank(n) {
  if (!Number.isFinite(Number(n))) return 0;
  return Math.max(0, Math.min(100, Math.round(Number(n))));
}

function trackedSinceIso(pick) {
  return (
    pick?.tracked_since ||
    pick?.trackedSince ||
    pick?.added_at ||
    pick?.addedAt ||
    null
  );
}

function trackedDays(pick, nowMs = Date.now()) {
  const iso = trackedSinceIso(pick);
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, (nowMs - t) / (24 * 60 * 60 * 1000));
}

function yearsSinceIso(iso, nowMs = Date.now()) {
  if (!iso) return null;
  const t = Date.parse(String(iso));
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (nowMs - t) / (365.25 * 24 * 60 * 60 * 1000));
}

function extractCloses(report = {}) {
  const raw =
    report.priceHistory ||
    report.quote?.priceHistory ||
    report.dailyCloses ||
    null;
  if (!Array.isArray(raw)) return [];
  return raw.map(Number).filter((n) => Number.isFinite(n) && n > 0);
}

function historyBarCount(report = {}, closes = []) {
  const explicit =
    report.historyBars ??
    report.quote?.historyBars ??
    report.priceHistoryBars ??
    null;
  if (explicit != null && Number.isFinite(Number(explicit))) {
    return Math.max(Number(explicit), closes.length);
  }
  return closes.length;
}

function sma200Present(report = {}) {
  const ind = report.indicators || report.quote?.indicators || {};
  const long = ind.long || ind;
  const sma200 =
    long?.sma?.sma200 ?? long?.sma200 ?? ind?.sma?.sma200 ?? null;
  return sma200 != null && Number.isFinite(Number(sma200));
}

/**
 * Annualized realized volatility (%) from daily closes (log returns × √252).
 * Returns null when too few points to estimate.
 */
function realizedVolatilityAnnualized(closes, lookback = VOL_LOOKBACK_BARS) {
  if (!Array.isArray(closes) || closes.length < 21) return null;
  const window = closes.slice(-Math.min(lookback, closes.length));
  const returns = [];
  for (let i = 1; i < window.length; i++) {
    const a = window[i - 1];
    const b = window[i];
    if (a > 0 && b > 0) returns.push(Math.log(b / a));
  }
  if (returns.length < 20) return null;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  let sumSq = 0;
  for (const r of returns) sumSq += (r - mean) ** 2;
  const stdev = Math.sqrt(sumSq / (returns.length - 1));
  if (!Number.isFinite(stdev)) return null;
  return Math.round(stdev * Math.sqrt(252) * 1000) / 10; // one decimal %
}

/**
 * Real market-history gate for long-term eligibility.
 * Uses IPO age and/or fetched daily history — NOT Ledger board tenure.
 */
function assessMarketHistory(report = {}, nowMs = Date.now()) {
  const closes = extractCloses(report);
  const bars = historyBarCount(report, closes);
  const ipoDate =
    report.ipoDate ||
    report.overview?.ipoDate ||
    report.fundamentals?.overview?.ipoDate ||
    null;
  const ipoYears = yearsSinceIso(ipoDate, nowMs);
  const hasSma200 = sma200Present(report);
  const volCloses =
    closes.length >= 21
      ? closes
      : null;
  const annualizedVolPct = volCloses
    ? realizedVolatilityAnnualized(volCloses)
    : null;

  const establishedByIpo =
    ipoYears != null && ipoYears >= LONG_MIN_IPO_YEARS;
  const establishedByBars = bars >= LONG_MIN_PRICE_BARS || hasSma200;
  const enoughRealHistory = establishedByIpo || establishedByBars;
  // Enough recent bars (or prior long-history proof) to run short-term indicators.
  const enoughForShortIndicators =
    bars >= SHORT_MIN_PRICE_BARS ||
    closes.length >= SHORT_MIN_PRICE_BARS ||
    hasSma200 ||
    establishedByIpo;
  const insufficientToClassify = !enoughForShortIndicators;

  return {
    ipoDate,
    ipoYears:
      ipoYears != null ? Math.round(ipoYears * 10) / 10 : null,
    historyBars: bars,
    priceHistoryPoints: closes.length,
    hasSma200,
    annualizedVolPct,
    establishedByIpo,
    establishedByBars,
    enoughRealHistory,
    enoughForShortIndicators,
    insufficientToClassify,
    thinMarketHistory: !enoughRealHistory,
  };
}

/**
 * Collect factual stability + real-history signals from pick + report.
 */
function collectStabilitySignals(pick = {}, report = {}) {
  const flags = parseFlags(pick.flags_json || pick.flags || {});
  const overview = report.overview || report.fundamentals?.overview || {};
  const price =
    report.price != null
      ? Number(report.price)
      : pick.price != null
        ? Number(pick.price)
        : null;
  const percentChange =
    report.changePercent != null
      ? Number(report.changePercent)
      : pick.percent_change != null
        ? Number(pick.percent_change)
        : pick.percentChange != null
          ? Number(pick.percentChange)
          : null;
  const exchange =
    report.exchange || pick.exchange || overview.exchange || null;

  const penny = Boolean(flags.penny) || isPennyPrice(price);
  const extremeMove =
    Boolean(flags.extremeMove) || isExtremeMove(percentChange);
  const nonMajorExchange =
    Boolean(flags.nonMajorExchange) ||
    (exchange ? !isMajorExchange(exchange) : false);

  const analystTarget =
    report.analystTarget ??
    report.analystTargetPrice ??
    overview.analystTargetPrice ??
    null;
  const peRatio =
    report.peRatio ?? overview.peRatio ?? report.company?.peRatio ?? null;
  const marketCapRaw = report.marketCap ?? overview.marketCap ?? null;
  const marketCap =
    marketCapRaw != null && Number.isFinite(Number(marketCapRaw))
      ? Number(marketCapRaw)
      : null;
  const hasAnalystTarget =
    analystTarget != null && Number.isFinite(Number(analystTarget));
  const hasPe = peRatio != null && Number.isFinite(Number(peRatio));
  const missingFundamentals = !hasAnalystTarget && !hasPe;

  const marketHistory = assessMarketHistory(
    {
      ...report,
      ipoDate: overview.ipoDate || report.ipoDate || null,
      overview,
    },
    Date.now()
  );

  const highHistoricalVol =
    marketHistory.annualizedVolPct != null &&
    marketHistory.annualizedVolPct > LONG_MAX_ANNUALIZED_VOL_PCT;

  const marketCapTooSmall =
    marketCap != null && marketCap > 0 && marketCap < LONG_MIN_MARKET_CAP;

  const days = trackedDays(pick);
  const discoverySource = String(pick.source || report.source || "");
  const fromDiscovery = /discovery|smart_refresh|fmp/i.test(discoverySource);

  // Legacy alias: "newlyTracked" now means thin REAL market history, not board tenure.
  const thinMarketHistory = marketHistory.thinMarketHistory;
  const newlyTracked = thinMarketHistory;

  return {
    price,
    percentChange,
    exchange,
    penny,
    extremeMove,
    nonMajorExchange,
    hasAnalystTarget,
    hasPe,
    marketCap,
    marketCapTooSmall,
    missingFundamentals,
    highHistoricalVol,
    thinMarketHistory,
    newlyTracked,
    trackedDays: Math.round(days * 10) / 10,
    minTrackedDays: LONG_MIN_PRICE_BARS,
    fromDiscovery,
    ipoDate: marketHistory.ipoDate,
    ipoYears: marketHistory.ipoYears,
    historyBars: marketHistory.historyBars,
    priceHistoryPoints: marketHistory.priceHistoryPoints,
    hasSma200: marketHistory.hasSma200,
    annualizedVolPct: marketHistory.annualizedVolPct,
    enoughRealHistory: marketHistory.enoughRealHistory,
    enoughForShortIndicators: marketHistory.enoughForShortIndicators,
    insufficientToClassify: marketHistory.insufficientToClassify,
    flags: { ...flags, penny, extremeMove, nonMajorExchange },
  };
}

/**
 * True when real market history supports a long-term judgment.
 * Does NOT consult Ledger tracked_since / board tenure.
 */
function meetsLongTermHistoryGate(pick, reportOrNow, maybeNow) {
  // Back-compat: meetsLongTermHistoryGate(pick, nowMs) used board tenure.
  // New: meetsLongTermHistoryGate(pick, report) or (pick, report, nowMs).
  let report = {};
  let nowMs = Date.now();
  if (reportOrNow != null && typeof reportOrNow === "object") {
    report = reportOrNow;
    if (maybeNow != null) nowMs = maybeNow;
  } else if (typeof reportOrNow === "number") {
    nowMs = reportOrNow;
  }
  const merged = {
    ...report,
    ipoDate:
      report.ipoDate ||
      report.overview?.ipoDate ||
      report.fundamentals?.overview?.ipoDate ||
      null,
  };
  return assessMarketHistory(merged, nowMs).enoughRealHistory;
}

/**
 * SINGLE SOURCE OF TRUTH for boardSection.
 * Priority (mutually exclusive — evaluate in order):
 *   1. penny  — price <$5 OR |%change|≥15% OR insufficient real price history
 *   2. long   — major exchange + established history + vol/cap gates
 *   3. short  — remaining default with enough bars for short-term indicators
 *
 * Do not duplicate this logic elsewhere — call assessBoardPlacement().
 */
function resolveBoardSection(signals) {
  // 1) Penny / volatile / unclassifiable — always first.
  if (
    signals.penny ||
    signals.extremeMove ||
    signals.insufficientToClassify
  ) {
    return BOARD_SECTIONS.PENNY;
  }

  // 2) Long — established + stable structural gates.
  const historyOk = Boolean(signals.enoughRealHistory);
  const volOk = !signals.highHistoricalVol;
  const capOk = !signals.marketCapTooSmall;
  if (
    historyOk &&
    volOk &&
    capOk &&
    !signals.nonMajorExchange
  ) {
    return BOARD_SECTIONS.LONG;
  }

  // 3) Short — default remainder (has enough data to classify, not long).
  return BOARD_SECTIONS.SHORT;
}

/**
 * Category-local ranks — never cross-wire these between sections.
 */
function computeSectionRanks(report, signals, longAdjusted) {
  const shortRaw =
    report?.shortTermRank != null ? Number(report.shortTermRank) : null;
  const shortRank = clampRank(
    Number.isFinite(shortRaw)
      ? shortRaw
      : report?.rankScore != null
        ? report.rankScore
        : 40
  );

  const absMove = Number.isFinite(signals.percentChange)
    ? Math.abs(Number(signals.percentChange))
    : 0;
  let volatileRank = Math.min(100, Math.round(absMove * 2));
  if (signals.penny) volatileRank = Math.min(100, volatileRank + 15);
  if (signals.extremeMove) {
    volatileRank = Math.min(100, Math.max(volatileRank, 60));
  }
  if (!Number.isFinite(signals.percentChange) && !signals.penny) {
    volatileRank = 40;
  }

  return {
    long: clampRank(longAdjusted),
    short: shortRank,
    penny: clampRank(volatileRank),
  };
}

/**
 * Compact factual ranking context for the Gemini payload.
 */
function buildRankingContext(pick = {}, reportLike = {}) {
  const signals = collectStabilitySignals(pick, reportLike);
  return {
    exchange: signals.exchange,
    marketCap: signals.marketCap,
    ipoDate: signals.ipoDate,
    ipoYears: signals.ipoYears,
    historyBars: signals.historyBars,
    annualizedVolPct: signals.annualizedVolPct,
    enoughRealHistory: signals.enoughRealHistory,
    thinMarketHistory: signals.thinMarketHistory,
    highHistoricalVol: signals.highHistoricalVol,
    // Legacy fields (thin history, not board tenure):
    newlyTracked: signals.thinMarketHistory,
    trackedDays: signals.trackedDays,
    fromDiscovery: signals.fromDiscovery,
    extremeSingleDayMove: signals.extremeMove,
    pennyUnder5: signals.penny,
    nonMajorExchange: signals.nonMajorExchange,
    hasAnalystTarget: signals.hasAnalystTarget,
    hasPeRatio: signals.hasPe,
    missingLongTermFundamentals: signals.missingFundamentals,
    longTermGuidance: {
      treatHotMoverVolatilityAsNegative: true,
      newlyTrackedLongRankSoftCap: signals.thinMarketHistory
        ? THIN_HISTORY_LONG_RANK_CAP
        : null,
      thinHistoryLongRankSoftCap: signals.thinMarketHistory
        ? THIN_HISTORY_LONG_RANK_CAP
        : null,
      doNotInventMissingFundamentals: true,
      eligibilityUsesRealMarketHistoryNotBoardTenure: true,
    },
  };
}

/**
 * Apply long-term-only penalties. Short / penny section ranks must NOT use this.
 */
function applyLongTermStabilityPenalties(baseRank, signals = {}) {
  let rank = clampRank(baseRank);
  const applied = [];

  const thin = Boolean(signals.thinMarketHistory || signals.newlyTracked);
  if (thin && rank > THIN_HISTORY_LONG_RANK_CAP) {
    applied.push({
      id: "thin_market_history_cap",
      amount: rank - THIN_HISTORY_LONG_RANK_CAP,
      detail: `Insufficient real price/IPO history — long-term rank capped at ${THIN_HISTORY_LONG_RANK_CAP}`,
    });
    rank = THIN_HISTORY_LONG_RANK_CAP;
  }

  if (signals.extremeMove) {
    rank -= LONG_TERM_PENALTIES.extremeMove;
    applied.push({
      id: "extreme_move",
      amount: LONG_TERM_PENALTIES.extremeMove,
      detail: `Single-day move beyond ±${EXTREME_MOVE_PCT}%`,
    });
  }
  if (signals.penny) {
    rank -= LONG_TERM_PENALTIES.penny;
    applied.push({
      id: "penny",
      amount: LONG_TERM_PENALTIES.penny,
      detail: `Price under $${PENNY_PRICE_THRESHOLD}`,
    });
  }
  if (signals.nonMajorExchange) {
    rank -= LONG_TERM_PENALTIES.nonMajorExchange;
    applied.push({
      id: "non_major_exchange",
      amount: LONG_TERM_PENALTIES.nonMajorExchange,
      detail: "Non-major / unknown exchange",
    });
  }
  if (thin) {
    rank -= LONG_TERM_PENALTIES.thinMarketHistory;
    applied.push({
      id: "thin_market_history",
      amount: LONG_TERM_PENALTIES.thinMarketHistory,
      detail:
        "Not enough real market history (IPO age / daily bars) for long-term conviction",
    });
  }
  if (signals.highHistoricalVol) {
    rank -= LONG_TERM_PENALTIES.highHistoricalVol;
    applied.push({
      id: "high_historical_vol",
      amount: LONG_TERM_PENALTIES.highHistoricalVol,
      detail: `Annualized realized vol above ${LONG_MAX_ANNUALIZED_VOL_PCT}%`,
    });
  }
  if (signals.missingFundamentals) {
    rank -= LONG_TERM_PENALTIES.missingFundamentals;
    applied.push({
      id: "missing_fundamentals",
      amount: LONG_TERM_PENALTIES.missingFundamentals,
      detail:
        "No analyst target and no P/E — missing long-term fundamental backing",
    });
  }

  return {
    baseRank: clampRank(baseRank),
    rank: clampRank(rank),
    penalties: applied,
  };
}

/**
 * Single placement API — eligibility + category-local ranks share one definition.
 */
function assessBoardPlacement(pick, report) {
  const signals = collectStabilitySignals(pick, report);
  const days = trackedDays(pick);
  const historyOk = Boolean(signals.enoughRealHistory);
  const boardSection = resolveBoardSection(signals);

  const rawLong =
    report?.longTermRank != null
      ? Number(report.longTermRank)
      : report?.rankScore != null
        ? Number(report.rankScore)
        : 40;
  const adjusted = applyLongTermStabilityPenalties(rawLong, signals);
  const ranks = computeSectionRanks(report, signals, adjusted.rank);

  const longTermEligible = boardSection === BOARD_SECTIONS.LONG;
  const unstable =
    signals.extremeMove || signals.penny || signals.nonMajorExchange;

  const warnings = warningLabelsFromFlags(signals.flags, {
    price: signals.price,
    percent_change: signals.percentChange,
    exchange: signals.exchange,
  });

  const sectionRank =
    boardSection === BOARD_SECTIONS.LONG
      ? ranks.long
      : boardSection === BOARD_SECTIONS.PENNY
        ? ranks.penny
        : ranks.short;

  return {
    boardSection,
    sectionRank,
    ranks,
    longTermEligible,
    /** @deprecated use boardSection === 'penny' || boardSection === 'short' for non-long */
    momentumSection: boardSection !== BOARD_SECTIONS.LONG,
    historyOk,
    trackedSince: trackedSinceIso(pick),
    trackedDays: Math.round(days * 10) / 10,
    minTrackedDays: LONG_MIN_PRICE_BARS,
    minPriceBars: LONG_MIN_PRICE_BARS,
    minIpoYears: LONG_MIN_IPO_YEARS,
    maxAnnualizedVolPct: LONG_MAX_ANNUALIZED_VOL_PCT,
    unstable,
    signals,
    warnings,
    longTermRankRaw: adjusted.baseRank,
    longTermRankAdjusted: adjusted.rank,
    shortTermRank: ranks.short,
    pennyVolatileRank: ranks.penny,
    penalties: adjusted.penalties,
  };
}

/** @deprecated Prefer assessBoardPlacement — kept for callers mid-migration. */
function assessLongTermPlacement(pick, report) {
  return assessBoardPlacement(pick, report);
}

function sortBySectionRank(rows) {
  return [...rows].sort(
    (a, b) =>
      Number(b.sectionRank ?? b.report?.sectionRank ?? 0) -
      Number(a.sectionRank ?? a.report?.sectionRank ?? 0)
  );
}

function partitionBoardBySection(rows) {
  const sections = {
    [BOARD_SECTIONS.LONG]: [],
    [BOARD_SECTIONS.SHORT]: [],
    [BOARD_SECTIONS.PENNY]: [],
  };
  for (const row of rows) {
    const key =
      row.boardSection ||
      row.report?.boardSection ||
      BOARD_SECTIONS.SHORT;
    if (!sections[key]) sections[BOARD_SECTIONS.SHORT].push(row);
    else sections[key].push(row);
  }
  for (const key of Object.keys(sections)) {
    sections[key] = sortBySectionRank(sections[key]);
  }
  return sections;
}

function buildSectionPayload(rows, { spotlightSize = 3 } = {}) {
  const sorted = sortBySectionRank(rows);
  const fresh = [];
  const stale = [];
  for (const row of sorted) {
    if (row.report?.stale) stale.push(row);
    else fresh.push(row);
  }
  return {
    items: fresh,
    stale,
    spotlight: fresh.slice(0, spotlightSize),
    rest: fresh.slice(spotlightSize),
    count: fresh.length,
    staleCount: stale.length,
  };
}

/**
 * Map analysis lean/risk + boardSection → board_picks status.
 * Penny/extreme names never get "recommended".
 */
function statusFromBoardSection(lean, risk, boardSection) {
  const section = String(boardSection || BOARD_SECTIONS.SHORT);
  if (section === BOARD_SECTIONS.PENNY) return "watch";

  const l = String(lean || "").toLowerCase();
  const r = String(risk || "").toLowerCase();
  if (l === "bearish" || r === "high") return "watch";
  if (l === "bullish" || (l === "neutral" && r === "low")) {
    if (section === BOARD_SECTIONS.LONG) return "recommended";
    return "watch";
  }
  return "watch";
}

module.exports = {
  BOARD_SECTIONS,
  LONG_MIN_PRICE_BARS,
  SHORT_MIN_PRICE_BARS,
  LONG_MIN_IPO_YEARS,
  LONG_MAX_ANNUALIZED_VOL_PCT,
  LONG_MIN_MARKET_CAP,
  VOL_LOOKBACK_BARS,
  THIN_HISTORY_LONG_RANK_CAP,
  LONG_TERM_MIN_TRACKED_DAYS,
  LONG_TERM_PENALTIES,
  NEWLY_TRACKED_LONG_RANK_CAP,
  trackedSinceIso,
  trackedDays,
  yearsSinceIso,
  realizedVolatilityAnnualized,
  assessMarketHistory,
  meetsLongTermHistoryGate,
  collectStabilitySignals,
  buildRankingContext,
  applyLongTermStabilityPenalties,
  /** THE single classification entry point — ranking + display must use this. */
  assessBoardPlacement,
  assessLongTermPlacement,
  sortBySectionRank,
  partitionBoardBySection,
  buildSectionPayload,
  statusFromBoardSection,
  clampRank,
  // resolveBoardSection is intentionally NOT exported — use assessBoardPlacement.
};
