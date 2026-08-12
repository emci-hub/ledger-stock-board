const { dbRun } = require("../db/schema");

/**
 * Append one day's close for a ticker if that date is not already logged.
 * No API cost — call after a successful price fetch.
 */
async function appendPriceClose(ticker, date, close) {
  const symbol = String(ticker || "")
    .trim()
    .toUpperCase();
  const day = String(date || "").trim().slice(0, 10);
  const price = Number(close);

  if (!symbol || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(price)) {
    return false;
  }

  await dbRun(
    `INSERT OR IGNORE INTO price_history_log (ticker, date, close, recorded_at)
     VALUES (?, ?, ?, ?)`,
    [symbol, day, price, new Date().toISOString()]
  );
  return true;
}

/** Log the latest trading day close from a quote object. */
async function logQuoteClose(quote) {
  if (!quote?.ticker) return false;
  const day = quote.price?.latestTradingDay || null;
  const close = quote.price?.current;
  return appendPriceClose(quote.ticker, day, close);
}

module.exports = { appendPriceClose, logQuoteClose };
