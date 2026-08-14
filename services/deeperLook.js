/**
 * Manual Claude "Deeper Look" — never automatic; paid credits only on user action.
 *
 * Public button visibility follows isDeeperLookEnabled():
 * - explicit app_settings off → hidden
 * - missing ANTHROPIC_API_KEY → hidden
 * - Claude health permanently unhealthy (bad key/model/credits) → hidden
 *   until a successful probe or enable clears it
 */

const { dbGet, dbRun, dbExecute, dbAll } = require("../db/schema");
const { getStockCacheEntry, pickAnalysisTake, normalizeDualAnalysis } = require("./cache");
const { hasSourceKey } = require("../lib/dataSources");
const { getSetting, setSetting } = require("./usage");
const {
  probeClaudeHealth,
  classifyClaudeError,
  getModel,
} = require("../lib/claudeProvider");
const { TAKE_FALLBACK } = require("../lib/aiShape");

const DEEPER_LOOK_SETTING = "deeperLookEnabled";
const HEALTH_OK_SETTING = "deeperLookHealthOk";
const HEALTH_AT_SETTING = "deeperLookHealthAt";
const HEALTH_ERR_SETTING = "deeperLookHealthError";
const HEALTH_KIND_SETTING = "deeperLookHealthKind";
const HEALTH_PERM_SETTING = "deeperLookHealthPermanent";
const HEALTH_MODEL_SETTING = "deeperLookHealthModel";

let healthProbeInFlight = null;

async function ensureDeeperLookTable() {
  await dbExecute(`
    CREATE TABLE IF NOT EXISTS ai_deeper_looks (
      ticker TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      generated_at TEXT NOT NULL
    )
  `);
}

function claudeConfigured() {
  return hasSourceKey("claude");
}

async function readHealth() {
  const okRaw = await getSetting(HEALTH_OK_SETTING);
  if (okRaw == null || okRaw === "") {
    return null;
  }
  return {
    ok: okRaw === "1" || okRaw === "true",
    permanent:
      (await getSetting(HEALTH_PERM_SETTING)) === "1" ||
      (await getSetting(HEALTH_PERM_SETTING)) === "true",
    kind: (await getSetting(HEALTH_KIND_SETTING)) || null,
    message: (await getSetting(HEALTH_ERR_SETTING)) || null,
    model: (await getSetting(HEALTH_MODEL_SETTING)) || getModel(),
    probedAt: (await getSetting(HEALTH_AT_SETTING)) || null,
  };
}

async function writeHealth(result) {
  await setSetting(HEALTH_OK_SETTING, result.ok ? "1" : "0");
  await setSetting(HEALTH_PERM_SETTING, result.permanent ? "1" : "0");
  await setSetting(HEALTH_KIND_SETTING, result.kind || "");
  await setSetting(HEALTH_ERR_SETTING, result.message || "");
  await setSetting(HEALTH_MODEL_SETTING, result.model || getModel());
  await setSetting(
    HEALTH_AT_SETTING,
    result.probedAt || new Date().toISOString()
  );
  return readHealth();
}

/**
 * Record a live Claude failure so the public button can hide itself.
 * Transient failures do not flip the feature off.
 */
async function recordClaudeFailure(err) {
  const classified =
    err?.claudeKind != null
      ? {
          permanent: Boolean(err.claudePermanent),
          kind: err.claudeKind,
          message: err.message,
          status: err.status ?? null,
        }
      : classifyClaudeError(err);
  if (!classified.permanent) {
    return {
      recorded: false,
      health: await readHealth(),
      classified,
    };
  }
  const health = await writeHealth({
    ok: false,
    permanent: true,
    kind: classified.kind,
    message: classified.message,
    model: getModel(),
    probedAt: new Date().toISOString(),
  });
  console.warn(
    `[deeperLook] Claude permanently unhealthy (${classified.kind}): ${classified.message}`
  );
  return { recorded: true, health, classified };
}

async function recordClaudeSuccess() {
  return writeHealth({
    ok: true,
    permanent: false,
    kind: null,
    message: "ok",
    model: getModel(),
    probedAt: new Date().toISOString(),
  });
}

/**
 * Run a tiny Anthropic probe and persist the result.
 */
async function refreshClaudeHealth() {
  if (!claudeConfigured()) {
    return writeHealth({
      ok: false,
      permanent: true,
      kind: "not_configured",
      message: "ANTHROPIC_API_KEY is not configured",
      model: getModel(),
      probedAt: new Date().toISOString(),
    });
  }
  const result = await probeClaudeHealth();
  return writeHealth(result);
}

