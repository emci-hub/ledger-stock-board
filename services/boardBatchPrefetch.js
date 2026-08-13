/**
 * Board-level batch prefetch — one MX + one AV news call, and as few TD
 * multi-symbol /time_series calls as needed, then write into stock_reports
 * so per-ticker getStockReport sees fields as fresh and skips re-fetch.
 */

const {
  getStockCacheEntry,
  saveStockToCache,
  isNewsFresh,
  isPriceFresh,
  emptyFreshness,
} = require("./cache");
const {
  getCombinedNewsBatch,
  getPriceHistoryFromTwelveDataBatch,
} = require("./dataFetch");
const { logQuoteClose } = require("./priceHistoryLog");

function ensureRawShape(data) {
  const raw = data && typeof data === "object" ? { ...data } : {};
  raw.fundamentals =
    raw.fundamentals && typeof raw.fundamentals === "object"
      ? { ...raw.fundamentals }
      : { overview: {} };
  if (!raw.fundamentals.overview || typeof raw.fundamentals.overview !== "object") {
    raw.fundamentals.overview = {};
  }
  raw.freshness =
    raw.freshness && typeof raw.freshness === "object"
      ? { ...raw.freshness }
      : emptyFreshness();
  if (!Array.isArray(raw.peers)) raw.peers = raw.peers || [];
  return raw;
}

async function applyNewsCombinedToCache(ticker, combined) {
  const symbol = String(ticker).toUpperCase();
  const entry = await getStockCacheEntry(symbol);
  const rawData = ensureRawShape(entry?.data);
  rawData.fundamentals.news = combined.alpha?.news || [];
  rawData.fundamentals.newsFinnhub = combined.finnhub || null;
  rawData.fundamentals.newsMarketaux = combined.marketaux || null;
  rawData.fundamentals.newsSources = combined.sources || [];
  rawData.fundamentals.newsPending = Boolean(combined.pending);
  if (!combined.pending) {
    rawData.freshness.newsUpdatedAt = new Date().toISOString();
  }
  await saveStockToCache(symbol, null, rawData);
  return !combined.pending;
}

async function applyQuoteToCache(ticker, quote) {
  const symbol = String(ticker).toUpperCase();
  if (!quote) return false;
  const entry = await getStockCacheEntry(symbol);
  const rawData = ensureRawShape(entry?.data);
  rawData.quote = quote;
  rawData.freshness.priceUpdatedAt = new Date().toISOString();
  await saveStockToCache(symbol, null, rawData);
  try {
    await logQuoteClose(quote);
  } catch (err) {
    console.warn(`[boardBatchPrefetch] logQuoteClose ${symbol}:`, err.message);
  }
  return true;
}

/**
 * Prefetch stale news + price for a ticker list using batched APIs.
 */
async function prefetchBoardNewsAndPrices(tickers, options = {}) {
  const list = (Array.isArray(tickers) ? tickers : [])
    .map((t) => String(t || "").trim().toUpperCase())
    .filter(Boolean);

  const newsTickers = [];
  const priceTickers = [];

  for (const t of list) {
    const entry = await getStockCacheEntry(t);
    if (options.forceNews || !isNewsFresh(entry?.data)) newsTickers.push(t);
    if (options.forcePrice || !isPriceFresh(entry?.data)) priceTickers.push(t);
  }

  const httpCalls = { marketaux: 0, alpha_vantage: 0, twelve_data: 0 };
  let twelveCredits = 0;
  let newsWritten = 0;
  let priceWritten = 0;

  if (newsTickers.length) {
    console.log(
      `[boardBatchPrefetch] news batch for ${newsTickers.length} ticker(s): ${newsTickers.join(",")}`
    );
    try {
      const { byTicker, httpCalls: newsHttp } = await getCombinedNewsBatch(
        newsTickers
      );
      httpCalls.marketaux += Number(newsHttp?.marketaux || 0);
      httpCalls.alpha_vantage += Number(newsHttp?.alpha_vantage || 0);
      for (const t of newsTickers) {
        const combined = byTicker[t];
        if (!combined) continue;
        const ok = await applyNewsCombinedToCache(t, combined);
        if (ok) newsWritten += 1;
      }
    } catch (err) {
      console.error(`[boardBatchPrefetch] news batch failed:`, err.message);
    }
  }

  if (priceTickers.length) {
    console.log(
      `[boardBatchPrefetch] price batch for ${priceTickers.length} ticker(s): ${priceTickers.join(",")}`
    );
    try {
      const { byTicker, httpCalls: tdHttp, credits } =
        await getPriceHistoryFromTwelveDataBatch(priceTickers);
      httpCalls.twelve_data += Number(tdHttp || 0);
      twelveCredits += Number(credits || 0);
      for (const t of priceTickers) {
        const quote = byTicker[t];
        if (!quote) continue;
        const ok = await applyQuoteToCache(t, quote);
        if (ok) priceWritten += 1;
      }
    } catch (err) {
      console.error(`[boardBatchPrefetch] price batch failed:`, err.message);
    }
  }

  const summary = {
    newsTickers,
    priceTickers,
    httpCalls,
    twelveCredits,
    newsWritten,
    priceWritten,
  };
  console.log(
    `[boardBatchPrefetch] done — news ${newsWritten}/${newsTickers.length} · price ${priceWritten}/${priceTickers.length} · http MX=${httpCalls.marketaux} AV=${httpCalls.alpha_vantage} TD=${httpCalls.twelve_data} (TD credits=${twelveCredits})`
  );
  return summary;
}

/**
 * Structural before/after HTTP call counts for a cold top-N board refresh
 * (news + price only — ignores target/earnings/peers/Gemini).
 */
function estimateBoardBatchCallSavings(tickerCount = 15) {
  const n = Math.max(0, Math.floor(Number(tickerCount) || 0));
  const before = {
    marketaux: n,
    alpha_vantage_news: n, // parallel restored; previously often 0 when MX ok
    twelve_data_http: n,
    twelve_data_credits: n,
  };
  const after = {
    marketaux: n ? 1 : 0,
    alpha_vantage_news: n ? 1 : 0,
    twelve_data_http: n ? Math.ceil(n / 15) : 0,
    twelve_data_credits: n, // TD still bills 1 credit / symbol
  };
  return {
    tickerCount: n,
    before,
    after,
    httpSaved: {
      marketaux: before.marketaux - after.marketaux,
      alpha_vantage_news: before.alpha_vantage_news - after.alpha_vantage_news,
      twelve_data: before.twelve_data_http - after.twelve_data_http,
    },
  };
}

module.exports = {
  prefetchBoardNewsAndPrices,
  estimateBoardBatchCallSavings,
  applyNewsCombinedToCache,
  applyQuoteToCache,
};
