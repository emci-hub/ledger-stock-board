const {
  getStockCacheEntry,
  saveStockToCache,
  getCachedSummary,
  saveSummaryToCache,
  isFullyFresh,
  isPriceFresh,
  isTargetFresh,
  isNewsFresh,
  isEarningsFresh,
  emptyFreshness,
  freshnessFromData,
  normalizeDualAnalysis,
  pickAnalysisTake,
  isBoardStale,
  latestFreshnessIso,
} = require("./cache");
const {
  getQuoteAndIndicators,
  getAnalystTarget,
  getCombinedNews,
  getPeers,
  getEarningsDateFromFinnhub,
  AlphaVantageError,
  QuotaSkippedError,
} = require("./dataFetch");
const { analyzeStock } = require("./analyze");
const { logQuoteClose } = require("./priceHistoryLog");
const { getTickerInfo } = require("../lib/tickerInfo");
const { sourceShortCode, formatSourceList } = require("../lib/dataSources");
const { resolveProviderId } = require("../lib/aiProvider");
const { deriveDataCaveats } = require("../lib/dataCaveats");
const { computeNewsAgreement } = require("../lib/newsAgreement");
const {
  buildTag,
  riskTag,
  buildIndicatorTags,
  normalizeLabel,
  normalizeLabelList,
} = require("../lib/indicatorTags");
const { heuristicRank, parseRank } = require("../lib/aiShape");
const { runWithCallContext } = require("./callContext");
const { getActiveOutcomes, getActiveBudget } = require("./quotaBudget");

function noteFieldRefreshed(field) {
  const outcomes = getActiveOutcomes();
  if (!outcomes) return;
  if (!Array.isArray(outcomes.refreshedFields)) outcomes.refreshedFields = [];
  if (!outcomes.refreshedFields.includes(field)) {
    outcomes.refreshedFields.push(field);
  }
}

/** In-flight shared-data loads keyed by ticker only (mode is display-only). */
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

/** Pick short vs long indicator window for display; tolerate legacy flat indicators. */
function pickIndicatorsForMode(quoteIndicators, mode) {
  if (!quoteIndicators || typeof quoteIndicators !== "object") return null;
  if (quoteIndicators.short || quoteIndicators.long) {
    const m = mode === "short" ? "short" : "long";
    return quoteIndicators[m] || quoteIndicators.long || quoteIndicators.short || null;
  }
  return quoteIndicators;
}

/**
 * Build a display report for one mode over shared raw data + dual analysis.
 * `analysis` may be dual `{ short, long, quip }` or a legacy single take.
 */
