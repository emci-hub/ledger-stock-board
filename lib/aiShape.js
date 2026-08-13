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
- These are mode-specific conviction scores used to ORDER the family board. They are NOT interchangeable.
- shortTermRank: weigh momentum, recent trend, and near-term volatility MORE heavily. A hot short-term mover can score high here even if long-term fundamentals are only average.
- longTermRank: weigh stability, fundamentals, and distance-to-analyst-target MORE heavily. A steady compounder can score high here even if short-term momentum is soft.
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
};
