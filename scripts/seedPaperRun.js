/**
 * Load data/paper-run-seed.json into the paper_run_snapshots table.
 *
 * Runs on demand — the server already seeds automatically on startup when the
 * table is empty. Pass --force to push the seed on top of existing snapshots
 * (the old rows stay in the history).
 *
 *   node scripts/seedPaperRun.js [--force]
 */

require("dotenv").config();

const {
  ensurePaperRunTables,
  seedPaperRunIfEmpty,
  savePaperSnapshot,
  readSeedFile,
  countPaperSnapshots,
} = require("../services/paperRun");

(async () => {
  const force = process.argv.includes("--force");
  await ensurePaperRunTables();

  if (force) {
    const result = await savePaperSnapshot(readSeedFile(), { source: "seed" });
    console.log(
      `Seed pushed (forced): day ${result.day}, ${result.accounts} accounts, updatedAt ${result.updatedAt}`
    );
  } else {
    const result = await seedPaperRunIfEmpty();
    console.log(
      result.seeded
        ? `Seeded: day ${result.day}, ${result.accounts} accounts, updatedAt ${result.updatedAt}`
        : `Nothing to do (${result.reason}). Use --force to push the seed anyway.`
    );
  }

  console.log(`Snapshots stored: ${await countPaperSnapshots()}`);
  process.exit(0);
})().catch((err) => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});
