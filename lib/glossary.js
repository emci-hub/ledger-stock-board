/**
 * Shared plain-English glossary for sitewide jargon.
 * Add a term here → UI shows the plain label by default everywhere,
 * with tap-to-reveal for the technical name + explanation.
 */

const GLOSSARY = {
  macd: {
    id: "macd",
    plainLabel: "Gaining or losing speed",
    technicalTerm: "MACD",
    explanation:
      "A short-term momentum gauge that compares two moving averages to show whether price moves are speeding up or slowing down.",
    aliases: ["macd", "macd signal", "positive macd", "negative macd", "macd crossover"],
  },
  macd_bullish: {
    id: "macd_bullish",
    plainLabel: "Gaining speed",
    technicalTerm: "Positive MACD signal",
    explanation:
      "Short-term momentum looks like it's picking up — the faster average is pulling ahead of the slower one.",
    aliases: ["positive macd", "bullish macd", "macd bullish"],
  },
  macd_bearish: {
    id: "macd_bearish",
    plainLabel: "Losing speed",
    technicalTerm: "Negative MACD signal",
    explanation:
      "Short-term momentum looks like it's fading — the faster average is slipping under the slower one.",
    aliases: ["negative macd", "bearish macd", "macd bearish"],
  },
  rsi: {
    id: "rsi",
    plainLabel: "Heating up or cooling off",
    technicalTerm: "RSI (Relative Strength Index)",
    explanation:
      "A 0–100 meter of how hard a stock has been pushed lately — high can mean stretched upward, low can mean stretched downward.",
    aliases: ["rsi", "relative strength", "relative strength index", "overbought", "oversold"],
  },
  moving_average: {
    id: "moving_average",
    plainLabel: "Smoothing out the bumps",
    technicalTerm: "Moving average",
    explanation:
      "An average of recent prices that smooths day-to-day noise so the broader path is easier to see.",
    aliases: ["moving average", "moving averages", "sma", "simple moving average"],
  },
  sma20: {
    id: "sma20",
    plainLabel: "About a month's average price",
    technicalTerm: "20-day moving average",
    explanation:
      "The typical price over roughly the last month of trading days.",
    aliases: ["sma20", "20-day", "20 day ma", "20-day moving average"],
  },
  sma50: {
    id: "sma50",
    plainLabel: "About two months' average price",
    technicalTerm: "50-day moving average",
    explanation:
      "The typical price over roughly the last two months of trading days.",
    aliases: ["sma50", "50-day", "50 day ma", "50-day moving average"],
  },
  sma200: {
    id: "sma200",
    plainLabel: "About a year's average price",
    technicalTerm: "200-day moving average",
    explanation:
      "The typical price over roughly a year of trading days — a common long-term trend line.",
    aliases: ["sma200", "200-day", "200 day ma", "200-day moving average", "200-day average"],
  },
  bollinger: {
    id: "bollinger",
    plainLabel: "Usual price stretch zone",
    technicalTerm: "Bollinger Bands",
    explanation:
      "A soft upper and lower range around recent prices — touching the edges can mean a stretch, not a rule.",
    aliases: ["bollinger", "bollinger bands", "bollinger band"],
  },
  momentum: {
    id: "momentum",
    plainLabel: "How fast it's moving",
    technicalTerm: "Momentum",
    explanation:
      "Whether recent price moves are speeding up, slowing down, or holding steady.",
    aliases: ["momentum", "price momentum"],
  },
  analyst_target: {
    id: "analyst_target",
    plainLabel: "What analysts aim for",
    technicalTerm: "Analyst target",
    explanation:
      "An average of published research guesses for where the price might be in about a year — an estimate, not a promise.",
    aliases: ["analyst target", "price target", "12mo target", "12-month target"],
  },
  week52_range: {
    id: "week52_range",
    plainLabel: "This year's high & low",
    technicalTerm: "52-week range",
    explanation:
      "The highest and lowest prices over the past year of trading.",
    aliases: ["52-week", "52 week", "52-week range", "fifty-two week"],
  },
  peers: {
    id: "peers",
    plainLabel: "Similar companies",
    technicalTerm: "Peers",
    explanation:
      "Other companies in a related business, used for a quick side-by-side feel — not identical twins.",
    aliases: ["peers", "peer list", "peer companies", "comparables"],
  },
  risk_low: {
    id: "risk_low",
    plainLabel: "Steadier ride",
    technicalTerm: "Low risk",
    explanation:
      "Our simple read suggests fewer sharp swings than average for this board — not a guarantee.",
    aliases: ["low risk", "lower risk"],
  },
  risk_medium: {
    id: "risk_medium",
    plainLabel: "Some bumps",
    technicalTerm: "Medium risk",
    explanation:
      "Our simple read suggests a normal mix of ups and downs — neither the calmest nor the wildest.",
    aliases: ["medium risk", "moderate risk"],
  },
  risk_high: {
    id: "risk_high",
    plainLabel: "Bumpier ride",
    technicalTerm: "High volatility",
    explanation:
      "Our simple read suggests bigger price swings are more likely — interesting, but not for the faint of heart.",
    aliases: ["high risk", "high volatility", "volatile"],
  },
  lean_bullish: {
    id: "lean_bullish",
    plainLabel: "Leaning upbeat",
    technicalTerm: "Bullish lean",
    explanation:
      "The overall read tilts toward strength or optimism — not a buy button.",
    aliases: ["bullish", "bullish lean"],
  },
  lean_neutral: {
    id: "lean_neutral",
    plainLabel: "Leaning mixed",
    technicalTerm: "Neutral lean",
    explanation:
      "The overall read doesn't strongly favor up or down right now.",
    aliases: ["neutral", "neutral lean"],
  },
  lean_bearish: {
    id: "lean_bearish",
    plainLabel: "Leaning cautious",
    technicalTerm: "Bearish lean",
    explanation:
      "The overall read tilts toward weakness or caution — not a sell button.",
    aliases: ["bearish", "bearish lean"],
  },
  news_agree: {
    id: "news_agree",
    plainLabel: "News agrees",
    technicalTerm: "Multi-source news agreement",
    explanation:
      "Two news sentiment feeds pointed the same direction, which adds a bit of confidence to the tone.",
    aliases: ["news agrees", "sources agree", "both sources"],
  },
  news_disagree: {
    id: "news_disagree",
    plainLabel: "Mixed news",
    technicalTerm: "Multi-source news disagreement",
    explanation:
      "Two news sentiment feeds disagreed, so the read stays cautious instead of picking one side.",
    aliases: ["mixed news", "mixed signals", "sources disagree"],
  },
};

