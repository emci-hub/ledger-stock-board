const { getDb } = require("../db/schema");

function getPacificDateString(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
  }).format(date);
}

function nextMidnightPacificIso() {
  const now = new Date();
  const ptNow = new Date(
    now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" })
  );
  const next = new Date(ptNow);
  next.setHours(24, 0, 0, 0);
  return new Date(now.getTime() + (next.getTime() - ptNow.getTime())).toISOString();
}

/** Increment today's Pacific-date Alpha Vantage usage counter by 1. */
function incrementApiUsage() {
  const date = getPacificDateString();
  const db = getDb();
  db.prepare(
    `INSERT INTO api_usage (date, count) VALUES (?, 1)
     ON CONFLICT(date) DO UPDATE SET count = count + 1`
  ).run(date);
}

function getApiUsageToday() {
  const date = getPacificDateString();
  const row = getDb()
    .prepare(`SELECT count FROM api_usage WHERE date = ?`)
    .get(date);
  return Number(row?.count || 0);
}

module.exports = {
  incrementApiUsage,
  getApiUsageToday,
  getPacificDateString,
  nextMidnightPacificIso,
};
