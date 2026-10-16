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
  sortAccountsForDisplay,
  isAccountPaused,
  isWatchlistAccount,
  watchlistSummary,
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
  ["us-swing", "glb-branch", "lottery-ca", "us-day", "zzz-future", "mystery"],
  "known ids sort first; unknown ids are appended in original order"
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
  ["lt-watch", "us-swing", "ca-swing", "zzz-future"],
  "lt-watch sorts first, in the slot ahead of us-swing; unknown ids stay appended"
);
assert.equal(PREFERRED_ORDER[0], "lt-watch");
assert.equal(withWatch.length, 4, "watchlist sort never drops ids");

const practiceLib = fs.readFileSync(path.join(__dirname, "..", "public", "practice-lib.js"), "utf8");
const orderBlock = practiceLib.slice(
  practiceLib.indexOf("const PREFERRED_ORDER"),
  practiceLib.indexOf("];", practiceLib.indexOf("const PREFERRED_ORDER")) + 2
);
assert.ok(orderBlock.indexOf('"lt-watch"') !== -1, "practice-lib preferred order includes lt-watch");
assert.ok(
  orderBlock.indexOf('"lt-watch"') < orderBlock.indexOf('"us-swing"'),
  "practice-lib lists lt-watch ahead of us-swing"
);

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
  ["us-swing", "ca-swing", "glb-branch", "lottery-us", "lottery-ca", "us-day", "ca-day"]
);

const seedNorm = normalizeSnapshot(seed);
assert.equal(seedNorm.accounts.length, seed.accounts.length);
assert.equal(seedNorm.accounts.find((a) => a.id === "us-swing").value, 996.35);
assert.equal(seedNorm.accounts.find((a) => a.id === "glb-branch").benchmark.ticker, "VOO");

console.log(
  "paperAccounts: ok — glb-branch kept, lt-watch sorts first, watchlist value may be null, nothing dropped"
);