function glossaryList() {
  return Object.values(GLOSSARY).map((e) => ({
    id: e.id,
    plainLabel: e.plainLabel,
    technicalTerm: e.technicalTerm,
    explanation: e.explanation,
    aliases: Array.isArray(e.aliases) ? e.aliases : [],
  }));
}

function getGlossaryEntry(id) {
  return GLOSSARY[id] || null;
}

/**
 * Match free text (e.g. an AI tag) to a glossary entry via id, technical term, or aliases.
 */
function matchGlossary(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  if (GLOSSARY[raw]) return GLOSSARY[raw];

  const t = raw.toLowerCase();
  if (GLOSSARY[t]) return GLOSSARY[t];

  let best = null;
  let bestLen = 0;
  for (const entry of Object.values(GLOSSARY)) {
    const candidates = [
      entry.id,
      entry.technicalTerm,
      entry.plainLabel,
      ...(entry.aliases || []),
    ]
      .filter(Boolean)
      .map((s) => String(s).toLowerCase());

    for (const c of candidates) {
      if (t === c || t.includes(c) || c.includes(t)) {
        if (c.length > bestLen) {
          best = entry;
          bestLen = c.length;
        }
      }
    }
  }
  return best;
}

module.exports = {
  GLOSSARY,
  glossaryList,
  getGlossaryEntry,
  matchGlossary,
};
