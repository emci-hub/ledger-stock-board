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
/** Retired models (e.g. claude-sonnet-4-20250514) return 404 — keep this current. */
const DEFAULT_MODEL = "claude-sonnet-4-5";

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
 * Classify Anthropic failures so Deeper Look can auto-hide on ongoing issues.
 */
function classifyClaudeError(err) {
  const status = err?.response?.status ?? err?.status ?? null;
  const body = err?.response?.data || err?.data || null;
  const apiType = body?.error?.type || body?.type || null;
  const msg = String(
    body?.error?.message || body?.message || err?.message || ""
  );
  const lower = msg.toLowerCase();

  if (status === 401 || status === 403 || apiType === "authentication_error") {
    return {
      permanent: true,
      kind: "auth",
      status,
      message: msg || "Anthropic authentication failed",
    };
  }
  if (
    status === 404 ||
    apiType === "not_found_error" ||
    /model:\s*claude/i.test(msg)
  ) {
    return {
      permanent: true,
      kind: "model",
      status,
      message: msg || "Claude model not found / retired",
    };
  }
  if (
    /credit|billing|balance|payment|purchase|quota.*exceed/i.test(lower) ||
    apiType === "billing_error"
  ) {
    return {
      permanent: true,
      kind: "credits",
      status,
      message: msg || "Claude billing/credits issue",
    };
  }
  if (status === 429 || apiType === "rate_limit_error") {
    return {
      permanent: false,
      kind: "rate_limit",
      status,
      message: msg || "Claude rate limited",
    };
  }
  if (status != null && status >= 500) {
    return {
      permanent: false,
      kind: "server",
      status,
      message: msg || "Claude server error",
    };
  }
  if (/timeout|ECONNRESET|ENOTFOUND|network/i.test(msg)) {
    return {
      permanent: false,
      kind: "network",
      status,
      message: msg || "Claude network error",
    };
  }
  return {
    permanent: false,
    kind: "unknown",
    status,
    message: msg || "Claude request failed",
  };
}

async function postClaudeMessages(body, { timeout = 60000 } = {}) {
  const key = getAnthropicKey();
  return axios.post(
    ANTHROPIC_URL,
    { model: getModel(), ...body },
    {
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      timeout,
    }
  );
}

/**
 * Tiny health probe — does not count as a full analysis.
 * Still increments usage so /dev-status reflects the call.
 */
async function probeClaudeHealth() {
  const model = getModel();
  try {
    await incrementUsage(PROVIDERS.CLAUDE, {
      action: "probeHealth",
      ticker: null,
    });
    const { data, status } = await postClaudeMessages(
      {
        max_tokens: 16,
        messages: [{ role: "user", content: "Reply with OK only." }],
      },
      { timeout: 20000 }
    );
    const text = extractText(data);
    return {
      ok: true,
      model,
      status: status || 200,
      permanent: false,
      kind: null,
      message: text ? "ok" : "empty_response",
      probedAt: new Date().toISOString(),
    };
  } catch (err) {
    const classified = classifyClaudeError(err);
    return {
      ok: false,
      model,
      status: classified.status,
      permanent: classified.permanent,
      kind: classified.kind,
      message: classified.message,
      probedAt: new Date().toISOString(),
    };
  }
}

/**
 * Stock dual analysis — identical shape to Gemini provider.
 * Intended for explicit user-triggered deeper looks (paid credits).
 */
async function generateAnalysis(payload) {
  const model = getModel();
  const prompt = buildAnalysisPrompt(payload);

  console.log(
    `[claudeProvider] generateAnalysis model=${model} ticker=${payload?.ticker || "?"}`
  );

  await incrementUsage(PROVIDERS.CLAUDE, {
    action: "generateAnalysis",
    ticker: payload?.ticker || null,
  });

  try {
    const { data } = await postClaudeMessages({
      max_tokens: 2048,
      temperature: 0.35,
      messages: [{ role: "user", content: prompt }],
    });

    const text = extractText(data);
    const parsed = parseAnalysisJson(text);
    if (!parsed) {
      throw new Error("Failed to parse Claude analysis JSON");
    }
    return { ...parsed, provider: "claude" };
  } catch (err) {
    const classified = classifyClaudeError(err);
    const wrapped = new Error(classified.message || err.message);
    wrapped.code = `claude_${classified.kind}`;
    wrapped.claudeKind = classified.kind;
    wrapped.claudePermanent = classified.permanent;
    wrapped.status = classified.status;
    wrapped.cause = err;
    throw wrapped;
  }
}

module.exports = {
  id: "claude",
  label: "Claude",
  generateAnalysis,
  probeClaudeHealth,
  classifyClaudeError,
  getModel,
  DEFAULT_MODEL,
};
