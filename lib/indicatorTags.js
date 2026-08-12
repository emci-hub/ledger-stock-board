/**
 * Central builder for fixed (non-Gemini) indicator / board labels.
 * Every tag is { plain, technical, explanation }.
 * Add a new indicator here once — callers use buildTag / helpers only.
 */

function makeTag(plain, technical, explanation) {
  return {
    plain: String(plain || "").trim(),
    technical: String(technical || "").trim(),
    explanation: String(explanation || "").trim(),
  };
}

/** Catalog of fixed labels — single source of truth. */
const CATALOG = {
  macd_bullish: () =>
    makeTag(
      "Gaining speed",
      "Positive MACD signal",
      "Short-term momentum looks like it's picking up — the faster average is pulling ahead of the slower one."
    ),
  macd_bearish: () =>
    makeTag(
      "Losing speed",
      "Negative MACD signal",
      "Short-term momentum looks like it's fading — the faster average is slipping under the slower one."
    ),
  rsi_high: () =>
    makeTag(
      "Running hot",
      "High RSI (overbought)",
      "Recent buying has been strong — a 0–100 meter above ~70 can mean the move is stretched upward."
    ),
  rsi_low: () =>
    makeTag(
      "Running cold",
      "Low RSI (oversold)",
      "Recent selling has been heavy — a 0–100 meter below ~30 can mean the move is stretched downward."
    ),
  rsi_mid: () =>
    makeTag(
      "Heating up or cooling off",
      "RSI (Relative Strength Index)",
      "A 0–100 meter of how hard a stock has been pushed lately — mid-range means not obviously stretched."
    ),
  bollinger_high: () =>
    makeTag(
      "Near the top of its usual stretch",
      "Upper Bollinger Band",
      "Price is close to the soft upper edge of its recent range — a stretch, not a rule."
    ),
  bollinger_low: () =>
    makeTag(
      "Near the bottom of its usual stretch",
      "Lower Bollinger Band",
      "Price is close to the soft lower edge of its recent range — a stretch, not a rule."
    ),
  above_sma50: () =>
    makeTag(
      "Above its two-month average",
      "Price vs 50-day moving average",
      "The latest price sits above the typical level of the last ~two months of trading."
    ),
  below_sma50: () =>
    makeTag(
      "Below its two-month average",
      "Price vs 50-day moving average",
      "The latest price sits below the typical level of the last ~two months of trading."
    ),
  above_sma200: () =>
    makeTag(
      "Above its year-long average",
      "Price vs 200-day moving average",
      "The latest price sits above the typical level over roughly a year of trading."
    ),
  below_sma200: () =>
    makeTag(
      "Below its year-long average",
      "Price vs 200-day moving average",
      "The latest price sits below the typical level over roughly a year of trading."
    ),
  risk_low: () =>
    makeTag(
      "Steadier ride",
      "Low risk",
      "Our simple read suggests fewer sharp swings than average for this board — not a guarantee."
    ),
  risk_medium: () =>
    makeTag(
      "Some bumps",
      "Medium risk",
      "Our simple read suggests a normal mix of ups and downs — neither the calmest nor the wildest."
    ),
  risk_high: () =>
    makeTag(
      "Bumpier ride",
      "High volatility",
      "Our simple read suggests bigger price swings are more likely — interesting, but not for the faint of heart."
    ),
  analyst_target: () =>
    makeTag(
      "What analysts aim for",
      "Analyst target",
      "An average of published research guesses for where the price might be in about a year — an estimate, not a promise."
    ),
  week52_range: () =>
    makeTag(
      "This year's high & low",
      "52-week range",
      "The highest and lowest prices over the past year of trading."
    ),
  week52_near_high: () =>
    makeTag(
      "Near this year's high",
      "Near 52-week high",
      "The latest price is close to the highest level of the past year."
    ),
  week52_near_low: () =>
    makeTag(
      "Near this year's low",
      "Near 52-week low",
      "The latest price is close to the lowest level of the past year."
    ),
  peers: () =>
    makeTag(
      "Similar companies",
      "Peers",
      "Other companies in a related business, used for a quick side-by-side feel — not identical twins."
    ),
  news_agree: () =>
    makeTag(
      "News agrees",
      "Multi-source news agreement",
      "Two news sentiment feeds pointed the same direction, which adds a bit of confidence to the tone."
    ),
  news_disagree: () =>
    makeTag(
      "Mixed news",
      "Multi-source news disagreement",
      "Two news sentiment feeds disagreed, so the read stays cautious instead of picking one side."
    ),
  complete: () =>
    makeTag(
      "Complete",
      "Fully analyzed",
      "All the usual data checks for this card passed — nothing flagged as missing."
    ),
};