/**
 * Re-probe when never checked, or when ANTHROPIC_MODEL changed since last probe.
 * Avoids leaving the button stuck hidden after a model fix, and avoids showing
 * it when the configured model is already known-dead.
 */
async function maybeRefreshStaleHealth() {
  if (!claudeConfigured()) return readHealth();
  const health = await readHealth();
  const model = getModel();
  const modelChanged = Boolean(health?.model && health.model !== model);
  const neverProbed = !health;
  if (!neverProbed && !modelChanged) return health;
  if (healthProbeInFlight) return healthProbeInFlight;
  healthProbeInFlight = refreshClaudeHealth().finally(() => {
    healthProbeInFlight = null;
  });
  return healthProbeInFlight;
}

/**
 * Public feature flag. Explicit app_settings value wins for intent, but a
 * permanent Claude health failure always hides the button (original design).
 */
async function isDeeperLookEnabled() {
  if (!claudeConfigured()) return false;

  const health = await maybeRefreshStaleHealth();
  if (health && health.ok === false && health.permanent) {
    return false;
  }

  const raw = await getSetting(DEEPER_LOOK_SETTING);
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return true; // key present, no explicit off, health ok/unknown
}

async function getDeeperLookSetting() {
  const raw = await getSetting(DEEPER_LOOK_SETTING);
  await maybeRefreshStaleHealth();
  const health = await readHealth();
  const enabled = await isDeeperLookEnabled();
  return {
    enabled,
    explicit: raw === "0" || raw === "1" || raw === "true" || raw === "false",
    claudeConfigured: claudeConfigured(),
    model: getModel(),
    health,
    source:
      health && health.ok === false && health.permanent
        ? "hidden_unhealthy"
        : raw === "1" || raw === "true" || raw === "0" || raw === "false"
          ? "app_settings"
          : "default_from_anthropic_key",
  };
}

/**
 * Persist on/off. Enabling without a Claude key is rejected.
 * Enabling always re-probes Claude — permanent failures refuse enable so the
 * public button cannot be turned on while Claude is broken.
 */
async function setDeeperLookEnabled(enabled) {
  const on = Boolean(enabled);
  if (on && !claudeConfigured()) {
    const err = new Error(
      "Cannot enable Deeper Look — ANTHROPIC_API_KEY is not configured."
    );
    err.code = "not_configured";
    throw err;
  }
  if (on) {
    const health = await refreshClaudeHealth();
    if (!health?.ok) {
      const err = new Error(
        `Cannot enable Deeper Look — Claude health check failed (${health?.kind || "error"}): ${health?.message || "unknown"}`
      );
      err.code = "unhealthy";
      err.health = health;
      throw err;
    }
  }
  await setSetting(DEEPER_LOOK_SETTING, on ? "1" : "0");
  // Always scrub failed/fallback rows so a later re-enable gets clean retries.
  await clearFailedDeeperLooks();
  return getDeeperLookSetting();
}

async function getDeeperLook(ticker) {
  await ensureDeeperLookTable();
  const symbol = String(ticker).toUpperCase();
  const row = await dbGet(
    `SELECT ticker, provider, summary_json, generated_at FROM ai_deeper_looks WHERE ticker = ?`,
    [symbol]
  );
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.summary_json);
    if (isFallbackAnalysis(parsed)) {
      // Failed/fallback rows should not surface on cards — delete so a later
      // enable gets a clean retry instead of the old failure.
      await dbRun(`DELETE FROM ai_deeper_looks WHERE ticker = ?`, [symbol]);
      console.warn(
        `[deeperLook] Cleared failed/fallback deeper look for ${symbol}`
      );
      return null;
    }
    const dual = normalizeDualAnalysis(parsed);
    return {
      ticker: symbol,
      provider: row.provider,
      generatedAt: row.generated_at,
      dual,
      long: pickAnalysisTake(dual, "long"),
      short: pickAnalysisTake(dual, "short"),
    };
  } catch {
    return null;
  }
}

function isFallbackAnalysis(analysis) {
  const dual = normalizeDualAnalysis(analysis);
  const longSum = dual?.long?.summary || analysis?.long?.summary || "";
  const shortSum = dual?.short?.summary || analysis?.short?.summary || "";
  const snippet = String(TAKE_FALLBACK.summary || "wasn't available").toLowerCase();
  const longHit = String(longSum).toLowerCase().includes(snippet);
  const shortHit = String(shortSum).toLowerCase().includes(snippet);
  // Treat as failed if either take is the canned fallback (or both).
  return longHit || shortHit;
}

