/**
 * Ingest for the optional watchlist, hot_today, lab, and per-account signals.
 * Also checks Strategy Lab display math. No network, no market APIs.
 * Run: node scripts/testPaperIngest.js
 */
const assert = require("assert");
const { normalizeSnapshot, PaperSnapshotError } = require("../services/paperRun");
const seed = require("../data/paper-run-seed.json");
const { buildSampleSnapshot } = require("./sampleSnapshot");
const Lab = require("../public/strategy-lab-lib");

const bare = normalizeSnapshot(seed);
assert.equal(bare.accounts.length, seed.accounts.length);
assert.equal(Object.prototype.hasOwnProperty.call(bare, "watchlist"), false);
assert.equal(Object.prototype.hasOwnProperty.call(bare, "hot_today"), false);
assert.equal(Object.prototype.hasOwnProperty.call(bare, "lab"), false);
assert.equal(bare.accounts.find((a) => a.id === "us-swing").value, 996.35);
assert.equal(Object.prototype.hasOwnProperty.call(bare.accounts[0], "signals"), false);

const sample = buildSampleSnapshot();
const doc = normalizeSnapshot(sample);
const ids = doc.accounts.map((a) => a.id);
for (const id of [
  "us-swing",
  "ca-swing",
  "glb-branch",
  "lottery-us",
  "lottery-ca",
  "us-day",
  "ca-day",
  "lt-watch",
  "us-ghost",
  "ghost-orig",
  "momentum",
  "baseline",
]) {
  assert.ok(ids.includes(id), `sample keeps ${id}`);
}
assert.equal(doc.watchlist.stocks.length, 45);
const msft = doc.watchlist.stocks.find((s) => s.ticker === "MSFT");
assert.equal(msft.grade, "A");
assert.equal(msft.score, 85);
assert.equal(msft.roic3, sample.watchlist.stocks.find((s) => s.ticker === "MSFT").roic3);
assert.equal(msft.capex_dip, false);
assert.equal(msft.core, true);
assert.equal(msft.disruption, "GREEN");
assert.ok(doc.watchlist.explain.roic3.includes("invested capital"));
assert.ok(doc.watchlist.explain.capex_dip.includes("capex"));
const nflx = doc.watchlist.stocks.find((s) => s.ticker === "NFLX");
assert.deepStrictEqual(nflx.fails, ["gm"]);
const adobe = doc.watchlist.stocks.find((s) => s.disruption === "RED");
assert.ok(adobe, "a RED disruption check is kept");

assert.equal(doc.hot_today.asof, "2026-10-16");
assert.ok(doc.hot_today.hot.length > 0);
assert.equal(doc.hot_today.hot[0].ticker, "PLTR");
assert.equal(doc.hot_today.hot[0].chg_pct, -7.22);
assert.equal(doc.hot_today.hot[0].hot, true);
assert.ok(Array.isArray(doc.hot_today.all) && doc.hot_today.all.length >= doc.hot_today.hot.length);

assert.equal(doc.lab.SPY, 763.25);
assert.equal(doc.lab.QQQ_now, sample.lab.QQQ_now);
assert.equal(doc.lab.start, "2026-10-16");

const ghost = doc.accounts.find((a) => a.id === "ghost-orig");
assert.equal(ghost.value, null, "explicit null value stays null");
assert.equal(ghost.signals.length, 2);
assert.equal(ghost.signals[0].ticker, "AMAT");
assert.equal(ghost.signals[0].taken, false);
assert.ok(ghost.signals[0].why.includes("frozen Ghost"));
assert.equal(ghost.signals[1].taken, false);

const baseline = doc.accounts.find((a) => a.id === "baseline");
assert.equal(baseline.value, 987.25);
assert.equal(baseline.cash, 0);
assert.equal(baseline.returnPct, null, "omitted return stays null, not zero");

const watch = doc.accounts.find((a) => a.id === "lt-watch");
assert.equal(watch.kind, "watchlist");
assert.equal(watch.value, null);
assert.equal(watch.benchmark.value, null);

assert.ok(Buffer.byteLength(JSON.stringify(doc), "utf8") < 2 * 1024 * 1024);

function rejects(doc, needle) {
  assert.throws(
    () => normalizeSnapshot(doc),
    (err) => err instanceof PaperSnapshotError && err.errors.some((line) => line.includes(needle)),
    `expected rejection mentioning ${needle}`
  );
}

