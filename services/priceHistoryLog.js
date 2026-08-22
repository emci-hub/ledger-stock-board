const { dbRun, dbAll } = require("../db/schema");

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

/**
 * Bulk-seed price_history_log from an already-parsed bars array (e.g.
 * extractBarsFromAlphaDaily/extractBarsFromTwelve in services/dataFetch.js).
 * Used to give a PRIMARY ticker enough trailing history for the drop math in
 * lib/dropMath.js (63-day high + T+5 event window) the first time it's
 * screened. Safe to call repeatedly — reuses appendPriceClose's
 * INSERT OR IGNORE dedup, so already-logged dates are a no-op.
 * Returns the count of bars successfully written (valid date + close).
 */
async function backfillFromBars(ticker, bars) {
  const symbol = String(ticker || "").trim().toUpperCase();
  if (!symbol || !Array.isArray(bars) || !bars.length) return 0;

  let written = 0;
  for (const bar of bars) {
    if (!bar || bar.close == null) continue;
    const ok = await appendPriceClose(symbol, bar.date, bar.close);
    if (ok) written += 1;
  }
  return written;
}

/**
 * Read logged closes for a ticker, oldest first — the shape lib/dropMath.js
 * expects ({ date, close }[]). This is the first read of price_history_log
 * in the codebase; the table was previously write-only.
 *
 * @param {string} ticker
 * @param {object} [opts]
 * @param {string} [opts.sinceDate] - 'YYYY-MM-DD', inclusive lower bound
 * @param {number} [opts.maxBars] - cap on the most recent N bars returned
 */
async function getRecentCloses(ticker, opts = {}) {
  const symbol = String(ticker || "").trim().toUpperCase();
  if (!symbol) return [];

  const conditions = ["ticker = ?"];
  const args = [symbol];

  const sinceDate = opts.sinceDate ? String(opts.sinceDate).slice(0, 10) : null;
  if (sinceDate) {
    conditions.push("date >= ?");
    args.push(sinceDate);
  }

  const maxBars = opts.maxBars ? Math.max(1, Math.floor(Number(opts.maxBars))) : null;
  if (maxBars) args.push(maxBars);

  const rows = await dbAll(
    `SELECT date, close FROM price_history_log
     WHERE ${conditions.join(" AND ")}
     ORDER BY date DESC
     ${maxBars ? "LIMIT ?" : ""}`,
    args
  );

  return rows.map((r) => ({ date: r.date, close: Number(r.close) })).reverse();
}

module.exports = {
  appendPriceClose,
  logQuoteClose,
  backfillFromBars,
  getRecentCloses,
};
