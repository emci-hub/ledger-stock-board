/**
 * TEST DATA ONLY — remove this seed and its inserted rows before real use,
 * once Alpha Vantage quota allows live testing (Step 12 cleanup).
 *
 * Seeds stock_cache + ai_summaries + board_picks for five long-mode tickers
 * so board/search/recent endpoints can be exercised without Alpha Vantage.
 */
const { getDb } = require("../db/schema");
const { saveStockToCache, saveSummaryToCache } = require("../services/cache");

const mode = "long";

const seeds = [
  {
    ticker: "AAPL",
    sector: "Technology",
    rawData: {
      quote: {
        ticker: "AAPL",
        mode,
        interval: "weekly",
        price: {
          current: 208.45,
          open: 206.1,
          high: 209.8,
          low: 205.4,
          volume: 48231500,
          previousClose: 205.9,
          change: 2.55,
          changePercent: 1.24,
          latestTradingDay: "2026-08-10",
        },
        indicators: {
          sma: { sma20: 201.35, sma50: 192.8, sma200: 178.4 },
          rsi: 58.6,
          macd: { macd: 2.45, signal: 1.92, histogram: 0.53 },
          bollinger: { upper: 218.2, middle: 201.35, lower: 184.5 },
        },
      },
      fundamentals: {
        ticker: "AAPL",
        overview: {
          name: "Apple Inc",
          sector: "Technology",
          industry: "Consumer Electronics",
          peRatio: 32.4,
          analystTargetPrice: 225.0,
        },
        news: [
          {
            title: "Apple expands services revenue",
            sentimentScore: 0.35,
            sentimentLabel: "Bullish",
          },
        ],
      },
      peers: ["MSFT", "GOOGL", "AMZN"],
    },
    analysis: {
      lean: "bullish",
      risk: "medium",
      tags: ["above long-term averages", "services growth"],
      summary:
        "Apple looks steadily constructive on a longer view, trading above its major averages with a higher analyst target nearby.",
    },
  },
  {
    ticker: "MSFT",
    sector: "Technology",
    rawData: {
      quote: {
        ticker: "MSFT",
        mode,
        interval: "weekly",
        price: {
          current: 428.9,
          open: 426.2,
          high: 431.5,
          low: 424.8,
          volume: 22145000,
          previousClose: 425.1,
          change: 3.8,
          changePercent: 0.89,
          latestTradingDay: "2026-08-10",
        },
        indicators: {
          sma: { sma20: 418.2, sma50: 405.6, sma200: 382.1 },
          rsi: 62.1,
          macd: { macd: 4.1, signal: 3.2, histogram: 0.9 },
          bollinger: { upper: 445.0, middle: 418.2, lower: 391.4 },
        },
      },
      fundamentals: {
        ticker: "MSFT",
        overview: {
          name: "Microsoft Corporation",
          sector: "Technology",
          industry: "Software — Infrastructure",
          peRatio: 35.8,
          analystTargetPrice: 460.0,
        },
        news: [
          {
            title: "Cloud demand remains firm",
            sentimentScore: 0.42,
            sentimentLabel: "Bullish",
          },
        ],
      },
      peers: ["AAPL", "GOOGL", "AMZN"],
    },
    analysis: {
      lean: "bullish",
      risk: "low",
      tags: ["cloud strength", "wide moat"],
      summary:
        "Microsoft looks like one of the steadier big-tech names here, with price above its long averages and a relatively calm risk profile.",
    },
  },
  {
    ticker: "JNJ",
    sector: "Healthcare",
    rawData: {
      quote: {
        ticker: "JNJ",
        mode,
        interval: "weekly",
        price: {
          current: 162.35,
          open: 163.1,
          high: 163.9,
          low: 161.2,
          volume: 8124500,
          previousClose: 163.4,
          change: -1.05,
          changePercent: -0.64,
          latestTradingDay: "2026-08-10",
        },
        indicators: {
          sma: { sma20: 164.8, sma50: 160.2, sma200: 155.6 },
          rsi: 46.2,
          macd: { macd: -0.35, signal: -0.1, histogram: -0.25 },
          bollinger: { upper: 171.5, middle: 164.8, lower: 158.1 },
        },
      },
      fundamentals: {
        ticker: "JNJ",
        overview: {
          name: "Johnson & Johnson",
          sector: "Healthcare",
          industry: "Drug Manufacturers — General",
          peRatio: 24.1,
          analystTargetPrice: 175.0,
        },
        news: [
          {
            title: "Healthcare names trade mixed",
            sentimentScore: 0.05,
            sentimentLabel: "Neutral",
          },
        ],
      },
      peers: ["PFE", "UNH", "MRK"],
    },
    analysis: {
      lean: "neutral",
      risk: "low",
      tags: ["defensive healthcare", "near-term soft"],
      summary:
        "Johnson & Johnson looks fairly quiet — a bit soft near-term but still within a longer-term range, with lower risk than growth stocks.",
    },
  },
  {
    ticker: "KO",
    sector: "Consumer Defensive",
    rawData: {
      quote: {
        ticker: "KO",
        mode,
        interval: "weekly",
        price: {
          current: 68.2,
          open: 68.5,
          high: 68.9,
          low: 67.8,
          volume: 14550200,
          previousClose: 68.7,
          change: -0.5,
          changePercent: -0.73,
          latestTradingDay: "2026-08-10",
        },
        indicators: {
          sma: { sma20: 69.1, sma50: 67.4, sma200: 64.9 },
          rsi: 44.8,
          macd: { macd: -0.18, signal: 0.05, histogram: -0.23 },
          bollinger: { upper: 71.8, middle: 69.1, lower: 66.4 },
        },
      },
      fundamentals: {
        ticker: "KO",
        overview: {
          name: "Coca-Cola Company",
          sector: "Consumer Defensive",
          industry: "Beverages — Non-Alcoholic",
          peRatio: 26.5,
          analystTargetPrice: 74.0,
        },
        news: [
          {
            title: "Consumer staples stay defensive",
            sentimentScore: 0.1,
            sentimentLabel: "Neutral",
          },
        ],
      },
      peers: ["PEP", "MNST", "KDP"],
    },
    analysis: {
      lean: "bearish",
      risk: "low",
      tags: ["below short averages", "defensive but soft"],
      summary:
        "Coca-Cola looks a little soft right now versus its recent averages, though as a defensive name the downside risk still looks limited.",
    },
  },
  {
    ticker: "NVDA",
    sector: "Technology",
    rawData: {
      quote: {
        ticker: "NVDA",
        mode,
        interval: "weekly",
        price: {
          current: 118.75,
          open: 116.2,
          high: 120.4,
          low: 115.6,
          volume: 198442000,
          previousClose: 114.9,
          change: 3.85,
          changePercent: 3.35,
          latestTradingDay: "2026-08-10",
        },
        indicators: {
          sma: { sma20: 112.4, sma50: 104.8, sma200: 88.2 },
          rsi: 71.4,
          macd: { macd: 5.6, signal: 4.1, histogram: 1.5 },
          bollinger: { upper: 128.5, middle: 112.4, lower: 96.3 },
        },
      },
      fundamentals: {
        ticker: "NVDA",
        overview: {
          name: "NVIDIA Corporation",
          sector: "Technology",
          industry: "Semiconductors",
          peRatio: 48.2,
          analystTargetPrice: 140.0,
        },
        news: [
          {
            title: "AI chip demand stays elevated",
            sentimentScore: 0.55,
            sentimentLabel: "Bullish",
          },
        ],
      },
      peers: ["AMD", "AVGO", "TSM"],
    },
    analysis: {
      lean: "bullish",
      risk: "high",
      tags: ["strong momentum", "elevated RSI", "volatile"],
      summary:
        "NVIDIA still looks strong with price well above its long averages, but the high RSI and big moves mean this one carries more risk than the quieter board names.",
    },
  },
];

const db = getDb();
const upsertBoardPick = db.prepare(
  `INSERT OR REPLACE INTO board_picks (ticker, status, added_at, sector)
   VALUES (?, 'recommended', ?, ?)`
);

const now = new Date().toISOString();

function makePriceHistory(endPrice, points = 12) {
  const hist = [];
  let v = endPrice * 0.92;
  for (let i = 0; i < points; i++) {
    v = v * (1 + Math.sin(i / 2) * 0.008 + ((endPrice - v) / endPrice) * 0.18);
    hist.push(Math.round(v * 100) / 100);
  }
  hist[hist.length - 1] = endPrice;
  return hist;
}

for (const seed of seeds) {
  const endPrice = seed.rawData.quote.price.current;
  seed.rawData.quote.priceHistory = makePriceHistory(endPrice);
  saveStockToCache(seed.ticker, mode, seed.rawData);
  saveSummaryToCache(seed.ticker, mode, seed.analysis);
  upsertBoardPick.run(seed.ticker, now, seed.sector);
  console.log(`Seeded ${seed.ticker} (${mode}) + board_picks recommended`);
}

console.log(`Done — seeded ${seeds.length} tickers at ${now}`);
