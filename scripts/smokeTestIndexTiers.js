/**
 * RUN THIS FIRST, before trusting services/indexTiers.js in production.
 *
 * This could not be tested from the build sandbox (no network route to
 * wikipedia.org there). Run it here — locally, or via Cursor/Render where
 * real internet access exists:
 *
 *   node scripts/smokeTestIndexTiers.js
 *
 * Expected: S&P 500 ~500 rows, S&P 400 ~400 rows, S&P 600 ~600 rows, with
 * real recognizable tickers (AAPL, MSFT, etc.) and real dates. If any count
 * is 0 or wildly wrong, Wikipedia's table structure has likely changed and
 * lib/indexTiers.js's parser needs updating before the weekly refresh job
 * is trusted to run unattended.
 */
const {
  fetchSp500Membership,
  fetchSp400Or600Membership,
  SP400_URL,
  SP600_URL,
} = require("../services/indexTiers");

async function main() {
  console.log("Fetching S&P 500 from Wikipedia...");
  const sp500 = await fetchSp500Membership();
  console.log(`  -> ${sp500.size} symbols parsed`);
  console.log(`  -> AAPL present: ${sp500.has("AAPL")}`);
  console.log(`  -> MSFT present: ${sp500.has("MSFT")}`);
  if (sp500.has("MMM")) {
    console.log(`  -> MMM sample:`, sp500.get("MMM"));
  }
  const sp500Ok = sp500.size > 450 && sp500.size < 520 && sp500.has("AAPL");
  console.log(sp500Ok ? "  PASS\n" : "  FAIL — check parser against current page structure\n");

  console.log("Fetching S&P 400 from Wikipedia...");
  const sp400 = await fetchSp400Or600Membership(SP400_URL);
  console.log(`  -> ${sp400.size} symbols parsed`);
  const sp400Ok = sp400.size > 350 && sp400.size < 450;
  console.log(sp400Ok ? "  PASS\n" : "  FAIL\n");

  console.log("Fetching S&P 600 from Wikipedia...");
  const sp600 = await fetchSp400Or600Membership(SP600_URL);
  console.log(`  -> ${sp600.size} symbols parsed`);
  const sp600Ok = sp600.size > 550 && sp600.size < 650;
  console.log(sp600Ok ? "  PASS\n" : "  FAIL\n");

  const allOk = sp500Ok && sp400Ok && sp600Ok;
  console.log(allOk ? "=== SMOKE TEST PASSED — safe to wire into Stage 0 ===" : "=== SMOKE TEST FAILED — do NOT trust the automated refresh yet ===");
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error("SMOKE TEST ERROR:", err.message);
  process.exit(1);
});
