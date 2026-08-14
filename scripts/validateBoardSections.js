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
  THIN_HISTORY_LONG_RANK_CAP,
} = require("../lib/rankingStability");

function yesterday() {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

function synthCloses(n, start = 100) {
  const out = [start];
  for (let i = 1; i < n; i++) out.push(out[i - 1] * 1.001);
  return out;
}

// --- Long-eligible stable (real IPO, calm) even if just added to Ledger ---
const stable = assessBoardPlacement(
  {
    ticker: "STBL",
    source: "discovery",
    exchange: "NYSE",
    tracked_since: yesterday(),
  },
  {
    price: 150,
    changePercent: 0.5,
    peRatio: 22,
    analystTarget: 170,
    ipoDate: "1995-06-01",
    marketCap: 5e10,
    shortTermRank: 55,
    longTermRank: 78,
    priceHistory: synthCloses(200),
    historyBars: 400,
    indicators: { long: { sma: { sma200: 140 } } },
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
    ipoDate: "2000-01-01",
    marketCap: 2e9,
    priceHistory: synthCloses(200),
    historyBars: 200,
  }
);
assert.strictEqual(hot.boardSection, BOARD_SECTIONS.PENNY);
assert.strictEqual(hot.longTermEligible, false);
assert.notStrictEqual(hot.sectionRank, hot.shortTermRank);

// --- Penny price → penny section ---
const penny = assessBoardPlacement(
  {
    ticker: "PNY",
    source: "discovery",
    exchange: "NASDAQ",
    tracked_since: yesterday(),
  },
  {
    price: 2.1,
    changePercent: 3,
    shortTermRank: 60,
    longTermRank: 50,
    ipoDate: "2010-01-01",
    marketCap: 5e8,
    priceHistory: synthCloses(200),
    historyBars: 200,
  }
);
assert.strictEqual(penny.boardSection, BOARD_SECTIONS.PENNY);

// --- Thin real history, calm → short (not long) ---
const thin = assessBoardPlacement(
  {
    ticker: "NEW1",
    source: "discovery",
    exchange: "NYSE",
    tracked_since: yesterday(),
  },
  {
    price: 40,
    changePercent: 2,
    shortTermRank: 70,
    longTermRank: 65,
    ipoDate: null,
    marketCap: null,
    priceHistory: synthCloses(25),
    historyBars: 25,
    indicators: { long: { sma: { sma200: null } } },
  }
);
assert.strictEqual(thin.boardSection, BOARD_SECTIONS.SHORT);
assert.strictEqual(thin.sectionRank, thin.shortTermRank);

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
    boardSection: thin.boardSection,
    sectionRank: thin.sectionRank,
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
assert.ok(!parts.long.some((r) => r.ticker === "RRGB" || r.ticker === "PNY"));

assert.strictEqual(
  statusFromBoardSection("bullish", "low", BOARD_SECTIONS.PENNY),
  "watch"
);
assert.strictEqual(
  statusFromBoardSection("bullish", "low", BOARD_SECTIONS.LONG),
  "recommended"
);

console.log("OK validateBoardSections");
console.log(
  JSON.stringify(
    {
      stable: stable.boardSection,
      hot: hot.boardSection,
      thin: thin.boardSection,
      penny: penny.boardSection,
      softCap: THIN_HISTORY_LONG_RANK_CAP,
    },
    null,
    2
  )
);
