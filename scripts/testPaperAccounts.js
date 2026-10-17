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
  ["glb-branch", "lottery-ca", "us-day", "zzz-future", "mystery", "us-swing"],
  "known ids sort first; unknown ids follow; us-swing is last when present"
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
  ["lt-watch", "ca-swing", "zzz-future", "us-swing"],
  "lt-watch sorts first; us-swing is last when present"
);
assert.equal(PREFERRED_ORDER[0], "lt-watch");
assert.equal(PREFERRED_ORDER.includes("us-swing"), false);
assert.equal(SHELVED_LAST_ID, "us-swing");
assert.equal(withWatch.length, 4, "watchlist sort never drops ids");

assert.equal(displayName({ id: "us-day", name: "US-DAY", label: "US day trading (paused)" }), "US Long-Term v5");
assert.equal(displayLabel({ id: "us-day", name: "US-DAY", label: "US day trading (paused)" }), "");
assert.equal(isAccountPaused({ id: "us-day", status: "paused", paused: true }), false);
assert.equal(displayStatus({ id: "us-day", status: "paused" }), "active");
assert.equal(displayName({ id: "us-swing", name: "US-SWING" }), "US Swing (shelved)");
assert.equal(displayStatus({ id: "us-swing", status: "active" }), "shelved");
assert.equal(displayName({ id: "ca-swing", name: "CA swing" }), "CA swing");
assert.equal(isAccountPaused({ id: "ca-day", status: "paused" }), true);
assert.equal(missingValueLabel({ id: "ghost-orig", value: null }), "Starts at next sync");
assert.equal(missingValueLabel({ id: "us-ghost" }), "Starts at next sync");
assert.equal(missingValueLabel({ id: "momentum" }), "Starts at next sync");
assert.equal(missingValueLabel({ id: "baseline" }), "Starts at next sync");
assert.equal(missingValueLabel({ id: "us-day" }), "Starts at next sync");
assert.equal(missingValueLabel({ id: "ca-swing", value: null }), "unavailable");

const practiceLib = fs.readFileSync(path.join(__dirname, "..", "public", "practice-lib.js"), "utf8");
const orderBlock = practiceLib.slice(
  practiceLib.indexOf("const PREFERRED_ORDER"),
  practiceLib.indexOf("];", practiceLib.indexOf("const PREFERRED_ORDER")) + 2
);
assert.ok(orderBlock.indexOf('"lt-watch"') !== -1, "practice-lib preferred order includes lt-watch");
assert.equal(orderBlock.indexOf('"us-swing"'), -1, "practice-lib preferred order does not pin us-swing");
assert.ok(practiceLib.includes("US Long-Term v5"), "practice-lib labels us-day");
assert.ok(practiceLib.includes("US Swing (shelved)"), "practice-lib labels us-swing");
assert.ok(practiceLib.includes("Starts at next sync"), "practice-lib names the waiting lab value");

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
assert.equal(watchlistBenchmarkLine(accepted.accounts[0]), "VOO —");

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
assert.equal(watchlistBenchmarkLine(spyBlank.accounts[0]), "SPY —");

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
  ["ca-swing", "glb-branch", "lottery-us", "lottery-ca", "us-day", "ca-day", "us-swing"]
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
