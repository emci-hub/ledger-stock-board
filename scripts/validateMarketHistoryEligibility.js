/**
 * Confirm long eligibility uses REAL market history, not Ledger board tenure.
 */
require("dotenv").config();
const assert = require("assert");
const {
  assessBoardPlacement,
  BOARD_SECTIONS,
  realizedVolatilityAnnualized,
  LONG_MIN_IPO_YEARS,
  LONG_MIN_PRICE_BARS,
} = require("../lib/rankingStability");

function yesterday() {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

function synthCloses(n, start = 100, dailyRet = 0.001) {
  const out = [start];
  for (let i = 1; i < n; i++) {
    out.push(out[i - 1] * (1 + dailyRet + (i % 7 === 0 ? -0.002 : 0)));
  }
  return out;
}

// --- Fresh-to-Ledger AAPL-like: tracked yesterday, but decades of IPO + calm day ---
const aaplFresh = assessBoardPlacement(
  {
    ticker: "AAPL",
    source: "discovery",
    exchange: "NASDAQ",
    tracked_since: yesterday(), // MUST NOT block long
    added_at: yesterday(),
  },
  {
    price: 305,
    changePercent: 0.9,
    exchange: "NASDAQ",
    ipoDate: "1980-12-12",
    marketCap: 4.4e12,
    peRatio: 32,
    analystTarget: 320,
    shortTermRank: 60,
    longTermRank: 75,
    priceHistory: synthCloses(200, 250, 0.0008),
    historyBars: 500,
    indicators: { long: { sma: { sma200: 280 } } },
  }
);
assert.strictEqual(
  aaplFresh.boardSection,
  BOARD_SECTIONS.LONG,
  "fresh AAPL must be long based on real IPO/history, not board tenure"
);
assert.ok(aaplFresh.longTermEligible);
assert.ok(aaplFresh.trackedDays < 2, "board tenure still young");
assert.ok(aaplFresh.signals.ipoYears >= LONG_MIN_IPO_YEARS);

// --- Fresh NVDA-like growth name ---
const nvdaFresh = assessBoardPlacement(
  {
    ticker: "NVDA",
    source: "discovery",
    exchange: "NASDAQ",
    tracked_since: yesterday(),
  },
  {
    price: 120,
    changePercent: 1.2,
    exchange: "NASDAQ",
    ipoDate: "1999-01-22",
    marketCap: 3e12,
    peRatio: 50,
    analystTarget: 140,
    shortTermRank: 70,
    longTermRank: 68,
    priceHistory: synthCloses(252, 80, 0.0015),
    historyBars: 500,
    indicators: { long: { sma: { sma200: 90 } } },
  }
);
assert.strictEqual(nvdaFresh.boardSection, BOARD_SECTIONS.LONG);

// --- Hot mover: extreme day → penny section even with long IPO ---
const hot = assessBoardPlacement(
  {
    ticker: "RRGB",
    source: "discovery",
    exchange: "NASDAQ",
    tracked_since: yesterday(),
  },
  {
    price: 10,
    changePercent: 26,
    exchange: "NASDAQ",
    ipoDate: "2002-01-01",
    marketCap: 2e9,
    shortTermRank: 78,
    longTermRank: 40,
    priceHistory: synthCloses(200),
    historyBars: 200,
  }
);
assert.strictEqual(hot.boardSection, BOARD_SECTIONS.PENNY);

// --- Obscure thin history, calm day → short (not long) ---
const thin = assessBoardPlacement(
  {
    ticker: "NEWX",
    source: "discovery",
    exchange: "NASDAQ",
    tracked_since: yesterday(),
  },
  {
    price: 25,
    changePercent: 1,
    exchange: "NASDAQ",
    ipoDate: null,
    marketCap: null,
    shortTermRank: 55,
    longTermRank: 50,
    priceHistory: synthCloses(30),
    historyBars: 30,
    indicators: { long: { sma: { sma200: null } } },
  }
);
assert.strictEqual(thin.boardSection, BOARD_SECTIONS.SHORT);
assert.ok(thin.signals.thinMarketHistory);

// Vol helper sanity
const vol = realizedVolatilityAnnualized(synthCloses(100, 100, 0.01));
assert.ok(vol == null || vol > 0);

console.log("OK validateMarketHistoryEligibility");
console.log(
  JSON.stringify(
    {
      criteria: {
        LONG_MIN_IPO_YEARS,
        LONG_MIN_PRICE_BARS,
      },
      aaplFresh: {
        section: aaplFresh.boardSection,
        trackedDays: aaplFresh.trackedDays,
        ipoYears: aaplFresh.signals.ipoYears,
      },
      nvdaFresh: nvdaFresh.boardSection,
      hot: hot.boardSection,
      thin: thin.boardSection,
    },
    null,
    2
  )
);
