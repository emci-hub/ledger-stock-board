/**
 * Validate three-category board placement (long | short | penny).
 * No live market APIs.
 */
require("dotenv").config();
const assert = require("assert");
const {
  assessBoardPlacement,
  BOARD_SECTIONS,
  partitionBoardBySection,
  buildSectionPayload,
  statusFromBoardSection,
  NEWLY_TRACKED_LONG_RANK_CAP,
} = require("../lib/rankingStability");

function monthAgo() {
  return new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
}
function yesterday() {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

// --- Long-eligible stable ---
const stable = assessBoardPlacement(
  {
    ticker: "STBL",
    source: "seed",
    exchange: "NYSE",
    tracked_since: monthAgo(),
  },
  {
    price: 150,
    changePercent: 0.5,
    peRatio: 22,
    analystTarget: 170,
    shortTermRank: 55,
    longTermRank: 78,
  }
);
assert.strictEqual(stable.boardSection, BOARD_SECTIONS.LONG);
assert.ok(stable.longTermEligible);
assert.strictEqual(stable.sectionRank, stable.longTermRankAdjusted);

// --- Extreme mover → penny section, never long ---
const hot = assessBoardPlacement(
  {
    ticker: "RRGB",
    source: "discovery",
    exchange: "NASDAQ",
    tracked_since: yesterday(),
  },
  {
    price: 10.7,
    changePercent: 26,
    shortTermRank: 78,
    longTermRank: 72,
  }
);
assert.strictEqual(hot.boardSection, BOARD_SECTIONS.PENNY);
assert.strictEqual(hot.longTermEligible, false);
assert.notStrictEqual(hot.sectionRank, hot.shortTermRank);
assert.strictEqual(hot.sectionRank, hot.pennyVolatileRank);

// --- Penny price → penny section ---
const penny = assessBoardPlacement(
  {
    ticker: "PNY",
    source: "discovery",
    exchange: "NASDAQ",
    tracked_since: monthAgo(),
  },
  { price: 2.1, changePercent: 3, shortTermRank: 60, longTermRank: 50 }
);
assert.strictEqual(penny.boardSection, BOARD_SECTIONS.PENNY);

// --- Newly tracked, calm move → short (not long, not penny) ---
const freshCalm = assessBoardPlacement(
  {
    ticker: "NEW1",
    source: "discovery",
    exchange: "NYSE",
    tracked_since: yesterday(),
  },
  { price: 40, changePercent: 2, shortTermRank: 70, longTermRank: 65 }
);
assert.strictEqual(freshCalm.boardSection, BOARD_SECTIONS.SHORT);
assert.strictEqual(freshCalm.sectionRank, freshCalm.shortTermRank);

// --- Partition + independent spotlights ---
const rows = [
  {
    ticker: "STBL",
    boardSection: stable.boardSection,
    sectionRank: stable.sectionRank,
    report: { stale: false, ticker: "STBL" },
  },
  {
    ticker: "RRGB",
    boardSection: hot.boardSection,
    sectionRank: hot.sectionRank,
    report: { stale: false, ticker: "RRGB" },
  },
  {
    ticker: "NEW1",
    boardSection: freshCalm.boardSection,
    sectionRank: freshCalm.sectionRank,
    report: { stale: false, ticker: "NEW1" },
  },
  {
    ticker: "PNY",
    boardSection: penny.boardSection,
    sectionRank: penny.sectionRank,
    report: { stale: false, ticker: "PNY" },
  },
];
const parts = partitionBoardBySection(rows);
assert.strictEqual(parts.long.length, 1);
assert.strictEqual(parts.long[0].ticker, "STBL");
assert.ok(parts.penny.every((r) => r.boardSection === "penny"));
assert.ok(!parts.long.some((r) => r.ticker === "RRGB" || r.ticker === "PNY"));

const longPay = buildSectionPayload(parts.long);
const shortPay = buildSectionPayload(parts.short);
const pennyPay = buildSectionPayload(parts.penny);
assert.ok(longPay.spotlight.every((r) => r.boardSection === "long"));
assert.ok(pennyPay.spotlight.every((r) => r.boardSection === "penny"));
assert.ok(!longPay.spotlight.some((r) => r.ticker === "RRGB"));

// Status alignment
assert.strictEqual(
  statusFromBoardSection("bullish", "low", BOARD_SECTIONS.PENNY),
  "watch"
);
assert.strictEqual(
  statusFromBoardSection("bullish", "low", BOARD_SECTIONS.LONG),
  "recommended"
);
assert.strictEqual(
  statusFromBoardSection("bullish", "low", BOARD_SECTIONS.SHORT),
  "watch"
);

console.log("OK validateBoardSections");
console.log(
  JSON.stringify(
    {
      stable: stable.boardSection,
      hot: { section: hot.boardSection, sectionRank: hot.sectionRank, short: hot.shortTermRank },
      freshCalm: freshCalm.boardSection,
      penny: penny.boardSection,
      softCap: NEWLY_TRACKED_LONG_RANK_CAP,
      counts: {
        long: parts.long.length,
        short: parts.short.length,
        penny: parts.penny.length,
      },
    },
    null,
    2
  )
);
