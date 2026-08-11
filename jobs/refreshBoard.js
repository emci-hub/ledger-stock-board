const { getDb } = require("../db/schema");
const { getStockReport } = require("../services/getStockReport");
const { getCachedStock } = require("../services/cache");

/** Fixed universe of stable large-caps for the family board (long mode). */
const BOARD_TICKERS = [
  // Tech
  "AAPL",
  "MSFT",
  "GOOGL",
  "NVDA",
  "AVGO",
  // Healthcare
  "JNJ",
  "UNH",
  "PFE",
  "ABBV",
  // Consumer staples
  "KO",
  "PG",
  "WMT",
  "COST",
  // Finance
  "JPM",
  "BAC",
  "V",
  // Energy
  "XOM",
  "CVX",
];

/** Neutral "roughly flat" band vs logged price (±3%). */
const FLAT_BAND = 0.03;

/**
 * Map Gemini lean/risk → board status.
 * recommended: bullish, or neutral with low risk
 * watch: bearish, or high risk
 * otherwise skip (no upsert)
 */
function statusFromAnalysis(lean, risk) {
  const l = String(lean || "").toLowerCase();
  const r = String(risk || "").toLowerCase();

  if (l === "bearish" || r === "high") return "watch";
  if (l === "bullish" || (l === "neutral" && r === "low")) return "recommended";
  return null;
}

function logRecommendation(ticker, price, lean) {
  const db = getDb();
  db.prepare(
    `INSERT INTO recommendation_log (ticker, logged_price, lean, logged_at, resolved, hit_target)
     VALUES (?, ?, ?, ?, 0, NULL)`
  ).run(
    String(ticker).toUpperCase(),
    Number(price),
    String(lean || "neutral").toLowerCase(),
    new Date().toISOString()
  );
}

async function getCurrentPrice(ticker) {
  const symbol = String(ticker).toUpperCase();
  // Cache only — never trigger Alpha Vantage / Gemini from resolution.
  const cached = getCachedStock(symbol, "long");
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
  // neutral — roughly flat
  return Math.abs(changePct) <= FLAT_BAND ? 1 : 0;
}

async function resolveOldRecommendations() {
  const db = getDb();
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const rows = db
    .prepare(
      `SELECT id, ticker, logged_price, lean, logged_at
       FROM recommendation_log
       WHERE resolved = 0 AND logged_at < ?
       ORDER BY logged_at ASC`
    )
    .all(cutoff);

  console.log(
    `[resolveOldRecommendations] ${rows.length} row(s) older than 30d at ${new Date().toISOString()}`
  );

  const update = db.prepare(
    `UPDATE recommendation_log SET resolved = 1, hit_target = ? WHERE id = ?`
  );

  let resolved = 0;
  let skipped = 0;

  for (const row of rows) {
    try {
      const currentPrice = await getCurrentPrice(row.ticker);
      if (currentPrice == null) {
        console.warn(
          `[resolveOldRecommendations] No price for ${row.ticker} (id=${row.id}) — skip`
        );
        skipped += 1;
        continue;
      }

      const hit = directionHit(row.lean, row.logged_price, currentPrice);
      update.run(hit, row.id);
      resolved += 1;
      console.log(
        `[resolveOldRecommendations] id=${row.id} ${row.ticker} lean=${row.lean} logged=${row.logged_price} now=${currentPrice} hit=${hit}`
      );
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

/**
 * Track record for a ticker.
 * Fewer than 3 resolved picks → { building: true, resolvedCount }.
 * Otherwise → { building: false, hitRate, hits, resolvedCount }.
 */
function getTrackRecord(ticker) {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS resolvedCount,
         SUM(CASE WHEN hit_target = 1 THEN 1 ELSE 0 END) AS hits
       FROM recommendation_log
       WHERE ticker = ? AND resolved = 1`
    )
    .get(String(ticker).toUpperCase());

  const resolvedCount = Number(row?.resolvedCount || 0);
  const hits = Number(row?.hits || 0);

  if (resolvedCount < 3) {
    return { building: true, resolvedCount };
  }

  const hitRate = Math.round((hits / resolvedCount) * 100);
  return { building: false, hitRate, hits, resolvedCount };
}

async function refreshBoard() {
  const db = getDb();
  const upsert = db.prepare(
    `INSERT OR REPLACE INTO board_picks (ticker, status, added_at, sector)
     VALUES (?, ?, ?, ?)`
  );

  console.log(
    `[refreshBoard] Starting refresh for ${BOARD_TICKERS.length} tickers at ${new Date().toISOString()}`
  );

  let recommended = 0;
  let watch = 0;
  let skipped = 0;

  for (const ticker of BOARD_TICKERS) {
    try {
      const report = await getStockReport(ticker, "long");
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

      upsert.run(
        ticker,
        status,
        new Date().toISOString(),
        report.sector || null
      );

      if (status === "recommended") {
        recommended += 1;
        if (report.price != null) {
          logRecommendation(ticker, report.price, lean);
        } else {
          console.warn(
            `[refreshBoard] ${ticker} recommended but missing price — not logged`
          );
        }
      } else {
        watch += 1;
      }

      console.log(
        `[refreshBoard] ${ticker} → ${status} (lean=${lean}, risk=${risk})`
      );
    } catch (err) {
      console.error(`[refreshBoard] Failed for ${ticker}:`, err.message);
      skipped += 1;
    }
  }

  console.log(
    `[refreshBoard] Done — recommended=${recommended}, watch=${watch}, skipped=${skipped}`
  );
}

module.exports = {
  BOARD_TICKERS,
  refreshBoard,
  statusFromAnalysis,
  logRecommendation,
  resolveOldRecommendations,
  getTrackRecord,
};
