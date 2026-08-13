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
  hasSourceKey,
  sourceLabel,
} = require("../lib/dataSources");
const {
  getActiveBudget,
  getActiveOutcomes,
  QuotaSkippedError,
} = require("./quotaBudget");
const { getCallContextTicker } = require("./callContext");

const ALPHA_VANTAGE_BASE = "https://www.alphavantage.co/query";
const FINNHUB_BASE = "https://finnhub.io/api/v1";
const TWELVE_DATA_BASE = "https://api.twelvedata.com";
const MARKETAUX_BASE = "https://api.marketaux.com/v1";
const FMP_BASE = "https://financialmodelingprep.com";

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

function getFmpKey() {
  const key = process.env.FMP_API_KEY;
  if (!key) throw new Error("FMP_API_KEY is not set in .env");
  return key;
}

function hasTwelveKey() {
  return hasSourceKey("twelve_data");
}

function hasMarketauxKey() {
  return hasSourceKey("marketaux");
}

function hasFmpKey() {
  return hasSourceKey("fmp");
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

function noteQuotaSkip(provider, action, reason = "no_quota") {
  const outcomes = getActiveOutcomes();
  if (!outcomes) return;
  if (!Array.isArray(outcomes.skippedNoQuota)) outcomes.skippedNoQuota = [];
  if (!Array.isArray(outcomes.skippedReserveProtected)) {
    outcomes.skippedReserveProtected = [];
  }
  const entry = {
    field: action || provider,
    reason: reason === "reserve_protected" ? "reserve_protected" : "no_quota",
    provider,
    ticker: getCallContextTicker(),
  };
  if (entry.reason === "reserve_protected") {
    outcomes.skippedReserveProtected.push(entry);
  } else {
    outcomes.skippedNoQuota.push(entry);
  }
}

function noteRefreshed(field) {
  const outcomes = getActiveOutcomes();
  if (!outcomes) return;
  if (!Array.isArray(outcomes.refreshedFields)) outcomes.refreshedFields = [];
  if (!outcomes.refreshedFields.includes(field)) {
    outcomes.refreshedFields.push(field);
  }
}

function consumeOrThrow(provider, action, n = 1) {
  const budget = getActiveBudget();
  if (!budget) return;
  const count = Math.max(1, Math.floor(Number(n) || 1));
  if (
    !budget.tryConsume(provider, count, {
      action,
      ticker: getCallContextTicker(),
    })
  ) {
    const err = budget.skipError(provider);
    noteQuotaSkip(provider, action, err.reason);
    throw err;
  }
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

  consumeOrThrow(PROVIDERS.ALPHA, params?.function || "alpha_vantage");
  await incrementUsage(PROVIDERS.ALPHA, {
    action: params?.function || "alpha_vantage",
  });

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
      await incrementUsage(PROVIDERS.FINNHUB_DELAY, {
        action: "rate_delay",
      });
      await sleep(Math.max(waitMs, 100));
    }
  } finally {
    release();
  }
}

async function callFinnhub(pathname, params = {}) {
  await acquireFinnhubSlot();
  consumeOrThrow(PROVIDERS.FINNHUB, pathname || "finnhub");
  await incrementUsage(PROVIDERS.FINNHUB, {
    action: pathname || "finnhub",
  });

  const { data } = await axios.get(`${FINNHUB_BASE}${pathname}`, {
    params: { ...params, token: getFinnhubKey() },
  });

  return data;
}

/**
 * Sole Marketaux HTTP entry point — always increments marketaux usage.
 */
