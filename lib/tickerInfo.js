/**
 * Static company info for the fixed board universe.
 * Avoids burning Alpha Vantage OVERVIEW just for name/sector/blurb.
 */

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

function getTickerInfo(ticker) {
  const key = String(ticker || "").trim().toUpperCase();
  return TICKER_INFO[key] || null;
}

module.exports = {
  TICKER_INFO,
  getTickerInfo,
};
