/**
 * Daily market-mood line — one Gemini call synthesizing live board cards.
 */

const { generateJson } = require("../lib/aiProvider");
const { getSetting, setSetting, getPacificDateString } = require("./usage");
const { listLiveBoardPicks } = require("../lib/boardPicks");
const { getStockCacheEntry, getCachedSummary } = require("./cache");
const { buildReport } = require("./getStockReport");

const SETTING_KEY = "marketMood";

async function loadMood() {
  const raw = await getSetting(SETTING_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function refreshMarketMood() {
  const picks = await listLiveBoardPicks();
  const snapshots = [];

  for (const pick of picks.slice(0, 16)) {
    const entry = await getStockCacheEntry(pick.ticker);
    const analysis = await getCachedSummary(pick.ticker);
    if (!entry?.data?.quote) continue;
    const report = buildReport(
      pick.ticker,
      "long",
      entry.data,
      analysis,
      entry.data?.freshness?.priceUpdatedAt || entry.lastUpdated
    );
    snapshots.push({
      ticker: pick.ticker,
      name: report.companyName || report.name || pick.ticker,
      sector: report.sector || pick.sector || null,
      lean: report.analysis?.lean || null,
      risk: report.analysis?.risk || null,
      changePercent: report.changePercent ?? null,
      summary: report.analysis?.summary || null,
    });
  }

  if (!snapshots.length) {
    const empty = {
      text: "Board mood will appear after today's picks refresh.",
      at: new Date().toISOString(),
      date: getPacificDateString(),
      count: 0,
    };
    await setSetting(SETTING_KEY, JSON.stringify(empty));
    return empty;
  }

  const prompt = `You write one short "market mood" line for a family stock board.

Given these board stocks (JSON), write ONE plain-English sentence (max ~28 words) summarizing the overall feel — e.g. which sectors are moving, whether most names are steady vs mixed. No buy/sell advice. No ticker laundry list.

Respond ONLY with JSON: { "mood": "your sentence here" }

Board:
${JSON.stringify(snapshots, null, 2)}`;

  const parsed = await generateJson(prompt, { maxOutputTokens: 256 });
  const text = String(parsed?.mood || parsed?.text || "").trim();
  const result = {
    text:
      text ||
      "Most of today's picks are holding steady — check each card for the details.",
    at: new Date().toISOString(),
    date: getPacificDateString(),
    count: snapshots.length,
  };
  await setSetting(SETTING_KEY, JSON.stringify(result));
  console.log(`[marketMood] ${result.text}`);
  return result;
}

/** Return cached mood; refresh if missing or from a prior Pacific day. */
async function getMarketMood({ force = false } = {}) {
  const cached = await loadMood();
  const today = getPacificDateString();
  if (!force && cached?.text && cached.date === today) return cached;
  try {
    return await refreshMarketMood();
  } catch (err) {
    console.warn("[marketMood] refresh failed:", err.message);
    return (
      cached || {
        text: "Market mood unavailable right now.",
        at: new Date().toISOString(),
        date: today,
        count: 0,
      }
    );
  }
}

module.exports = {
  refreshMarketMood,
  getMarketMood,
  loadMood,
  SETTING_KEY,
};
