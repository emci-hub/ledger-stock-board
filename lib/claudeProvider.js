/**
 * Claude (Anthropic) AI provider — manual "Deeper Look" only by default.
 * Must return the same structured analysis shape as Gemini.
 */

require("dotenv").config();

const axios = require("axios");
const { incrementUsage, PROVIDERS } = require("../services/usage");
const {
  buildAnalysisPrompt,
  parseAnalysisJson,
} = require("./aiShape");

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-4-20250514";

function getAnthropicKey() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set in .env");
  return key;
}

function getModel() {
  return process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
}

function extractText(data) {
  const parts = Array.isArray(data?.content) ? data.content : [];
  return parts
    .filter((p) => p && p.type === "text")
    .map((p) => p.text)
    .join("")
    .trim();
}

/**
 * Stock dual analysis — identical shape to Gemini provider.
 * Intended for explicit user-triggered deeper looks (paid credits).
 */
async function generateAnalysis(payload) {
  const key = getAnthropicKey();
  const model = getModel();
  const prompt = buildAnalysisPrompt(payload);

  console.log(
    `[claudeProvider] generateAnalysis model=${model} ticker=${payload?.ticker || "?"}`
  );

  await incrementUsage(PROVIDERS.CLAUDE);

  const { data } = await axios.post(
    ANTHROPIC_URL,
    {
      model,
      max_tokens: 2048,
      temperature: 0.35,
      messages: [{ role: "user", content: prompt }],
    },
    {
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      timeout: 60000,
    }
  );

  const text = extractText(data);
  const parsed = parseAnalysisJson(text);
  if (!parsed) {
    throw new Error("Failed to parse Claude analysis JSON");
  }
  return { ...parsed, provider: "claude" };
}

module.exports = {
  id: "claude",
  label: "Claude",
  generateAnalysis,
};
