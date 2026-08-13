/**
 * Shared analysis shape for all AI providers.
 * Every provider must return this dual take + structured labels.
 */

const { makeTag, normalizeLabel, normalizeLabelList } = require("./indicatorTags");

const TAKE_FALLBACK = {
  lean: "neutral",
  risk: "medium",
  tags: [],
  summary: "Analysis wasn't available right now.",
  deepDive:
    "A longer AI deep dive wasn't available for this name yet. Check price, range, and news sources in the panel below when they load.",
};

const FALLBACK = {
  short: { ...TAKE_FALLBACK },
  long: { ...TAKE_FALLBACK },
  quip: null,
  shortTermRank: null,
  longTermRank: null,
};

const LABEL_SCHEMA_HINT = `{ "plain": string, "technical": string, "explanation": string }`;

const ANALYSIS_JSON_SHAPE = `{
  "short": {
    "lean": "bullish" | "neutral" | "bearish",
    "risk": "low" | "medium" | "high",
    "tags": [ ${LABEL_SCHEMA_HINT}, ${LABEL_SCHEMA_HINT} ],
    "summary": "one or two plain-English sentences for the short-term view",
    "deepDive": "3-5 plain-English sentences for short-term Deep Dive"
  },
  "long": {
    "lean": "bullish" | "neutral" | "bearish",
    "risk": "low" | "medium" | "high",
    "tags": [ ${LABEL_SCHEMA_HINT}, ${LABEL_SCHEMA_HINT} ],
    "summary": "one or two plain-English sentences for the long-term view",
    "deepDive": "3-5 plain-English sentences for long-term Deep Dive"
  },
  "quip": ${LABEL_SCHEMA_HINT},
  "shortTermRank": number,
  "longTermRank": number
}`;