async function callMarketaux(pathname, params = {}) {
  consumeOrThrow(PROVIDERS.MARKETAUX, pathname || "marketaux");
  await incrementUsage(PROVIDERS.MARKETAUX, {
    action: pathname || "marketaux",
  });

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
 * opts.credits — bill N credits for multi-symbol batch (TD bills 1 credit / symbol).
 */
async function callTwelveData(pathname, params = {}, opts = {}) {
  const credits = Math.max(1, Math.floor(Number(opts.credits) || 1));
  consumeOrThrow(PROVIDERS.TWELVE, pathname || "twelve_data", credits);
  await incrementUsage(PROVIDERS.TWELVE, {
    action: pathname || "twelve_data",
    count: credits,
    ticker: opts.ticker || getCallContextTicker(),
    detail: credits > 1 ? `batch_credits=${credits}` : null,
  });

  let data;
  try {
    const res = await axios.get(`${TWELVE_DATA_BASE}${pathname}`, {
      params: { ...params, apikey: getTwelveKey() },
      timeout: opts.timeoutMs || 60000,
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

/**
 * Sole FMP HTTP entry point — always increments fmp usage.
 * Uses /stable/* paths (legacy /api/v3/* is blocked for new free keys).
 */
async function callFmp(pathname, params = {}) {
  consumeOrThrow(PROVIDERS.FMP, pathname || "fmp");
  await incrementUsage(PROVIDERS.FMP, {
    action: pathname || "fmp",
  });

  let data;
  try {
    const res = await axios.get(`${FMP_BASE}${pathname}`, {
      params: { ...params, apikey: getFmpKey() },
      timeout: 30000,
    });
    data = res.data;
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    const msg =
      body?.["Error Message"] ||
      body?.error ||
      body?.message ||
      err.message ||
      "FMP error";
    if (status === 403 || status === 402 || /legacy|upgrade|plan/i.test(String(msg))) {
      throw new Error(`FMP plan/legacy: ${msg}`);
    }
    if (status === 429) {
      throw new AlphaVantageError("rate_limit", String(msg), nextMidnightPacificIso());
    }
    throw err;
  }

  if (data && typeof data === "object" && !Array.isArray(data) && data["Error Message"]) {
    throw new Error(String(data["Error Message"]));
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

/** Max symbols per Twelve Data multi-symbol /time_series request (API allows up to 120). */
const TWELVE_BATCH_CHUNK = 15;

/**
 * Resolve one symbol's payload from a TD single- or multi-symbol response.
 */
function twelvePayloadForSymbol(data, symbol, batchSize) {
  if (!data || typeof data !== "object") return null;
  if (batchSize === 1 && Array.isArray(data.values)) return data;
  if (data[symbol] && typeof data[symbol] === "object") return data[symbol];
  // Some responses nest under uppercase keys only.
  const upper = String(symbol).toUpperCase();
  if (data[upper] && typeof data[upper] === "object") return data[upper];
  return null;
}

/**
 * Multi-symbol Twelve Data /time_series — as few HTTP calls as the chunk size allows.
 * TD still bills 1 credit per symbol; our usage counter matches that.
 * @returns {{ byTicker: Record<string, object|null>, httpCalls: number, credits: number }}
 */
async function getPriceHistoryFromTwelveDataBatch(tickers) {
  const symbols = normalizeTickerList(tickers);
  const byTicker = Object.fromEntries(symbols.map((s) => [s, null]));
  let httpCalls = 0;
  let credits = 0;
  if (!symbols.length) return { byTicker, httpCalls, credits };
  if (!hasTwelveKey()) return { byTicker, httpCalls, credits };

  for (const chunk of chunkList(symbols, TWELVE_BATCH_CHUNK)) {
    try {
      const data = await callTwelveData(
        "/time_series",
        {
          symbol: chunk.join(","),
          interval: "1day",
          outputsize: DAILY_HISTORY_BARS,
          order: "DESC",
        },
        { credits: chunk.length, ticker: chunk.join(",") }
      );
      httpCalls += 1;
      credits += chunk.length;

      for (const symbol of chunk) {
        const payload = twelvePayloadForSymbol(data, symbol, chunk.length);
        if (!payload || payload.status === "error" || payload.code) {
          console.warn(
            `[getPriceHistoryFromTwelveDataBatch] no series for ${symbol}:`,
            payload?.message || payload?.code || "empty"
          );
          continue;
        }
        const bars = extractBarsFromTwelve(payload);
        if (!bars.length) {
          console.warn(
            `[getPriceHistoryFromTwelveDataBatch] empty bars for ${symbol}`
          );
          continue;
        }
        byTicker[symbol] = buildQuoteFromBars(
          symbol,
          bars,
          "twelve_data",
          payload.meta || null
        );
      }
    } catch (err) {
      if (err instanceof QuotaSkippedError) throw err;
      console.error(
        `[getPriceHistoryFromTwelveDataBatch] chunk failed (${chunk.join(",")}):`,
        err.message
      );
    }
  }

  const ok = Object.values(byTicker).filter(Boolean).length;
  console.log(
    `[getPriceHistoryFromTwelveDataBatch] http=${httpCalls} credits=${credits} ok=${ok}/${symbols.length}`
  );
  return { byTicker, httpCalls, credits };
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
      if (err instanceof QuotaSkippedError) {
        console.warn(
          `[getQuoteAndIndicators] ${symbol} twelve_data skipped — no quota; trying Alpha Vantage if available`
        );
      } else if (err instanceof AlphaVantageError && err.code === "rate_limit") {
        // Do not fall through to AV on Twelve rate limits — AV is reserved for news
        // and is often already exhausted; falling through blanks the board.
        console.error(
          `[getQuoteAndIndicators] Twelve Data rate-limited for ${symbol} — not falling back to Alpha Vantage`
        );
        throw err;
      } else if (err instanceof AlphaVantageError && err.code === "invalid_ticker") {
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
    if (err instanceof QuotaSkippedError) {
      console.warn(
        `[getQuoteAndIndicators] ${symbol} alpha_vantage skipped — no quota`
      );
      throw err;
    }
    if (err instanceof AlphaVantageError) throw err;
    console.error(`[getQuoteAndIndicators] Failed for ${ticker}:`, err.message);
    return null;
  }
}

/**
 * Analyst target from Twelve Data /price_target.
 * Grow-plan-only — used exclusively by the monthly capability probe.
 * NEVER call this from the live board / search / promotion path.
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
 * Analyst target from Alpha Vantage OVERVIEW (scarce specialist — AV's live target role).
 * Also returns name/sector/52w extras when present. Earnings date is NOT taken from here
 * (Finnhub calendar is primary for earnings).
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
  };
}

/**
 * Analyst target: Alpha Vantage OVERVIEW only.
 * Twelve Data /price_target is Grow-plan-only (confirmed) — not used on the live path;
 * the monthly capability probe still checks that it stays blocked.
 */
async function getAnalystTarget(ticker) {
  const symbol = String(ticker).toUpperCase();

  try {
    const fromAlpha = await getAnalystTargetFromAlphaOverview(symbol);
    console.log(`[getAnalystTarget] ${symbol} source=alpha_vantage`);
    return fromAlpha;
  } catch (err) {
    if (err instanceof QuotaSkippedError) {
      console.warn(`[getAnalystTarget] ${symbol} skipped — no Alpha Vantage quota`);
      return {
        analystTargetPrice: null,
        source: null,
        quotaSkipped: true,
      };
    }
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
    console.error(`[getAnalystTarget] Alpha Vantage failed for ${symbol}:`, err.message);
    return {
      analystTargetPrice: null,
      source: null,
    };
  }
}

function formatYmd(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * Next earnings date from Finnhub /calendar/earnings (free tier: ~1 month US).
 */
async function getEarningsDateFromFinnhub(ticker) {
  try {
    const symbol = String(ticker).toUpperCase();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const from = new Date(today);
    from.setDate(from.getDate() - 7);
    const to = new Date(today);
    to.setMonth(to.getMonth() + 1);

    const data = await callFinnhub("/calendar/earnings", {
      symbol,
      from: formatYmd(from),
      to: formatYmd(to),
    });

    const rows = Array.isArray(data?.earningsCalendar)
      ? data.earningsCalendar
      : [];
    const upcoming = rows
      .map((r) => ({
        date: r?.date ? String(r.date).slice(0, 10) : null,
        hour: r?.hour || null,
        epsEstimate: num(r?.epsEstimate),
        revenueEstimate: num(r?.revenueEstimate),
      }))
      .filter((r) => r.date)
      .sort((a, b) => a.date.localeCompare(b.date));

    const todayStr = formatYmd(today);
    const next =
      upcoming.find((r) => r.date >= todayStr) || upcoming[upcoming.length - 1] || null;

    if (!next) {
      console.warn(`[getEarningsDateFromFinnhub] No calendar rows for ${symbol}`);
      return {
        earningsDate: null,
        source: "finnhub",
        hour: null,
      };
    }

    console.log(
      `[getEarningsDateFromFinnhub] ${symbol} → ${next.date}${next.hour ? ` (${next.hour})` : ""}`
    );
    return {
      earningsDate: next.date,
      source: "finnhub",
      hour: next.hour,
      epsEstimate: next.epsEstimate,
      revenueEstimate: next.revenueEstimate,
    };
  } catch (err) {
    if (err instanceof QuotaSkippedError) {
      console.warn(`[getEarningsDateFromFinnhub] ${ticker} skipped — no Finnhub quota`);
      return null;
    }
    console.error(
      `[getEarningsDateFromFinnhub] Failed for ${ticker}:`,
      err.message
    );
    return null;
  }
}

function normalizeTickerList(tickers) {
  const out = [];
  const seen = new Set();
  for (const t of Array.isArray(tickers) ? tickers : [tickers]) {
    const s = String(t || "")
      .trim()
      .toUpperCase();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function chunkList(list, size) {
  const n = Math.max(1, Math.floor(Number(size) || 1));
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/**
 * Build Alpha Vantage news payload for one ticker from a (possibly multi-ticker) feed.
 */
function buildAlphaNewsFromFeed(symbol, feed) {
  const articles = (Array.isArray(feed) ? feed : [])
    .map((article) => {
      const tickerSentiment = (article.ticker_sentiment || []).find(
        (t) => String(t.ticker).toUpperCase() === symbol
      );
      // Keep articles that mention this ticker; drop unrelated multi-ticker hits.
      if (
        Array.isArray(article.ticker_sentiment) &&
        article.ticker_sentiment.length &&
        !tickerSentiment
      ) {
        return null;
      }
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
    })
    .filter(Boolean)
    .sort((a, b) =>
      String(b.publishedAt || "").localeCompare(String(a.publishedAt || ""))
    )
    .slice(0, 5);

  return { ticker: symbol, source: "alpha_vantage", news: articles };
}

/**
 * Build Marketaux payload for one ticker from a (possibly multi-ticker) article list.
 */
function buildMarketauxFromArticles(symbol, articlesIn) {
  const articles = Array.isArray(articlesIn) ? articlesIn : [];
  const scored = [];

  for (const article of articles) {
    const entities = Array.isArray(article.entities) ? article.entities : [];
    const match = entities.find(
      (e) => String(e.symbol || "").toUpperCase() === symbol
    );
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
}

function marketauxPayloadOk(marketaux) {
  return Boolean(
    marketaux &&
      (marketaux.sentimentScore != null ||
        (Array.isArray(marketaux.articles) && marketaux.articles.length > 0))
  );
}

function alphaPayloadOk(alpha) {
  return Boolean(alpha && Array.isArray(alpha.news) && alpha.news.length > 0);
}

function assembleCombinedNews(symbol, marketaux, alpha, flags = {}) {
  const mxOk = marketauxPayloadOk(marketaux);
  const avOk = alphaPayloadOk(alpha);
  const sources = [];
  if (mxOk) sources.push("marketaux");
  if (avOk) sources.push("alpha_vantage");
  return {
    alpha: avOk ? alpha : alpha || null,
    finnhub: null,
    marketaux: mxOk ? marketaux : null,
    byId: {
      marketaux: mxOk ? marketaux : null,
      alpha_vantage: avOk ? alpha : alpha || null,
      finnhub: null,
    },
    sources,
    pending: sources.length === 0,
    quotaSkipped: Boolean(flags.mxQuotaSkipped || flags.avQuotaSkipped),
  };
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
    return buildAlphaNewsFromFeed(symbol, newsData.feed || []);
  } catch (err) {
    if (err instanceof QuotaSkippedError) throw err;
    console.error(`[getNewsSentiment] Failed for ${ticker}:`, err.message);
    return null;
  }
}

/**
 * One NEWS_SENTIMENT call for many tickers (counts as 1 against AV daily limit).
 * @returns {Record<string, object|null>}
 */
async function getNewsSentimentBatch(tickers) {
  const symbols = normalizeTickerList(tickers);
  const out = Object.fromEntries(symbols.map((s) => [s, null]));
  if (!symbols.length) return out;
  if (symbols.length === 1) {
    out[symbols[0]] = await getNewsSentiment(symbols[0]);
    return out;
  }

  try {
    const newsData = await callAlphaVantage({
      function: "NEWS_SENTIMENT",
      tickers: symbols.join(","),
      limit: Math.min(1000, Math.max(50, symbols.length * 8)),
    });
    const feed = newsData.feed || [];
    for (const symbol of symbols) {
      out[symbol] = buildAlphaNewsFromFeed(symbol, feed);
    }
    console.log(
      `[getNewsSentimentBatch] 1 AV call → ${symbols.length} ticker(s)`
    );
    return out;
  } catch (err) {
    if (err instanceof QuotaSkippedError) throw err;
    console.error(`[getNewsSentimentBatch] Failed:`, err.message);
    return out;
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
    return buildMarketauxFromArticles(symbol, articles);
  } catch (err) {
    if (err instanceof QuotaSkippedError) throw err;
    console.error(`[getNewsFromMarketaux] Failed for ${ticker}:`, err.message);
    return null;
  }
}

/**
 * One Marketaux /news/all call for many tickers (counts as 1 against MX daily limit).
 * @returns {Record<string, object|null>}
 */
async function getNewsFromMarketauxBatch(tickers) {
  const symbols = normalizeTickerList(tickers);
  const out = Object.fromEntries(symbols.map((s) => [s, null]));
  if (!symbols.length) return out;
  if (!hasMarketauxKey()) return out;
  if (symbols.length === 1) {
    out[symbols[0]] = await getNewsFromMarketaux(symbols[0]);
    return out;
  }

  try {
    const data = await callMarketaux("/news/all", {
      symbols: symbols.join(","),
      filter_entities: true,
      language: "en",
      limit: Math.min(100, Math.max(10, symbols.length * 4)),
    });
    const articles = Array.isArray(data?.data) ? data.data : [];
    for (const symbol of symbols) {
      out[symbol] = buildMarketauxFromArticles(symbol, articles);
    }
    console.log(
      `[getNewsFromMarketauxBatch] 1 MX call → ${symbols.length} ticker(s) (articles=${articles.length})`
    );
    return out;
  } catch (err) {
    if (err instanceof QuotaSkippedError) throw err;
    console.error(`[getNewsFromMarketauxBatch] Failed:`, err.message);
    return out;
  }
}

/** Capability → fetcher map (kept for optional direct probes / tests). */
const NEWS_FETCHERS = {
  alpha_vantage: getNewsSentiment,
  finnhub: getNewsFromFinnhub,
  marketaux: getNewsFromMarketaux,
};

/**
 * Marketaux + Alpha Vantage NEWS_SENTIMENT in parallel (both are real news sources).
 * Finnhub scored /news-sentiment is free-tier blocked — not called on the live path.
 */
async function getCombinedNews(ticker) {
  const symbol = String(ticker).toUpperCase();
  let marketaux = null;
  let alpha = null;
  let mxQuotaSkipped = false;
  let avQuotaSkipped = false;

  const mxPromise = hasMarketauxKey()
    ? getNewsFromMarketaux(symbol).catch((err) => {
        if (err instanceof QuotaSkippedError) {
          mxQuotaSkipped = true;
          console.warn(
            `[getCombinedNews] ${symbol} marketaux skipped — no quota`
          );
        } else {
          console.error(
            `[getCombinedNews] ${sourceLabel("marketaux")} failed:`,
            err.message
          );
        }
        return null;
      })
    : Promise.resolve(null);

  const avPromise = getNewsSentiment(symbol).catch((err) => {
    if (err instanceof QuotaSkippedError) {
      avQuotaSkipped = true;
      console.warn(
        `[getCombinedNews] ${symbol} alpha_vantage news skipped — no quota`
      );
    } else {
      console.error(
        `[getCombinedNews] ${sourceLabel("alpha_vantage")} failed:`,
        err.message
      );
    }
    return null;
  });

  [marketaux, alpha] = await Promise.all([mxPromise, avPromise]);

  const combined = assembleCombinedNews(symbol, marketaux, alpha, {
    mxQuotaSkipped,
    avQuotaSkipped,
  });
  console.log(
    `[getCombinedNews] ${symbol} sources=${combined.sources.join("+") || "none"} pending=${combined.pending}`
  );
  return combined;
}

/**
 * Board-level news: ONE Marketaux call + ONE Alpha Vantage NEWS_SENTIMENT call
 * for the whole ticker list, then split per symbol.
 * @returns {{ byTicker: Record<string, object>, httpCalls: { marketaux: number, alpha_vantage: number } }}
 */
async function getCombinedNewsBatch(tickers) {
  const symbols = normalizeTickerList(tickers);
  const byTicker = {};
  const httpCalls = { marketaux: 0, alpha_vantage: 0 };
  if (!symbols.length) return { byTicker, httpCalls };

  let mxMap = Object.fromEntries(symbols.map((s) => [s, null]));
  let avMap = Object.fromEntries(symbols.map((s) => [s, null]));
  let mxQuotaSkipped = false;
  let avQuotaSkipped = false;

  const mxPromise = hasMarketauxKey()
    ? getNewsFromMarketauxBatch(symbols)
        .then((m) => {
          httpCalls.marketaux = 1;
          return m;
        })
        .catch((err) => {
          if (err instanceof QuotaSkippedError) {
            mxQuotaSkipped = true;
            console.warn(`[getCombinedNewsBatch] marketaux skipped — no quota`);
          } else {
            console.error(
              `[getCombinedNewsBatch] marketaux failed:`,
              err.message
            );
          }
          return mxMap;
        })
    : Promise.resolve(mxMap);

  const avPromise = getNewsSentimentBatch(symbols)
    .then((m) => {
      httpCalls.alpha_vantage = 1;
      return m;
    })
    .catch((err) => {
      if (err instanceof QuotaSkippedError) {
        avQuotaSkipped = true;
        console.warn(
          `[getCombinedNewsBatch] alpha_vantage skipped — no quota`
        );
      } else {
        console.error(
          `[getCombinedNewsBatch] alpha_vantage failed:`,
          err.message
        );
      }
      return avMap;
    });

  [mxMap, avMap] = await Promise.all([mxPromise, avPromise]);

  for (const symbol of symbols) {
    byTicker[symbol] = assembleCombinedNews(
      symbol,
      mxMap[symbol],
      avMap[symbol],
      { mxQuotaSkipped, avQuotaSkipped }
    );
  }

  console.log(
    `[getCombinedNewsBatch] tickers=${symbols.length} http MX=${httpCalls.marketaux} AV=${httpCalls.alpha_vantage}`
  );
  return { byTicker, httpCalls };
}

/**
 * @deprecated Prefer getAnalystTarget + getCombinedNews + getEarningsDateFromFinnhub.
 */
async function getFundamentalsAndNews(ticker) {
  const target = await getAnalystTarget(ticker);
  await sleep(1200);
  const combined = await getCombinedNews(ticker);
  const earnings = await getEarningsDateFromFinnhub(ticker);

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
      earningsDate: earnings?.earningsDate || null,
      earningsSource: earnings?.source || null,
    },
    news: combined.alpha?.news || [],
    newsFinnhub: combined.finnhub || null,
    newsMarketaux: combined.marketaux || null,
    newsSources: combined.sources,
    newsPending: combined.pending,
  };
}

/**
 * FMP /stable/biggest-gainers|biggest-losers|most-actives — free-tier movers.
 * Does not call Twelve Data or Alpha Vantage.
 */
async function getMarketMoversFromFmp(kind = "gainers") {
  const map = {
    gainers: { path: "/stable/biggest-gainers", direction: "gainers" },
    losers: { path: "/stable/biggest-losers", direction: "losers" },
    actives: { path: "/stable/most-actives", direction: "actives" },
  };
  const conf = map[String(kind || "gainers").toLowerCase()];
  if (!conf) {
    throw new Error(`Invalid FMP movers kind: ${kind}`);
  }

  const data = await callFmp(conf.path);
  const rows = Array.isArray(data) ? data : [];
  return rows
    .map((row) => {
      const ticker = String(row.symbol || "")
        .trim()
        .toUpperCase();
      if (!ticker) return null;
      return {
        ticker,
        name: row.name || null,
        exchange: row.exchange || null,
        last: num(row.price),
        volume: num(row.volume),
        change: num(row.change),
        percentChange: num(row.changesPercentage),
        direction: conf.direction,
        source: "fmp",
      };
    })
    .filter(Boolean);
}

/**
 * Bundle FMP gainers + losers + most-actives into one candidate pool.
 * Three FMP calls; union deduped by ticker.
 */
async function getDiscoveryMoversBundle(_options = {}) {
  const [gainers, losers, actives] = await Promise.all([
    getMarketMoversFromFmp("gainers"),
    getMarketMoversFromFmp("losers"),
    getMarketMoversFromFmp("actives"),
  ]);

  const byTicker = new Map();
  for (const row of [...gainers, ...losers, ...actives]) {
    const prev = byTicker.get(row.ticker);
    if (!prev) {
      byTicker.set(row.ticker, { ...row, directions: [row.direction] });
      continue;
    }
    const dirs = new Set([...(prev.directions || []), row.direction]);
    const richer =
      Math.abs(Number(row.percentChange) || 0) >=
      Math.abs(Number(prev.percentChange) || 0)
        ? row
        : prev;
    byTicker.set(row.ticker, {
      ...richer,
      directions: [...dirs],
      volume:
        Math.max(Number(prev.volume) || 0, Number(row.volume) || 0) || null,
    });
  }

  const all = [...byTicker.values()];
  // Prefer FMP's most-actives order when present; else fall back to |% change|.
  const activeOrder = new Map(
    actives.map((r, i) => [r.ticker, i])
  );
  const mostActive = all.slice().sort((a, b) => {
    const ai = activeOrder.has(a.ticker)
      ? activeOrder.get(a.ticker)
      : Number.MAX_SAFE_INTEGER;
    const bi = activeOrder.has(b.ticker)
      ? activeOrder.get(b.ticker)
      : Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return (
      Math.abs(Number(b.percentChange) || 0) -
      Math.abs(Number(a.percentChange) || 0)
    );
  });

  return {
    gainers,
    losers,
    mostActive,
    all,
    fetchedAt: new Date().toISOString(),
    source: "fmp",
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
    if (err instanceof QuotaSkippedError) {
      console.warn(`[getPeers] ${ticker} skipped — no Finnhub quota`);
      return null;
    }
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
  callFmp,
  getQuoteAndIndicators,
  getAnalystTarget,
  getAnalystTargetFromTwelveData,
  getEarningsDateFromFinnhub,
  getMarketMoversFromFmp,
  getDiscoveryMoversBundle,
  getNewsSentiment,
  getNewsSentimentBatch,
  getNewsFromFinnhub,
  getNewsFromMarketaux,
  getNewsFromMarketauxBatch,
  getCombinedNews,
  getCombinedNewsBatch,
  getFundamentalsAndNews,
  getPeers,
  getPriceHistoryFromTwelveData,
  getPriceHistoryFromTwelveDataBatch,
  normalizeTickerList,
  AlphaVantageError,
  TwelveDataError,
  QuotaSkippedError,
  nextMidnightPacificIso,
  TWELVE_BATCH_CHUNK,
  DAILY_HISTORY_BARS,
};
