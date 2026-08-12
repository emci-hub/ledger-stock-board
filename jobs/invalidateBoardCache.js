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

    if (summary.includes("wasn't available")) return true;
    // Dual/legacy rows with no usable take text
    if (!summary.trim()) return true;
    // Failed dual path often left quip null + fallback wording already covered;
    // also treat explicit FALLBACK deepDive + empty tags as failed when quip missing
    // and summary is the canned fallback.
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

/**
 * Clear failed Gemini fallbacks and pre-merge flat price rows for board tickers
 * so the next refreshBoard rebuilds shared indicators + dual+quip analysis.
 */
async function invalidateBoardStaleCaches(tickers = BOARD_TICKERS) {
  const board = tickers.map((t) => String(t).toUpperCase());
  let aiDeleted = 0;
  let priceInvalidated = 0;

  for (const ticker of board) {
    const ai = await dbGet(
      `SELECT summary_json FROM ai_reports WHERE ticker = ?`,
      [ticker]
    );
    if (ai && isFallbackSummaryJson(ai.summary_json)) {
      await dbRun(`DELETE FROM ai_reports WHERE ticker = ?`, [ticker]);
      aiDeleted += 1;
      console.log(`[invalidateBoardStaleCaches] deleted fallback ai_reports for ${ticker}`);
    }

    // Also clear legacy mode-keyed fallbacks if present
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
      /* legacy table optional */
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
      await dbRun(`DELETE FROM stock_reports WHERE ticker = ?`, [ticker]);
      priceInvalidated += 1;
      continue;
    }

    if (!hasSharedIndicatorShape(data)) {
      // Keep news/target/peers; force price refetch under shared {short,long} shape.
      if (data.freshness) data.freshness.priceUpdatedAt = null;
      else data.freshness = { priceUpdatedAt: null, targetUpdatedAt: null, newsUpdatedAt: null };
      // Drop flat quote so isPriceFresh cannot treat it as usable shared history.
      data.quote = null;

      await dbRun(
        `INSERT OR REPLACE INTO stock_reports (ticker, data_json, last_updated)
         VALUES (?, ?, ?)`,
        [ticker, JSON.stringify(data), stock.last_updated || new Date().toISOString()]
      );
      priceInvalidated += 1;
      console.log(
        `[invalidateBoardStaleCaches] cleared flat pre-merge price cache for ${ticker}`
      );
    }
  }

  console.log(
    `[invalidateBoardStaleCaches] Done — aiDeleted=${aiDeleted}, priceInvalidated=${priceInvalidated}`
  );
  return { aiDeleted, priceInvalidated };
}

module.exports = {
  invalidateBoardStaleCaches,
  isFallbackSummaryJson,
  hasSharedIndicatorShape,
  FALLBACK_SUMMARY,
};
