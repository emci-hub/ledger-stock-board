require("dotenv").config();

const { getFallbackJoke } = require("./jokes");
const { computeNewsAgreement } = require("../lib/newsAgreement");
const { generateAnalysis } = require("../lib/aiProvider");
const {
  TAKE_FALLBACK,
  FALLBACK,
  parseQuip,
  applyNewsAgreementGuard,
  parseRank,
} = require("../lib/aiShape");
const { NEWLY_TRACKED_LONG_RANK_CAP } = require("../lib/rankingStability");

function pickIndicators(quoteData) {
  const ind = quoteData?.indicators;
  if (ind?.short && ind?.long) {
    return { short: ind.short, long: ind.long };
  }
  const flat = {
    sma20: ind?.sma?.sma20 ?? null,
    sma50: ind?.sma?.sma50 ?? null,
    sma200: ind?.sma?.sma200 ?? null,
    rsi: ind?.rsi ?? null,
    macd: ind?.macd || null,
    bollinger: ind?.bollinger || null,
  };
  return { short: flat, long: flat };
}

/**
 * Complements Gemini RANKING_RUBRIC — factual signals that must not rely on the model alone.
 * Soft-clamp Gemini longTermRank using factual rankingContext.
 * Full stability penalties (extreme/penny/exchange/thin real history) are applied
 * once at board read time via assessBoardPlacement — do not re-apply them here.
 * shortTermRank is never modified.
 */
function applyLongTermRankGuardrails(parsed, rankingContext) {
  if (!parsed || typeof parsed !== "object") return parsed;
  const ctx = rankingContext || {};
  let longRank = parseRank(parsed.longTermRank);
  if (longRank == null) return parsed;

  // If Gemini copied short onto long for a hot mover, pull long down first.
  const shortRank = parseRank(parsed.shortTermRank);
  if (
    ctx.extremeSingleDayMove &&
    shortRank != null &&
    longRank >= shortRank - 5
  ) {
    longRank = Math.min(longRank, Math.max(15, shortRank - 20));
  }

  const cap =
    ctx.longTermGuidance?.newlyTrackedLongRankSoftCap != null
      ? Number(ctx.longTermGuidance.newlyTrackedLongRankSoftCap)
      : ctx.newlyTracked
        ? NEWLY_TRACKED_LONG_RANK_CAP
        : null;

  if (cap != null && Number.isFinite(cap) && longRank > cap) {
    longRank = cap;
  }

  if (ctx.missingLongTermFundamentals && longRank > 55) {
    longRank = Math.min(longRank, 55);
  }

  parsed.longTermRank = longRank;
  return parsed;
}

function flattenIndicators(block) {
  if (!block) return {};
  if (block.sma) {
    return {
      sma20: block.sma?.sma20 ?? null,
      sma50: block.sma?.sma50 ?? null,
      sma200: block.sma?.sma200 ?? null,
      rsi: block.rsi ?? null,
      macd: block.macd || null,
      bollinger: block.bollinger || null,
    };
  }
  return {
    sma20: block.sma20 ?? null,
    sma50: block.sma50 ?? null,
    sma200: block.sma200 ?? null,
    rsi: block.rsi ?? null,
    macd: block.macd || null,
    bollinger: block.bollinger || null,
  };
}