/** Clamp a mode-specific conviction score to 0–100 (or null). */
function parseRank(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Fallback score when Gemini ranks are missing (older cached analyses).
 * Keeps board ordering usable until the next dual analysis refresh.
 */
function heuristicRank(take) {
  if (!take || typeof take !== "object") return 40;
  const lean = String(take.lean || "").toLowerCase();
  const risk = String(take.risk || "").toLowerCase();
  let score = lean === "bullish" ? 72 : lean === "bearish" ? 32 : 50;
  if (risk === "low") score += 8;
  if (risk === "high") score -= 10;
  return Math.max(0, Math.min(100, score));
}

/**
 * Explicit ranking rubric (shortTermRank / longTermRank) — keep in sync with the
 * prompt text below. Tunable weights are intentional and inspectable here.
 *
 * SHORT-TERM (near-term board ordering):
 *   40% trend / momentum (SMA20/50 slope, MACD histogram, recent price change)
 *   25% risk / volatility (RSI extremes, Bollinger width, declared risk)
 *   20% news agreement (agree boosts; disagree caps conviction; single = mild)
 *   15% data completeness (missing news/target/indicators → soft penalty)
 *   NOTE: Extreme single-day % moves, sub-$5 price, and non-major exchanges are
 *   NOT penalized here — short-term is meant to value momentum / hot movers.
 *
 * LONG-TERM (patient board ordering):
 *   35% stability / broader trend (SMA200 context, smoother lean)
 *   25% fundamentals / distance-to-analyst-target
 *   20% risk level (prefer lower structural risk)
 *   12% news agreement (same agree/disagree rules; lower weight than short)
 *   8%  data completeness
 *   HARD PENALTIES (deterministic, applied after model score):
 *     - extreme single-day move beyond ±15% → strong penalty (not merely unweighted)
 *     - sub-$5 (penny) pricing → strong penalty
 *     - non-major-exchange listing → strong penalty
 *   These same traits must NOT penalize shortTermRank.
 *
 * Scores are 0–100 integers. Modes MUST often diverge when evidence diverges.
 */
const RANKING_RUBRIC = {
  shortTerm: [
    { factor: "trend_momentum", weight: 40 },
    { factor: "risk_volatility", weight: 25 },
    { factor: "news_agreement", weight: 20 },
    { factor: "data_completeness", weight: 15 },
  ],
  longTerm: [
    { factor: "stability_broader_trend", weight: 35 },
    { factor: "fundamentals_target", weight: 25 },
    { factor: "risk_level", weight: 20 },
    { factor: "news_agreement", weight: 12 },
    { factor: "data_completeness", weight: 8 },
  ],
  longTermHardPenalties: [
    { factor: "extreme_single_day_move", note: "penalize; do not reward" },
    { factor: "penny_under_5", note: "penalize; do not reward" },
    { factor: "non_major_exchange", note: "penalize; do not reward" },
  ],
  shortTermDoesNotPenalize: [
    "extreme_single_day_move",
    "penny_under_5",
    "non_major_exchange",
  ],
};

function buildAnalysisPrompt(payload) {
  return `You are helping a family stock information board (NOT a trading platform). Analyze the stock data below for beginners.

You will produce BOTH a short-term take and a long-term take from the SAME shared price history (daily bars). Short-term uses recent indicators (≈20–50 day window: SMA20/50, RSI, MACD, Bollinger). Long-term uses broader trend (SMA200 and longer context).

Respond with ONLY valid JSON matching this exact shape — no markdown, no code fences, no extra text:
${ANALYSIS_JSON_SHAPE}

STRICT LABEL RULES (tags AND quip):
- Every tag and the quip MUST be an object with ALL three keys: plain, technical, explanation — never a bare string.
- "plain": beginner-friendly phrase shown by default (no stock jargon).
- "technical": the real market term (e.g. "Positive MACD signal", "RSI overbought").
- "explanation": one simple sentence connecting the plain phrase to the technical term.
- Inventing new phrasings is fine — the three-field shape makes them compliant automatically.

RANKING SCORES (shortTermRank / longTermRank) — REQUIRED, 0–100 integers:
Use this EXPLICIT rubric (weights are intentional — do not invent a different weighting):

shortTermRank weights:
- 40% trend/momentum — SMA20/50 direction, MACD histogram, recent price change. Hot near-term movers score high here even if long-term fundamentals are only average. A large single-day % move is a POSITIVE momentum signal for short-term (do not penalize it here).
- 25% risk/volatility — RSI extremes, Bollinger width, and the risk you assign. High near-term volatility should pull this score down unless momentum clearly compensates.
- 20% news agreement — when newsAgreement.status is "agree", add confidence; when "disagree", cap conviction (avoid very high ranks); when "single"/"none", apply only a mild news signal.
- 15% data completeness — missing news, target, or key indicators is a soft penalty (do not collapse the score to zero).
- Do NOT penalize sub-$5 price or non-major exchange on shortTermRank — short-term is allowed to surface hot/volatile discoveries.

longTermRank weights:
- 35% stability / broader trend — SMA200 context and whether the longer take looks steady rather than choppy.
- 25% fundamentals / distance-to-analyst-target — healthier target distance and steadier fundamental tone score higher.
- 20% risk level — prefer lower structural risk for long-term ranking.
- 12% news agreement — same agree/disagree rules as short-term, but lower weight.
- 8%  data completeness — soft penalty for gaps.
- HARD PENALTIES (must actively lower longTermRank — not merely leave unweighted):
  - Extreme recent single-day move beyond about ±15% → strong penalty (this is the opposite of short-term, where that move can help).
  - Sub-$5 / penny pricing → strong penalty.
  - Non-major-exchange listing → strong penalty.
- A brand-new hot mover with a huge one-day spike must NOT outrank a stable long-held name on longTermRank.

- These scores are mode-specific conviction used to ORDER the family board. They are NOT interchangeable.
- A stock SHOULD often rank differently between the two modes — do not copy one score onto the other unless the evidence truly supports it.
- Higher = stronger fit for that mode's lens. Use the full 0–100 range thoughtfully (avoid clustering everything at 50).

Other rules:
- "short" and "long" may differ when the data supports it; do not force them to match.
- Each "tags" array: 1–3 label objects.
- Each "summary": 1–2 beginner-friendly sentences, no jargon.
- Each "deepDive": 3–5 sentences covering price context, news tone, and peers when available; under ~120 words; no buy/sell advice.
- Do NOT apologize for or explain missing/unavailable data. The UI shows those gaps as small badges separately. Write only genuine analysis from the data that IS present.
- If newsPending is true, do not invent news sentiment — skip news and lean on price/indicators/target.
- newsAgreement is critical when Alpha Vantage and Marketaux both succeed:
  - status "agree": added confidence — say both news sources point the same way.
  - status "disagree": lean neutral/cautious; say mixed signals plainly — do NOT pick one source silently.
  - status "single" or "none": no agreement claim.
- "quip.plain" must be about this company/ticker specifically — light, max ~20 words, not financial advice.
- Do not give buy/sell advice or trading instructions.

Stock data:
${JSON.stringify(payload, null, 2)}`;
}

function parseTake(raw) {
  if (!raw || typeof raw !== "object") return null;
  const lean = String(raw.lean || "").toLowerCase();
  const risk = String(raw.risk || "").toLowerCase();
  if (!["bullish", "neutral", "bearish"].includes(lean)) return null;
  if (!["low", "medium", "high"].includes(risk)) return null;
  if (typeof raw.summary !== "string" || !raw.summary.trim()) return null;

  const tags = normalizeLabelList(raw.tags, 3);
  const deepDive =
    typeof raw.deepDive === "string" && raw.deepDive.trim()
      ? raw.deepDive.trim()
      : TAKE_FALLBACK.deepDive;

  return {
    lean,
    risk,
    tags,
    summary: raw.summary.trim(),
    deepDive,
  };
}

function parseQuip(raw) {
  if (raw == null) return null;
  if (typeof raw === "string" && raw.trim()) {
    return makeTag(
      raw.trim(),
      "Light aside",
      "A playful one-liner about this company — not part of the analysis."
    );
  }
  const label = normalizeLabel(raw);
  if (!label || !label.plain) return null;
  if (!label.technical) label.technical = "Company quip";
  if (!label.explanation) {
    label.explanation =
      "A playful one-liner about this company — not part of the analysis.";
  }
  return label;
}

function stripJsonFences(text) {
  if (!text) return null;
  let cleaned = String(text).trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
  }
  if (!cleaned.startsWith("{") && !cleaned.startsWith("[")) {
    const startObj = cleaned.indexOf("{");
    const startArr = cleaned.indexOf("[");
    let start = -1;
    if (startObj === -1) start = startArr;
    else if (startArr === -1) start = startObj;
    else start = Math.min(startObj, startArr);
    const endChar = cleaned[start] === "[" ? "]" : "}";
    const end = cleaned.lastIndexOf(endChar);
    if (start === -1 || end === -1 || end <= start) return null;
    cleaned = cleaned.slice(start, end + 1);
  }
  return cleaned;
}

