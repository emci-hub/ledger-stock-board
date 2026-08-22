/**
 * The six-gate ignore/watch/add/avoid resolver for the long-term screen,
 * per stock-alert-spec.md. Pure function — all inputs are pre-computed by
 * the caller (services/newsEvents.js for the event, lib/dropMath.js for the
 * drop math, fundamentals fetchers for cap/cash/debt/growth). This is a
 * distinct concern from lib/rankingStability.js's resolveBoardSection()
 * (which board a ticker sits on) — this decides what to do with a ticker
 * already placed on the Long board, and is not merged into that function
 * per CLAUDE.md rule 4.
 *
 * Gate 5 ("the fear is temporary") is fully deterministic — a keyword scan
 * for fraud/restatement/liquidity/going-concern language — no AI call.
 */

const CAP_MISMATCH_THRESHOLD_PCT = 30;
const LONG_TERM_CAP_GATE_USD = 100e9;
const EARNINGS_CUT_MATERIAL_PCT = -10;
const STOPPED_WORSENING_SESSIONS = 5;
const STOPPED_WORSENING_CLOSES_ABOVE_SMA20 = 2;

// Structural-break language — any match forces "avoid" regardless of the
// other gates, per spec: "Not fraud, restatement, liquidity, collapsing
// core demand, or a write-off of the engine."
const STRUCTURAL_BREAK_PATTERNS = [
  { label: "fraud", pattern: /\bfraud\w*/i },
  { label: "restatement", pattern: /\brestat\w*/i },
  { label: "going concern", pattern: /\bgoing[- ]concern\b/i },
  { label: "liquidity crisis", pattern: /\bliquidity\s+(crisis|crunch|concern\w*)\b/i },
  { label: "SEC investigation", pattern: /\bSEC\s+(investigat\w*|subpoena\w*|probe\w*)\b/i },
  { label: "bankruptcy", pattern: /\bbankrupt\w*|\bchapter\s+11\b/i },
  { label: "delisting", pattern: /\bdelist\w*/i },
  { label: "accounting irregularities", pattern: /\baccounting\s+irregularit\w*/i },
  { label: "material weakness", pattern: /\bmaterial\s+weakness\w*/i },
  { label: "auditor resignation", pattern: /\bauditor\s+resign\w*/i },
  { label: "embezzlement", pattern: /\bembezzl\w*/i },
  { label: "short-seller report", pattern: /\bshort[- ]sell\w*\s+(report|allegation\w*)\b/i },
  { label: "write-off", pattern: /\bwrite[- ]?off\b/i },
];

function scanForStructuralBreak(eventText) {
  const text = String(eventText || "");
  for (const { label, pattern } of STRUCTURAL_BREAK_PATTERNS) {
    if (pattern.test(text)) return label;
  }
  return null;
}

function pctDiff(a, b) {
  if (a == null || b == null || a === 0) return null;
  return (Math.abs(a - b) / Math.abs(a)) * 100;
}

/**
 * @param {object} candidate
 * @param {number|null} candidate.marketCapUsd - PRIMARY-listing market cap (USD)
 * @param {number|null} candidate.marketCapUsdAlt - cross-check cap from a second source
 * @param {boolean|null} candidate.profitable
 * @param {number|null} candidate.revenueGrowthPct - YoY %
 * @param {number|null} candidate.earningsEstimateCutPct - negative = downward revision magnitude
 * @param {number|null} candidate.operatingCashFlow - latest reported OCF (USD)
 * @param {'improving'|'flat'|'declining'|null} candidate.freeCashFlowTrend
 * @param {boolean|null} candidate.dilutionFlag - recent emergency-dilution signal
 * @param {{headline: string, url: string, date: string, source: string|null, sourceType: string}|null} candidate.event
 * @param {object|null} candidate.dropSignals - output of lib/dropMath.js computeDropSignals()
 * @param {string} candidate.eventText - headline (+ summary if available), scanned for gate 5
 * @param {number|null} candidate.sessionsSinceNewLow - consecutive recent sessions with no new 20-day low
 * @param {number|null} candidate.closesAboveSma20Count - consecutive recent closes above the 20-day MA
 */
