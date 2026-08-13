/**
 * Static company info for the curated seed board universe.
 * Newly discovered / searched tickers fall back to API overview fields
 * in buildReport (name, sector, description) — no need to hardcode every ticker.
 */

const { BOARD_TICKERS } = require("./boardTickers");

const TICKER_INFO = {
  AAPL: {
    name: "Apple Inc.",
    sector: "Technology",
    description:
      "Apple Inc. — makes iPhones, Macs, and other consumer electronics.",
  },
  MSFT: {
    name: "Microsoft Corporation",
    sector: "Technology",
    description:
      "Microsoft — makes Windows, Office, cloud services (Azure), and Xbox.",
  },
  JNJ: {
    name: "Johnson & Johnson",
    sector: "Healthcare",
    description:
      "Johnson & Johnson — makes medicines, medical devices, and everyday health products.",
  },
  UNH: {
    name: "UnitedHealth Group",
    sector: "Healthcare",
    description:
      "UnitedHealth — provides health insurance and health-care services across the US.",
  },
  KO: {
    name: "The Coca-Cola Company",
    sector: "Consumer Staples",
    description:
      "Coca-Cola — sells soft drinks and other beverages sold around the world.",
  },
  PG: {
    name: "Procter & Gamble",
    sector: "Consumer Staples",
    description:
      "Procter & Gamble — makes household brands like Tide, Pampers, and Crest.",
  },
  JPM: {
    name: "JPMorgan Chase & Co.",
    sector: "Finance",
    description:
      "JPMorgan Chase — one of the largest banks in the US.",
  },
  V: {
    name: "Visa Inc.",
    sector: "Finance",
    description:
      "Visa — runs a global payments network that helps process card purchases.",
  },
};

for (const ticker of BOARD_TICKERS) {
  if (!TICKER_INFO[ticker]) {
    throw new Error(
      `lib/tickerInfo.js missing entry for seed board ticker ${ticker} (see lib/boardTickers.js)`
    );
  }
}

function getTickerInfo(ticker) {
  const key = String(ticker || "").trim().toUpperCase();
  return TICKER_INFO[key] || null;
}

/**
 * Resolve display identity: curated blurb first, else API-sourced fields.
 */
function resolveTickerIdentity(ticker, overview = {}, quote = {}) {
  const local = getTickerInfo(ticker);
  return {
    name: local?.name || overview.name || quote.name || null,
    sector: local?.sector || overview.sector || null,
    description: local?.description || overview.description || null,
    curated: Boolean(local),
  };
}

module.exports = {
  TICKER_INFO,
  getTickerInfo,
  resolveTickerIdentity,
};
