require("dotenv").config();

const { getFallbackJoke } = require("./jokes");
const { computeNewsAgreement } = require("../lib/newsAgreement");
const { generateAnalysis } = require("../lib/aiProvider");
const {
  TAKE_FALLBACK,
  FALLBACK,
  parseQuip,
  applyNewsAgreementGuard,
} = require("../lib/aiShape");

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

function buildPayload(ticker, quoteData, fundamentalsData, peersData) {
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
      peRatio: overview.peRatio ?? null,
    },
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
    o && typeof o === "object" && !Array.isArray(o) && ("provider" in o || "skip" in o);

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
      peersData
    );
    const newsAgreement = payload.newsAgreement;

    let parsed = await generateAnalysis(payload, { provider });
    parsed = applyNewsAgreementGuard(parsed, newsAgreement);

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
      provider,
    };
  }
}

module.exports = {
  analyzeStock,
  buildPayload,
  TAKE_FALLBACK,
  FALLBACK,
};