function buildReport(ticker, mode, rawData, analysis, lastUpdated = null) {
  const displayMode = mode === "short" ? "short" : "long";
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
  // Curated blurbs preferred; otherwise use API overview description (non-board / discovery).
  const description =
    local?.description || overview.description || null;
  const priceHistory = Array.isArray(quote.priceHistory)
    ? quote.priceHistory
    : Array.isArray(rawData?.priceHistory)
      ? rawData.priceHistory
      : [];
  const price = quote.price?.current ?? null;
  const weekRange = computeWeekRange(price, priceHistory, overview);
  const earnings = buildEarningsFlag(overview.earningsDate);
  const peers = Array.isArray(rawData?.peers) ? rawData.peers : [];
  const newsAgreement = computeNewsAgreement(rawData?.fundamentals);
  const analysisProvider = resolveProviderId() || "gemini";
  const analysisSourceLabel = sourceShortCode(analysisProvider);

  const dual = normalizeDualAnalysis(analysis);
  const take = pickAnalysisTake(dual, displayMode);
  const quip =
    normalizeLabel(dual?.quip) ||
    normalizeLabel(analysis?.quip) ||
    null;
  const analysisGeneratedAt =
    analysis?.generatedAt || dual?.generatedAt || null;
  const hasRealAnalysis = Boolean(
    take?.summary &&
      !String(take.summary).toLowerCase().includes("wasn't available")
  );
  const shortTermRank =
    parseRank(dual?.shortTermRank ?? analysis?.shortTermRank) ??
    heuristicRank(dual?.short || take);
  const longTermRank =
    parseRank(dual?.longTermRank ?? analysis?.longTermRank) ??
    heuristicRank(dual?.long || take);
  const modeRank = displayMode === "short" ? shortTermRank : longTermRank;
  const lastFieldRefresh =
    latestFreshnessIso(rawData) || analysisGeneratedAt || lastUpdated || null;
  const stale = isBoardStale(rawData, analysisGeneratedAt);

  const indicatorsForMode = pickIndicatorsForMode(quote.indicators, displayMode);
  const riskLevel = take?.risk || "medium";
  const aiTags = normalizeLabelList(take?.tags, 3);
  const indicatorTags = buildIndicatorTags(indicatorsForMode, {
    price,
    mode: displayMode,
  });
  // Prefer AI tags first, then our fixed indicator-derived tags (dedupe by technical).
  const mergedTags = [];
  const seen = new Set();
  for (const t of [...aiTags, ...indicatorTags]) {
    if (!t) continue;
    const key = String(t.technical || t.plain).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    mergedTags.push(t);
  }

  const newsAgreeTag =
    newsAgreement?.status === "agree"
      ? buildTag("news_agree")
      : newsAgreement?.status === "disagree"
        ? buildTag("news_disagree")
        : null;

  let weekRangeOut = weekRange;
  if (weekRange?.label === "near 52-week high") {
    weekRangeOut = { ...weekRange, labelTag: buildTag("week52_near_high") };
  } else if (weekRange?.label === "near 52-week low") {
    weekRangeOut = { ...weekRange, labelTag: buildTag("week52_near_low") };
  } else if (weekRange) {
    weekRangeOut = { ...weekRange, labelTag: buildTag("week52_range") };
  }

  const reportBase = {
    ticker: String(ticker).toUpperCase(),
    mode: displayMode,
    name: companyName,
    companyName,
    description,
    price,
    change: quote.price?.change ?? null,
    changePercent: quote.price?.changePercent ?? null,
    indicators: indicatorsForMode,
    analystTarget: overview.analystTargetPrice ?? null,
    sector,
    lastUpdated:
      lastUpdated ||
      freshness.priceUpdatedAt ||
      null,
    priceUpdatedAt: freshness.priceUpdatedAt || null,
    targetUpdatedAt: freshness.targetUpdatedAt || null,
    newsUpdatedAt: freshness.newsUpdatedAt || null,
    analysisGeneratedAt,
    lastFieldRefresh,
    stale,
    shortTermRank,
    longTermRank,
    rankScore: modeRank,
    priceSource,
    priceSourceLabel: sourceShortCode(priceSource),
    targetSource,
    targetSourceLabel: sourceShortCode(targetSource),
    newsSources,
    newsSourceLabel: formatSourceList(newsSources),
    newsPending,
    newsAgreement,
    analysisSource: hasRealAnalysis ? analysisProvider : null,
    analysisSourceLabel: hasRealAnalysis ? analysisSourceLabel : null,
    weekRange: weekRangeOut,
    earnings,
    peers,
    priceHistory,
    quip: hasRealAnalysis ? quip : null,
    labels: {
      analystTarget: buildTag("analyst_target"),
      week52Range: buildTag("week52_range"),
      peers: buildTag("peers"),
      risk: riskTag(riskLevel),
      newsAgreement: newsAgreeTag,
      complete: buildTag("complete"),
    },
    deepDive: {
      sources: {
        price: sourceShortCode(priceSource),
        target: sourceShortCode(targetSource),
        news: formatSourceList(newsSources),
        peers: peers.length ? sourceShortCode("finnhub") : null,
        analysis: hasRealAnalysis ? analysisSourceLabel : null,
      },
      weekRange: weekRangeOut,
      earnings,
      peers,
      newsMarketaux: rawData?.fundamentals?.newsMarketaux || null,
      newsFinnhub: rawData?.fundamentals?.newsFinnhub || null,
    },
    analysis: {
      lean: take?.lean || "neutral",
      risk: riskLevel,
      riskTag: riskTag(riskLevel),
      tags: mergedTags.slice(0, 5),
      summary:
        take?.summary || "Analysis wasn't available right now.",
      deepDive:
        take?.deepDive ||
        "A longer AI deep dive wasn't available for this name yet.",
    },
  };

  reportBase.caveats = deriveDataCaveats(reportBase, {
    sharedIndicators: quote.indicators,
  });
  reportBase.fullyAnalyzed = reportBase.caveats.length === 0;

  return reportBase;
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

/**
 * Load/refresh shared stock data + dual AI analysis (one Gemini call).
 * Mode is not used for fetching or storage.
 * options.skipPeers — skip Finnhub peers when true.
 * options.newsOnly — refresh news (and re-analyze if needed); skip price/target/peers.
 * options.smartRefresh — when a QuotaBudget is active, skip sources with 0 remaining
 *   instead of failing hard; respects normal freshness (does not force stale).
 */
async function loadSharedStockData(ticker, options = {}) {
  const symbol = String(ticker).toUpperCase();
  return runWithCallContext({ ticker: symbol }, () =>
    loadSharedStockDataInner(symbol, options)
  );
}

async function loadSharedStockDataInner(symbol, options = {}) {
  const skipPeers = Boolean(options.skipPeers);
  const newsOnly = Boolean(options.newsOnly);
  const smartRefresh = Boolean(options.smartRefresh);

  const entry = await getStockCacheEntry(symbol);
  let rawData = ensureRawShape(entry?.data);
  let analysis = await getCachedSummary(symbol);

  const priceOk = isPriceFresh(rawData);
  const targetOk = isTargetFresh(rawData);
  const newsOk = isNewsFresh(rawData);
  const earningsOk = isEarningsFresh(rawData);
  const fullyFresh = isFullyFresh(rawData);

  if (fullyFresh && analysis && !newsOnly) {
    // Still fill missing peers — empty [] used to stick forever on full cache hits.
    if (!skipPeers && (!rawData.peers || !rawData.peers.length)) {
      console.log(
        `[getStockReport] full cache hit for ${symbol} but peers empty — fetching peers only`
      );
      try {
        rawData.peers = (await getPeers(symbol)) || [];
        if (rawData.peers.length) noteFieldRefreshed("peers");
        await saveStockToCache(symbol, null, rawData);
      } catch (err) {
        if (!(err instanceof QuotaSkippedError)) throw err;
        console.warn(`[getStockReport] peers skipped — no quota for ${symbol}`);
      }
    } else {
      console.log(
        `[getStockReport] full cache hit for ${symbol} — no live API calls`
      );
    }
    return {
      rawData,
      analysis,
      lastUpdated: rawData.freshness.priceUpdatedAt,
    };
  }

  let didFetch = false;
  let newsJustFetched = false;
  const now = () => new Date().toISOString();

  if (!newsOnly) {
    if (!priceOk) {
      console.log(`[getStockReport] price stale/missing for ${symbol} — fetching`);
      try {
        const quote = await getQuoteAndIndicators(symbol);
        if (!quote && !rawData.quote) {
          console.error(
            `[getStockReport] Missing quote/indicators for ${symbol}`
          );
          return null;
        }
        if (quote) {
          rawData.quote = quote;
          rawData.freshness.priceUpdatedAt = now();
          noteFieldRefreshed("price");
          if (quote.name && !rawData.fundamentals.overview.name) {
            rawData.fundamentals.overview.name = quote.name;
          }
          try {
            await logQuoteClose(quote);
          } catch (err) {
            console.warn(
              `[getStockReport] logQuoteClose failed for ${symbol}:`,
              err.message
            );
          }
          didFetch = true;
        }
      } catch (err) {
        if (err instanceof QuotaSkippedError) {
          console.warn(
            `[getStockReport] price skipped — no quota for ${symbol}`
          );
        } else if (
          err instanceof AlphaVantageError &&
          err.code === "rate_limit" &&
          rawData.quote
        ) {
          console.warn(
            `[getStockReport] price refetch rate-limited for ${symbol} — keeping cached quote and continuing`
          );
        } else {
          throw err;
        }
      }
    } else {
      console.log(`[getStockReport] price fresh for ${symbol}`);
    }

    if (!targetOk) {
      console.log(
        `[getStockReport] target stale/missing for ${symbol} — fetching`
      );
      const target = await getAnalystTarget(symbol);
      const overview = rawData.fundamentals.overview;
      const local = getTickerInfo(symbol);
      if (target?.quotaSkipped) {
        console.warn(
          `[getStockReport] target skipped — no quota for ${symbol}`
        );
      } else if (!target?.rateLimited) {
        overview.analystTargetPrice = target?.analystTargetPrice ?? null;
        overview.analystTargetSource = target?.source || null;
        if (target?.week52High != null) overview.week52High = target.week52High;
        if (target?.week52Low != null) overview.week52Low = target.week52Low;
        if (!local) {
          if (target?.name) overview.name = overview.name || target.name;
          if (target?.sector) overview.sector = overview.sector || target.sector;
          if (target?.industry) {
            overview.industry = overview.industry || target.industry;
          }
          if (target?.description) {
            overview.description = overview.description || target.description;
          }
        }
        if (target?.peRatio != null) overview.peRatio = target.peRatio;
        if (target?.marketCap != null) overview.marketCap = target.marketCap;
        rawData.freshness.targetUpdatedAt = now();
        noteFieldRefreshed("target");
        didFetch = true;
      } else if (target?.analystTargetPrice != null) {
        overview.analystTargetPrice = target.analystTargetPrice;
        overview.analystTargetSource = target.source || null;
        rawData.freshness.targetUpdatedAt = now();
        noteFieldRefreshed("target");
        didFetch = true;
      } else {
        didFetch = true;
      }
    } else {
      console.log(`[getStockReport] target fresh for ${symbol}`);
    }

    if (!earningsOk) {
      console.log(
        `[getStockReport] earnings stale/missing for ${symbol} — Finnhub calendar`
      );
      const earnings = await getEarningsDateFromFinnhub(symbol);
      if (earnings) {
        const overview = rawData.fundamentals.overview;
        overview.earningsDate = earnings.earningsDate || null;
        overview.earningsSource = earnings.source || "finnhub";
        if (earnings.hour) overview.earningsHour = earnings.hour;
        rawData.freshness.earningsUpdatedAt = now();
        noteFieldRefreshed("earnings");
      }
      didFetch = true;
    } else {
      console.log(`[getStockReport] earnings fresh for ${symbol}`);
    }
  } else {
    console.log(`[getStockReport] newsOnly for ${symbol} — skipping price/target/earnings`);
    if (!rawData.quote) {
      console.error(
        `[getStockReport] newsOnly requested but no cached quote for ${symbol}`
      );
      return null;
    }
  }

  if (!newsOk) {
    console.log(
      `[getStockReport] news stale/missing for ${symbol} — Marketaux primary, AV fallback-only`
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
      noteFieldRefreshed("news");
    }
    didFetch = true;
  } else {
    rawData.fundamentals.newsPending = false;
    console.log(`[getStockReport] news fresh for ${symbol}`);
  }

  if (!newsOnly) {
    if (!skipPeers && (!rawData.peers || !rawData.peers.length)) {
      rawData.peers = (await getPeers(symbol)) || [];
      if (rawData.peers.length) noteFieldRefreshed("peers");
      didFetch = true;
    } else if (skipPeers && !Array.isArray(rawData.peers)) {
      rawData.peers = [];
    }
  } else if (!Array.isArray(rawData.peers)) {
    rawData.peers = [];
  }

  if (didFetch || !entry) {
    await saveStockToCache(symbol, null, rawData);
  }

  const shouldAnalyze =
    !analysis || (newsJustFetched && rawData.fundamentals.newsPending === false);

  if (shouldAnalyze) {
    const budget = getActiveBudget();
    if (smartRefresh && budget && !budget.hasQuota("gemini")) {
      const reason = budget.blockReason("gemini", 1) || "no_quota";
      console.warn(
        `[getStockReport] analysis skipped — ${reason} for ${symbol}`
      );
      const outcomes = getActiveOutcomes();
      if (outcomes) {
        const entry = {
          field: "analysis",
          reason,
          provider: "gemini",
        };
        if (reason === "reserve_protected") {
          if (!Array.isArray(outcomes.skippedReserveProtected)) {
            outcomes.skippedReserveProtected = [];
          }
          outcomes.skippedReserveProtected.push(entry);
        } else {
          if (!Array.isArray(outcomes.skippedNoQuota)) {
            outcomes.skippedNoQuota = [];
          }
          outcomes.skippedNoQuota.push(entry);
        }
      }
    } else {
      console.log(
        `[getStockReport] summary ${analysis ? "refresh" : "miss"} for ${symbol} — calling Gemini once (dual+quip)`
      );
      analysis = await analyzeStock(
        symbol,
        rawData.quote,
        rawData.fundamentals,
        rawData.peers || []
      );
      await saveSummaryToCache(symbol, null, analysis);
      noteFieldRefreshed("analysis");
    }
  } else {
    console.log(`[getStockReport] summary cache hit for ${symbol}`);
  }

  return {
    rawData,
    analysis,
    lastUpdated: rawData.freshness.priceUpdatedAt,
  };
}

/**
 * Cache-first report builder with in-flight dedupe per ticker.
 * Mode is display-only: picks short/long take + indicators from the shared report.
 * options.skipPeers — skip Finnhub peers when true.
 * options.newsOnly — only refresh news (+ re-analyze if needed).
 * options.smartRefresh — quota-aware path used by Smart Refresh.
 */
async function getStockReport(ticker, mode, options = {}) {
  const symbol = String(ticker).toUpperCase();
  const displayMode = mode === "short" ? "short" : "long";

  let promise = inFlight.get(symbol);
  if (promise) {
    console.log(`[getStockReport] joining in-flight request for ${symbol}`);
  } else {
    promise = loadSharedStockData(symbol, options).finally(() => {
      inFlight.delete(symbol);
    });
    inFlight.set(symbol, promise);
  }

  const loaded = await promise;
  if (!loaded) return null;

  return buildReport(
    symbol,
    displayMode,
    loaded.rawData,
    loaded.analysis,
    loaded.lastUpdated
  );
}

module.exports = { getStockReport, buildReport };
