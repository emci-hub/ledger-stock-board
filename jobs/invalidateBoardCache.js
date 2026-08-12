const { dbGet, dbAll, dbRun } = require("../db/schema");
const { BOARD_TICKERS } = require("../lib/boardTickers");

const FALLBACK_SUMMARY = "Analysis wasn't available right now.";

function preferTake(dual) {
  if (!dual || typeof dual !== "object") return null;
  return dual.long || dual.short || dual;
}

function isFallbackSummaryJson(summaryJson) {
  try {
    const parsed = JSON.parse(summaryJson);
    const take = preferTake(parsed);
    const summary = String(take?.summary || parsed?.summary || "");
    const quip =
      typeof parsed?.quip === "string" && parsed.quip.trim()
        ? parsed.quip.trim()
        : null;

    if (summary.toLowerCase().includes("wasn't available")) return true;
    if (!summary.trim()) return true;
    if (!quip && summary === FALLBACK_SUMMARY) return true;
    return false;
  } catch {
    return true;
  }
}

function hasSharedIndicatorShape(data) {
  const ind = data?.quote?.indicators;
  return Boolean(ind && ind.short && ind.long);
}

function preferModeRank(mode) {
  if (mode === "long") return 0;
  if (mode === "short") return 1;
  return 2;
}

/** Restore quote from legacy stock_cache when shared row was wiped. */
async function restoreQuoteFromLegacy(ticker, data) {
  try {
    const rows = await dbAll(
      `SELECT mode, data_json, last_updated FROM stock_cache WHERE ticker = ?`,
      [ticker]
    );
    if (!rows.length) return false;

    rows.sort(
      (a, b) =>
        preferModeRank(a.mode) - preferModeRank(b.mode) ||
        String(b.last_updated).localeCompare(String(a.last_updated))
    );

    for (const row of rows) {
      try {
        const legacy = JSON.parse(row.data_json);
        if (legacy?.quote?.price?.current != null) {
          data.quote = legacy.quote;
          if (!data.freshness) data.freshness = {};
          // Keep displayable quote but force rebuild under shared shape.
          data.freshness.priceUpdatedAt = null;
          return true;
        }
      } catch {
        /* try next */
      }
    }
  } catch {
    /* legacy table may not exist */
  }
  return false;
}

/**
 * Clear failed Gemini fallbacks for board tickers.
 * Mark flat pre-merge price rows stale WITHOUT wiping the quote (keeps board visible).
 * Restore quotes from legacy stock_cache if a prior heal nulled them.
 */
async function invalidateBoardStaleCaches(tickers = BOARD_TICKERS) {
  const board = tickers.map((t) => String(t).toUpperCase());
  let aiDeleted = 0;
  let priceInvalidated = 0;
  let quotesRestored = 0;

  for (const ticker of board) {
    const ai = await dbGet(
      `SELECT summary_json FROM ai_reports WHERE ticker = ?`,
      [ticker]
    );
    if (ai && isFallbackSummaryJson(ai.summary_json)) {
      await dbRun(`DELETE FROM ai_reports WHERE ticker = ?`, [ticker]);
      aiDeleted += 1;
      console.log(
        `[invalidateBoardStaleCaches] deleted fallback ai_reports for ${ticker}`
      );
    }

    try {
      const legacy = await dbAll(
        `SELECT mode, summary_json FROM ai_summaries WHERE ticker = ?`,
        [ticker]
      );
      for (const row of legacy) {
        if (isFallbackSummaryJson(row.summary_json)) {
          await dbRun(
            `DELETE FROM ai_summaries WHERE ticker = ? AND mode = ?`,
            [ticker, row.mode]
          );
        }
      }
    } catch {
      /* optional */
    }

    const stock = await dbGet(
      `SELECT data_json, last_updated FROM stock_reports WHERE ticker = ?`,
      [ticker]
    );
    if (!stock) continue;

    let data;
    try {
      data = JSON.parse(stock.data_json);
    } catch {
      continue;
    }

    let changed = false;

    if (!data.quote || data.quote.price?.current == null) {
      const restored = await restoreQuoteFromLegacy(ticker, data);
      if (restored) {
        quotesRestored += 1;
        changed = true;
        console.log(
          `[invalidateBoardStaleCaches] restored quote from legacy stock_cache for ${ticker}`
        );
      }
    }

    if (data.quote && !hasSharedIndicatorShape(data)) {
      if (!data.freshness) {
        data.freshness = {
          priceUpdatedAt: null,
          targetUpdatedAt: null,
          newsUpdatedAt: null,
        };
      } else {
        data.freshness.priceUpdatedAt = null;
      }
      // Keep quote for display; isPriceFresh requires shared short/long shape so refresh rebuilds.
      priceInvalidated += 1;
      changed = true;
      console.log(
        `[invalidateBoardStaleCaches] marked flat price stale (kept quote) for ${ticker}`
      );
    }

    if (changed) {
      await dbRun(
        `INSERT OR REPLACE INTO stock_reports (ticker, data_json, last_updated)
         VALUES (?, ?, ?)`,
        [
          ticker,
          JSON.stringify(data),
          stock.last_updated || new Date().toISOString(),
        ]
      );
    }
  }

  console.log(
    `[invalidateBoardStaleCaches] Done — aiDeleted=${aiDeleted}, priceInvalidated=${priceInvalidated}, quotesRestored=${quotesRestored}`
  );
  return { aiDeleted, priceInvalidated, quotesRestored };
}

module.exports = {
  invalidateBoardStaleCaches,
  isFallbackSummaryJson,
  hasSharedIndicatorShape,
  FALLBACK_SUMMARY,
};
