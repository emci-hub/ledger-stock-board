require("dotenv").config();

const axios = require("axios");
const {
  MACD,
  SMA,
  RSI,
  BollingerBands,
} = require("technicalindicators");
const {
  incrementUsage,
  PROVIDERS,
  nextMidnightPacificIso,
} = require("./usage");
const {
  enabledSourcesFor,
  hasSourceKey,
  sourceLabel,
} = require("../lib/dataSources");

const ALPHA_VANTAGE_BASE = "https://www.alphavantage.co/query";
const FINNHUB_BASE = "https://finnhub.io/api/v1";
const TWELVE_DATA_BASE = "https://api.twelvedata.com";
const MARKETAUX_BASE = "https://api.marketaux.com/v1";

/** Once Twelve Data rejects price_target as plan-gated, skip further TD target calls this process. */
let twelvePriceTargetPlanBlocked = false;
/** Once Alpha Vantage hits daily rate limit, skip further AV calls this process (preserve remaining attempts). */
let alphaVantageRateLimited = false;

class AlphaVantageError extends Error {
  constructor(code, message, resetsAt = null) {
    super(message);
    this.name = "AlphaVantageError";
    this.code = code;
    this.resetsAt = resetsAt;
  }
}

class TwelveDataError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TwelveDataError";
    this.code = code;
  }
}

function getAlphaKey() {
  const key = process.env.ALPHA_VANTAGE_API_KEY;
  if (!key) throw new Error("ALPHA_VANTAGE_API_KEY is not set in .env");
  return key;
}

function getFinnhubKey() {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) throw new Error("FINNHUB_API_KEY is not set in .env");
  return key;
}

function getTwelveKey() {
  const key = process.env.TWELVE_DATA_API_KEY;
  if (!key) throw new Error("TWELVE_DATA_API_KEY is not set in .env");
  return key;
}

function getMarketauxKey() {
  const key = process.env.MARKETAUX_API_KEY;
  if (!key) throw new Error("MARKETAUX_API_KEY is not set in .env");
  return key;
}

function hasTwelveKey() {
  return hasSourceKey("twelve_data");
}

function hasMarketauxKey() {
  return hasSourceKey("marketaux");
}

