const { dbGet, dbAll, dbRun } = require("../db/schema");
const { getStockReport } = require("../services/getStockReport");
const {
  getCachedStock,
  getCachedStockRow,
  getCachedSummary,
} = require("../services/cache");
const { setSetting } = require("../services/usage");
const { AlphaVantageError } = require("../services/dataFetch");

/** Fixed universe of stable large-caps for the family board (long mode). */
const BOARD_TICKERS = [
  // Tech
  "AAPL",
  "MSFT",
  // Healthcare
  "JNJ",
  "UNH",
  // Consumer staples
  "KO",
  "PG",
  // Finance
  "JPM",
  "V",
];

/** Neutral "roughly flat" band vs logged price (±3%). */
const FLAT_BAND = 0.03;

function statusFromAnalysis(lean, risk) {
  const l = String(lean || "").toLowerCase();
  const r = String(risk || "").toLowerCase();

  if (l === "bearish" || r === "high") return "watch";
  if (l === "bullish" || (l === "neutral" && r === "low")) return "recommended";
  return null;
}

async function logRecommendation(ticker, price, lean) {
  await dbRun(
    `INSERT INTO recommendation_log (ticker, logged_price, lean, logged_at, resolved, hit_target)
     VALUES (?, ?, ?, ?, 0, NULL)`,
    [
      String(ticker).toUpperCase(),
      Number(price),
      String(lean || "neutral").toLowerCase(),
      new Date().toISOString(),
    ]
  );
}

async function getCurrentPrice(ticker) {
  const symbol = String(ticker).toUpperCase();
  const cached = await getCachedStock(symbol, "long");
  if (cached?.quote?.price?.current != null) {
    return Number(cached.quote.price.current);
  }
  return null;
}

function directionHit(lean, loggedPrice, currentPrice) {
  if (
    loggedPrice == null ||
    currentPrice == null ||
    !Number.isFinite(loggedPrice) ||
    !Number.isFinite(currentPrice) ||
    loggedPrice === 0
  ) {
    return 0;
  }

  const changePct = (currentPrice - loggedPrice) / Math.abs(loggedPrice);
  const l = String(lean || "").toLowerCase();

  if (l === "bullish") return changePct > 0 ? 1 : 0;
  if (l === "bearish") return changePct < 0 ? 1 : 0;
  return Math.abs(changePct) <= FLAT_BAND ? 1 : 0;
}

async function resolveOldRecommendations() {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const rows = await dbAll(
    `SELECT id, ticker, logged_price, lean, logged_at
     FROM recommendation_log
     WHERE resolved = 0 AND logged_at < ?
     ORDER BY logged_at ASC`,
    [cutoff]
  );

  console.log(
    `[resolveOldRecommendations] ${rows.length} row(s) older than 30d at ${new Date().toISOString()}`
  );

  let resolved = 0;
  let skipped = 0;

  for (const row of rows) {
    try {
      const currentPrice = await getCurrentPrice(row.ticker);
      if (currentPrice == null) {
        skipped += 1;
        continue;
      }

      const hit = directionHit(row.lean, row.logged_price, currentPrice);
      await dbRun(
        `UPDATE recommendation_log SET resolved = 1, hit_target = ? WHERE id = ?`,
        [hit, row.id]
      );
      resolved += 1;
    } catch (err) {
      console.error(
        `[resolveOldRecommendations] Failed id=${row.id} ${row.ticker}:`,
        err.message
      );
      skipped += 1;
    }
  }

  console.log(
    `[resolveOldRecommendations] Done — resolved=${resolved}, skipped=${skipped}`
  );
}

async function getTrackRecord(ticker) {
  const row = await dbGet(
    `SELECT
       COUNT(*) AS resolvedCount,
       SUM(CASE WHEN hit_target = 1 THEN 1 ELSE 0 END) AS hits
     FROM recommendation_log
     WHERE ticker = ? AND resolved = 1`,
    [String(ticker).toUpperCase()]
  );

  const resolvedCount = Number(row?.resolvedCount || 0);
  const hits = Number(row?.hits || 0);

  if (resolvedCount < 3) {
    return { building: true, resolvedCount };
  }

  const hitRate = Math.round((hits / resolvedCount) * 100);
  return { building: false, hitRate, hits, resolvedCount };
}

