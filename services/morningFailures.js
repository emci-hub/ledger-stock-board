/**
 * Morning board refresh failure log — used by the 1pm lightweight retry cron.
 * Stored in app_settings as JSON.
 */

const { getSetting, setSetting } = require("../services/usage");

const SETTING_KEY = "lastMorningRefreshFailures";

async function saveMorningRefreshFailures(payload) {
  const body = {
    at: new Date().toISOString(),
    ...payload,
  };
  await setSetting(SETTING_KEY, JSON.stringify(body));
  return body;
}

async function loadMorningRefreshFailures() {
  const raw = await getSetting(SETTING_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function clearMorningRefreshFailures() {
  await setSetting(SETTING_KEY, JSON.stringify({ at: new Date().toISOString(), failures: [] }));
}

module.exports = {
  SETTING_KEY,
  saveMorningRefreshFailures,
  loadMorningRefreshFailures,
  clearMorningRefreshFailures,
};