function num(value) {
  if (value == null || value === "") return null;
  const n = Number(String(value).replace("%", ""));
  return Number.isFinite(n) ? n : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitMessage(msg) {
  const m = String(msg || "").toLowerCase();
  return (
    m.includes("frequency") ||
    m.includes("rate limit") ||
    m.includes("25 requests") ||
    m.includes("per day") ||
    m.includes("per minute") ||
    m.includes("call frequency") ||
    m.includes("thank you for using alpha vantage") ||
    m.includes("api credits") ||
    m.includes("run out of")
  );
}

function isPlanRestrictedMessage(msg, data) {
  const m = String(msg || "").toLowerCase();
  const code = Number(data?.code);
  return (
    code === 403 ||
    code === 402 ||
    m.includes("upgrade") ||
    m.includes("your current plan") ||
    m.includes("your plan") ||
    m.includes("not available") ||
    m.includes("not included") ||
    m.includes("subscribe") ||
    m.includes("permission denied") ||
    m.includes("ultra plan") ||
    m.includes("pro plan") ||
    m.includes("enterprise plan") ||
    m.includes("higher plan")
  );
}

/**
 * Sole Alpha Vantage HTTP entry point — always increments alpha_vantage usage.
 */
async function callAlphaVantage(params) {
  if (alphaVantageRateLimited) {
    throw new AlphaVantageError(
      "rate_limit",
      "Alpha Vantage already rate-limited this process",
      nextMidnightPacificIso()
    );
  }

  await incrementUsage(PROVIDERS.ALPHA);

  const { data } = await axios.get(ALPHA_VANTAGE_BASE, {
    params: { ...params, apikey: getAlphaKey() },
  });

  if (data?.Note || data?.Information) {
    const msg = data.Note || data.Information;
    alphaVantageRateLimited = true;
    throw new AlphaVantageError("rate_limit", msg, nextMidnightPacificIso());
  }

  if (data?.["Error Message"]) {
    throw new AlphaVantageError("invalid_ticker", data["Error Message"]);
  }

  return data;
}

/**
 * Sole Finnhub HTTP entry point — always increments finnhub usage.
 * Soft-caps at 50 calls / rolling 60s (Finnhub free limit is 60/min) by
 * queuing callers with a short wait instead of risking 429s.
 */
const FINNHUB_WINDOW_MS = 60_000;
const FINNHUB_SOFT_LIMIT = 50;
const finnhubCallTimestamps = [];
let finnhubGate = Promise.resolve();

async function acquireFinnhubSlot() {
  let release;
  const previous = finnhubGate;
  finnhubGate = new Promise((resolve) => {
    release = resolve;
  });
  await previous;

  try {
    for (;;) {
      const now = Date.now();
      while (
        finnhubCallTimestamps.length &&
        now - finnhubCallTimestamps[0] >= FINNHUB_WINDOW_MS
      ) {
        finnhubCallTimestamps.shift();
      }

      if (finnhubCallTimestamps.length < FINNHUB_SOFT_LIMIT) {
        finnhubCallTimestamps.push(Date.now());
        return;
      }

      const waitMs =
        FINNHUB_WINDOW_MS - (now - finnhubCallTimestamps[0]) + 50;
      console.warn(
        `[callFinnhub] rate-limit delay ${waitMs}ms (${finnhubCallTimestamps.length}/${FINNHUB_SOFT_LIMIT} in 60s window)`
      );
      await incrementUsage(PROVIDERS.FINNHUB_DELAY);
      await sleep(Math.max(waitMs, 100));
    }
  } finally {
    release();
  }
}

async function callFinnhub(pathname, params = {}) {
  await acquireFinnhubSlot();
  await incrementUsage(PROVIDERS.FINNHUB);

  const { data } = await axios.get(`${FINNHUB_BASE}${pathname}`, {
    params: { ...params, token: getFinnhubKey() },
  });

  return data;
}

/**
 * Sole Marketaux HTTP entry point — always increments marketaux usage.
 */
async function callMarketaux(pathname, params = {}) {
  await incrementUsage(PROVIDERS.MARKETAUX);

  const { data } = await axios.get(`${MARKETAUX_BASE}${pathname}`, {
    params: { ...params, api_token: getMarketauxKey() },
  });

  if (data?.error || data?.errors) {
    const msg =
      data?.error?.message ||
      (Array.isArray(data.errors) ? data.errors.join(", ") : null) ||
      "Marketaux error";
    throw new Error(msg);
  }

  return data;
}

/**
 * Sole Twelve Data HTTP entry point — always increments twelve_data usage.
 */
async function callTwelveData(pathname, params = {}) {
  await incrementUsage(PROVIDERS.TWELVE);

  let data;
  try {
    const res = await axios.get(`${TWELVE_DATA_BASE}${pathname}`, {
      params: { ...params, apikey: getTwelveKey() },
    });
    data = res.data;
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    const msg = body?.message || err.message || "Twelve Data error";
    if (status === 403 || status === 402 || isPlanRestrictedMessage(msg, body)) {
      throw new TwelveDataError("plan_restricted", msg);
    }
    if (status === 429 || isRateLimitMessage(msg)) {
      throw new AlphaVantageError("rate_limit", msg, nextMidnightPacificIso());
    }
    throw err;
  }

  if (data?.status === "error" || data?.code === 429 || data?.code === 403) {
    const msg = data?.message || "Twelve Data error";
    if (isPlanRestrictedMessage(msg, data)) {
      throw new TwelveDataError("plan_restricted", msg);
    }
    if (isRateLimitMessage(msg) || data?.code === 429) {
      throw new AlphaVantageError("rate_limit", msg, nextMidnightPacificIso());
    }
    throw new TwelveDataError("error", msg);
  }

  return data;
}

/** Bars oldest→newest from Alpha Vantage daily time series. */
function extractBarsFromAlphaDaily(timeSeriesData) {
  const series = timeSeriesData?.["Time Series (Daily)"];
  if (!series || typeof series !== "object") return [];

  return Object.keys(series)
    .sort()
    .map((date) => {
      const row = series[date];
      return {
        date,
        open: num(row["1. open"]),
        high: num(row["2. high"]),
        low: num(row["3. low"]),
        close: num(row["4. close"]),
        volume: num(row["5. volume"]),
      };
    })
    .filter((b) => b.close != null);
}

/** Bars oldest→newest from Twelve Data time_series response. */
function extractBarsFromTwelve(twelveData) {
  const values = Array.isArray(twelveData?.values) ? twelveData.values : [];
  return values
    .slice()
    .reverse()
    .map((row) => ({
      date: row.datetime || null,
      open: num(row.open),
      high: num(row.high),
      low: num(row.low),
      close: num(row.close),
      volume: num(row.volume),
    }))
    .filter((b) => b.close != null);
}

function lastOrNull(arr) {
  if (!arr || !arr.length) return null;
  return arr[arr.length - 1];
}

function calculateIndicatorsFromCloses(closes) {
  const sma20 = lastOrNull(SMA.calculate({ period: 20, values: closes }));
  const sma50 = lastOrNull(SMA.calculate({ period: 50, values: closes }));
  const sma200 = lastOrNull(SMA.calculate({ period: 200, values: closes }));
  const rsi = lastOrNull(RSI.calculate({ period: 14, values: closes }));

  const bbands = lastOrNull(
    BollingerBands.calculate({
      period: 20,
      stdDev: 2,
      values: closes,
    })
  );

  let macd = { macd: null, signal: null, histogram: null };
  if (closes.length >= 26) {
    const macdSeries = MACD.calculate({
      values: closes,
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      SimpleMAOscillator: false,
      SimpleMASignal: false,
    });
    const latest = lastOrNull(macdSeries);
    if (latest) {
      macd = {
        macd: num(latest.MACD),
        signal: num(latest.signal),
        histogram: num(latest.histogram),
      };
    }
  }

  return {
    sma: {
      sma20: num(sma20),
      sma50: num(sma50),
      sma200: num(sma200),
    },
    rsi: num(rsi),
    macd,
    bollinger: {
      upper: num(bbands?.upper),
      middle: num(bbands?.middle),
      lower: num(bbands?.lower),
    },
  };
}

/** ~1–2 years of daily bars shared by short + long indicator windows. */
const DAILY_HISTORY_BARS = 500;
/** Recent window for short-term indicators (enough for SMA50). */
const SHORT_WINDOW_BARS = 60;

function buildQuoteFromBars(symbol, bars, source, meta = null) {
  const latest = bars[bars.length - 1];
  const prev = bars.length > 1 ? bars[bars.length - 2] : null;
  const current = latest.close;
  const previousClose = prev?.close ?? null;
  const change =
    current != null && previousClose != null ? current - previousClose : null;
  const changePercent =
    change != null && previousClose ? (change / previousClose) * 100 : null;
  const closes = bars.map((b) => b.close);
  const shortCloses = closes.slice(-SHORT_WINDOW_BARS);
  const indicatorsShort = calculateIndicatorsFromCloses(shortCloses);
  const indicatorsLong = calculateIndicatorsFromCloses(closes);

  return {
    ticker: symbol,
    interval: "daily",
    source,
    name: meta?.name || null,
    price: {
      current,
      open: latest.open,
      high: latest.high,
      low: latest.low,
      volume: latest.volume,
      previousClose,
      change,
      changePercent,
      latestTradingDay: latest.date || null,
    },
    priceHistory: closes.slice(-40),
    /** Shared history; UI/analysis pick short vs long from the same object. */
    indicators: {
      short: indicatorsShort,
      long: indicatorsLong,
    },
  };
}

async function getPriceHistoryFromTwelveData(ticker) {
  const symbol = String(ticker).toUpperCase();
  const data = await callTwelveData("/time_series", {
    symbol,
    interval: "1day",
    outputsize: DAILY_HISTORY_BARS,
    order: "DESC",
  });

  const bars = extractBarsFromTwelve(data);
  if (!bars.length) {
    throw new AlphaVantageError(
      "invalid_ticker",
      `No Twelve Data time series for ${symbol}`
    );
  }

  return buildQuoteFromBars(symbol, bars, "twelve_data", data.meta || null);
}

async function getPriceHistoryFromAlpha(ticker) {
  const symbol = String(ticker).toUpperCase();
  const timeSeriesData = await callAlphaVantage({
    function: "TIME_SERIES_DAILY",
    symbol,
    outputsize: "full",
  });

  let bars = extractBarsFromAlphaDaily(timeSeriesData);
  if (!bars.length) {
    throw new AlphaVantageError(
      "invalid_ticker",
      `No time series data returned for ${symbol}`
    );
  }

  if (bars.length > DAILY_HISTORY_BARS) {
    bars = bars.slice(-DAILY_HISTORY_BARS);
  }

  return buildQuoteFromBars(symbol, bars, "alpha_vantage");
}

/**
 * One longer daily price history + short/long indicators from the same bars.
 * Tries Twelve Data first; falls back to Alpha Vantage to preserve AV quota for news.
 * Optional second arg ignored (mode is no longer a separate fetch).
 */
async function getQuoteAndIndicators(ticker, _mode) {
  const symbol = String(ticker).toUpperCase();

  if (hasTwelveKey()) {
    try {
      const quote = await getPriceHistoryFromTwelveData(symbol);
      console.log(
        `[getQuoteAndIndicators] ${symbol} source=twelve_data bars≈daily/${DAILY_HISTORY_BARS}`
      );
      return quote;
    } catch (err) {
      // Do not fall through to AV on Twelve rate limits — AV is reserved for news
      // and is often already exhausted; falling through blanks the board.
      if (err instanceof AlphaVantageError && err.code === "rate_limit") {
        console.error(
          `[getQuoteAndIndicators] Twelve Data rate-limited for ${symbol} — not falling back to Alpha Vantage`
        );
        throw err;
      }
      if (err instanceof AlphaVantageError && err.code === "invalid_ticker") {
        console.warn(
          `[getQuoteAndIndicators] Twelve Data invalid for ${symbol} — trying Alpha Vantage`
        );
      } else {
        console.warn(
          `[getQuoteAndIndicators] Twelve Data failed for ${symbol} — trying Alpha Vantage:`,
          err.message
        );
      }
    }
  } else {
    console.warn(
      `[getQuoteAndIndicators] TWELVE_DATA_API_KEY missing — price fetch will use Alpha Vantage for ${symbol}`
    );
  }

  try {
    const quote = await getPriceHistoryFromAlpha(symbol);
    console.log(`[getQuoteAndIndicators] ${symbol} source=alpha_vantage`);
    return quote;
  } catch (err) {
    if (err instanceof AlphaVantageError) throw err;
    console.error(`[getQuoteAndIndicators] Failed for ${ticker}:`, err.message);
    return null;
  }
}

/**
 * Analyst target from Twelve Data /price_target (often plan-gated on free tier).
 */
async function getAnalystTargetFromTwelveData(ticker) {
  const symbol = String(ticker).toUpperCase();
  if (twelvePriceTargetPlanBlocked) {
    throw new TwelveDataError(
      "plan_restricted",
      "Twelve Data price_target previously blocked for this process"
    );
  }

  const data = await callTwelveData("/price_target", { symbol });
  const average = num(data?.price_target?.average);
  if (average == null) {
    throw new TwelveDataError(
      "unavailable",
      `No price_target.average for ${symbol}`
    );
  }

  return {
    analystTargetPrice: average,
    source: "twelve_data",
    name: data?.meta?.name || null,
  };
}

/**
 * Analyst target from Alpha Vantage OVERVIEW (also returns name/sector extras).
 */
async function getAnalystTargetFromAlphaOverview(ticker) {
  const symbol = String(ticker).toUpperCase();
  const overview = await callAlphaVantage({ function: "OVERVIEW", symbol });

  if (!overview || !overview.Symbol) {
    throw new AlphaVantageError(
      "invalid_ticker",
      `No overview data returned for ${symbol}`
    );
  }

  return {
    analystTargetPrice: num(overview.AnalystTargetPrice),
    source: "alpha_vantage",
    name: overview.Name || null,
    sector: overview.Sector || null,
    industry: overview.Industry || null,
    description: overview.Description || null,
    marketCap: num(overview.MarketCapitalization),
    peRatio: num(overview.PERatio),
    week52High: num(overview["52WeekHigh"]),
    week52Low: num(overview["52WeekLow"]),
    // Present on some OVERVIEW payloads; null when absent.
    earningsDate:
      overview.EarningsDate ||
      overview.NextEarningsDate ||
      overview.EarningsReportDate ||
      null,
  };
}

/**
 * Try Twelve Data price_target first; on plan/unavailable errors fall back to AV overview.
 * Never throws for soft failures — returns null target instead.
 */
async function getAnalystTarget(ticker) {
  const symbol = String(ticker).toUpperCase();

  if (hasTwelveKey() && !twelvePriceTargetPlanBlocked) {
    try {
      const fromTwelve = await getAnalystTargetFromTwelveData(symbol);
      console.log(`[getAnalystTarget] ${symbol} source=twelve_data`);
      return fromTwelve;
    } catch (err) {
      if (err instanceof TwelveDataError && err.code === "plan_restricted") {
        twelvePriceTargetPlanBlocked = true;
        console.warn(
          `[getAnalystTarget] Twelve Data price_target plan-restricted — using Alpha Vantage overview for ${symbol} (and later tickers this process)`
        );
      } else {
        console.warn(
          `[getAnalystTarget] Twelve Data failed for ${symbol} — falling back to Alpha Vantage:`,
          err.message
        );
      }
    }
  }

  try {
    const fromAlpha = await getAnalystTargetFromAlphaOverview(symbol);
    console.log(`[getAnalystTarget] ${symbol} source=alpha_vantage`);
    return fromAlpha;
  } catch (err) {
    if (err instanceof AlphaVantageError && err.code === "rate_limit") {
      console.warn(
        `[getAnalystTarget] Alpha Vantage rate-limited for ${symbol} — target=null`
      );
      return {
        analystTargetPrice: null,
        source: null,
        rateLimited: true,
      };
    }
    console.error(`[getAnalystTarget] Both sources failed for ${symbol}:`, err.message);
    return {
      analystTargetPrice: null,
      source: null,
    };
  }
}

/**
 * Alpha Vantage NEWS_SENTIMENT only. Soft-fail: returns null on error (non-blocking).
 */
async function getNewsSentiment(ticker) {
  try {
    const symbol = String(ticker).toUpperCase();
    const newsData = await callAlphaVantage({
      function: "NEWS_SENTIMENT",
      tickers: symbol,
      limit: 50,
    });

    const articles = (newsData.feed || [])
      .slice()
      .sort((a, b) =>
        String(b.time_published).localeCompare(String(a.time_published))
      )
      .slice(0, 5)
      .map((article) => {
        const tickerSentiment = (article.ticker_sentiment || []).find(
          (t) => String(t.ticker).toUpperCase() === symbol
        );

        return {
          title: article.title || null,
          url: article.url || null,
          publishedAt: article.time_published || null,
          summary: article.summary || null,
          source: article.source || null,
          sentimentScore: num(
            tickerSentiment?.ticker_sentiment_score ??
              article.overall_sentiment_score
          ),
          sentimentLabel:
            tickerSentiment?.ticker_sentiment_label ||
            article.overall_sentiment_label ||
            null,
        };
      });

    return { ticker: symbol, source: "alpha_vantage", news: articles };
  } catch (err) {
    console.error(`[getNewsSentiment] Failed for ${ticker}:`, err.message);
    return null;
  }
}

/**
 * Finnhub /news-sentiment — aggregate company news score (US tickers).
 * Soft-fail: returns null on error (non-blocking). Independent of Alpha Vantage.
 */
async function getNewsFromFinnhub(ticker) {
  try {
    const symbol = String(ticker).toUpperCase();
    const data = await callFinnhub("/news-sentiment", { symbol });

    if (!data || typeof data !== "object") {
      throw new Error("Finnhub news-sentiment returned empty body");
    }

    return {
      ticker: symbol,
      source: "finnhub",
      companyNewsScore: num(data.companyNewsScore),
      sectorAverageBullishPercent: num(data.sectorAverageBullishPercent),
      sectorAverageNewsScore: num(data.sectorAverageNewsScore),
      buzz: data.buzz || null,
      sentiment: data.sentiment
        ? {
            bullishPercent: num(data.sentiment.bullishPercent),
            bearishPercent: num(data.sentiment.bearishPercent),
          }
        : null,
    };
  } catch (err) {
    console.error(`[getNewsFromFinnhub] Failed for ${ticker}:`, err.message);
    return null;
  }
}

/**
 * Marketaux /v1/news/all — entity sentiment_score + one highlight snippet.
 * Soft-fail: returns null on error (non-blocking).
 */
async function getNewsFromMarketaux(ticker) {
  try {
    if (!hasMarketauxKey()) return null;

    const symbol = String(ticker).toUpperCase();
    const data = await callMarketaux("/news/all", {
      symbols: symbol,
      filter_entities: true,
      language: "en",
      limit: 5,
    });

    const articles = Array.isArray(data?.data) ? data.data : [];
    const scored = [];

    for (const article of articles) {
      const entities = Array.isArray(article.entities) ? article.entities : [];
      const match =
        entities.find(
          (e) => String(e.symbol || "").toUpperCase() === symbol
        ) || entities[0];
      if (!match) continue;

      const highlight =
        Array.isArray(match.highlights) && match.highlights[0]
          ? match.highlights[0].highlight || null
          : null;

      scored.push({
        title: article.title || null,
        url: article.url || null,
        publishedAt: article.published_at || null,
        sentimentScore: num(match.sentiment_score),
        highlight: highlight
          ? String(highlight).replace(/<[^>]+>/g, "").slice(0, 220)
          : null,
      });
    }

    if (!scored.length) {
      return {
        ticker: symbol,
        source: "marketaux",
        articles: [],
        sentimentScore: null,
        highlight: null,
      };
    }

    const scores = scored
      .map((a) => a.sentimentScore)
      .filter((n) => n != null && Number.isFinite(n));
    const avg = scores.length
      ? scores.reduce((sum, n) => sum + n, 0) / scores.length
      : null;

    return {
      ticker: symbol,
      source: "marketaux",
      articles: scored.slice(0, 3),
      sentimentScore: avg != null ? avg : scored[0].sentimentScore,
      highlight: scored[0].highlight,
    };
  } catch (err) {
    console.error(`[getNewsFromMarketaux] Failed for ${ticker}:`, err.message);
    return null;
  }
}

/** Capability → fetcher map (registry-driven news aggregation). */
const NEWS_FETCHERS = {
  alpha_vantage: getNewsSentiment,
  finnhub: getNewsFromFinnhub,
  marketaux: getNewsFromMarketaux,
};

/**
 * Fetch all enabled news sources from the registry in parallel.
 * One failure never blocks another.
 */
async function getCombinedNews(ticker) {
  const enabled = enabledSourcesFor("news");
  const settled = await Promise.all(
    enabled.map(async (src) => {
      const fetch = NEWS_FETCHERS[src.id];
      if (!fetch) return { id: src.id, data: null };
      try {
        return { id: src.id, data: await fetch(ticker) };
      } catch (err) {
        console.error(
          `[getCombinedNews] ${sourceLabel(src.id)} failed:`,
          err.message
        );
        return { id: src.id, data: null };
      }
    })
  );

  const byId = Object.fromEntries(settled.map((r) => [r.id, r.data]));
  const sources = settled.filter((r) => r.data).map((r) => r.id);

  return {
    alpha: byId.alpha_vantage || null,
    finnhub: byId.finnhub || null,
    marketaux: byId.marketaux || null,
    byId,
    sources,
    pending: sources.length === 0,
  };
}

/**
 * @deprecated Prefer getAnalystTarget + getCombinedNews. Kept for compatibility.
 */
async function getFundamentalsAndNews(ticker) {
  const target = await getAnalystTarget(ticker);
  await sleep(1200);
  const combined = await getCombinedNews(ticker);

  return {
    ticker: String(ticker).toUpperCase(),
    overview: {
      name: target?.name || null,
      description: target?.description || null,
      sector: target?.sector || null,
      industry: target?.industry || null,
      marketCap: target?.marketCap ?? null,
      peRatio: target?.peRatio ?? null,
      analystTargetPrice: target?.analystTargetPrice ?? null,
      analystTargetSource: target?.source || null,
      week52High: target?.week52High ?? null,
      week52Low: target?.week52Low ?? null,
      earningsDate: target?.earningsDate || null,
    },
    news: combined.alpha?.news || [],
    newsFinnhub: combined.finnhub || null,
    newsMarketaux: combined.marketaux || null,
    newsSources: combined.sources,
    newsPending: combined.pending,
  };
}

/**
 * Finnhub peers — returns 3–5 peer tickers, excluding the original.
 * Free-tier /stock/peers is generally available (unlike /news-sentiment which is often 403).
 */
async function getPeers(ticker) {
  try {
    const symbol = String(ticker).toUpperCase();
    const data = await callFinnhub("/stock/peers", { symbol });

    if (!Array.isArray(data)) {
      console.error(
        `[getPeers] Unexpected Finnhub peers payload for ${symbol}:`,
        typeof data === "object" ? JSON.stringify(data).slice(0, 300) : data
      );
      throw new Error("Finnhub peers response was not an array");
    }

    const peers = data
      .map((p) => String(p).toUpperCase())
      .filter((p) => p && p !== symbol)
      .slice(0, 5);

    if (peers.length < 3) {
      console.warn(
        `[getPeers] Only found ${peers.length} peer(s) for ${symbol} (wanted 3–5); rawCount=${data.length}`
      );
    } else {
      console.log(`[getPeers] ${symbol} → ${peers.join(", ")}`);
    }

    return peers;
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    console.error(
      `[getPeers] Failed for ${ticker}:`,
      status ? `HTTP ${status}` : "",
      err.message,
      body ? JSON.stringify(body).slice(0, 300) : ""
    );
    return null;
  }
}

module.exports = {
  callAlphaVantage,
  callFinnhub,
  callTwelveData,
  callMarketaux,
  getQuoteAndIndicators,
  getAnalystTarget,
  getNewsSentiment,
  getNewsFromFinnhub,
  getNewsFromMarketaux,
  getCombinedNews,
  getFundamentalsAndNews,
  getPeers,
  getPriceHistoryFromTwelveData,
  AlphaVantageError,
  TwelveDataError,
  nextMidnightPacificIso,
};