async function refreshBoard() {
  console.log(
    `[refreshBoard] Starting refresh for ${BOARD_TICKERS.length} tickers at ${new Date().toISOString()}`
  );

  let recommended = 0;
  let watch = 0;
  let skipped = 0;
  let fetched = 0;
  let cacheReused = 0;
  let rateLimited = false;
  let successes = 0;

  for (const ticker of BOARD_TICKERS) {
    try {
      const stockFresh = await getCachedStockRow(ticker, "long");
      const summaryFresh = await getCachedSummary(ticker, "long");

      if (stockFresh && summaryFresh) {
        cacheReused += 1;
        console.log(
          `[refreshBoard] ${ticker} still fresh (<24h) — skipping live fetch`
        );
        const report = await getStockReport(ticker, "long", { skipPeers: true });
        if (!report) {
          skipped += 1;
          continue;
        }
        const lean = report.analysis?.lean;
        const risk = report.analysis?.risk;
        const status = statusFromAnalysis(lean, risk);
        if (!status) {
          skipped += 1;
          continue;
        }
        await dbRun(
          `INSERT OR REPLACE INTO board_picks (ticker, status, added_at, sector)
           VALUES (?, ?, ?, ?)`,
          [ticker, status, new Date().toISOString(), report.sector || null]
        );
        if (status === "recommended") recommended += 1;
        else watch += 1;
        successes += 1;
        continue;
      }

      fetched += 1;
      const report = await getStockReport(ticker, "long", { skipPeers: true });
      if (!report) {
        console.warn(`[refreshBoard] No report for ${ticker} — leaving out`);
        skipped += 1;
        continue;
      }

      const lean = report.analysis?.lean;
      const risk = report.analysis?.risk;
      const status = statusFromAnalysis(lean, risk);

      if (!status) {
        console.log(
          `[refreshBoard] ${ticker} lean=${lean} risk=${risk} — no board status, leaving out`
        );
        skipped += 1;
        continue;
      }

      await dbRun(
        `INSERT OR REPLACE INTO board_picks (ticker, status, added_at, sector)
         VALUES (?, ?, ?, ?)`,
        [ticker, status, new Date().toISOString(), report.sector || null]
      );

      if (status === "recommended") {
        recommended += 1;
        if (report.price != null) {
          await logRecommendation(ticker, report.price, lean);
        }
      } else {
        watch += 1;
      }

      successes += 1;
      console.log(
        `[refreshBoard] ${ticker} → ${status} (lean=${lean}, risk=${risk})`
      );
    } catch (err) {
      if (err instanceof AlphaVantageError && err.code === "rate_limit") {
        rateLimited = true;
      }
      console.error(`[refreshBoard] Failed for ${ticker}:`, err.message);
      skipped += 1;
    }
  }

  let boardRefreshStatus = "full_success";
  if (successes === 0 && rateLimited) boardRefreshStatus = "failed_rate_limit";
  else if (successes === 0) boardRefreshStatus = "failed";
  else if (skipped > 0 || rateLimited) boardRefreshStatus = "partial";

  const finishedAt = new Date().toISOString();
  await setSetting("lastBoardRefresh", finishedAt);
  await setSetting("lastBoardRefreshStatus", boardRefreshStatus);

  console.log(
    `[refreshBoard] Done — recommended=${recommended}, watch=${watch}, skipped=${skipped}, fetched=${fetched}, cacheReused=${cacheReused}, status=${boardRefreshStatus}`
  );

  return {
    recommended,
    watch,
    skipped,
    fetched,
    cacheReused,
    boardRefreshStatus,
  };
}

module.exports = {
  BOARD_TICKERS,
  refreshBoard,
  statusFromAnalysis,
  logRecommendation,
  resolveOldRecommendations,
  getTrackRecord,
};
