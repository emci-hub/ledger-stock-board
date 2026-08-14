/**
 * One-shot: ensure schema, reclassify all live board tickers from cache
 * (backfill only when history is too thin), then run integrity self-check.
 * Prefer cached data — avoid Alpha Vantage unless a ticker needs backfill.
 */
require("dotenv").config();

async function main() {
  const { initSchema } = require("../db/schema");
  const {
    reclassifyLiveBoard,
    validateBoardSectionIntegrity,
  } = require("../services/boardSectionService");

  await initSchema();
  const reclass = await reclassifyLiveBoard({
    allowBackfill: true,
    updateStatus: true,
  });
  const check = await validateBoardSectionIntegrity({ recordJob: true });

  console.log(
    JSON.stringify(
      {
        reclass: {
          total: reclass.total,
          counts: reclass.counts,
          bySection: reclass.bySection,
          backfilled: reclass.backfilled,
          errors: reclass.errors,
        },
        selfCheck: {
          ok: check.ok,
          missing: check.missing?.length || 0,
          mismatches: check.mismatches?.length || 0,
          invalid: check.invalid?.length || 0,
        },
      },
      null,
      2
    )
  );

  if (!check.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
