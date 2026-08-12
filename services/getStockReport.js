const {
  getStockCacheEntry,
  saveStockToCache,
  getCachedSummary,
  saveSummaryToCache,
  isFullyFresh,
  isPriceFresh,
  isTargetFresh,
  isNewsFresh,
  emptyFreshness,
  freshnessFromData,
} = require("./cache");
const {
  getQuoteAndIndicators,
  getAnalystTarget,
  getNewsSentiment,
  getPeers,
  AlphaVantageError,
} = require("./dataFetch");
const { analyzeStock } = require("./analyze");
const { getTickerInfo } = require("../lib/tickerInfo");

/** In-flight getStockReport promises keyed by `${ticker}_${mode}`. */
const inFlight = new Map();

function sourceLabel(source) {
  if (source === "twelve_data") return "Twelve Data";
  if (source === "alpha_vantage") return "Alpha Vantage";
  return null;
}

function buildReport(ticker, mode, rawData, analysis, lastUpdated = null) {
  const quote = rawData?.quote || {};
  const overview = rawData?.fundamentals?.overview || {};
  const freshness = freshnessFromData(rawData);
  const newsPending =
    Boolean(rawData?.fundamentals?.newsPending) || !freshness.newsUpdatedAt;
  const priceSource = quote.source || null;
  const local = getTickerInfo(ticker);
  const companyName =
    local?.name || overview.name || quote.name || null;
  const sector = local?.sector || overview.sector || null;
  const description = local?.description || null;

  return {
    ticker: String(ticker).toUpperCase(),
    mode,
    name: companyName,
    companyName,
    description,
    price: quote.price?.current ?? null,
    change: quote.price?.change ?? null,
    changePercent: quote.price?.changePercent ?? null,
    indicators: quote.indicators || null,
    analystTarget: overview.analystTargetPrice ?? null,
    sector,
    lastUpdated:
      lastUpdated ||
      freshness.priceUpdatedAt ||
      null,
    priceUpdatedAt: freshness.priceUpdatedAt || null,
    targetUpdatedAt: freshness.targetUpdatedAt || null,
    newsUpdatedAt: freshness.newsUpdatedAt || null,
    priceSource,
    priceSourceLabel: sourceLabel(priceSource),
    newsPending,
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

function ensureRawShape(rawData) {
  const base = rawData && typeof rawData === "object" ? rawData : {};
  return {
    quote: base.quote || null,
    fundamentals: {
      overview: base.fundamentals?.overview || {},
      news: Array.isArray(base.fundamentals?.news)
        ? base.fundamentals.news
        : [],
      newsPending: Boolean(base.fundamentals?.newsPending),
    },
    peers: Array.isArray(base.peers) ? base.peers : [],
    freshness: {
      ...emptyFreshness(),
      ...freshnessFromData(base),
    },
  };
}

async function buildStockReport(ticker, mode, options = {}) {
  const symbol = String(ticker).toUpperCase();
  const skipPeers = Boolean(options.skipPeers);

  const entry = await getStockCacheEntry(symbol, mode);
  let rawData = ensureRawShape(entry?.data);
  let analysis = await getCachedSummary(symbol, mode);

  const priceOk = isPriceFresh(rawData);
  const targetOk = isTargetFresh(rawData);
  const newsOk = isNewsFresh(rawData);
  const fullyFresh = isFullyFresh(rawData);

  if (fullyFresh && analysis) {
    console.log(
      `[getStockReport] full cache hit for ${symbol} (${mode}) — no live API calls`
    );
    return buildReport(
      symbol,
      mode,
      rawData,
      analysis,
      rawData.freshness.priceUpdatedAt
    );
  }

  let didFetch = false;
  let newsJustFetched = false;
  const now = () => new Date().toISOString();

  if (!priceOk) {
    console.log(
      `[getStockReport] price stale/missing for ${symbol} (${mode}) — fetching`
    );
    const quote = await getQuoteAndIndicators(symbol, mode);
    if (!quote && !rawData.quote) {
      console.error(
        `[getStockReport] Missing quote/indicators for ${symbol} (${mode})`
      );
      return null;
    }
    if (quote) {
      rawData.quote = quote;
      rawData.freshness.priceUpdatedAt = now();
      if (quote.name && !rawData.fundamentals.overview.name) {
        rawData.fundamentals.overview.name = quote.name;
      }
      didFetch = true;
    }
  } else {
    console.log(`[getStockReport] price fresh for ${symbol} (${mode})`);
  }

  if (!targetOk) {
    console.log(
      `[getStockReport] target stale/missing for ${symbol} — fetching`
    );
    const target = await getAnalystTarget(symbol);
    const overview = rawData.fundamentals.overview;
    const local = getTickerInfo(symbol);
    if (!target?.rateLimited) {
      overview.analystTargetPrice = target?.analystTargetPrice ?? null;
      overview.analystTargetSource = target?.source || null;
      // Board tickers use lib/tickerInfo for name/sector/description — only
      // keep API name/sector for tickers outside that static list.
      if (!local) {
        if (target?.name) overview.name = overview.name || target.name;
        if (target?.sector) overview.sector = overview.sector || target.sector;
        if (target?.industry) overview.industry = overview.industry || target.industry;
        if (target?.description) {
          overview.description = overview.description || target.description;
        }
      }
      if (target?.peRatio != null) overview.peRatio = target.peRatio;
      if (target?.marketCap != null) overview.marketCap = target.marketCap;
      rawData.freshness.targetUpdatedAt = now();
    } else if (target?.analystTargetPrice != null) {
      overview.analystTargetPrice = target.analystTargetPrice;
      overview.analystTargetSource = target.source || null;
      rawData.freshness.targetUpdatedAt = now();
    }
    didFetch = true;
  } else {
    console.log(`[getStockReport] target fresh for ${symbol}`);
  }

  if (!newsOk) {
    console.log(
      `[getStockReport] news stale/missing for ${symbol} — fetching Alpha Vantage NEWS_SENTIMENT`
    );
    const newsResult = await getNewsSentiment(symbol);
    if (newsResult) {
      rawData.fundamentals.news = newsResult.news;
      rawData.fundamentals.newsPending = false;
      rawData.freshness.newsUpdatedAt = now();
      newsJustFetched = true;
    } else {
      rawData.fundamentals.newsPending = true;
      // Leave newsUpdatedAt unset so the next refresh retries news only.
    }
    didFetch = true;
  } else {
    rawData.fundamentals.newsPending = false;
    console.log(`[getStockReport] news fresh for ${symbol}`);
  }

  if (!skipPeers && (!rawData.peers || !rawData.peers.length)) {
    rawData.peers = (await getPeers(symbol)) || [];
    didFetch = true;
  } else if (skipPeers && !Array.isArray(rawData.peers)) {
    rawData.peers = [];
  }

  if (didFetch || !entry) {
    await saveStockToCache(symbol, mode, rawData);
  }

  const shouldAnalyze =
    !analysis || (newsJustFetched && rawData.fundamentals.newsPending === false);

  if (shouldAnalyze) {
    console.log(
      `[getStockReport] summary ${analysis ? "refresh" : "miss"} for ${symbol} (${mode}) — calling Gemini once`
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

  return buildReport(
    symbol,
    mode,
    rawData,
    analysis,
    rawData.freshness.priceUpdatedAt
  );
}

/**
 * Cache-first report builder with in-flight dedupe per ticker/mode.
 * options.skipPeers — skip Finnhub (used by board refresh).
 * Fetches only stale pieces (price / target / news) independently.
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
