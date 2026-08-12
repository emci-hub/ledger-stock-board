require("dotenv").config();

const axios = require("axios");
const { incrementUsage, PROVIDERS } = require("./usage");

const FALLBACK_MODEL = "gemini-flash-latest";

const FALLBACK = {
  lean: "neutral",
  risk: "medium",
  tags: [],
  summary: "Analysis wasn't available right now.",
  deepDive:
    "A longer AI deep dive wasn't available for this name yet. Check price, range, and news sources in the panel below when they load.",
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

function buildPayload(ticker, mode, quoteData, fundamentalsData, peersData) {
  const price = quoteData?.price || {};
  const indicators = quoteData?.indicators || {};
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
    mode,
    price: {
      current: price.current ?? null,
      change: price.change ?? null,
      changePercent: price.changePercent ?? null,
      latestTradingDay: price.latestTradingDay || null,
    },
    indicators: {
      sma20: indicators.sma?.sma20 ?? null,
      sma50: indicators.sma?.sma50 ?? null,
      sma200: indicators.sma?.sma200 ?? null,
      rsi: indicators.rsi ?? null,
      macd: indicators.macd || null,
      bollinger: indicators.bollinger || null,
    },
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
    peers,
  };
}

function buildPrompt(payload) {
  return `You are helping a family stock information board (NOT a trading platform). Analyze the stock data below for beginners.

Respond with ONLY valid JSON matching this exact shape — no markdown, no code fences, no extra text:
{
  "lean": "bullish" | "neutral" | "bearish",
  "risk": "low" | "medium" | "high",
  "tags": ["short phrase", "short phrase"],
  "summary": "one or two plain-English sentences, no jargon, beginner-friendly",
  "deepDive": "3-5 plain-English sentences for a Deep Dive panel — still beginner-friendly, no jargon, no buy/sell advice"
}

Rules:
- "tags" must be an array of 1–3 short plain phrases.
- "summary" is the short card blurb (1–2 sentences).
- "deepDive" is a slightly longer explanation (3–5 sentences) covering price context, news tone, and peers when available. Keep it under ~120 words.
- If newsPending is true, do not invent news sentiment; lean on price/indicators/target only.
- If multiple news sources are present (newsAlphaVantage / newsFinnhub / newsMarketaux), briefly note whether they seem to agree or disagree in summary and/or deepDive.
- If only one news source is present, use that one only.
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

  const lean = String(parsed.lean || "").toLowerCase();
  const risk = String(parsed.risk || "").toLowerCase();

  if (!["bullish", "neutral", "bearish"].includes(lean)) return null;
  if (!["low", "medium", "high"].includes(risk)) return null;
  if (typeof parsed.summary !== "string" || !parsed.summary.trim()) return null;

  const tags = Array.isArray(parsed.tags)
    ? parsed.tags.filter((t) => typeof t === "string" && t.trim()).slice(0, 3)
    : [];

  const deepDive =
    typeof parsed.deepDive === "string" && parsed.deepDive.trim()
      ? parsed.deepDive.trim()
      : FALLBACK.deepDive;

  return {
    lean,
    risk,
    tags,
    summary: parsed.summary.trim(),
    deepDive,
  };
}

async function callGemini(model, prompt) {
  await incrementUsage(PROVIDERS.GEMINI);

  const { data } = await axios.post(
    geminiUrl(model),
    {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 1536,
        responseMimeType: "application/json",
        thinkingConfig: { thinkingBudget: 0 },
      },
    },
    {
      params: { key: getGeminiKey() },
      headers: { "Content-Type": "application/json" },
      timeout: 30000,
    }
  );
  return data;
}

/**
 * Gemini analysis with one model-availability fallback — no other retries/loops.
 * Returns structured analysis, or a safe fallback if anything fails.
 */
async function analyzeStock(ticker, mode, quoteData, fundamentalsData, peersData) {
  const primaryModel = getPrimaryGeminiModel();
  console.log(
    `[analyzeStock] Gemini model=${primaryModel} at ${new Date().toISOString()}`
  );

  try {
    const payload = buildPayload(
      ticker,
      mode,
      quoteData,
      fundamentalsData,
      peersData
    );
    const prompt = buildPrompt(payload);

    let data;
    try {
      data = await callGemini(primaryModel, prompt);
    } catch (primaryErr) {
      if (!isModelUnavailableError(primaryErr)) {
        throw primaryErr;
      }

      console.warn(
        `GEMINI_MODEL in .env may be outdated — fell back to ${FALLBACK_MODEL}. Consider updating .env. [${new Date().toISOString()}]`
      );
      console.log(
        `[analyzeStock] Gemini model=${FALLBACK_MODEL} at ${new Date().toISOString()}`
      );
      data = await callGemini(FALLBACK_MODEL, prompt);
    }

    const text = extractText(data);
    const parsed = parseAnalysisJson(text);
    if (!parsed) {
      console.error(
        `[analyzeStock] Failed to parse Gemini JSON for ${ticker} (${mode})`
      );
      return { ...FALLBACK };
    }

    return parsed;
  } catch (err) {
    console.error(
      `[analyzeStock] Failed for ${ticker} (${mode}):`,
      err.response?.data?.error?.message || err.message
    );
    return { ...FALLBACK };
  }
}

module.exports = { analyzeStock };
