/**
 * One-shot force refresh for all live board tickers.
 * Bypasses per-field freshness TTLs; never loops; in-progress lock prevents double-fire.
 */
const { refreshBoard } = require("./refreshBoard");
const { getUsageToday, PROVIDERS } = require("../services/usage");
const { recordJobRun } = require("../services/jobRuns");

let inProgress = false;
let startedAt = null;
let lastResult = null;

const USAGE_PROVIDERS = [
  { key: "twelve_data", provider: PROVIDERS.TWELVE },
  { key: "alpha_vantage", provider: PROVIDERS.ALPHA },
  { key: "finnhub", provider: PROVIDERS.FINNHUB },
  { key: "marketaux", provider: PROVIDERS.MARKETAUX },
  { key: "gemini", provider: PROVIDERS.GEMINI },
  { key: "claude", provider: PROVIDERS.CLAUDE },
];

async function snapshotUsage() {
  const out = {};
  for (const { key, provider } of USAGE_PROVIDERS) {
    out[key] = await getUsageToday(provider);
  }
  return out;
}

function usageDelta(before, after) {
  const calls = {};
  let total = 0;
  for (const { key } of USAGE_PROVIDERS) {
    const n = Math.max(0, Number(after[key] || 0) - Number(before[key] || 0));
    calls[key] = n;
    total += n;
  }
  return { calls, total };
}

function getForceRefreshState() {
  return {
    inProgress,
    startedAt,
    lastResult,
  };
}

/**
 * Force-refresh the live board once.
 * Returns immediately with alreadyRunning if a run is in flight.
 */
async function forceRefreshAll() {
  if (inProgress) {
    return {
      ok: false,
      alreadyRunning: true,
      startedAt,
      message: "Force refresh already in progress — not starting another run.",
      lastResult,
    };
  }

  inProgress = true;
  startedAt = new Date().toISOString();
  const usageBefore = await snapshotUsage();

  try {
    console.log(
      `[forceRefreshAll] Starting forced board refresh at ${startedAt}`
    );
    // Shared report covers both short + long takes in one pass.
    const board = await refreshBoard({ forceRefresh: true });
    const usageAfter = await snapshotUsage();
    const { calls, total } = usageDelta(usageBefore, afterSafe(usageAfter));

    const succeeded = Number(board?.successes ?? 0);
    const failed = Number(board?.skipped ?? 0);
    const tickers = Number(board?.tickerCount ?? succeeded + failed);

    const result = {
      ok: true,
      alreadyRunning: false,
      startedAt,
      finishedAt: new Date().toISOString(),
      message: "Force refresh completed (single pass, freshness bypassed).",
      tickers,
      succeeded,
      failed,
      fetched: board?.fetched ?? null,
      cacheReused: board?.cacheReused ?? null,
      boardRefreshStatus: board?.boardRefreshStatus || null,
      callsBySource: calls,
      totalCalls: total,
      usageBefore,
      usageAfter,
      note: "One shared report per ticker includes both short and long AI takes.",
    };

    lastResult = result;
    await recordJobRun("manual_force_refresh", {
      ok: true,
      summary: `${succeeded}/${tickers} ok · ${total} API calls · status=${result.boardRefreshStatus}`,
      detail: result,
    });
    console.log(
      `[forceRefreshAll] Done — succeeded=${succeeded} failed=${failed} calls=${total}`
    );
    return result;
  } catch (err) {
    const usageAfter = await snapshotUsage().catch(() => usageBefore);
    const { calls, total } = usageDelta(usageBefore, afterSafe(usageAfter));
    const result = {
      ok: false,
      alreadyRunning: false,
      startedAt,
      finishedAt: new Date().toISOString(),
      message: err.message || "Force refresh failed.",
      callsBySource: calls,
      totalCalls: total,
      usageBefore,
      usageAfter,
    };
    lastResult = result;
    await recordJobRun("manual_force_refresh", {
      ok: false,
      summary: `failed: ${err.message}`,
      detail: result,
    }).catch(() => {});
    throw err;
  } finally {
    inProgress = false;
  }
}

function afterSafe(u) {
  return u && typeof u === "object" ? u : {};
}

module.exports = {
  forceRefreshAll,
  getForceRefreshState,
};
