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

/**
 * Real per-minute pacing gate — same proven rolling-window pattern already
 * used for Finnhub (acquireFinnhubSlot) and Twelve Data (acquireTwelveDataSlot).
 * Was previously MISSING entirely — the code treated Gemini as having no
 * cap, but research (2026-08-17) found free-tier Gemini has a real reported
 * RPM limit (commonly cited 10-15 RPM depending on source/model). At the
 * observed real refresh pace (~20 req/min for 300 tickers over ~15 min),
 * this app was almost certainly already exceeding it — a plausible real
 * cause of intermittent "Gemini JSON parse failed" errors seen in logs.
 * Capped conservatively at 60-75% of the most cautious reported limit (10
 * RPM), per explicit instruction, rather than the most generous number —
 * safer to be wrong by having headroom than to still be over the real cap.
 * GEMINI_RPM_LIMIT is a real, named, Render-configurable constant — update
 * it if you check your actual Google AI Studio dashboard for your key's
 * real number.
 */
const GEMINI_WINDOW_MS = 60_000;
const GEMINI_RPM_LIMIT = Math.max(
  1,
  Number.parseInt(process.env.GEMINI_RPM_LIMIT || "10", 10) || 10
);
const GEMINI_TARGET_UTILIZATION = Math.min(
  1,
  Math.max(
    0.1,
    Number.parseFloat(process.env.GEMINI_TARGET_UTILIZATION || "0.7") || 0.7
  )
);
const GEMINI_SOFT_LIMIT = Math.max(
  1,
  Math.floor(GEMINI_RPM_LIMIT * GEMINI_TARGET_UTILIZATION)
);
const geminiCallTimestamps = [];
let geminiGate = Promise.resolve();

async function acquireGeminiSlot() {
  let release;
  const previous = geminiGate;
  geminiGate = new Promise((resolve) => {
    release = resolve;
  });
  await previous;

  try {
    for (;;) {
      const now = Date.now();
      while (
        geminiCallTimestamps.length &&
        now - geminiCallTimestamps[0] >= GEMINI_WINDOW_MS
      ) {
        geminiCallTimestamps.shift();
      }
      if (geminiCallTimestamps.length < GEMINI_SOFT_LIMIT) {
        geminiCallTimestamps.push(now);
        return;
      }
      const waitMs =
        GEMINI_WINDOW_MS - (now - geminiCallTimestamps[0]) + 50;
      console.warn(
        `[geminiProvider] rate-limit delay ${waitMs}ms (${geminiCallTimestamps.length}/${GEMINI_SOFT_LIMIT} in 60s window, real limit ~${GEMINI_RPM_LIMIT} RPM)`
      );
      await incrementUsage(PROVIDERS.GEMINI_DELAY, {
        action: "rate_delay",
      }).catch(() => {});
      await new Promise((r) => setTimeout(r, Math.max(waitMs, 100)));
    }
  } finally {
    release();
  }
}

const FALLBACK_MODEL = "gemini-3.6-flash";

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
  },
  required: ["short", "long", "quip", "shortTermRank"],
};

function getGeminiKey() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set in .env");
  return key;
}

function getPrimaryModel() {
  return process.env.GEMINI_MODEL || "gemini-flash-latest";
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
  await acquireGeminiSlot();
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
  await acquireGeminiSlot();
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
      await acquireGeminiSlot();
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