/**
 * Delete stored Claude results that are canned fallbacks / failures.
 * Successful deeper looks are left intact.
 */
async function clearFailedDeeperLooks() {
  await ensureDeeperLookTable();
  const rows = await dbAll(
    `SELECT ticker, summary_json FROM ai_deeper_looks`
  );
  const cleared = [];
  for (const row of rows || []) {
    try {
      const parsed = JSON.parse(row.summary_json);
      if (!isFallbackAnalysis(parsed)) continue;
      await dbRun(`DELETE FROM ai_deeper_looks WHERE ticker = ?`, [row.ticker]);
      cleared.push(String(row.ticker).toUpperCase());
    } catch {
      await dbRun(`DELETE FROM ai_deeper_looks WHERE ticker = ?`, [row.ticker]);
      cleared.push(String(row.ticker).toUpperCase());
    }
  }
  if (cleared.length) {
    console.log(
      `[deeperLook] Cleared ${cleared.length} failed deeper look(s): ${cleared.join(", ")}`
    );
  }
  return { cleared };
}

/**
 * Explicit user-triggered Claude analysis for one ticker.
 */
async function requestDeeperLook(ticker, { mode = "long" } = {}) {
  if (!(await isDeeperLookEnabled())) {
    const err = new Error("Deeper Look is disabled.");
    err.code = "disabled";
    throw err;
  }
  if (!claudeConfigured()) {
    const err = new Error("Claude is not configured (ANTHROPIC_API_KEY missing).");
    err.code = "not_configured";
    throw err;
  }

  const symbol = String(ticker).toUpperCase();
  const entry = await getStockCacheEntry(symbol);
  if (!entry?.data?.quote) {
    const err = new Error(
      `No cached stock data for ${symbol} — look it up on the board first.`
    );
    err.code = "no_data";
    throw err;
  }

  await ensureDeeperLookTable();

  let analysis;
  try {
    // Call Claude provider directly so auth/model/credit errors aren't
    // swallowed into Gemini-style fallback text by analyzeStock.
    const { generateAnalysis } = require("../lib/aiProvider");
    const { buildPayload } = require("./analyze");
    const { applyNewsAgreementGuard, parseQuip } = require("../lib/aiShape");
    const { getFallbackJoke } = require("./jokes");
    const payload = buildPayload(
      symbol,
      entry.data.quote,
      entry.data.fundamentals,
      entry.data.peers || []
    );
    analysis = await generateAnalysis(payload, { provider: "claude" });
    analysis = applyNewsAgreementGuard(analysis, payload.newsAgreement);
    if (!analysis?.quip) {
      analysis.quip = parseQuip(await getFallbackJoke());
    }
    await recordClaudeSuccess();
  } catch (err) {
    await recordClaudeFailure(err);
    console.error(`[deeperLook] Claude failed for ${symbol}:`, err.message);
    const wrapped = new Error(
      err.message || "Claude Deeper Look failed"
    );
    wrapped.code = err.code || "claude_failed";
    wrapped.claudeKind = err.claudeKind;
    wrapped.claudePermanent = err.claudePermanent;
    throw wrapped;
  }

  if (isFallbackAnalysis(analysis)) {
    // analyzeStock-style fallback should not be persisted as a "success".
    const err = new Error("Claude returned fallback analysis");
    err.code = "claude_fallback";
    await recordClaudeFailure({
      message: err.message,
      claudeKind: "unknown",
      claudePermanent: false,
    });
    throw err;
  }

  const now = new Date().toISOString();
  await dbRun(
    `INSERT OR REPLACE INTO ai_deeper_looks (ticker, provider, summary_json, generated_at)
     VALUES (?, ?, ?, ?)`,
    [symbol, "claude", JSON.stringify(analysis), now]
  );

  const dual = normalizeDualAnalysis(analysis);
  const take = pickAnalysisTake(dual, mode === "short" ? "short" : "long");

  return {
    ticker: symbol,
    provider: "claude",
    generatedAt: now,
    dual,
    analysis: take,
  };
}

module.exports = {
  ensureDeeperLookTable,
  getDeeperLook,
  requestDeeperLook,
  isDeeperLookEnabled,
  getDeeperLookSetting,
  setDeeperLookEnabled,
  refreshClaudeHealth,
  recordClaudeFailure,
  recordClaudeSuccess,
  clearFailedDeeperLooks,
  isFallbackAnalysis,
  readHealth,
  DEEPER_LOOK_SETTING,
};
