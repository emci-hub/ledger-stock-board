const {
  getCachedStockRow,
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

/** In-flight getStockReport promises keyed by `${ticker}_${mode}`. */
const inFlight = new Map();

function buildReport(ticker, mode, rawData, analysis, lastUpdated = null) {
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
    lastUpdated: lastUpdated || null,
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

async function buildStockReport(ticker, mode, options = {}) {
  const symbol = String(ticker).toUpperCase();
  const skipPeers = Boolean(options.skipPeers);

  const stockRow = await getCachedStockRow(symbol, mode);
  let rawData = stockRow ? stockRow.data : null;
  let lastUpdated = stockRow ? stockRow.lastUpdated : null;
  let analysis = await getCachedSummary(symbol, mode);

  if (rawData && analysis) {
    console.log(
      `[getStockReport] cache hit for ${symbol} (${mode}) — no live API calls`
    );
    return buildReport(symbol, mode, rawData, analysis, lastUpdated);
  }

  if (!rawData) {
    console.log(
      `[getStockReport] stock cache miss for ${symbol} (${mode}) — fetching market data`
    );
    const quote = await getQuoteAndIndicators(symbol, mode);
    await new Promise((r) => setTimeout(r, 1200));
    const fundamentals = await getFundamentalsAndNews(symbol);
    const peers = skipPeers ? [] : await getPeers(symbol);

    if (!quote) {
      console.error(
        `[getStockReport] Missing quote/indicators for ${symbol} (${mode})`
      );
      return null;
    }

    rawData = { quote, fundamentals, peers };
    lastUpdated = await saveStockToCache(symbol, mode, rawData);
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
      rawData.peers || []
    );
    await saveSummaryToCache(symbol, mode, analysis);
  } else {
    console.log(`[getStockReport] summary cache hit for ${symbol} (${mode})`);
  }

  return buildReport(symbol, mode, rawData, analysis, lastUpdated);
}

/**
 * Cache-first report builder with in-flight dedupe per ticker/mode.
 * options.skipPeers — skip Finnhub (used by board refresh).
 */
async function getStockReport(ticker, mode, options = {}) {
  const key = `${String(ticker).toUpperCase()}_${mode}`;

  if (inFlight.has(key)) {
    console.log(`[getStockReport] joining in-flight request for ${key}`);
    return inFlight.get(key);
  }

  const promise = buildStockReport(ticker, mode, options).finally(() => {
    inFlight.delete(key);
  });

  inFlight.set(key, promise);
  return promise;
}

module.exports = { getStockReport, buildReport };
