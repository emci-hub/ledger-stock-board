const {
  getCachedStock,
  saveStockToCache,
  getCachedSummary,
  saveSummaryToCache,
} = require("./cache");
const {
  getQuoteAndIndicators,
  getFundamentalsAndNews,
  getPeers,
  AlphaVantageError,
} = require("./dataFetch");
const { analyzeStock } = require("./analyze");

function buildReport(ticker, mode, rawData, analysis) {
  const quote = rawData?.quote || {};
  const overview = rawData?.fundamentals?.overview || {};

  return {
    ticker: String(ticker).toUpperCase(),
    mode,
    name: overview.name || null,
    price: quote.price?.current ?? null,
    change: quote.price?.change ?? null,
    changePercent: quote.price?.changePercent ?? null,
    indicators: quote.indicators || null,
    analystTarget: overview.analystTargetPrice ?? null,
    sector: overview.sector || null,
    priceHistory: Array.isArray(quote.priceHistory)
      ? quote.priceHistory
      : Array.isArray(rawData?.priceHistory)
        ? rawData.priceHistory
        : [],
    analysis: {
      lean: analysis?.lean || "neutral",
      risk: analysis?.risk || "medium",
      tags: Array.isArray(analysis?.tags) ? analysis.tags : [],
      summary:
        analysis?.summary || "Analysis wasn't available right now.",
    },
  };
}

/**
 * Full stock report: cache → fetch missing pieces only → return.
 * Fresh stock_cache + ai_summaries (same ticker/mode, <24h) skips all live APIs.
 * Propagates AlphaVantageError (rate_limit / invalid_ticker).
 */
async function getStockReport(ticker, mode) {
  const symbol = String(ticker).toUpperCase();

  let rawData = getCachedStock(symbol, mode);
  let analysis = getCachedSummary(symbol, mode);

  if (rawData && analysis) {
    console.log(
      `[getStockReport] cache hit for ${symbol} (${mode}) — no live API calls`
    );
    return buildReport(symbol, mode, rawData, analysis);
  }

  if (!rawData) {
    console.log(
      `[getStockReport] stock cache miss for ${symbol} (${mode}) — fetching market data`
    );
    try {
      const quote = await getQuoteAndIndicators(symbol, mode);
      await new Promise((r) => setTimeout(r, 1200));
      const fundamentals = await getFundamentalsAndNews(symbol);
      const peers = await getPeers(symbol);

      if (!quote) {
        console.error(
          `[getStockReport] Missing quote/indicators for ${symbol} (${mode})`
        );
        return null;
      }

      rawData = { quote, fundamentals, peers };
      saveStockToCache(symbol, mode, rawData);
    } catch (err) {
      if (err instanceof AlphaVantageError) throw err;
      throw err;
    }
  } else {
    console.log(`[getStockReport] stock cache hit for ${symbol} (${mode})`);
  }

  if (!analysis) {
    console.log(
      `[getStockReport] summary cache miss for ${symbol} (${mode}) — calling Gemini once`
    );
    analysis = await analyzeStock(
      symbol,
      mode,
      rawData.quote,
      rawData.fundamentals,
      rawData.peers
    );
    saveSummaryToCache(symbol, mode, analysis);
  } else {
    console.log(`[getStockReport] summary cache hit for ${symbol} (${mode})`);
  }

  return buildReport(symbol, mode, rawData, analysis);
}

module.exports = { getStockReport, buildReport };
