/**
 * Single shared in-progress lock for admin Discovery + Smart Refresh + Manual Analyze.
 * Prevents overlapping runs that could double-fetch the same ticker.
 */

let holder = null; // 'smart_refresh' | 'discovery' | 'board_refresh' | 'manual_analyze' | null
let startedAt = null;

function labelFor(action) {
  if (action === "discovery") return "Discovery";
  if (action === "smart_refresh") return "Smart Refresh";
  if (action === "board_refresh") return "Board refresh";
  if (action === "manual_analyze") return "Manual Analyze";
  return action || "another admin action";
}

function getAdminActionLock() {
  return {
    inProgress: Boolean(holder),
    action: holder,
    startedAt,
    message: holder
      ? `${labelFor(holder)} is already in progress — wait for it to finish.`
      : null,
  };
}

/**
 * @param {'smart_refresh'|'discovery'|'board_refresh'|'manual_analyze'} action
 * @returns {{ ok: true, action: string, startedAt: string } | { ok: false, alreadyRunning: true, action: string|null, startedAt: string|null, message: string }}
 */
function tryAcquireAdminLock(action) {
  const id = String(action || "").trim();
  if (!id) {
    return {
      ok: false,
      alreadyRunning: false,
      action: holder,
      startedAt,
      message: "Admin lock requires an action name.",
    };
  }
  if (holder) {
    return {
      ok: false,
      alreadyRunning: true,
      action: holder,
      startedAt,
      message: `${labelFor(holder)} is already in progress — not starting ${labelFor(id)}.`,
    };
  }
  holder = id;
  startedAt = new Date().toISOString();
  return { ok: true, action: holder, startedAt };
}

function releaseAdminLock(action) {
  const id = String(action || "").trim();
  if (!id || holder === id) {
    holder = null;
    startedAt = null;
  }
}

module.exports = {
  getAdminActionLock,
  tryAcquireAdminLock,
  releaseAdminLock,
};
