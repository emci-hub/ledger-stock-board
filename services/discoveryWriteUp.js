/**
 * Short Gemini write-up when discovery promotes a new stock onto the board.
 */

const { generateJson } = require("../lib/aiProvider");
const { dbRun } = require("../db/schema");

async function generateDiscoveryWriteUp({
  ticker,
  name = null,
  sector = null,
  percentChange = null,
  mover = null,
} = {}) {
  const symbol = String(ticker).toUpperCase();
  const prompt = `A family stock board just added ${symbol}${name ? ` (${name})` : ""} from today's market movers.

Write a short plain-English blurb (2–3 sentences, max ~55 words) explaining:
1) what this company roughly does (if you know; otherwise stay general), and
2) why it showed up here (e.g. it was among today's notable movers — percent change ${percentChange ?? "n/a"}).

No buy/sell advice. No jargon. Respond ONLY with JSON: { "blurb": "..." }

Context: ${JSON.stringify({ ticker: symbol, name, sector, percentChange, mover }, null, 2)}`;

  const parsed = await generateJson(prompt, { maxOutputTokens: 256 });
  const blurb = String(parsed?.blurb || "").trim();
  if (!blurb) {
    return `${symbol} is a new addition from today's market movers — open the card for the full plain-English read.`;
  }
  return blurb;
}

async function saveDiscoveryBlurb(ticker, blurb) {
  const symbol = String(ticker).toUpperCase();
  // Column may not exist until migration; try update, ignore if missing.
  try {
    await dbRun(`UPDATE board_picks SET discovery_blurb = ? WHERE ticker = ?`, [
      String(blurb || "").slice(0, 500),
      symbol,
    ]);
  } catch (err) {
    console.warn(
      `[discoveryWriteUp] Could not save blurb for ${symbol}:`,
      err.message
    );
  }
}

module.exports = {
  generateDiscoveryWriteUp,
  saveDiscoveryBlurb,
};
