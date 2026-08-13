/**
 * Gemini AI provider — default automated analysis path.
 */

require("dotenv").config();

const axios = require("axios");
const { incrementUsage, PROVIDERS } = require("../services/usage");
const {
  buildAnalysisPrompt,
  parseAnalysisJson,
  ANALYSIS_JSON_SHAPE,
  parseJsonLoose,
} = require("./aiShape");
const { getActiveBudget, QuotaSkippedError } = require("../services/quotaBudget");
const { getCallContextTicker } = require("../services/callContext");

function consumeGeminiOrThrow(action) {
  const budget = getActiveBudget();
  if (!budget) return;
  if (
    !budget.tryConsume(PROVIDERS.GEMINI, 1, {
      action,
      ticker: getCallContextTicker(),
    })
  ) {
    throw budget.skipError(PROVIDERS.GEMINI);
  }
}

const FALLBACK_MODEL = "gemini-flash-latest";

const GEMINI_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    short: {
      type: "OBJECT",
      properties: {
        lean: { type: "STRING" },
        risk: { type: "STRING" },
        tags: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              plain: { type: "STRING" },
              technical: { type: "STRING" },
              explanation: { type: "STRING" },
            },
            required: ["plain", "technical", "explanation"],
          },
        },
        summary: { type: "STRING" },
        deepDive: { type: "STRING" },
      },
      required: ["lean", "risk", "tags", "summary", "deepDive"],
    },
    long: {
      type: "OBJECT",
      properties: {
        lean: { type: "STRING" },
        risk: { type: "STRING" },
        tags: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              plain: { type: "STRING" },
              technical: { type: "STRING" },
              explanation: { type: "STRING" },
            },
            required: ["plain", "technical", "explanation"],
          },
        },
        summary: { type: "STRING" },
        deepDive: { type: "STRING" },
      },
      required: ["lean", "risk", "tags", "summary", "deepDive"],
    },
    quip: {
      type: "OBJECT",
      properties: {
        plain: { type: "STRING" },
        technical: { type: "STRING" },
        explanation: { type: "STRING" },
      },
      required: ["plain", "technical", "explanation"],
    },
    shortTermRank: { type: "NUMBER" },
    longTermRank: { type: "NUMBER" },
  },
  required: ["short", "long", "quip", "shortTermRank", "longTermRank"],
};

function getGeminiKey() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set in .env");
  return key;
}

function getPrimaryModel() {
  return process.env.GEMINI_MODEL || "gemini-2.5-flash";
}

function geminiUrl(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
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
  return /not found|no longer available|deprecated|not supported|invalid model|unknown model|is not available/.test(
    message
  );
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

function formatError(err) {
  const apiErr = err.response?.data?.error;
  if (apiErr) {
    return `${apiErr.status || err.response?.status || "ERR"}: ${apiErr.message || JSON.stringify(apiErr)}`;
  }
  return err.message;
}

async function callGemini(model, prompt, { withSchema = true } = {}) {
  consumeGeminiOrThrow("generateAnalysis");
  await incrementUsage(PROVIDERS.GEMINI, { action: "generateAnalysis" });
  const generationConfig = {
    temperature: 0.35,
    maxOutputTokens: 2048,
    responseMimeType: "application/json",
  };
  if (withSchema) generationConfig.responseSchema = GEMINI_RESPONSE_SCHEMA;

  const { data } = await axios.post(
    geminiUrl(model),
    {
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
 * Stock dual analysis — same shape as Claude provider.
 */
async function generateAnalysis(payload) {
  const prompt = buildAnalysisPrompt(payload);
  const primaryModel = getPrimaryModel();
  console.log(
    `[geminiProvider] generateAnalysis model=${primaryModel} ticker=${payload?.ticker || "?"}`
  );

  let data;
  try {
    data = await callGemini(primaryModel, prompt, { withSchema: true });
  } catch (primaryErr) {
    console.error(`[geminiProvider] Primary error:`, formatError(primaryErr));
    if (isModelUnavailableError(primaryErr)) {
      console.warn(`[geminiProvider] Falling back to ${FALLBACK_MODEL}`);
      data = await callGemini(FALLBACK_MODEL, prompt, { withSchema: true });
    } else if (isInvalidArgumentError(primaryErr)) {
      console.warn(`[geminiProvider] INVALID_ARGUMENT — retry without schema`);
      data = await callGemini(primaryModel, prompt, { withSchema: false });
    } else {
      throw primaryErr;
    }
  }

  const text = extractText(data);
  const parsed = parseAnalysisJson(text);
  if (!parsed) {
    throw new Error("Failed to parse Gemini analysis JSON");
  }
  return { ...parsed, provider: "gemini" };
}

/**
 * Free-form JSON helper for mood / tidbits / write-ups (Gemini only path).
 */
async function generateJson(prompt, { maxOutputTokens = 1024 } = {}) {
  consumeGeminiOrThrow("generateJson");
  await incrementUsage(PROVIDERS.GEMINI, { action: "generateJson" });
  const model = getPrimaryModel();
  try {
    const { data } = await axios.post(
      geminiUrl(model),
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens,
          responseMimeType: "application/json",
        },
      },
      {
        params: { key: getGeminiKey() },
        headers: { "Content-Type": "application/json" },
        timeout: 45000,
      }
    );
    const text = extractText(data);
    const parsed = parseJsonLoose(text);
    if (parsed == null) throw new Error("Gemini JSON parse failed");
    return parsed;
  } catch (err) {
    if (err instanceof QuotaSkippedError) throw err;
    if (isModelUnavailableError(err)) {
      consumeGeminiOrThrow("generateJson");
      await incrementUsage(PROVIDERS.GEMINI, { action: "generateJson" });
      const { data } = await axios.post(
        geminiUrl(FALLBACK_MODEL),
        {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens,
            responseMimeType: "application/json",
          },
        },
        {
          params: { key: getGeminiKey() },
          headers: { "Content-Type": "application/json" },
          timeout: 45000,
        }
      );
      const text = extractText(data);
      const parsed = parseJsonLoose(text);
      if (parsed == null) throw new Error("Gemini JSON parse failed (fallback)");
      return parsed;
    }
    throw err;
  }
}

module.exports = {
  id: "gemini",
  label: "Gemini",
  generateAnalysis,
  generateJson,
  formatError,
  ANALYSIS_JSON_SHAPE,
};
