/**
 * Load the watchlist / lab sample snapshot into the paper table.
 * Does not replace data/paper-run-seed.json (that still seeds a fresh boot).
 *
 *   TURSO_DATABASE_URL=file:/tmp/ledger-sample.db node scripts/seedLabSample.js
 */
process.env.TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || "file:/tmp/ledger-sample.db";

const { savePaperSnapshot } = require("../services/paperRun");
const { buildSampleSnapshot } = require("./sampleSnapshot");

(async () => {
  const result = await savePaperSnapshot(buildSampleSnapshot(), { source: "sample" });
  console.log(
    `Sample stored: ${result.accounts} accounts, hash ${result.docHash.slice(0, 12)}, updatedAt ${result.updatedAt}`
  );
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
