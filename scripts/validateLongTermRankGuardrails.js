/**
 * Deterministic smoke checks for long-term vs short-term ranking guardrails.
 * No live market APIs — uses fake payloads + rankingStability math only.
 */
require("dotenv").config();

const assert = require("assert");
const {
  buildPayload,
  applyLongTermRankGuardrails,
} = require("../services/analyze");
const {
  buildRankingContext,
  applyLongTermStabilityPenalties,
  assessLongTermPlacement,
  NEWLY_TRACKED_LONG_RANK_CAP,
} = require("../lib/rankingStability");
const { buildAnalysisPrompt, RANKING_RUBRIC } = require("../lib/aiShape");

function fakeQuote(changePercent = 26) {
  return {
    price: {
      current: 10.7,
      change: 2.2,
      changePercent,
      latestTradingDay: "2026-08-13",
    },
    indicators: {
      short: {
        sma20: 7.5,
        sma50: 7.5,
        sma200: null,
        rsi: 80,
        macd: { macd: 0.5, signal: 0.2, histogram: 0.3 },
        bollinger: { upper: 9.5, middle: 7.5, lower: 5.5 },
      },
      long: {
        sma20: 7.5,
        sma50: 7.5,
        sma200: null,
        rsi: 80,
        macd: { macd: 0.5, signal: 0.2, histogram: 0.3 },
        bollinger: { upper: 9.5, middle: 7.5, lower: 5.5 },
      },
    },
  };
}

function fakeFundamentals({ pe = null, target = null } = {}) {
  return {
    overview: {
      name: "Hot Mover Inc",
      sector: "Technology",
      industry: "Software",
      peRatio: pe,
      analystTargetPrice: target,
      marketCap: null,
      exchange: "NASDAQ",
    },
    news: [],
    newsPending: true,
    newsSources: [],
  };
}

function yesterdayIso() {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

function monthAgoIso() {
  return new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
}

const discoveryPick = {
  ticker: "HOTX",
  source: "discovery",
  exchange: "NASDAQ",
  tracked_since: yesterdayIso(),
  flags_json: JSON.stringify({ extremeMove: true }),
};

const payload = buildPayload("HOTX", fakeQuote(26), fakeFundamentals(), [], {
  pick: discoveryPick,
});

assert.strictEqual(payload.rankingContext.newlyTracked, true);
assert.strictEqual(payload.rankingContext.extremeSingleDayMove, true);
assert.strictEqual(payload.rankingContext.missingLongTermFundamentals, true);
assert.strictEqual(
  payload.rankingContext.longTermGuidance.newlyTrackedLongRankSoftCap,
  NEWLY_TRACKED_LONG_RANK_CAP
);

const prompt = buildAnalysisPrompt(payload);
assert.ok(/hot mover/i.test(prompt), "prompt mentions hot mover");
assert.ok(prompt.includes("newlyTracked"), "prompt mentions newlyTracked");
assert.ok(
  /NEVER invent fundamentals/i.test(prompt),
  "prompt forbids inventing fundamentals"
);
assert.ok(RANKING_RUBRIC.longTermHardPenalties.length >= 4);

const guarded = applyLongTermRankGuardrails(
  { shortTermRank: 72, longTermRank: 72 },
  payload.rankingContext
);
assert.ok(
  guarded.longTermRank <= NEWLY_TRACKED_LONG_RANK_CAP,
  `expected long <= ${NEWLY_TRACKED_LONG_RANK_CAP}, got ${guarded.longTermRank}`
);
assert.ok(
  guarded.longTermRank <= Math.max(15, 72 - 20),
  `hot-mover long should diverge from short, got ${guarded.longTermRank}`
);
assert.strictEqual(guarded.shortTermRank, 72);

const stablePick = {
  ticker: "STBL",
  source: "seed",
  exchange: "NYSE",
  tracked_since: monthAgoIso(),
};
const stableCtx = buildRankingContext(stablePick, {
  price: 150,
  changePercent: 0.4,
  exchange: "NYSE",
  analystTargetPrice: 170,
  peRatio: 22,
  marketCap: 2e11,
  ipoDate: "1990-01-01",
  priceHistory: Array.from({ length: 200 }, (_, i) => 100 + i * 0.1),
  historyBars: 400,
  indicators: { long: { sma: { sma200: 140 } } },
});
assert.strictEqual(stableCtx.thinMarketHistory, false);
assert.strictEqual(stableCtx.newlyTracked, false);
assert.strictEqual(stableCtx.missingLongTermFundamentals, false);
const stableAdj = applyLongTermStabilityPenalties(78, {
  thinMarketHistory: false,
  newlyTracked: false,
  extremeMove: false,
  penny: false,
  nonMajorExchange: false,
  missingFundamentals: false,
});
assert.strictEqual(stableAdj.rank, 78);

const placement = assessLongTermPlacement(discoveryPick, {
  price: 10.7,
  changePercent: 26,
  longTermRank: 72,
  peRatio: null,
  analystTarget: null,
  exchange: "NASDAQ",
});
assert.strictEqual(placement.longTermEligible, false);
assert.strictEqual(placement.boardSection, "penny");
assert.ok(placement.momentumSection);
assert.ok(placement.longTermRankAdjusted < 40);

console.log("OK validateLongTermRankGuardrails");
console.log(
  JSON.stringify(
    {
      discoveryGuardedLongFrom72: guarded.longTermRank,
      shortUnchanged: guarded.shortTermRank,
      stableLongKept: stableAdj.rank,
      placementAdjusted: placement.longTermRankAdjusted,
      penalties: placement.penalties.map((p) => p.id),
    },
    null,
    2
  )
);
