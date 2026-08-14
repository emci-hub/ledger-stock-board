/**
 * Board section placement + category-local ranking.
 *
 * Three independent categories (no shared ranking across them):
 *   long  — stable / low-volatility only (7-day history, no penny, no extreme move, major exchange)
 *   short — general short-term names that are not long-eligible and not penny/extreme
 *   penny — penny and/or extreme single-day movers (Short-term sub-category)
 *
 * Each section carries its own sectionRank. Never sort one section with another
 * section's score (that was the root cause of cross-category leaks).
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

/** Days a stock must be live before it can enter the long-term category. */
const LONG_TERM_MIN_TRACKED_DAYS = Math.max(
  1,
  Number.parseInt(process.env.LONG_TERM_MIN_TRACKED_DAYS || "7", 10) || 7
);

/** Deterministic longTermRank penalty amounts (long category score only). */
const LONG_TERM_PENALTIES = {
  extremeMove: 30,
  penny: 25,
  nonMajorExchange: 20,
  newlyTracked: 20,
  missingFundamentals: 15,
};

/** Soft ceiling for brand-new names on longTermRank (Gemini soft-cap). */
const NEWLY_TRACKED_LONG_RANK_CAP = 45;

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

function meetsLongTermHistoryGate(pick, nowMs = Date.now()) {
  return trackedDays(pick, nowMs) >= LONG_TERM_MIN_TRACKED_DAYS;
}

/**
 * Collect factual stability signals from pick + report/overview.
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
  const marketCap = report.marketCap ?? overview.marketCap ?? null;
  const hasAnalystTarget =
    analystTarget != null && Number.isFinite(Number(analystTarget));
  const hasPe = peRatio != null && Number.isFinite(Number(peRatio));
  const missingFundamentals = !hasAnalystTarget && !hasPe;

  const days = trackedDays(pick);
  const newlyTracked = days < LONG_TERM_MIN_TRACKED_DAYS;
  const discoverySource = String(pick.source || report.source || "");
  const fromDiscovery = /discovery|smart_refresh|fmp/i.test(discoverySource);

  return {
    price,
    percentChange,
    exchange,
    penny,
    extremeMove,
    nonMajorExchange,
    hasAnalystTarget,
    hasPe,
    marketCap:
      marketCap != null && Number.isFinite(Number(marketCap))
        ? Number(marketCap)
        : null,
    missingFundamentals,
    newlyTracked,
    trackedDays: Math.round(days * 10) / 10,
    minTrackedDays: LONG_TERM_MIN_TRACKED_DAYS,
    fromDiscovery,
    ipoDate: overview.ipoDate || report.ipoDate || null,
    flags: { ...flags, penny, extremeMove, nonMajorExchange },
  };
}

/**
 * Resolve the single board section for a stock.
 * Mutual exclusion: penny/extreme never long; long never shares short ranks.
 */
function resolveBoardSection(signals, historyOk) {
  // Highest-risk short sub-category first — never eligible for long.
  if (signals.penny || signals.extremeMove) {
    return BOARD_SECTIONS.PENNY;
  }
  // Long: history + structural stability only.
  if (
    historyOk &&
    !signals.penny &&
    !signals.extremeMove &&
    !signals.nonMajorExchange
  ) {
    return BOARD_SECTIONS.LONG;
  }
  return BOARD_SECTIONS.SHORT;
}

/**
 * Category-local ranks — never cross-wire these between sections.
 */