/**
 * Build one fixed tag by catalog id.
 * @param {string} id
 * @returns {{ plain: string, technical: string, explanation: string } | null}
 */
function buildTag(id) {
  const factory = CATALOG[id];
  if (!factory) return null;
  return factory();
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function flattenIndicators(block) {
  if (!block) return {};
  if (block.sma) {
    return {
      sma20: block.sma?.sma20 ?? null,
      sma50: block.sma?.sma50 ?? null,
      sma200: block.sma?.sma200 ?? null,
      rsi: block.rsi ?? null,
      macd: block.macd || null,
      bollinger: block.bollinger || null,
    };
  }
  return {
    sma20: block.sma20 ?? null,
    sma50: block.sma50 ?? null,
    sma200: block.sma200 ?? null,
    rsi: block.rsi ?? null,
    macd: block.macd || null,
    bollinger: block.bollinger || null,
  };
}

/**
 * Risk level → structured label (low | medium | high).
 */
function riskTag(level) {
  const key =
    level === "low"
      ? "risk_low"
      : level === "high"
        ? "risk_high"
        : "risk_medium";
  return buildTag(key);
}

/**
 * Derive indicator tags from live indicator values + optional last price.
 * All code that wants RSI/MACD/Bollinger/MA badges should call this (or buildTag).
 */
function buildIndicatorTags(indicators, { price = null, mode = "long" } = {}) {
  const ind = flattenIndicators(indicators);
  const tags = [];
  const px = num(price);

  const rsi = num(ind.rsi);
  if (rsi != null) {
    if (rsi >= 70) tags.push(buildTag("rsi_high"));
    else if (rsi <= 30) tags.push(buildTag("rsi_low"));
  }

  const macd = ind.macd || {};
  const hist = num(macd.histogram);
  const macdLine = num(macd.macd);
  const signal = num(macd.signal);
  if (hist != null) {
    tags.push(buildTag(hist >= 0 ? "macd_bullish" : "macd_bearish"));
  } else if (macdLine != null && signal != null) {
    tags.push(buildTag(macdLine >= signal ? "macd_bullish" : "macd_bearish"));
  }

  const upper = num(ind.bollinger?.upper);
  const lower = num(ind.bollinger?.lower);
  if (px != null && upper != null && lower != null && upper > lower) {
    const span = upper - lower;
    if (px >= upper - span * 0.05) tags.push(buildTag("bollinger_high"));
    else if (px <= lower + span * 0.05) tags.push(buildTag("bollinger_low"));
  }

  const sma50 = num(ind.sma50);
  if (px != null && sma50 != null) {
    tags.push(buildTag(px >= sma50 ? "above_sma50" : "below_sma50"));
  }

  if (mode === "long") {
    const sma200 = num(ind.sma200);
    if (px != null && sma200 != null) {
      tags.push(buildTag(px >= sma200 ? "above_sma200" : "below_sma200"));
    }
  }

  return tags.filter(Boolean);
}

/**
 * Normalize any tag-like value into { plain, technical, explanation }.
 * Accepts structured objects, legacy bare strings, or catalog ids.
 */
function normalizeLabel(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const fromCatalog = buildTag(trimmed);
    if (fromCatalog) return fromCatalog;
    return makeTag(trimmed, trimmed, "");
  }
  if (typeof value === "object") {
    const plain =
      value.plain ?? value.plainLabel ?? value.label ?? value.text ?? "";
    const technical =
      value.technical ?? value.technicalTerm ?? value.term ?? plain;
    const explanation = value.explanation ?? value.explain ?? "";
    if (!String(plain).trim() && !String(technical).trim()) return null;
    return makeTag(plain || technical, technical || plain, explanation);
  }
  return null;
}

function normalizeLabelList(list, limit = 6) {
  if (!Array.isArray(list)) return [];
  return list
    .map(normalizeLabel)
    .filter(Boolean)
    .slice(0, limit);
}

module.exports = {
  makeTag,
  buildTag,
  riskTag,
  buildIndicatorTags,
  normalizeLabel,
  normalizeLabelList,
  CATALOG_IDS: Object.keys(CATALOG),
};
