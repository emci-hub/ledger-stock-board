/**
 * Display-order helper: never drop an account id from the synced document.
 * Also checks watchlist ordering and paper-run validation (no money value).
 * Run: node scripts/testPaperAccounts.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  PREFERRED_ORDER,
  SHELVED_LAST_ID,
  sortAccountsForDisplay,
  isAccountPaused,
  isWatchlistAccount,
  watchlistSummary,
  watchlistBenchmarkLine,
  displayName,
  displayLabel,
  displayStatus,
  missingValueLabel,
  groupAccounts,
  accountBlurb,
} = require("../lib/paperAccounts");
const { normalizeSnapshot, PaperSnapshotError } = require("../services/paperRun");
const seed = require("../data/paper-run-seed.json");

assert.ok(PREFERRED_ORDER.includes("glb-branch"), "glb-branch belongs in preferred order");

const seedIds = seed.accounts.map((a) => a.id);
assert.ok(seedIds.includes("glb-branch"), "seed snapshot includes glb-branch");
const glb = seed.accounts.find((a) => a.id === "glb-branch");
assert.equal(glb.label, "Green line breakout");
assert.equal(glb.benchmark.ticker, "VOO");
assert.equal(glb.status, "active");
assert.equal(isAccountPaused(glb), false);

const mixed = [
  { id: "zzz-future" },
  { id: "us-day" },
  { id: "glb-branch" },
  { id: "mystery" },
  { id: "us-swing" },
  { id: "lottery-ca" },
];
const sorted = sortAccountsForDisplay(mixed);
assert.deepStrictEqual(
  sorted.map((a) => a.id),
  ["us-day", "glb-branch", "lottery-ca", "us-swing", "zzz-future", "mystery"],
  "sections first, then unknown ids; us-swing stays inside older experiments"
);
assert.equal(sorted.length, mixed.length, "sort never drops ids");

const onlyUnknown = sortAccountsForDisplay([{ id: "alpha" }, { id: "beta" }]);
assert.deepStrictEqual(onlyUnknown.map((a) => a.id), ["alpha", "beta"]);

const withNulls = sortAccountsForDisplay([null, { id: "glb-branch" }, undefined]);
assert.deepStrictEqual(withNulls.map((a) => a.id), ["glb-branch"]);

assert.deepStrictEqual(sortAccountsForDisplay(null), []);
assert.deepStrictEqual(sortAccountsForDisplay(undefined), []);

const withWatch = sortAccountsForDisplay([
  { id: "us-swing" },
  { id: "zzz-future" },
  { id: "lt-watch", kind: "watchlist" },
  { id: "ca-swing" },
]);
assert.deepStrictEqual(
  withWatch.map((a) => a.id),
  ["lt-watch", "ca-swing", "us-swing", "zzz-future"],
  "watchlist, then older experiments, then unknown ids"
);
assert.equal(PREFERRED_ORDER[0], "lt-watch");
assert.equal(PREFERRED_ORDER[PREFERRED_ORDER.length - 1], "us-swing");
assert.equal(SHELVED_LAST_ID, "us-swing");
assert.equal(withWatch.length, 4, "watchlist sort never drops ids");

assert.equal(displayName({ id: "us-day", name: "US-DAY", label: "US day trading (paused)" }), "US Long-Term v5");
assert.equal(displayLabel({ id: "us-day", name: "US-DAY", label: "US day trading (paused)" }), "");
assert.equal(isAccountPaused({ id: "us-day", status: "paused", paused: true }), false);
assert.equal(displayStatus({ id: "us-day", status: "paused" }), "active");
assert.equal(displayName({ id: "us-swing", name: "US-SWING" }), "US swing (shelved, tracking last positions)");
assert.equal(displayStatus({ id: "us-swing", status: "active" }), "shelved");
assert.equal(displayName({ id: "ca-swing", name: "CA swing" }), "Canadian swing");
assert.equal(displayName({ id: "baseline", name: "BASELINE" }), "Buy & hold A/B names, the bar to beat");
assert.equal(displayName({ id: "ghost-orig" }), "Ghost Dip, Gemini version");
assert.equal(displayName({ id: "us-ghost" }), "Ghost Dip, red-teamed");
assert.equal(displayName({ id: "momentum" }), "Breakout momentum");
assert.equal(displayName({ id: "lottery-ca" }), "Lottery (high-risk small bets)");
assert.equal(isAccountPaused({ id: "ca-day", status: "paused" }), true);
assert.equal(missingValueLabel({ id: "ghost-orig", value: null }), "Starts at next sync");
assert.equal(missingValueLabel({ id: "ca-swing", value: null }), "Starts at next sync");
assert.equal(
  accountBlurb({ id: "baseline" }),
  "Bought the top-graded stocks once and holds them. The bar to beat."
);
assert.equal(
  accountBlurb({ id: "ghost-orig" }),
  "Waits for a great company to drop hard, checks why with AI, buys once the chart turns up."
);
assert.equal(
  accountBlurb({ id: "us-ghost" }),
  "Same idea with stricter safety rules: smaller bets, set exits, a profit-taking rule."
);
assert.equal(
  accountBlurb({ id: "momentum" }),
  "Buys strong stocks hitting new highs on big volume, sells when the trend breaks."
);
assert.equal(
  accountBlurb({ id: "us-day" }),
  "Buy-and-hold quality companies in small steps, rules frozen while we test."
);
assert.equal(displayName({ id: "bt-ghost-orig" }), "Ghost Dip, Gemini (backtest)");
assert.equal(displayName({ id: "bt-ghost-fixed" }), "Ghost Dip, red-teamed (backtest)");
assert.equal(displayName({ id: "bt-momentum" }), "Breakout momentum (backtest)");
assert.equal(
  accountBlurb({ id: "bt-ghost-orig" }),
  "Waits for a great company to drop hard, checks why with AI, buys once the chart turns up. (replayed from Jul 16)"
);
assert.equal(
  accountBlurb({ id: "bt-momentum" }),
  "Buys strong stocks hitting new highs on big volume, sells when the trend breaks. (replayed from Jul 16)"
);

const withBacktest = groupAccounts([
  { id: "momentum" },
  { id: "bt-momentum" },
  { id: "us-day" },
  { id: "bt-ghost-orig" },
  { id: "baseline" },
  { id: "bt-ghost-fixed" },
]);
assert.deepStrictEqual(
  withBacktest.map((group) => group.id),
  ["lab", "lab-backtest", "long-term"]
);
assert.equal(
  withBacktest[1].summary,
  "The same three strategies replayed from mid-July with US$1,000 each, buying only on days their rules fired, then continuing live from Oct 19. Shows what could have happened. The AI check is replaced by fixed rules in the replay."
);
assert.deepStrictEqual(
  withBacktest[1].accounts.map((account) => account.id),
  ["bt-ghost-orig", "bt-ghost-fixed", "bt-momentum"]
);
assert.equal(withBacktest[1].accounts.length + withBacktest[0].accounts.length + withBacktest[2].accounts.length, 6);

const grouped = groupAccounts([
  { id: "us-swing" },
  { id: "momentum" },
  { id: "lt-watch" },
  { id: "us-day" },
  { id: "baseline" },
  { id: "mystery" },
  { id: "ghost-orig" },
  { id: "us-ghost" },
]);
assert.deepStrictEqual(
  grouped.map((group) => group.id),
  ["watchlist", "lab", "long-term", "older", "other"]
);
assert.equal(
  grouped[1].summary,
  "Four pretend US$1,000 accounts, each following one fixed strategy, picking only from the watchlist. We see which beats simply holding."
);
assert.deepStrictEqual(
  grouped[1].accounts.map((account) => account.id),
  ["baseline", "ghost-orig", "us-ghost", "momentum"]
);
assert.equal(grouped[3].collapsed, true);
assert.equal(grouped.length, 5);
assert.equal(
  grouped.reduce((n, group) => n + group.accounts.length, 0),
  8,
  "grouping never drops an id"
);

const practiceLib = fs.readFileSync(path.join(__dirname, "..", "public", "practice-lib.js"), "utf8");
const groupFile = fs.readFileSync(path.join(__dirname, "..", "public", "account-groups.js"), "utf8");
assert.ok(practiceLib.includes("AccountGroups"), "practice-lib reads the shared group map");
assert.ok(groupFile.includes("US Long-Term v5"), "group map labels us-day");
assert.ok(groupFile.includes("US swing (shelved, tracking last positions)"), "group map labels us-swing");
assert.ok(practiceLib.includes("Starts at next sync"), "practice-lib names the waiting value");
const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
assert.ok(serverSrc.includes('app.get("/strategy-lab"'), "strategy-lab redirects toward /lab");
assert.ok(serverSrc.includes('res.redirect(302, "/lab")'), "strategy-lab redirect target is /lab");

const graded = Array.from({ length: 35 }, (_, i) => ({
  ticker: `T${i}`,
  grade: i < 2 ? "A" : i < 10 ? "b" : "C",
}));
assert.equal(
  watchlistSummary({ kind: "watchlist", watchlist: { items: graded } }),
  "35 names · top grade A"
);
assert.equal(
  watchlistSummary({ watchlist: { items: [{ ticker: "X", grade: "B" }] } }),
  "1 name · top grade B"
);
assert.equal(watchlistSummary({ watchlist: { items: [{ ticker: "X" }] } }), "1 name");
assert.equal(watchlistSummary({}), "0 names");
assert.equal(isWatchlistAccount({ kind: "Watchlist" }), true);
assert.equal(isWatchlistAccount({ kind: "swing" }), false);

function watchlistAccount(extra) {
  return {
    id: "lt-watch",
    kind: "watchlist",
    name: "LT Watch",
    label: "Long-term watchlist",
    currency: "USD",
    value: null,
    cash: null,
    startValue: null,
    returnPct: null,
    benchmark: { ticker: "VOO", name: "Vanguard S&P 500 ETF" },
    watchlist: {
      asOf: "2026-10-15",
      items: [
        { ticker: "TSM", grade: "A", ROIC: 0.4, core: false },
        { ticker: "AMD", grade: "D", ROIC: "inf", core: true },
      ],
    },
    hotToday: [{ ticker: "P", grade: "C", chg_pct: -9.86, why: "move" }],
    ...extra,
  };
}

const accepted = normalizeSnapshot({ day: 1, accounts: [watchlistAccount()] });
assert.equal(accepted.accounts[0].kind, "watchlist");
assert.equal(accepted.accounts[0].value, null, "explicit null value stays null, not 0");
assert.equal(accepted.accounts[0].cash, null);
assert.equal(accepted.accounts[0].startValue, null);
assert.equal(accepted.accounts[0].returnPct, null);
assert.equal(accepted.accounts[0].watchlist.items[1].ROIC, "inf");
assert.equal(accepted.accounts[0].benchmark.ticker, "VOO");
assert.equal(accepted.accounts[0].benchmark.value, null, "omitted benchmark value stays null");
assert.equal(accepted.accounts[0].benchmark.returnPct, null, "omitted benchmark return stays null");
assert.equal(watchlistBenchmarkLine(accepted.accounts[0]), "");

const spyBlank = normalizeSnapshot({
  accounts: [
    watchlistAccount({
      benchmark: { ticker: "SPY", name: "SPDR S&P 500 ETF", value: null, returnPct: null },
    }),
  ],
});
assert.equal(spyBlank.accounts[0].benchmark.ticker, "SPY");
assert.equal(spyBlank.accounts[0].benchmark.value, null);
assert.equal(spyBlank.accounts[0].benchmark.returnPct, null);
assert.equal(watchlistBenchmarkLine(spyBlank.accounts[0]), "");

const spyQuoted = normalizeSnapshot({
  accounts: [
    watchlistAccount({
      benchmark: { ticker: "SPY", value: 512.4, returnPct: 1.25 },
    }),
  ],
});
assert.equal(spyQuoted.accounts[0].benchmark.value, 512.4);
assert.equal(spyQuoted.accounts[0].benchmark.returnPct, 1.25);
assert.equal(watchlistBenchmarkLine(spyQuoted.accounts[0]), "SPY 512.4 / 1.25%");

const spyZero = normalizeSnapshot({
  accounts: [watchlistAccount({ benchmark: { ticker: "SPY", value: 0, returnPct: 0 } })],
});
assert.equal(spyZero.accounts[0].benchmark.value, 0, "a real zero is kept");
assert.equal(spyZero.accounts[0].benchmark.returnPct, 0);
assert.equal(watchlistBenchmarkLine(spyZero.accounts[0]), "SPY 0 / 0%");

const normalNullBench = normalizeSnapshot({
  accounts: [
    {
      id: "us-swing",
      currency: "USD",
      value: 1000,
      benchmark: { ticker: "VOO", value: null, returnPct: null },
    },
  ],
});
assert.equal(normalNullBench.accounts[0].benchmark.value, 0);
assert.equal(normalNullBench.accounts[0].benchmark.returnPct, 0);

const omitted = watchlistAccount();
delete omitted.value;
const omittedDoc = normalizeSnapshot({ accounts: [omitted] });
assert.equal(omittedDoc.accounts[0].value, null, "omitted value is allowed on a watchlist");

const keptNumber = normalizeSnapshot({
  accounts: [watchlistAccount({ value: 1000, returnPct: 1.5 })],
});
assert.equal(keptNumber.accounts[0].value, 1000);
assert.equal(keptNumber.accounts[0].returnPct, 1.5);

assert.throws(
  () =>
    normalizeSnapshot({
      accounts: [
        {
          id: "us-swing",
          currency: "USD",
          benchmark: { ticker: "VOO" },
        },
      ],
    }),
  (err) =>
    err instanceof PaperSnapshotError &&
    err.errors.some((line) => line.includes("accounts[0].value must be a number")),
  "a paper account still needs a numeric value"
);

assert.throws(
  () =>
    normalizeSnapshot({
      accounts: [
        {
          id: "lt-watch",
          kind: "watchlist",
          currency: "USD",
          value: null,
        },
      ],
    }),
  (err) =>
    err instanceof PaperSnapshotError &&
    err.errors.some((line) => line.includes("benchmark")),
  "a watchlist still needs a benchmark object"
);

const seedSorted = sortAccountsForDisplay(seed.accounts);
assert.equal(seedSorted.length, seed.accounts.length);
assert.deepStrictEqual(
  seedSorted.map((a) => a.id),
  ["us-day", "ca-swing", "glb-branch", "lottery-us", "lottery-ca", "ca-day", "us-swing"]
);

const seedNorm = normalizeSnapshot(seed);
assert.equal(seedNorm.accounts.length, seed.accounts.length);
const seededSwing = seedNorm.accounts.find((a) => a.id === "us-swing");
assert.equal(seededSwing.value, 996.35);
assert.equal(seededSwing.benchmark.value, 1003.75);
assert.equal(seededSwing.benchmark.returnPct, 0.37);
assert.equal(seedNorm.accounts.find((a) => a.id === "glb-branch").benchmark.ticker, "VOO");

console.log(
  "paperAccounts: ok — glb-branch kept, lt-watch sorts first, watchlist benchmark null stays null"
);