function parseAnalysisJson(text) {
  const cleaned = stripJsonFences(text);
  if (!cleaned) return null;

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }

  if (parsed.short || parsed.long) {
    const short = parseTake(parsed.short) || { ...TAKE_FALLBACK };
    const long = parseTake(parsed.long) || { ...TAKE_FALLBACK };
    return {
      short,
      long,
      quip: parseQuip(parsed.quip),
      shortTermRank: parseRank(parsed.shortTermRank) ?? heuristicRank(short),
      longTermRank: parseRank(parsed.longTermRank) ?? heuristicRank(long),
    };
  }

  const take = parseTake(parsed);
  if (!take) return null;
  const rank =
    parseRank(parsed.shortTermRank) ??
    parseRank(parsed.longTermRank) ??
    heuristicRank(take);
  return {
    short: take,
    long: take,
    quip: parseQuip(parsed.quip),
    shortTermRank: parseRank(parsed.shortTermRank) ?? rank,
    longTermRank: parseRank(parsed.longTermRank) ?? rank,
  };
}

function mentionsMixedNews(take) {
  const tagText = (take?.tags || [])
    .map((t) =>
      typeof t === "string"
        ? t
        : `${t.plain || ""} ${t.technical || ""} ${t.explanation || ""}`
    )
    .join(" ");
  const text = `${take?.summary || ""} ${tagText} ${take?.deepDive || ""}`.toLowerCase();
  return (
    text.includes("mixed") ||
    text.includes("disagree") ||
    text.includes("conflict") ||
    text.includes("don't agree") ||
    text.includes("do not agree") ||
    text.includes("split") ||
    text.includes("don't line up") ||
    text.includes("do not line up")
  );
}

function applyNewsAgreementGuard(parsed, newsAgreement) {
  if (!parsed || newsAgreement?.status !== "disagree") return parsed;
  for (const mode of ["short", "long"]) {
    const take = parsed[mode];
    if (!take) continue;
    if (
      (take.lean === "bullish" || take.lean === "bearish") &&
      !mentionsMixedNews(take)
    ) {
      take.lean = "neutral";
    }
  }
  return parsed;
}

function parseJsonLoose(text) {
  const cleaned = stripJsonFences(text);
  if (!cleaned) return null;
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

module.exports = {
  TAKE_FALLBACK,
  FALLBACK,
  LABEL_SCHEMA_HINT,
  ANALYSIS_JSON_SHAPE,
  buildAnalysisPrompt,
  parseTake,
  parseQuip,
  parseRank,
  heuristicRank,
  parseAnalysisJson,
  applyNewsAgreementGuard,
  parseJsonLoose,
  stripJsonFences,
  RANKING_RUBRIC,
};
