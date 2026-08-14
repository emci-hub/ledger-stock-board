/**
 * Cache-only board-section census (no market API calls).
 * Classifies every board display pick (live + archived) that has stock_reports cache.
 */
require("dotenv").config();

async function main() {
  const { initSchema, dbAll } = require("../db/schema");
  const { listBoardDisplayPicks } = require("../lib/boardPicks");
  const {
    buildReportForTicker,
    classifyAndPersistTicker,
  } = require("../services/boardSectionService");
  const {
    SHORT_MIN_PRICE_BARS,
    LONG_MIN_PRICE_BARS,
  } = require("../lib/rankingStability");

  await initSchema();

  const reports = await dbAll(`SELECT COUNT(*) AS n FROM stock_reports`);
  const picksAll = await dbAll(
    `SELECT status, COUNT(*) AS n FROM board_picks GROUP BY status`
  );
  const picks = await listBoardDisplayPicks();

  const counts = { long: 0, short: 0, penny: 0, unclassified: 0 };
  const bySection = { long: [], short: [], penny: [], unclassified: [] };
  const needsBackfillToClassify = [];
  const skippedNoCache = [];

  for (const pick of picks) {
    const report = await buildReportForTicker(pick.ticker);
    if (!report) {
      skippedNoCache.push(pick.ticker);
      continue;
    }
    const row = await classifyAndPersistTicker(pick.ticker, {
      pick,
      report,
      allowBackfill: false,
      updateStatus: false,
    });
    if (counts[row.boardSection] != null) counts[row.boardSection] += 1;
    if (bySection[row.boardSection]) bySection[row.boardSection].push(row.ticker);

    const s = row.placement.signals;
    if (s.insufficientToClassify || row.boardSection === "unclassified") {
      needsBackfillToClassify.push({
        ticker: row.ticker,
        bars: s.historyBars ?? 0,
        boardSection: row.boardSection,
        need: `needs backfill to ≥${SHORT_MIN_PRICE_BARS} bars to classify reliably`,
      });
    }
  }

  const displayCounts = {
    long: counts.long,
    short: counts.short,
    penny: counts.penny,
  };
  console.log(
    JSON.stringify(
      {
        inventory: {
          stockReports: reports[0].n,
          boardPicksByStatus: Object.fromEntries(
            picksAll.map((r) => [r.status, r.n])
          ),
          displayUniverse: picks.length,
          classifiedWithCache:
            displayCounts.long + displayCounts.short + displayCounts.penny,
          unclassified: counts.unclassified,
          skippedNoCache,
        },
        criteria: { SHORT_MIN_PRICE_BARS, LONG_MIN_PRICE_BARS },
        counts: displayCounts,
        countsIncludingUnclassified: counts,
        bySection,
        needsBackfillToClassify,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
