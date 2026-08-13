/**
 * Rotating beginner "Did you know?" tidbits — weekly Gemini batch, daily rotation.
 */

const { generateJson } = require("../lib/aiProvider");
const {
  getSetting,
  setSetting,
  getPacificDateString,
} = require("./usage");

const BATCH_KEY = "didYouKnowBatch";
const BATCH_SIZE = 12;

async function loadBatch() {
  const raw = await getSetting(BATCH_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function weekKey(date = new Date()) {
  // ISO week-ish key in Pacific date space
  const d = new Date(date);
  const day = getPacificDateString(d);
  return day.slice(0, 7); // YYYY-MM is fine for monthly-ish; use week number
}

function pacificWeekId() {
  const day = getPacificDateString();
  const [y, m, d] = day.split("-").map(Number);
  const utc = Date.UTC(y, m - 1, d);
  const date = new Date(utc);
  const oneJan = new Date(Date.UTC(y, 0, 1));
  const week = Math.ceil(((date - oneJan) / 86400000 + oneJan.getUTCDay() + 1) / 7);
  return `${y}-W${String(week).padStart(2, "0")}`;
}

async function regenerateTidbitBatch() {
  const prompt = `Create ${BATCH_SIZE} beginner-friendly "Did you know?" tidbits for a family learning about stocks.

Rules:
- Each item is one or two short sentences, plain English, no jargon without a quick gloss.
- Educational, light, not financial advice — never tell anyone to buy or sell.
- Cover varied basics: dividends, indexes, volatility, dollar-cost averaging, what a ticker is, earnings, diversification, etc.
- Respond ONLY with JSON: { "tidbits": ["...", "..."] } with exactly ${BATCH_SIZE} strings.`;

  const parsed = await generateJson(prompt, { maxOutputTokens: 2048 });
  const list = Array.isArray(parsed?.tidbits)
    ? parsed.tidbits.map((t) => String(t).trim()).filter(Boolean)
    : [];
  if (list.length < 5) {
    throw new Error("Did-you-know batch too small");
  }

  const batch = {
    items: list.slice(0, 15),
    generatedAt: new Date().toISOString(),
    weekId: pacificWeekId(),
  };
  await setSetting(BATCH_KEY, JSON.stringify(batch));
  console.log(`[didYouKnow] Generated ${batch.items.length} tidbits (${batch.weekId})`);
  return batch;
}

async function ensureTidbitBatch({ force = false } = {}) {
  const cached = await loadBatch();
  const weekId = pacificWeekId();
  if (!force && cached?.items?.length && cached.weekId === weekId) {
    return cached;
  }
  try {
    return await regenerateTidbitBatch();
  } catch (err) {
    console.warn("[didYouKnow] regenerate failed:", err.message);
    return cached;
  }
}

function dayIndexPacific() {
  const day = getPacificDateString();
  // Stable hash from date string
  let h = 0;
  for (let i = 0; i < day.length; i++) h = (h * 31 + day.charCodeAt(i)) >>> 0;
  return h;
}

async function getTodaysTidbit({ allowGenerate = false } = {}) {
  let batch = allowGenerate ? await ensureTidbitBatch() : await loadBatch();
  if (!batch?.items?.length && allowGenerate) {
    batch = await ensureTidbitBatch({ force: true });
  }
  if (!batch?.items?.length) {
    return {
      text: "Did you know? A stock ticker is just a short nickname for a company on the exchange.",
      index: 0,
      total: 1,
      date: getPacificDateString(),
    };
  }
  const idx = dayIndexPacific() % batch.items.length;
  return {
    text: batch.items[idx],
    index: idx,
    total: batch.items.length,
    date: getPacificDateString(),
    weekId: batch.weekId,
  };
}

module.exports = {
  ensureTidbitBatch,
  regenerateTidbitBatch,
  getTodaysTidbit,
  loadBatch,
  BATCH_KEY,
};
