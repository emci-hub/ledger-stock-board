require("dotenv").config();

const axios = require("axios");

const FALLBACK_MODEL = "gemini-flash-latest";

const FALLBACK = {
  lean: "neutral",
  risk: "medium",
  tags: [],
  summary: "Analysis wasn't available right now.",
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

  const newsSentiment = news.map((article) => ({
    title: article.title || null,
    sentimentScore: article.sentimentScore ?? null,
    sentimentLabel: article.sentimentLabel || null,
  }));

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
    company: {
      name: overview.name || null,
      sector: overview.sector || null,
      peRatio: overview.peRatio ?? null,
    },
    newsSentiment,
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
  "summary": "one or two plain-English sentences, no jargon, beginner-friendly"
}

Rules:
- "tags" must be an array of 1–3 short plain phrases.
- "summary" may briefly note how this stock compares to the listed peers if useful.
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

  // If the model prepends prose, pull out the first JSON object.
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

  return {
    lean,
    risk,
    tags,
    summary: parsed.summary.trim(),
  };
}

async function callGemini(model, prompt) {
  const { data } = await axios.post(
    geminiUrl(model),
    {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 1024,
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
