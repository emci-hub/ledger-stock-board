/**
 * Monthly capability probe — one minimal call per gated endpoint.
 * Confirms known blocks stay blocked and flags Gemini rate-limits.
 * Piggybacked from cleanupStaleCache; results stored in app_settings.
 */

require("dotenv").config();

const axios = require("axios");
const {
  callTwelveData,
  callFinnhub,
  TwelveDataError,
} = require("../services/dataFetch");
const { incrementUsage, PROVIDERS, getSetting, setSetting } = require("../services/usage");
const { hasSourceKey } = require("../lib/dataSources");

const PROBE_TICKER = "AAPL";
const SETTING_KEY = "lastCapabilityProbe";

function isoDate(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function classifyBlocked(err) {
  const status = err?.response?.status;
  const msg = String(err?.message || err?.response?.data?.message || "").toLowerCase();
  if (
    err instanceof TwelveDataError &&
    err.code === "plan_restricted"
  ) {
    return { blocked: true, reason: err.message };
  }
  if (status === 403 || status === 401 || status === 402) {
    return { blocked: true, reason: `HTTP ${status}` };
  }
  if (
    msg.includes("403") ||
    msg.includes("permission") ||
    msg.includes("upgrade") ||
    msg.includes("plan") ||
    msg.includes("not available") ||
    msg.includes("access denied")
  ) {
    return { blocked: true, reason: err.message || msg };
  }
  return { blocked: false, reason: err?.message || "unexpected" };
}

async function probeTwelvePriceTarget() {
  if (!hasSourceKey("twelve_data")) {
    return { skipped: true, reason: "no_key" };
  }
  try {
    await callTwelveData("/price_target", { symbol: PROBE_TICKER });
    return {
      expected: "blocked",
      actual: "allowed",
      ok: false,
      note: "price_target unexpectedly succeeded — Grow gating may have changed",
    };
  } catch (err) {
    const c = classifyBlocked(err);
    return {
      expected: "blocked",
      actual: c.blocked ? "blocked" : "error",
      ok: c.blocked,
      reason: c.reason,
    };
  }
}

async function probeTwelveProfile() {
  if (!hasSourceKey("twelve_data")) {
    return { skipped: true, reason: "no_key" };
  }
  try {
    await callTwelveData("/profile", { symbol: PROBE_TICKER });
    return {
      expected: "blocked",
      actual: "allowed",
      ok: false,
      note: "profile unexpectedly succeeded — Grow gating may have changed",
    };
  } catch (err) {
    const c = classifyBlocked(err);
    return {
      expected: "blocked",
      actual: c.blocked ? "blocked" : "error",
      ok: c.blocked,
      reason: c.reason,
    };
  }
}

async function probeFinnhubNewsSentiment() {
  if (!hasSourceKey("finnhub")) {
    return { skipped: true, reason: "no_key" };
  }
  try {
    await callFinnhub("/news-sentiment", { symbol: PROBE_TICKER });
    return {
      expected: "blocked",
      actual: "allowed",
      ok: false,
      note: "news-sentiment unexpectedly succeeded — free-tier gating may have changed",
    };
  } catch (err) {
    const c = classifyBlocked(err);
    return {
      expected: "blocked",
      actual: c.blocked ? "blocked" : "error",
      ok: c.blocked,
      reason: c.reason,
    };
  }
}

function isGeminiRateLimit(err, body) {
  const status = err?.response?.status;
  const apiErr = body?.error || err?.response?.data?.error || {};
  const message = String(apiErr.message || err?.message || "").toLowerCase();
  const statusText = String(apiErr.status || "").toUpperCase();
  return (
    status === 429 ||
    statusText === "RESOURCE_EXHAUSTED" ||
    /rate.?limit|quota|resource.?exhausted|billing|credit/.test(message)
  );
}

async function probeGemini() {
  if (!hasSourceKey("gemini")) {
    return { skipped: true, reason: "no_key" };
  }
  const key = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  try {
    await incrementUsage(PROVIDERS.GEMINI);
    const { data } = await axios.post(
      url,
      {
        contents: [{ parts: [{ text: 'Reply with exactly: {"ok":true}' }] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 32,
          responseMimeType: "application/json",
        },
      },
      {
        params: { key },
        headers: { "Content-Type": "application/json" },
        timeout: 30000,
      }
    );
    const text =
      data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
    return {
      expected: "ok",
      actual: "ok",
      ok: true,
      rateLimited: false,
      snippet: String(text).slice(0, 80),
    };
  } catch (err) {
    const body = err.response?.data;
    const rateLimited = isGeminiRateLimit(err, body);
    return {
      expected: "ok",
      actual: rateLimited ? "rate_limited" : "error",
      ok: !rateLimited,
      rateLimited,
      reason: body?.error?.message || err.message,
      flagged: rateLimited,
    };
  }
}

/**
 * Run all probes and persist JSON under app_settings.lastCapabilityProbe.
 */
async function runCapabilityProbe() {
  console.log(
    `[capabilityProbe] Starting monthly probes at ${new Date().toISOString()}`
  );

  const twelvePriceTarget = await probeTwelvePriceTarget();
  const twelveProfile = await probeTwelveProfile();
  const finnhubNewsSentiment = await probeFinnhubNewsSentiment();
  const gemini = await probeGemini();

  const result = {
    at: new Date().toISOString(),
    probeDate: isoDate(),
    ticker: PROBE_TICKER,
    twelve_data: {
      price_target: twelvePriceTarget,
      profile: twelveProfile,
    },
    finnhub: {
      news_sentiment: finnhubNewsSentiment,
    },
    gemini,
  };

  const alerts = [];
  if (twelvePriceTarget?.ok === false && !twelvePriceTarget.skipped) {
    alerts.push("twelve_data.price_target no longer blocked");
  }
  if (twelveProfile?.ok === false && !twelveProfile.skipped) {
    alerts.push("twelve_data.profile no longer blocked");
  }
  if (finnhubNewsSentiment?.ok === false && !finnhubNewsSentiment.skipped) {
    alerts.push("finnhub.news-sentiment no longer blocked");
  }
  if (gemini?.rateLimited || gemini?.flagged) {
    alerts.push("gemini rate-limited during probe");
  }
  result.alerts = alerts;

  await setSetting(SETTING_KEY, JSON.stringify(result));
  await setSetting("lastCapabilityProbeAt", result.at);

  if (alerts.length) {
    console.warn(`[capabilityProbe] ALERTS: ${alerts.join("; ")}`);
  } else {
    console.log("[capabilityProbe] All expected gates look unchanged");
  }
  console.log(`[capabilityProbe] Done at ${result.at}`);

  return result;
}

async function getLastCapabilityProbe() {
  const raw = await getSetting(SETTING_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

module.exports = {
  runCapabilityProbe,
  getLastCapabilityProbe,
  SETTING_KEY,
  PROBE_TICKER,
};
