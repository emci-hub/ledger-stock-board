/**
 * Persist last-run metadata for scheduled / manual jobs (shown on /dev-status).
 */
const { getSetting, setSetting } = require("./usage");

const JOB_DEFS = [
  {
    id: "daily_board_refresh",
    name: "7am board refresh",
    schedule: "0 7 * * * (server local / UTC on Render)",
    enabled: true,
    description:
      "refreshBoard + resolveOldRecommendations + marketMood + didYouKnow + daily discoverHotStocks",
  },
  {
    id: "news_catchup_1pm",
    name: "1pm news catch-up",
    schedule: "not scheduled",
    enabled: false,
    description:
      "Planned news-only catch-up — not wired in cron yet (newsOnly path exists in getStockReport).",
  },
  {
    id: "daily_discovery",
    name: "Daily hot-stock discovery",
    schedule: "daily with 7am refresh (after board refresh)",
    enabled: true,
    description:
      "discoverHotStocks via Twelve Data movers; DISCOVERY_MAX_NEW cap; BOARD_MAX_SIZE archive/re-promote.",
  },
  {
    id: "monthly_cleanup_probe",
    name: "Monthly cleanup + capability probe",
    schedule: "0 4 1 * * (1st of month 04:00)",
    enabled: true,
    description: "cleanupStaleCache + joke pool + capabilityProbe + archive 90d/40-cap",
  },
  {
    id: "manual_force_refresh",
    name: "Manual smart refresh",
    schedule: "on demand (dev-status only)",
    enabled: true,
    description:
      "Quota-aware priority waterfall with per-source reserves (AV keeps 3 for live searches). Board gaps → recent → archive.",
  },
];

function settingKey(jobId) {
  return `jobRun:${jobId}`;
}

async function recordJobRun(jobId, result = {}) {
  const payload = {
    jobId,
    finishedAt: new Date().toISOString(),
    ok: result.ok !== false,
    summary: result.summary || null,
    detail: result.detail || null,
  };
  await setSetting(settingKey(jobId), JSON.stringify(payload));
  return payload;
}

async function getJobRun(jobId) {
  const raw = await getSetting(settingKey(jobId));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { finishedAt: raw, ok: null, summary: raw };
  }
}

async function listJobStatuses() {
  const out = [];
  for (const def of JOB_DEFS) {
    let last = await getJobRun(def.id);
    // Backfill 7am job row from legacy settings when no structured run yet.
    if (!last && def.id === "daily_board_refresh") {
      const at = await getSetting("lastBoardRefresh");
      const status = await getSetting("lastBoardRefreshStatus");
      if (at) {
        last = {
          finishedAt: at,
          ok: status === "full_success" || status === "partial",
          summary: status ? `boardRefreshStatus=${status} (from app_settings)` : null,
        };
      }
    }
    if (!last && def.id === "daily_discovery") {
      const at = await getSetting("lastHotStockDiscoveryAt");
      const status = await getSetting("lastHotStockDiscoveryStatus");
      if (at) {
        last = {
          finishedAt: at,
          ok: !status || !String(status).startsWith("failed"),
          summary: status ? `status=${status}` : null,
        };
      }
    }
    if (!last && def.id === "manual_force_refresh") {
      const at =
        (await getSetting("lastSmartRefresh")) ||
        (await getSetting("lastForceRefresh"));
      const status =
        (await getSetting("lastSmartRefreshStatus")) ||
        (await getSetting("lastForceRefreshStatus"));
      if (at) {
        last = {
          finishedAt: at,
          ok: status === "ok" || status === "full_success" || status === "partial",
          summary: status ? `status=${status}` : null,
        };
      }
    }
    out.push({
      ...def,
      lastRunAt: last?.finishedAt || null,
      lastOk: last == null ? null : Boolean(last.ok),
      lastSummary: last?.summary || null,
      lastDetail: last?.detail || null,
    });
  }
  return out;
}

module.exports = {
  JOB_DEFS,
  recordJobRun,
  getJobRun,
  listJobStatuses,
};