function resolveLongTermVerdict(candidate = {}) {
  const {
    marketCapUsd = null,
    marketCapUsdAlt = null,
    profitable = null,
    revenueGrowthPct = null,
    earningsEstimateCutPct = null,
    operatingCashFlow = null,
    freeCashFlowTrend = null,
    dilutionFlag = null,
    event = null,
    dropSignals = null,
    eventText = "",
    sessionsSinceNewLow = null,
    closesAboveSma20Count = null,
  } = candidate;

  const reasons = [];
  const gates = {
    sizeQuality: false,
    cashReal: false,
    event: false,
    drop: false,
    fearTemporary: false,
    stoppedWorsening: false,
  };

  // Cap cross-check — spec: "If two sources disagree on cap or P/E by more
  // than 30%, stop. Say you cannot screen it." This overrides everything else.
  const capMismatchPct = pctDiff(marketCapUsd, marketCapUsdAlt);
  if (capMismatchPct != null && capMismatchPct > CAP_MISMATCH_THRESHOLD_PCT) {
    return {
      verdict: "can't screen",
      gates,
      killSwitch: null,
      capMismatchPct,
      reasons: [
        `Market cap sources disagree by ${capMismatchPct.toFixed(1)}% (>${CAP_MISMATCH_THRESHOLD_PCT}%) — cannot screen.`,
      ],
    };
  }

  // Gate 3: dated event. No headline, no flag.
  gates.event = Boolean(event && event.headline && event.date);
  if (!gates.event) {
    reasons.push("No qualifying dated event in the last 90 days.");
    return { verdict: "ignore", gates, killSwitch: null, capMismatchPct, reasons };
  }
  reasons.push(`Event: "${event.headline}" (${event.date}, ${event.sourceType}).`);

  // Gate 4: the drop is measured, not felt.
  if (dropSignals && !dropSignals.dropFlag && !dropSignals.decidable) {
    reasons.push(
      "Event is too recent to complete the T+5 drop window — not yet decidable."
    );
    return { verdict: "watch", gates, killSwitch: null, capMismatchPct, reasons };
  }
  gates.drop = Boolean(dropSignals && dropSignals.dropFlag);
  if (!gates.drop) {
    reasons.push("Drop does not cross the 63-day-high or T-1→T+5 threshold.");
    return { verdict: "ignore", gates, killSwitch: null, capMismatchPct, reasons };
  }
  if (dropSignals.high63) {
    reasons.push(
      `${dropSignals.high63.pctBelowHigh?.toFixed(1)}% off the 63-day high.`
    );
  }
  if (dropSignals.eventWindow) {
    reasons.push(
      `${dropSignals.eventWindow.pctChange?.toFixed(1)}% T-1→worst-T+5 close.`
    );
  }

  // Gate 5: the fear is temporary — deterministic keyword scan, no AI.
  const killSwitch = scanForStructuralBreak(eventText || event.headline);
  gates.fearTemporary = killSwitch === null;
  if (!gates.fearTemporary) {
    reasons.push(`Structural-break language detected: "${killSwitch}".`);
    return { verdict: "avoid", gates, killSwitch, capMismatchPct, reasons };
  }

  // Gate 1: already big and earning.
  if (marketCapUsd == null || profitable == null) {
    reasons.push("Missing market cap or profitability data — cannot screen.");
    return { verdict: "can't screen", gates, killSwitch: null, capMismatchPct, reasons };
  }
  const materialEstimateCut =
    earningsEstimateCutPct != null && earningsEstimateCutPct <= EARNINGS_CUT_MATERIAL_PCT;
  gates.sizeQuality =
    marketCapUsd > LONG_TERM_CAP_GATE_USD &&
    profitable === true &&
    revenueGrowthPct != null &&
    revenueGrowthPct > 0 &&
    !materialEstimateCut;
  if (!gates.sizeQuality) {
    reasons.push("Does not meet the $100B / profitable / growing-revenue quality bar.");
    return { verdict: "ignore", gates, killSwitch: null, capMismatchPct, reasons };
  }

  // Gate 2: cash is real.
  if (operatingCashFlow == null) {
    reasons.push("Missing operating cash flow data — cannot screen.");
    return { verdict: "can't screen", gates, killSwitch: null, capMismatchPct, reasons };
  }
  gates.cashReal =
    operatingCashFlow > 0 &&
    freeCashFlowTrend !== "declining" &&
    dilutionFlag !== true;
  if (!gates.cashReal) {
    reasons.push("Cash flow / dilution signals fail the funding-without-distress check.");
    return { verdict: "avoid", gates, killSwitch: null, capMismatchPct, reasons };
  }

  // Gate 6: stopped getting worse.
  gates.stoppedWorsening =
    (sessionsSinceNewLow != null && sessionsSinceNewLow >= STOPPED_WORSENING_SESSIONS) ||
    (closesAboveSma20Count != null &&
      closesAboveSma20Count >= STOPPED_WORSENING_CLOSES_ABOVE_SMA20);
  if (!gates.stoppedWorsening) {
    reasons.push("Still making lower lows — has not stopped getting worse.");
    return { verdict: "watch", gates, killSwitch: null, capMismatchPct, reasons };
  }

  reasons.push("All six gates pass.");
  return { verdict: "add", gates, killSwitch: null, capMismatchPct, reasons };
}

module.exports = {
  CAP_MISMATCH_THRESHOLD_PCT,
  LONG_TERM_CAP_GATE_USD,
  EARNINGS_CUT_MATERIAL_PCT,
  STOPPED_WORSENING_SESSIONS,
  STOPPED_WORSENING_CLOSES_ABOVE_SMA20,
  STRUCTURAL_BREAK_PATTERNS,
  scanForStructuralBreak,
  resolveLongTermVerdict,
};