function buildPayload(ticker, quoteData, fundamentalsData, peersData, options = {}) {
  const price = quoteData?.price || {};
  const windows = pickIndicators(quoteData);
  const overview = fundamentalsData?.overview || {};
  const news = Array.isArray(fundamentalsData?.news)
    ? fundamentalsData.news
    : [];
  const newsFinnhub = fundamentalsData?.newsFinnhub || null;
  const newsMarketaux = fundamentalsData?.newsMarketaux || null;
  const newsSources = Array.isArray(fundamentalsData?.newsSources)
    ? fundamentalsData.newsSources
    : [];
  const hasAlpha = newsSources.includes("alpha_vantage") || news.length > 0;
  const hasFinnhub = newsSources.includes("finnhub") || Boolean(newsFinnhub);
  const hasMarketaux =
    newsSources.includes("marketaux") || Boolean(newsMarketaux);
  const newsPending = Boolean(
    fundamentalsData?.newsPending ||
      (!hasAlpha && !hasFinnhub && !hasMarketaux)
  );

  const newsAlphaVantage = hasAlpha
    ? news.map((article) => ({
        title: article.title || null,
        sentimentScore: article.sentimentScore ?? null,
        sentimentLabel: article.sentimentLabel || null,
      }))
    : null;

  const newsAgreement = computeNewsAgreement(fundamentalsData);

  const peers = Array.isArray(peersData)
    ? peersData.map((peer) => {
        if (peer && typeof peer === "object") {
          return {
            ticker: peer.ticker || peer.symbol || null,
            price: peer.price ?? peer.current ?? null,
            changePercent: peer.changePercent ?? null,
            peRatio: peer.peRatio ?? null,
            sector: peer.sector || null,
          };
        }
        return { ticker: String(peer).toUpperCase() };
      })
    : [];

  const { buildRankingContext } = require("../lib/rankingStability");
  const rankingContext =
    options.rankingContext ||
    buildRankingContext(options.pick || {}, {
      price: price.current ?? null,
      changePercent: price.changePercent ?? null,
      exchange: overview.exchange || options.pick?.exchange || null,
      analystTargetPrice: overview.analystTargetPrice ?? null,
      peRatio: overview.peRatio ?? null,
      marketCap: overview.marketCap ?? null,
      ipoDate: overview.ipoDate || null,
      overview,
      source: options.pick?.source || null,
    });

  return {
    ticker: String(ticker).toUpperCase(),
    price: {
      current: price.current ?? null,
      change: price.change ?? null,
      changePercent: price.changePercent ?? null,
      latestTradingDay: price.latestTradingDay || null,
    },
    indicatorsShort: flattenIndicators(windows.short),
    indicatorsLong: flattenIndicators(windows.long),
    analystTargetPrice: overview.analystTargetPrice ?? null,
    week52High: overview.week52High ?? null,
    week52Low: overview.week52Low ?? null,
    earningsDate: overview.earningsDate || null,
    company: {
      name: overview.name || null,
      sector: overview.sector || null,
      industry: overview.industry || null,
      peRatio: overview.peRatio ?? null,
      marketCap: overview.marketCap ?? null,
      exchange: overview.exchange || options.pick?.exchange || null,
      ipoDate: overview.ipoDate || null,
    },
    rankingContext,
    newsSources,
    newsAlphaVantage,
    newsFinnhub: hasFinnhub ? newsFinnhub : null,
    newsMarketaux: hasMarketaux
      ? {
          sentimentScore: newsMarketaux.sentimentScore ?? null,
          highlight: newsMarketaux.highlight || null,
          articles: Array.isArray(newsMarketaux.articles)
            ? newsMarketaux.articles.slice(0, 2)
            : [],
        }
      : null,
    newsPending,
    newsAgreement,
    peers,
  };
}

/**
 * Dual analysis via swappable AI provider (default Gemini).
 * Call shapes:
 *   analyzeStock(ticker, quote, fundamentals, peers)
 *   analyzeStock(ticker, quote, fundamentals, peers, { provider })
 *   analyzeStock(ticker, mode, quote, fundamentals, peers) // mode ignored
 *   analyzeStock(ticker, mode, quote, fundamentals, peers, { provider })
 */
async function analyzeStock(
  ticker,
  modeOrQuote,
  quoteMaybe,
  fundamentalsMaybe,
  peersMaybe,
  optionsMaybe
) {
  let quoteData;
  let fundamentalsData;
  let peersData;
  let opts = {};

  const looksLikeQuote = (o) =>
    o && typeof o === "object" && !Array.isArray(o) && (o.price || o.indicators);

  const looksLikeOptions = (o) =>
    o &&
    typeof o === "object" &&
    !Array.isArray(o) &&
    ("provider" in o ||
      "skip" in o ||
      "pick" in o ||
      "rankingContext" in o);

  if (looksLikeQuote(modeOrQuote)) {
    quoteData = modeOrQuote;
    fundamentalsData = quoteMaybe;
    if (looksLikeOptions(peersMaybe)) {
      peersData = Array.isArray(fundamentalsMaybe) ? fundamentalsMaybe : [];
      opts = peersMaybe;
    } else {
      peersData = peersMaybe;
      if (looksLikeOptions(optionsMaybe)) opts = optionsMaybe;
    }
  } else {
    quoteData = quoteMaybe;
    fundamentalsData = fundamentalsMaybe;
    peersData = peersMaybe;
    if (looksLikeOptions(optionsMaybe)) opts = optionsMaybe;
  }

  const provider = opts.provider || process.env.AI_PROVIDER || "gemini";
  console.log(
    `[analyzeStock] provider=${provider} ticker=${String(ticker).toUpperCase()} at ${new Date().toISOString()}`
  );

  try {
    const payload = buildPayload(
      ticker,
      quoteData,
      fundamentalsData,
      peersData,
      opts
    );
    const newsAgreement = payload.newsAgreement;

    let parsed = await generateAnalysis(payload, { provider });
    parsed = applyNewsAgreementGuard(parsed, newsAgreement);
    parsed = applyLongTermRankGuardrails(parsed, payload.rankingContext);

    if (!parsed?.quip) {
      parsed.quip = parseQuip(await getFallbackJoke());
    }

    return parsed;
  } catch (err) {
    console.error(`[analyzeStock] Failed for ${ticker}:`, err.message);
    const quip = parseQuip(await getFallbackJoke());
    return {
      short: { ...TAKE_FALLBACK },
      long: { ...TAKE_FALLBACK },
      quip,
      shortTermRank: null,
      longTermRank: null,
      provider,
    };
  }
}

module.exports = {
  analyzeStock,
  buildPayload,
  applyLongTermRankGuardrails,
  TAKE_FALLBACK,
  FALLBACK,
};
