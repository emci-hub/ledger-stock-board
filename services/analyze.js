require("dotenv").config();

const axios = require("axios");
const { incrementUsage, PROVIDERS } = require("./usage");
const { getFallbackJoke } = require("./jokes");
const { computeNewsAgreement } = require("../lib/newsAgreement");

const FALLBACK_MODEL = "gemini-flash-latest";

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
};

function getGeminiKey() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set in .env");
  return key;
}

function getPrimaryGeminiModel() {
  return process.env.GEMINI_MODEL || "gemini-2.5-flash";
}

function geminiUrl(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

/** True only for missing/deprecated model errors — not rate limits or billing. */
function isModelUnavailableError(err) {
  const status = err.response?.status;
  const apiErr = err.response?.data?.error || {};
  const message = String(apiErr.message || err.message || "").toLowerCase();
  const statusText = String(apiErr.status || "").toUpperCase();

  if (status === 429 || statusText === "RESOURCE_EXHAUSTED") return false;
  if (/rate.?limit|quota|resource.?exhausted|prepayment|billing|credit/.test(message)) {
    return false;
  }

  if (status === 404 || statusText === "NOT_FOUND") return true;

  return (
    /not found|no longer available|deprecated|not supported|invalid model|unknown model|is not available/.test(
      message
    )
  );
}

function pickIndicators(quoteData) {
  const ind = quoteData?.indicators;
  if (ind?.short && ind?.long) {
    return { short: ind.short, long: ind.long };
  }
  const flat = {
    sma20: ind?.sma?.sma20 ?? null,
    sma50: ind?.sma?.sma50 ?? null,
    sma200: ind?.sma?.sma200 ?? null,
    rsi: ind?.rsi ?? null,
    macd: ind?.macd || null,
    bollinger: ind?.bollinger || null,
  };
  return { short: flat, long: flat };
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

function buildPayload(ticker, quoteData, fundamentalsData, peersData) {
  const price = quoteData?.price || {};
  const windows = pickIndicators(quoteData);
  const overview = fundamentalsData?.overview || {};
  const news = Array.isArray(fundamentalsData?.news)
    ? fundamentalsData.news
    : [];
  const newsFinnhub = fundamentalsData?.newsFinnhub || null;
  const newsMarketaux = fundamentalsData?.newsMarketaux || null;
  const newsSources = Array.isArray(fundamentalsData?.newsSources)
    ? fundamentalsData.newsSources
    : [];
  const hasAlpha = newsSources.includes("alpha_vantage") || news.length > 0;
  const hasFinnhub = newsSources.includes("finnhub") || Boolean(newsFinnhub);
  const hasMarketaux =
    newsSources.includes("marketaux") || Boolean(newsMarketaux);
  const newsPending = Boolean(
    fundamentalsData?.newsPending ||
      (!hasAlpha && !hasFinnhub && !hasMarketaux)
  );

  const newsAlphaVantage = hasAlpha
    ? news.map((article) => ({
        title: article.title || null,
        sentimentScore: article.sentimentScore ?? null,
        sentimentLabel: article.sentimentLabel || null,
      }))
    : null;

  const newsAgreement = computeNewsAgreement(fundamentalsData);

  const peers = Array.isArray(peersData)
    ? peersData.map((peer) => {
        if (peer && typeof peer === "object") {
          return {
            ticker: peer.ticker || peer.symbol || null,
            price: peer.price ?? peer.current ?? null,
            changePercent: peer.changePercent ?? null,
            peRatio: peer.peRatio ?? null,
            sector: peer.sector || null,
          };
        }
        return { ticker: String(peer).toUpperCase() };
      })
    : [];

  return {
    ticker: String(ticker).toUpperCase(),
    price: {
      current: price.current ?? null,
      change: price.change ?? null,
      changePercent: price.changePercent ?? null,
      latestTradingDay: price.latestTradingDay || null,
    },
    indicatorsShort: flattenIndicators(windows.short),
    indicatorsLong: flattenIndicators(windows.long),
    analystTargetPrice: overview.analystTargetPrice ?? null,
    week52High: overview.week52High ?? null,
    week52Low: overview.week52Low ?? null,
    earningsDate: overview.earningsDate || null,
    company: {
      name: overview.name || null,
      sector: overview.sector || null,
      peRatio: overview.peRatio ?? null,
    },
    newsSources,
    newsAlphaVantage,
    newsFinnhub: hasFinnhub ? newsFinnhub : null,
    newsMarketaux: hasMarketaux
      ? {
          sentimentScore: newsMarketaux.sentimentScore ?? null,
          highlight: newsMarketaux.highlight || null,
          articles: Array.isArray(newsMarketaux.articles)
            ? newsMarketaux.articles.slice(0, 2)
            : [],
        }
      : null,
    newsPending,
    newsAgreement,
    peers,
  };
}

function buildPrompt(payload) {
  return `You are helping a family stock information board (NOT a trading platform). Analyze the stock data below for beginners.

You will produce BOTH a short-term take and a long-term take from the SAME shared price history (daily bars). Short-term uses recent indicators (≈20–50 day window: SMA20/50, RSI, MACD, Bollinger). Long-term uses broader trend (SMA200 and longer context).

Respond with ONLY valid JSON matching this exact shape — no markdown, no code fences, no extra text:
{
  "short": {
    "lean": "bullish" | "neutral" | "bearish",
    "risk": "low" | "medium" | "high",
    "tags": ["short phrase", "short phrase"],
    "summary": "one or two plain-English sentences for the short-term view",
    "deepDive": "3-5 plain-English sentences for short-term Deep Dive"
  },
  "long": {
    "lean": "bullish" | "neutral" | "bearish",
    "risk": "low" | "medium" | "high",
    "tags": ["short phrase", "short phrase"],
    "summary": "one or two plain-English sentences for the long-term view",
    "deepDive": "3-5 plain-English sentences for long-term Deep Dive"
  },
  "quip": "one short, light, genuinely stock-relevant quip or pun about THIS specific company"
}

Rules:
- "short" and "long" may differ when the data supports it; do not force them to match.
- Each "tags" array: 1–3 short plain phrases.
- Each "summary": 1–2 beginner-friendly sentences, no jargon.
- Each "deepDive": 3–5 sentences covering price context, news tone, and peers when available; under ~120 words; no buy/sell advice.
- Do NOT apologize for or explain missing/unavailable data (no news, no peers, no analyst target, not enough history for a 200-day average, missing 52-week range, etc.). The UI shows those gaps as small badges separately. Write only genuine analysis from the data that IS present, and simply omit topics you cannot support.
- You may still use real stock-specific reasoning that happens to mention a shorter history when it adds insight (e.g. a newer public company) — but never boilerplate "we don't have X" / "data isn't available" disclaimers.
- If newsPending is true, do not invent news sentiment and do not say that news is missing — just skip news and lean on price/indicators/target.
- newsAgreement is critical when Alpha Vantage and Marketaux both succeed:
  - status "agree": both point the same way. Factor that as ADDED CONFIDENCE in lean and summary — say something like "both news sources point the same way" or "the two news feeds agree".
  - status "disagree": sources genuinely conflict. Do NOT silently pick one. Set lean toward "neutral" / cautious, and say plainly that signals are mixed (e.g. "mixed signals in recent news right now").
  - status "single" or "none": only one feed or neither — no agreement claim; just use what you have.
- "quip" must be about this company/ticker specifically (name, products, sector, or well-known traits) — light and tasteful, not mean-spirited, not financial advice, max ~20 words. Never a generic stock-market joke that could apply to any ticker.
- Do not give buy/sell advice or trading instructions.

Stock data:
${JSON.stringify(payload, null, 2)}`;
}

function extractText(apiResponse) {
  const parts = apiResponse?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return null;
  return parts
    .map((p) => p.text)
    .filter(Boolean)
    .join("")
    .trim();
}

function parseTake(raw) {
  if (!raw || typeof raw !== "object") return null;
  const lean = String(raw.lean || "").toLowerCase();
  const risk = String(raw.risk || "").toLowerCase();
  if (!["bullish", "neutral", "bearish"].includes(lean)) return null;
  if (!["low", "medium", "high"].includes(risk)) return null;
  if (typeof raw.summary !== "string" || !raw.summary.trim()) return null;

  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((t) => typeof t === "string" && t.trim()).slice(0, 3)
    : [];

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

function mentionsMixedNews(take) {
  const text = `${take?.summary || ""} ${(take?.tags || []).join(" ")} ${take?.deepDive || ""}`.toLowerCase();
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

/** Soft guard: disagreement must not stay strongly directional without acknowledgment. */
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

function parseAnalysisJson(text) {
  if (!text) return null;

  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
  }

  if (!cleaned.startsWith("{")) {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    cleaned = cleaned.slice(start, end + 1);
  }

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }

  if (parsed.short || parsed.long) {
    const short = parseTake(parsed.short) || { ...TAKE_FALLBACK };
    const long = parseTake(parsed.long) || { ...TAKE_FALLBACK };
    const quip =
      typeof parsed.quip === "string" && parsed.quip.trim()
        ? parsed.quip.trim()
        : null;
    return { short, long, quip };
  }

  const take = parseTake(parsed);
  if (!take) return null;
  const quip =
    typeof parsed.quip === "string" && parsed.quip.trim()
      ? parsed.quip.trim()
      : null;
  return { short: take, long: take, quip };
}

function isInvalidArgumentError(err) {
  const status = err.response?.status;
  const apiErr = err.response?.data?.error || {};
  const message = String(apiErr.message || err.message || "").toLowerCase();
  const statusText = String(apiErr.status || "").toUpperCase();
  return (
    status === 400 ||
    statusText === "INVALID_ARGUMENT" ||
    message.includes("invalid argument") ||
    message.includes("invalid_argument")
  );
}

function formatGeminiError(err) {
  const apiErr = err.response?.data?.error;
  if (apiErr) {
    return `${apiErr.status || err.response?.status || "ERR"}: ${apiErr.message || JSON.stringify(apiErr)}`;
  }
  return err.message;
}

async function callGemini(model, prompt, { useThinkingConfig = false } = {}) {
  await incrementUsage(PROVIDERS.GEMINI);

  const generationConfig = {
    temperature: 0.35,
    maxOutputTokens: 2048,
    responseMimeType: "application/json",
  };

  // thinkingBudget: 0 causes INVALID_ARGUMENT on several Gemini 2.5 models
  // (Pro rejects 0; some Flash aliases also reject the nested thinkingConfig).
  // Only attach when explicitly requested.
  if (useThinkingConfig) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }

  const { data } = await axios.post(
    geminiUrl(model),
    {
      // Omit role — some Gemini endpoints reject unexpected role values with INVALID_ARGUMENT.
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig,
    },
    {
      params: { key: getGeminiKey() },
      headers: { "Content-Type": "application/json" },
      timeout: 45000,
    }
  );
  return data;
}

/**
 * One Gemini call per ticker: short + long takes + stock-tied quip.
 * Optional mode arg ignored (kept for call-site compatibility).
 * If quip is empty, falls back to a cached JokeAPI general joke.
 */
async function analyzeStock(
  ticker,
  modeOrQuote,
  quoteMaybe,
  fundamentalsMaybe,
  peersMaybe
) {
  let quoteData;
  let fundamentalsData;
  let peersData;
  if (
    modeOrQuote &&
    typeof modeOrQuote === "object" &&
    (modeOrQuote.price || modeOrQuote.indicators)
  ) {
    quoteData = modeOrQuote;
    fundamentalsData = quoteMaybe;
    peersData = fundamentalsMaybe;
  } else {
    quoteData = quoteMaybe;
    fundamentalsData = fundamentalsMaybe;
    peersData = peersMaybe;
  }

  const primaryModel = getPrimaryGeminiModel();
  console.log(
    `[analyzeStock] Gemini model=${primaryModel} (dual+quip) at ${new Date().toISOString()}`
  );

  try {
    const payload = buildPayload(
      ticker,
      quoteData,
      fundamentalsData,
      peersData
    );
    const prompt = buildPrompt(payload);
    const newsAgreement = payload.newsAgreement;

    let data;
    try {
      data = await callGemini(primaryModel, prompt);
    } catch (primaryErr) {
      console.error(
        `[analyzeStock] Primary Gemini error for ${ticker}:`,
        formatGeminiError(primaryErr)
      );

      if (isModelUnavailableError(primaryErr)) {
        console.warn(
          `GEMINI_MODEL in .env may be outdated — fell back to ${FALLBACK_MODEL}. Consider updating .env. [${new Date().toISOString()}]`
        );
        console.log(
          `[analyzeStock] Gemini model=${FALLBACK_MODEL} at ${new Date().toISOString()}`
        );
        data = await callGemini(FALLBACK_MODEL, prompt);
      } else if (isInvalidArgumentError(primaryErr)) {
        // Retry once with an even leaner payload shape (no thinkingConfig already).
        // If the model rejected nested JSON mime + large prompt, try without mime type.
        console.warn(
          `[analyzeStock] INVALID_ARGUMENT on ${primaryModel} — retrying without responseMimeType`
        );
        await incrementUsage(PROVIDERS.GEMINI);
        const { data: retryData } = await axios.post(
          geminiUrl(primaryModel),
          {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.35,
              maxOutputTokens: 2048,
            },
          },
          {
            params: { key: getGeminiKey() },
            headers: { "Content-Type": "application/json" },
            timeout: 45000,
          }
        );
        data = retryData;
      } else {
        throw primaryErr;
      }
    }

    const text = extractText(data);
    if (!text) {
      const blockReason =
        data?.promptFeedback?.blockReason ||
        data?.candidates?.[0]?.finishReason ||
        null;
      console.error(
        `[analyzeStock] Empty Gemini text for ${ticker}` +
          (blockReason ? ` (finish/block=${blockReason})` : "") +
          ` raw=${JSON.stringify(data?.candidates?.[0] || data?.promptFeedback || {}).slice(0, 400)}`
      );
    }
    const parsed = applyNewsAgreementGuard(
      parseAnalysisJson(text),
      newsAgreement
    );
    if (!parsed) {
      console.error(`[analyzeStock] Failed to parse Gemini JSON for ${ticker}`);
      const quip = await getFallbackJoke();
      return {
        short: { ...TAKE_FALLBACK },
        long: { ...TAKE_FALLBACK },
        quip,
      };
    }

    if (!parsed.quip) {
      parsed.quip = await getFallbackJoke();
    }

    return parsed;
  } catch (err) {
    console.error(
      `[analyzeStock] Failed for ${ticker}:`,
      formatGeminiError(err)
    );
    const quip = await getFallbackJoke();
    return {
      short: { ...TAKE_FALLBACK },
      long: { ...TAKE_FALLBACK },
      quip,
    };
  }
}

module.exports = { analyzeStock, TAKE_FALLBACK, FALLBACK };
