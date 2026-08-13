/**
 * Long-term ranking stability gates + deterministic penalties.
 * Complements Gemini RANKING_RUBRIC — factual signals that must not rely on the model alone.
 */

const {
  EXTREME_MOVE_PCT,
  PENNY_PRICE_THRESHOLD,
  isExtremeMove,
  isPennyPrice,
  isMajorExchange,
} = require("./boardTickers");
const { warningLabelsFromFlags, parseFlags } = require("./boardPicks");

/** Days a stock must be live/active before it can enter long-term spotlight. */
const LONG_TERM_MIN_TRACKED_DAYS = Math.max(
  1,
  Number.parseInt(process.env.LONG_TERM_MIN_TRACKED_DAYS || "7", 10) || 7
);

/** Deterministic longTermRank penalty amounts (applied after Gemini/heuristic score). */
const LONG_TERM_PENALTIES = {
  extremeMove: 30,
  penny: 25,
  nonMajorExchange: 20,
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

function meetsLongTermHistoryGate(pick, nowMs = Date.now()) {
  return trackedDays(pick, nowMs) >= LONG_TERM_MIN_TRACKED_DAYS;
}

/**
 * Collect factual stability signals from pick + report.
 */
function collectStabilitySignals(pick = {}, report = {}) {
  const flags = parseFlags(pick.flags_json || pick.flags || {});
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
  const exchange = report.exchange || pick.exchange || null;

  const penny = Boolean(flags.penny) || isPennyPrice(price);
  const extremeMove =
    Boolean(flags.extremeMove) || isExtremeMove(percentChange);
  const nonMajorExchange =
    Boolean(flags.nonMajorExchange) ||
    (exchange ? !isMajorExchange(exchange) : false);

  return {
    price,
    percentChange,
    exchange,
    penny,
    extremeMove,
    nonMajorExchange,
    flags: { ...flags, penny, extremeMove, nonMajorExchange },
  };
}

/**
 * Apply long-term-only penalties. Short-term ranks must NOT use this.
 */
function applyLongTermStabilityPenalties(baseRank, signals = {}) {
  let rank = clampRank(baseRank);
  const applied = [];
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
  return {
    baseRank: clampRank(baseRank),
    rank: clampRank(rank),
    penalties: applied,
  };
}

/**
 * Full long-term eligibility assessment for board layout.
 */
function assessLongTermPlacement(pick, report) {
  const signals = collectStabilitySignals(pick, report);
  const days = trackedDays(pick);
  const historyOk = meetsLongTermHistoryGate(pick);
  const rawLong =
    report?.longTermRank != null
      ? Number(report.longTermRank)
      : report?.rankScore != null
        ? Number(report.rankScore)
        : 40;
  const adjusted = applyLongTermStabilityPenalties(rawLong, signals);
  const unstable =
    signals.extremeMove || signals.penny || signals.nonMajorExchange;
  // Fail gate → Momentum (not long-term spotlight). History OR instability.
  const longTermEligible = historyOk && !unstable;
  const warnings = warningLabelsFromFlags(signals.flags, {
    price: signals.price,
    percent_change: signals.percentChange,
    exchange: signals.exchange,
  });

  return {
    longTermEligible,
    momentumSection: !longTermEligible,
    historyOk,
    trackedSince: trackedSinceIso(pick),
    trackedDays: Math.round(days * 10) / 10,
    minTrackedDays: LONG_TERM_MIN_TRACKED_DAYS,
    unstable,
    signals,
    warnings,
    longTermRankRaw: adjusted.baseRank,
    longTermRankAdjusted: adjusted.rank,
    penalties: adjusted.penalties,
  };
}

module.exports = {
  LONG_TERM_MIN_TRACKED_DAYS,
  LONG_TERM_PENALTIES,
  trackedSinceIso,
  trackedDays,
  meetsLongTermHistoryGate,
  collectStabilitySignals,
  applyLongTermStabilityPenalties,
  assessLongTermPlacement,
  clampRank,
};
