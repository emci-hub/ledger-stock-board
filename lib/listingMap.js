/**
 * Curated TRADE -> PRIMARY listing map for the long-term screen.
 *
 * TRADE = the listing they can actually buy (US share, ADR, CDR, TSX, etc).
 * PRIMARY = the operating company's main listing, used for company-level
 * facts (cap, P/E, cash flow, debt, revenue growth) per stock-alert-spec.md —
 * those numbers must never come from a wrapper's market-cap/P/E field.
 *
 * A ticker not in this map is assumed to already be its own PRIMARY listing
 * (TRADE === PRIMARY) — that is a normal, common case, not a missing one.
 * No automatic ADR/CDR detection exists anywhere in the codebase; this is a
 * manually-maintained seed list, expanded as new wrapper tickers are screened.
 */

const LISTING_MAP = {
  // Foreign large-caps trading in the US via ADR
  TSM: { primaryTicker: "2330", primaryExchange: "TWSE", tradeCurrency: "USD" },
  ASML: { primaryTicker: "ASML", primaryExchange: "Euronext Amsterdam", tradeCurrency: "USD" },
  NVO: { primaryTicker: "NOVO-B", primaryExchange: "Nasdaq Copenhagen", tradeCurrency: "USD" },
  TM: { primaryTicker: "7203", primaryExchange: "TSE", tradeCurrency: "USD" },
  SAP: { primaryTicker: "SAP", primaryExchange: "XETRA", tradeCurrency: "USD" },
  SHEL: { primaryTicker: "SHEL", primaryExchange: "LSE", tradeCurrency: "USD" },
  NVS: { primaryTicker: "NOVN", primaryExchange: "SIX", tradeCurrency: "USD" },
  UL: { primaryTicker: "ULVR", primaryExchange: "LSE", tradeCurrency: "USD" },

  // Canadian CDRs of US mega-caps (Cboe Canada NEO, priced in CAD)
  "AAPL.NE": { primaryTicker: "AAPL", primaryExchange: "Nasdaq", tradeCurrency: "CAD" },
  "MSFT.NE": { primaryTicker: "MSFT", primaryExchange: "Nasdaq", tradeCurrency: "CAD" },
  "GOOGL.NE": { primaryTicker: "GOOGL", primaryExchange: "Nasdaq", tradeCurrency: "CAD" },
  "AMZN.NE": { primaryTicker: "AMZN", primaryExchange: "Nasdaq", tradeCurrency: "CAD" },
};

/**
 * Resolve a TRADE ticker to its PRIMARY listing. Falls back to
 * TRADE === PRIMARY when the ticker isn't in the curated map.
 */
function resolveListing(tradeTicker) {
  const key = String(tradeTicker || "").trim().toUpperCase();
  const entry = LISTING_MAP[key];
  if (entry) {
    return {
      tradeTicker: key,
      primaryTicker: entry.primaryTicker,
      primaryExchange: entry.primaryExchange,
      tradeCurrency: entry.tradeCurrency || "USD",
      sameListing: false,
    };
  }
  return {
    tradeTicker: key,
    primaryTicker: key,
    primaryExchange: null,
    tradeCurrency: "USD",
    sameListing: true,
  };
}

module.exports = {
  LISTING_MAP,
  resolveListing,
};