const one = {
  accounts: [{ id: "us-swing", currency: "USD", value: 1000, benchmark: { ticker: "VOO" } }],
};
rejects({ ...one, watchlist: [] }, "watchlist must be an object");
rejects({ ...one, watchlist: { stocks: [{ name: "Nope" }] } }, "ticker is required");
rejects({ ...one, hot_today: [] }, "hot_today must be an object");
rejects({ ...one, hot_today: { hot: [{}] } }, "ticker is required");
rejects({ ...one, lab: [] }, "lab must be an object");
rejects({ ...one, lab: { SPY: "nope" } }, "lab.SPY must be a number");
rejects(
  {
    accounts: [
      {
        id: "us-swing",
        currency: "USD",
        value: 1000,
        benchmark: { ticker: "VOO" },
        signals: { date: "2026-10-16" },
      },
    ],
  },
  "signals must be an array"
);
rejects(
  {
    accounts: [
      {
        id: "us-swing",
        currency: "USD",
        value: 1000,
        benchmark: { ticker: "VOO" },
        signals: [{ date: "2026-10-16", taken: "yes" }],
      },
    ],
  },
  "ticker is required"
);

const yesNo = normalizeSnapshot({
  accounts: [
    {
      id: "ghost-orig",
      currency: "USD",
      value: null,
      benchmark: { ticker: "SPY" },
      signals: [
        { date: "2026-10-16", ticker: "NVDA", trigger: "breakout", taken: "yes", reason: "size ok" },
        { date: "2026-10-16", ticker: "AMD", trigger: "dip", taken: false, why: "spread" },
      ],
    },
  ],
});
assert.equal(yesNo.accounts[0].signals[0].taken, true);
assert.equal(yesNo.accounts[0].signals[0].why, "size ok");
assert.equal(yesNo.accounts[0].signals[1].taken, false);
assert.equal(yesNo.accounts[0].signals[1].why, "spread");

assert.equal(Lab.addMonthsIso("2026-10-16", 6), "2027-04-16");
assert.equal(Lab.daysBetween("2026-10-16", "2027-04-16"), 182);
assert.equal(Lab.benchReturn({ SPY: 100, SPY_now: 110 }, "SPY", "SPY_now"), 10);
assert.equal(Lab.benchReturn({ SPY: 763.25, SPY_now: 763.25 }, "SPY", "SPY_now"), 0);
assert.equal(Lab.benchReturn({}, "SPY", "SPY_now"), null);
assert.equal(Lab.closedTradeCount({ trades: [{ side: "BUY" }, { side: "sell" }, { side: "SELL" }] }), 2);
assert.equal(Lab.closedTradeCount({ closedTrades: 4, trades: [{ side: "SELL" }] }), 4);

const early = Lab.judgingProgress({ start: "2026-10-16", asof: "2026-10-16", closedTrades: 0 });
assert.equal(early.ready, false);
assert.equal(early.elapsedDays, 0);
assert.equal(early.totalDays, 182);
assert.equal(early.fraction, 0);

const tradesOnly = Lab.judgingProgress({ start: "2026-10-16", asof: "2026-10-16", closedTrades: 20 });
assert.equal(tradesOnly.ready, false, "20 trades on day 0 is not yet the later bar");

const timeOnly = Lab.judgingProgress({ start: "2026-10-16", asof: "2027-04-16", closedTrades: 3 });
assert.equal(timeOnly.ready, false, "6 months without 20 trades is not yet the later bar");

const ready = Lab.judgingProgress({ start: "2026-10-16", asof: "2027-04-16", closedTrades: 20 });
assert.equal(ready.ready, true);
assert.equal(ready.fraction, 1);

const board = Lab.scoreboard(doc);
assert.equal(board.spyReturn, 0);
assert.equal(board.qqqReturn, 0);
assert.equal(board.rows.length, 5);
assert.deepStrictEqual(
  board.rows.map((row) => row.id),
  ["ghost-orig", "us-ghost", "momentum", "baseline", "us-day"]
);
const usDay = board.rows.find((row) => row.id === "us-day");
assert.equal(usDay.returnPct, 0.77);
assert.equal(usDay.vsSpy, 0.77);
assert.equal(usDay.vsQqq, 0.77);
assert.equal(usDay.vsBaseline, null, "baseline has no synced return, so the gap is unavailable");
assert.equal(usDay.closedTrades, 0);
assert.equal(usDay.progress.ready, false);
const baseRow = board.rows.find((row) => row.id === "baseline");
assert.equal(baseRow.value, 987.25);
assert.equal(baseRow.returnPct, null);
assert.equal(baseRow.vsSpy, null);
const ghostRow = board.rows.find((row) => row.id === "ghost-orig");
assert.equal(ghostRow.signals.length, 2);
assert.equal(ghostRow.value, null);

const missing = Lab.scoreboard({ accounts: [], lab: { start: "2026-10-16", asof: "2026-10-16", SPY: 1, SPY_now: 1, QQQ: 1, QQQ_now: 1 } });
assert.equal(missing.rows.length, 5);
assert.ok(missing.rows.every((row) => row.present === false));

console.log("paper ingest: ok — watchlist, hot today, lab, signals, and the judging bar");
