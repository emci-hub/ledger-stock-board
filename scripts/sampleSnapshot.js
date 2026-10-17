/**
 * Build a paper snapshot from the uploaded sample files plus the Oct 15 seed.
 * Used by tests and by scripts/seedLabSample.js. Does not replace the boot seed.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const seed = require("../data/paper-run-seed.json");

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "data", "samples", name), "utf8"));
}

function readSignals(name) {
  const text = fs.readFileSync(path.join(ROOT, "data", "samples", name), "utf8").trim();
  const lines = text.split(/\r?\n/);
  return lines.slice(1).filter(Boolean).map((line) => {
    const cols = line.split(",");
    const takenRaw = (cols[3] || "").trim().toLowerCase();
    let taken = null;
    if (["yes", "y", "true", "1"].includes(takenRaw)) taken = true;
    else if (["no", "n", "false", "0"].includes(takenRaw)) taken = false;
    return {
      date: cols[0] || null,
      ticker: cols[1] || null,
      trigger: cols[2] || null,
      taken,
      why: cols.slice(4).join(",").trim() || null,
    };
  });
}

function paperAccount(partial) {
  return {
    currency: "USD",
    status: "active",
    benchmark: { ticker: "SPY", name: "SPDR S&P 500 ETF" },
    positions: [],
    trades: [],
    picks: [],
    scorecards: [],
    lessons: [],
    equityCurve: [],
    ...partial,
  };
}

/** Three-month replay sample. Dates are intentionally out of order. */
function backtestAccounts() {
  const curve = [
    { date: "2026-10-19", value: 1084, benchmark: 1042 },
    { date: "2026-07-16", value: 1000, benchmark: 1000 },
    { date: "2026-08-20", value: 1032, benchmark: 1014 },
    { date: "2026-09-15", value: 1055, benchmark: 1028 },
  ];
  const trades = [
    { date: "2026-10-19", time: "09:45", ticker: "NVDA", side: "BUY", shares: 1, price: 184, value: 184, reason: "Live continuation after the replay." },
    { date: "2026-07-16", time: "10:05", ticker: "AVGO", side: "BUY", shares: 2, price: 170, value: 340, reason: "Replay entry. The rule fired." },
    { date: "2026-08-20", time: "15:30", ticker: "AVGO", side: "SELL", shares: 2, price: 188, value: 376, reason: "Replay exit." },
  ];
  const shared = {
    startValue: 1000,
    currency: "USD",
    benchmark: { ticker: "SPY", name: "SPDR S&P 500 ETF", returnPct: 4.2 },
    equityCurve: curve,
    trades,
  };
  return [
    paperAccount({
      ...shared,
      id: "bt-ghost-orig",
      name: "BT-GHOST-ORIG",
      value: 1084,
      returnPct: 8.4,
      cash: 200,
    }),
    paperAccount({
      ...shared,
      id: "bt-ghost-fixed",
      name: "BT-GHOST-FIXED",
      value: 1061,
      returnPct: 6.1,
      cash: 240,
    }),
    paperAccount({
      ...shared,
      id: "bt-ghost-macro",
      name: "BT-GHOST-MACRO",
      value: 1055,
      returnPct: 5.5,
      cash: 280,
    }),
    paperAccount({
      ...shared,
      id: "bt-momentum",
      name: "BT-MOMENTUM",
      value: 1110,
      returnPct: 11,
      cash: 150,
    }),
  ];
}

function buildSampleSnapshot() {
  const watchlist = readJson("watchlist-v2.json");
  const hotToday = readJson("hot-today.json");
  const lab = readJson("lab-bench.json");
  const state = readJson("baseline-state.json");
  const signals = readSignals("ghost-orig-signals.csv");

  const ltWatch = {
    id: "lt-watch",
    kind: "watchlist",
    name: "LT-WATCH",
    label: "Frozen AI/tech watchlist",
    currency: "USD",
    benchmark: { ticker: "SPY", name: "SPDR S&P 500 ETF" },
    watchlist: { asOf: watchlist.asof, items: watchlist.stocks },
    hotToday: hotToday.hot,
  };

  const accounts = seed.accounts.concat([
    ltWatch,
    paperAccount({
      id: "us-ghost",
      name: "US-GHOST",
      label: "Ghost fixed (Ghost Playbook v1, red-teamed)",
      value: null,
    }),
    paperAccount({
      id: "ghost-orig",
      name: "GHOST-ORIG",
      label: "Gemini Ghost playbook as written",
      value: null,
      signals,
    }),
    paperAccount({
      id: "ghost-macro",
      name: "GHOST-MACRO",
      label: "Ghost dip plus market weather",
      value: null,
    }),
    paperAccount({
      id: "momentum",
      name: "MOMENTUM",
      label: "52-week-high breakouts on volume",
      value: null,
    }),
    paperAccount({
      id: "baseline",
      name: "BASELINE",
      label: "Equal-weight A/B names, bought once",
      value: state.value,
      cash: state.cash,
      valueNote: `Marked value from the baseline state file as of ${state.asof}. Start value was not in that file, so return is unavailable.`,
    }),
    ...backtestAccounts(),
  ]);

  return {
    updatedAt: "2026-10-16T21:00:00.000Z",
    day: seed.day,
    totalDays: seed.totalDays,
    run: {
      ...(seed.run || {}),
      note: "Sample snapshot for the watchlist and Strategy Lab. Paper only. Existing seed accounts are included unchanged.",
    },
    watchlist,
    hot_today: hotToday,
    lab,
    accounts,
  };
}

module.exports = { buildSampleSnapshot, readSignals };
