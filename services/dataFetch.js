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

const ALPHA_VANTAGE_BASE = "https://www.alphavantage.co/query";
const FINNHUB_BASE = "https://finnhub.io/api/v1";
const TWELVE_DATA_BASE = "https://api.twelvedata.com";

class AlphaVantageError extends Error {
  constructor(code, message, resetsAt = null) {
    super(message);
    this.name = "AlphaVantageError";
    this.code = code;
    this.resetsAt = resetsAt;
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

/**
 * Sole Alpha Vantage HTTP entry point — always increments alpha_vantage usage.
 */
async function callAlphaVantage(params) {
  await incrementUsage(PROVIDERS.ALPHA);

  const { data } = await axios.get(ALPHA_VANTAGE_BASE, {
    params: { ...params, apikey: getAlphaKey() },
  });

  if (data?.Note || data?.Information) {
    const msg = data.Note || data.Information;
    throw new AlphaVantageError("rate_limit", msg, nextMidnightPacificIso());
  }

  if (data?.["Error Message"]) {
    throw new AlphaVantageError("invalid_ticker", data["Error Message"]);
  }

  return data;
}

/**
 * Sole Finnhub HTTP entry point — always increments finnhub usage.
 */
async function callFinnhub(pathname, params = {}) {
  await incrementUsage(PROVIDERS.FINNHUB);

  const { data } = await axios.get(`${FINNHUB_BASE}${pathname}`, {
    params: { ...params, token: getFinnhubKey() },
  });

  return data;
}

/**
 * Sole Twelve Data HTTP entry point — always increments twelve_data usage.
 */
async function callTwelveData(pathname, params = {}) {
  await incrementUsage(PROVIDERS.TWELVE);

  const { data } = await axios.get(`${TWELVE_DATA_BASE}${pathname}`, {
    params: { ...params, apikey: getTwelveKey() },
  });

  if (data?.status === "error" || data?.code === 429) {
    const msg = data?.message || "Twelve Data error";
    if (isRateLimitMessage(msg) || data?.code === 429) {
      throw new AlphaVantageError("rate_limit", msg, nextMidnightPacificIso());
    }
    throw new Error(msg);
  }

  return data;
}

function seriesKeyForMode(mode) {
  return mode === "long" ? "Weekly Time Series" : "Time Series (Daily)";
}

/** Bars oldest→newest from Alpha Vantage daily/weekly time series. */
function extractBarsFromAlpha(timeSeriesData, mode) {
  const series = timeSeriesData?.[seriesKeyForMode(mode)];
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

function buildQuoteFromBars(symbol, mode, interval, bars, source) {
  const latest = bars[bars.length - 1];
  const prev = bars.length > 1 ? bars[bars.length - 2] : null;
  const current = latest.close;
  const previousClose = prev?.close ?? null;
  const change =
    current != null && previousClose != null ? current - previousClose : null;
  const changePercent =
    change != null && previousClose ? (change / previousClose) * 100 : null;
  const closes = bars.map((b) => b.close);

  return {
    ticker: symbol,
    mode,
    interval,
    source,
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
    indicators: calculateIndicatorsFromCloses(closes),
  };
}

/**
 * Twelve Data price history — same consumer shape as Alpha Vantage path.
 */
async function getPriceHistoryFromTwelveData(ticker, mode) {
  const symbol = String(ticker).toUpperCase();
  const interval = mode === "long" ? "1week" : "1day";
  const data = await callTwelveData("/time_series", {
    symbol,
    interval,
    outputsize: 100,
    order: "DESC",
  });

  const bars = extractBarsFromTwelve(data);
  if (!bars.length) {
    throw new AlphaVantageError(
      "invalid_ticker",
      `No Twelve Data time series for ${symbol}`
    );
  }

  return buildQuoteFromBars(
    symbol,
    mode,
    mode === "long" ? "weekly" : "daily",
    bars,
    "twelve_data"
  );
}

/**
 * Current price + SMA/RSI/MACD/Bollinger.
 * Tries Alpha Vantage once; on rate_limit, falls back to Twelve Data.
 */
async function getQuoteAndIndicators(ticker, mode) {
  const symbol = String(ticker).toUpperCase();
  const interval = mode === "long" ? "weekly" : "daily";
  const timeSeriesFunction =
    mode === "long" ? "TIME_SERIES_WEEKLY" : "TIME_SERIES_DAILY";

  try {
    const timeSeriesData = await callAlphaVantage({
      function: timeSeriesFunction,
      symbol,
    });

    const bars = extractBarsFromAlpha(timeSeriesData, mode);
    if (!bars.length) {
      throw new AlphaVantageError(
        "invalid_ticker",
        `No time series data returned for ${symbol}`
      );
    }

    console.log(
      `[getQuoteAndIndicators] ${symbol} (${mode}) source=alpha_vantage`
    );
    return buildQuoteFromBars(symbol, mode, interval, bars, "alpha_vantage");
  } catch (err) {
    if (err instanceof AlphaVantageError && err.code === "rate_limit") {
      console.warn(
        `[getQuoteAndIndicators] Alpha Vantage rate-limited for ${symbol} — trying Twelve Data`
      );
      try {
        const quote = await getPriceHistoryFromTwelveData(symbol, mode);
        console.log(
          `[getQuoteAndIndicators] ${symbol} (${mode}) source=twelve_data`
        );
        return quote;
      } catch (twelveErr) {
        console.error(
          `[getQuoteAndIndicators] Twelve Data fallback failed for ${symbol}:`,
          twelveErr.message
        );
        throw err;
      }
    }

    if (err instanceof AlphaVantageError) throw err;
    console.error(
      `[getQuoteAndIndicators] Failed for ${ticker} (${mode}):`,
      err.message
    );
    return null;
  }
}

/**
 * Company overview + news — two Alpha Vantage calls (sequential).
 */
async function getFundamentalsAndNews(ticker) {
  try {
    const symbol = String(ticker).toUpperCase();

    const overview = await callAlphaVantage({ function: "OVERVIEW", symbol });
    await sleep(1200);
    const newsData = await callAlphaVantage({
      function: "NEWS_SENTIMENT",
      tickers: symbol,
      limit: 50,
    });

    if (!overview || !overview.Symbol) {
      throw new AlphaVantageError(
        "invalid_ticker",
        `No overview data returned for ${symbol}`
      );
    }

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

    return {
      ticker: symbol,
      overview: {
        name: overview.Name || null,
        description: overview.Description || null,
        sector: overview.Sector || null,
        industry: overview.Industry || null,
        marketCap: num(overview.MarketCapitalization),
        peRatio: num(overview.PERatio),
        pegRatio: num(overview.PEGRatio),
        eps: num(overview.EPS),
        dividendYield: num(overview.DividendYield),
        profitMargin: num(overview.ProfitMargin),
        week52High: num(overview["52WeekHigh"]),
        week52Low: num(overview["52WeekLow"]),
        beta: num(overview.Beta),
        analystTargetPrice: num(overview.AnalystTargetPrice),
        analystRatingStrongBuy: num(overview.AnalystRatingStrongBuy),
        analystRatingBuy: num(overview.AnalystRatingBuy),
        analystRatingHold: num(overview.AnalystRatingHold),
        analystRatingSell: num(overview.AnalystRatingSell),
        analystRatingStrongSell: num(overview.AnalystRatingStrongSell),
      },
      news: articles,
    };
  } catch (err) {
    if (err instanceof AlphaVantageError) throw err;
    console.error(`[getFundamentalsAndNews] Failed for ${ticker}:`, err.message);
    return null;
  }
}

/**
 * Finnhub peers — returns 3–5 peer tickers, excluding the original.
 */
async function getPeers(ticker) {
  try {
    const symbol = String(ticker).toUpperCase();
    const data = await callFinnhub("/stock/peers", { symbol });

    if (!Array.isArray(data)) {
      throw new Error("Finnhub peers response was not an array");
    }

    const peers = data
      .map((p) => String(p).toUpperCase())
      .filter((p) => p && p !== symbol)
      .slice(0, 5);

    if (peers.length < 3) {
      console.warn(
        `[getPeers] Only found ${peers.length} peer(s) for ${symbol} (wanted 3–5)`
      );
    }

    return peers;
  } catch (err) {
    console.error(`[getPeers] Failed for ${ticker}:`, err.message);
    return null;
  }
}

module.exports = {
  callAlphaVantage,
  callFinnhub,
  callTwelveData,
  getQuoteAndIndicators,
  getFundamentalsAndNews,
  getPeers,
  getPriceHistoryFromTwelveData,
  AlphaVantageError,
  nextMidnightPacificIso,
};
