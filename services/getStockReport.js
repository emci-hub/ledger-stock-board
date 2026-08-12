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
  getCombinedNews,
  getPeers,
} = require("./dataFetch");
const { analyzeStock } = require("./analyze");
const { getTickerInfo } = require("../lib/tickerInfo");
const { sourceLabel, formatSourceList } = require("../lib/dataSources");

/** In-flight getStockReport promises keyed by `${ticker}_${mode}`. */
const inFlight = new Map();

const EARNINGS_SOON_DAYS = 21;

function parseEarningsDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  // Alpha may return "2026-04-25" or "2026-04-25,2026-07-24"
  const first = s.split(",")[0].trim();
  const t = Date.parse(first);
  if (Number.isNaN(t)) return null;
  return new Date(t);
}

function buildEarningsFlag(earningsDateRaw) {
  const date = parseEarningsDate(earningsDateRaw);
  if (!date) return null;
  const now = new Date();
  const diffDays = (date.getTime() - now.getTime()) / (24 * 60 * 60 * 1000);
  if (diffDays < -1 || diffDays > EARNINGS_SOON_DAYS) return null;
  const label = date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return {
    date: date.toISOString().slice(0, 10),
    label,
    text: `earnings expected ${label}`,
  };
}

function computeWeekRange(price, priceHistory, overview) {
  const history = Array.isArray(priceHistory)
    ? priceHistory.map(Number).filter(Number.isFinite)
    : [];
  const high =
    overview?.week52High != null && Number.isFinite(Number(overview.week52High))
      ? Number(overview.week52High)
      : history.length
        ? Math.max(...history)
        : null;
  const low =
    overview?.week52Low != null && Number.isFinite(Number(overview.week52Low))
      ? Number(overview.week52Low)
      : history.length
        ? Math.min(...history)
        : null;
  const current = price != null && Number.isFinite(Number(price)) ? Number(price) : null;

  if (high == null || low == null || current == null || high <= low) {
    return {
      high,
      low,
      position: null,
      label: null,
      fromOverview: Boolean(overview?.week52High != null || overview?.week52Low != null),
    };
  }

  const pct = (current - low) / (high - low);
  let label = "mid-range";
  let position = "mid";
  if (pct <= 0.2) {
    label = "near 52-week low";
    position = "low";
  } else if (pct >= 0.8) {
    label = "near 52-week high";
    position = "high";
  }

  return {
    high,
    low,
    pct,
    position,
    label,
    fromOverview: Boolean(overview?.week52High != null || overview?.week52Low != null),
  };
}

function buildReport(ticker, mode, rawData, analysis, lastUpdated = null) {
  const quote = rawData?.quote || {};
  const overview = rawData?.fundamentals?.overview || {};
  const freshness = freshnessFromData(rawData);
  const newsSources = Array.isArray(rawData?.fundamentals?.newsSources)
    ? rawData.fundamentals.newsSources
    : [];
  const newsPending =
    Boolean(rawData?.fundamentals?.newsPending) ||
    (!freshness.newsUpdatedAt && newsSources.length === 0);
  const priceSource = quote.source || null;
  const targetSource = overview.analystTargetSource || null;
  const local = getTickerInfo(ticker);
  const companyName =
    local?.name || overview.name || quote.name || null;
  const sector = local?.sector || overview.sector || null;
  const description = local?.description || null;
  const priceHistory = Array.isArray(quote.priceHistory)
    ? quote.priceHistory
    : Array.isArray(rawData?.priceHistory)
      ? rawData.priceHistory
      : [];
  const price = quote.price?.current ?? null;
  const weekRange = computeWeekRange(price, priceHistory, overview);
  const earnings = buildEarningsFlag(overview.earningsDate);
  const peers = Array.isArray(rawData?.peers) ? rawData.peers : [];

  return {
    ticker: String(ticker).toUpperCase(),
    mode,
    name: companyName,
    companyName,
    description,
    price,
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
    targetSource,
    targetSourceLabel: sourceLabel(targetSource),
    newsSources,
    newsSourceLabel: formatSourceList(newsSources),
    newsPending,
    weekRange,
    earnings,
    peers,
    priceHistory,
    deepDive: {
      sources: {
        price: sourceLabel(priceSource),
        target: sourceLabel(targetSource),
        news: formatSourceList(newsSources),
        peers: peers.length ? sourceLabel("finnhub") : null,
        analysis: sourceLabel("gemini"),
      },
      weekRange,
      earnings,
      peers,
      newsMarketaux: rawData?.fundamentals?.newsMarketaux || null,
      newsFinnhub: rawData?.fundamentals?.newsFinnhub || null,
    },
    analysis: {
      lean: analysis?.lean || "neutral",
      risk: analysis?.risk || "medium",
      tags: Array.isArray(analysis?.tags) ? analysis.tags : [],
      summary:
        analysis?.summary || "Analysis wasn't available right now.",
      deepDive:
        analysis?.deepDive ||
        "A longer AI deep dive wasn't available for this name yet.",
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
      newsFinnhub: base.fundamentals?.newsFinnhub || null,
      newsMarketaux: base.fundamentals?.newsMarketaux || null,
      newsSources: Array.isArray(base.fundamentals?.newsSources)
        ? base.fundamentals.newsSources
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
      if (target?.week52High != null) overview.week52High = target.week52High;
      if (target?.week52Low != null) overview.week52Low = target.week52Low;
      if (target?.earningsDate) overview.earningsDate = target.earningsDate;
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
      `[getStockReport] news stale/missing for ${symbol} — fetching registry news sources in parallel`
    );
    const combined = await getCombinedNews(symbol);
    rawData.fundamentals.news = combined.alpha?.news || [];
    rawData.fundamentals.newsFinnhub = combined.finnhub || null;
    rawData.fundamentals.newsMarketaux = combined.marketaux || null;
    rawData.fundamentals.newsSources = combined.sources;
    rawData.fundamentals.newsPending = combined.pending;
    if (!combined.pending) {
      rawData.freshness.newsUpdatedAt = now();
      newsJustFetched = true;
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
 * options.skipPeers — skip Finnhub peers when true.
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
