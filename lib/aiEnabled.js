/**
 * Global AI kill switch.
 *
 * AI is OFF unless AI_ENABLED is explicitly set to 1 (or true/yes/on). While it
 * is off, nothing in this app may call Gemini or Anthropic: the provider facade
 * (lib/aiProvider.js), the Claude Deeper Look path, the capability probe, the
 * AI-using cron jobs and the boot-time repair all check here first and return a
 * paused result instead. Stored analyses keep being served — paused means "stop
 * spending model tokens", never "delete or overwrite what we already have".
 *
 * The Practice Run paper sync (POST /api/paper/sync) uses no AI and is
 * unaffected by this switch.
 */

const ON_VALUES = new Set(["1", "true", "yes", "on"]);

const AI_PAUSED_CODE = "ai_paused";
/** Short line for the UI. */
const AI_PAUSED_LABEL = "AI analysis paused";
/** One-sentence explanation shown to the family / returned by paused endpoints. */
const AI_PAUSED_MESSAGE =
  "AI analysis is paused right now. Stored results are still shown; nothing new is being generated.";
const AI_PAUSED_SUMMARY =
  "AI analysis is paused — this card shows the stored data only.";
const AI_PAUSED_DEEP_DIVE =
  "AI analysis is paused, so there is no new deep dive for this name. The numbers above are real stored data.";

function isAiEnabled() {
  return ON_VALUES.has(String(process.env.AI_ENABLED || "").trim().toLowerCase());
}

function isAiPaused() {
  return !isAiEnabled();
}

/** Why it is off, for logs and dev-status. */
function aiPausedReason() {
  return "AI_ENABLED is not set to 1";
}

let loggedOnce = new Set();

/** Log a skip once per call site per process so paused runs stay quiet. */
function logPausedOnce(site) {
  const key = String(site || "ai");
  if (loggedOnce.has(key)) return;
  loggedOnce.add(key);
  console.log(`[aiEnabled] ${key} skipped — ${aiPausedReason()} (AI paused)`);
}

/** Flat JSON body for a paused on-demand endpoint. */
function aiPausedBody(extra = {}) {
  return {
    ok: false,
    aiPaused: true,
    status: "paused",
    code: AI_PAUSED_CODE,
    message: AI_PAUSED_MESSAGE,
    reason: aiPausedReason(),
    ...extra,
  };
}

/**
 * Analysis-shaped stand-in returned by the providers while paused. Carries
 * aiPaused so callers can recognise it and refuse to persist it over a real
 * stored analysis.
 */
function pausedTake() {
  return {
    lean: "neutral",
    risk: "medium",
    tags: [],
    summary: AI_PAUSED_SUMMARY,
    deepDive: AI_PAUSED_DEEP_DIVE,
  };
}

function pausedAnalysis(provider = "paused") {
  return {
    aiPaused: true,
    short: pausedTake(),
    long: pausedTake(),
    quip: null,
    shortTermRank: null,
    longTermRank: null,
    provider,
  };
}

/** Stand-in for the Gemini-only JSON helper (mood / tidbits / write-ups). */
function pausedJson() {
  return {
    aiPaused: true,
    code: AI_PAUSED_CODE,
    message: AI_PAUSED_MESSAGE,
  };
}

module.exports = {
  AI_PAUSED_CODE,
  AI_PAUSED_LABEL,
  AI_PAUSED_MESSAGE,
  AI_PAUSED_SUMMARY,
  AI_PAUSED_DEEP_DIVE,
  isAiEnabled,
  isAiPaused,
  aiPausedReason,
  aiPausedBody,
  logPausedOnce,
  pausedAnalysis,
  pausedJson,
  pausedTake,
};