function computeSectionRanks(report, signals, longAdjusted) {
  const shortRaw =
    report?.shortTermRank != null ? Number(report.shortTermRank) : null;
  const shortRank = clampRank(
    Number.isFinite(shortRaw) ? shortRaw : report?.rankScore != null ? report.rankScore : 40
  );

  // Volatile/penny rank: magnitude of move + penny boost. Independent of shortTermRank.
  const absMove = Number.isFinite(signals.percentChange)
    ? Math.abs(Number(signals.percentChange))
    : 0;
  let volatileRank = Math.min(100, Math.round(absMove * 2));
  if (signals.penny) volatileRank = Math.min(100, volatileRank + 15);
  if (signals.extremeMove) volatileRank = Math.min(100, Math.max(volatileRank, 60));
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
    trackedDays: signals.trackedDays,
    minTrackedDaysForLongSpotlight: signals.minTrackedDays,
    newlyTracked: signals.newlyTracked,
    fromDiscovery: signals.fromDiscovery,
    extremeSingleDayMove: signals.extremeMove,
    pennyUnder5: signals.penny,
    nonMajorExchange: signals.nonMajorExchange,
    hasAnalystTarget: signals.hasAnalystTarget,
    hasPeRatio: signals.hasPe,
    missingLongTermFundamentals: signals.missingFundamentals,
    longTermGuidance: {
      treatHotMoverVolatilityAsNegative: true,
      newlyTrackedLongRankSoftCap: signals.newlyTracked
        ? NEWLY_TRACKED_LONG_RANK_CAP
        : null,
      doNotInventMissingFundamentals: true,
    },
  };
}

/**
 * Apply long-term-only penalties. Short / penny section ranks must NOT use this.
 */
function applyLongTermStabilityPenalties(baseRank, signals = {}) {
  let rank = clampRank(baseRank);
  const applied = [];

  if (signals.newlyTracked && rank > NEWLY_TRACKED_LONG_RANK_CAP) {
    applied.push({
      id: "newly_tracked_cap",
      amount: rank - NEWLY_TRACKED_LONG_RANK_CAP,
      detail: `Tracked < ${LONG_TERM_MIN_TRACKED_DAYS}d — long-term rank capped at ${NEWLY_TRACKED_LONG_RANK_CAP}`,
    });
    rank = NEWLY_TRACKED_LONG_RANK_CAP;
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
  if (signals.newlyTracked) {
    rank -= LONG_TERM_PENALTIES.newlyTracked;
    applied.push({
      id: "newly_tracked",
      amount: LONG_TERM_PENALTIES.newlyTracked,
      detail: `On the board < ${LONG_TERM_MIN_TRACKED_DAYS} days — long-term conviction still uncertain`,
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
  const historyOk = meetsLongTermHistoryGate(pick);
  const boardSection = resolveBoardSection(signals, historyOk);

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
    minTrackedDays: LONG_TERM_MIN_TRACKED_DAYS,
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

/**
 * Sort + spotlight helpers — always use the row's own sectionRank.
 */
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
 * Penny/extreme names never get "recommended" (that chrome implies a calm pick).
 */
function statusFromBoardSection(lean, risk, boardSection) {
  const section = String(boardSection || BOARD_SECTIONS.SHORT);
  if (section === BOARD_SECTIONS.PENNY) return "watch";

  const l = String(lean || "").toLowerCase();
  const r = String(risk || "").toLowerCase();
  if (l === "bearish" || r === "high") return "watch";
  if (l === "bullish" || (l === "neutral" && r === "low")) {
    // Only long-section names may be recommended as stable family picks.
    if (section === BOARD_SECTIONS.LONG) return "recommended";
    return "watch";
  }
  return "watch";
}

module.exports = {
  BOARD_SECTIONS,
  LONG_TERM_MIN_TRACKED_DAYS,
  LONG_TERM_PENALTIES,
  NEWLY_TRACKED_LONG_RANK_CAP,
  trackedSinceIso,
  trackedDays,
  meetsLongTermHistoryGate,
  collectStabilitySignals,
  resolveBoardSection,
  buildRankingContext,
  applyLongTermStabilityPenalties,
  assessBoardPlacement,
  assessLongTermPlacement,
  sortBySectionRank,
  partitionBoardBySection,
  buildSectionPayload,
  statusFromBoardSection,
  clampRank,
};
