/**
 * Display-order helper: never drop an account id from the synced document.
 * Run: node scripts/testPaperAccounts.js
 */
const assert = require("assert");
const {
  PREFERRED_ORDER,
  sortAccountsForDisplay,
  isAccountPaused,
} = require("../lib/paperAccounts");
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

const seedSorted = sortAccountsForDisplay(seed.accounts);
assert.equal(seedSorted.length, seed.accounts.length);
assert.deepStrictEqual(
  seedSorted.map((a) => a.id),
  ["us-swing", "ca-swing", "glb-branch", "lottery-us", "lottery-ca", "us-day", "ca-day"]
);

console.log("paperAccounts: ok — glb-branch kept, unknown ids appended, nothing dropped");
