const axios = require("axios");
const { dbGet, dbAll, dbRun } = require("../db/schema");

const JOKE_API =
  "https://v2.jokeapi.dev/joke/Any?safe-mode&blacklistFlags=nsfw,racist,sexist,explicit,political,religious";
const POOL_MIN = 4;

function formatJoke(item) {
  if (!item || item.error) return null;
  if (item.type === "twopart") {
    const setup = String(item.setup || "").trim();
    const delivery = String(item.delivery || "").trim();
    if (!setup || !delivery) return null;
    return `${setup} ${delivery}`;
  }
  const joke = String(item.joke || "").trim();
  return joke || null;
}

async function poolCount() {
  const row = await dbGet(`SELECT COUNT(*) AS n FROM joke_pool`);
  return Number(row?.n || 0);
}

/**
 * Top up the JokeAPI fallback pool when low. Safe-mode + blacklist flags.
 * Not the primary quip source — only used when Gemini quip is empty.
 */
async function ensureJokePool(force = false) {
  const count = await poolCount();
  if (!force && count >= POOL_MIN) {
    return { count, fetched: 0 };
  }

  let fetched = 0;
  try {
    const { data } = await axios.get(JOKE_API, {
      params: { amount: 10 },
      timeout: 12000,
    });

    const items = Array.isArray(data?.jokes)
      ? data.jokes
      : data && !data.error
        ? [data]
        : [];

    const now = new Date().toISOString();
    for (const item of items) {
      const text = formatJoke(item);
      if (!text) continue;
      try {
        await dbRun(
          `INSERT OR IGNORE INTO joke_pool (joke_text, fetched_at) VALUES (?, ?)`,
          [text, now]
        );
        fetched += 1;
      } catch {
        /* ignore duplicate / insert errors */
      }
    }
  } catch (err) {
    console.warn("[jokes] JokeAPI pool fetch failed:", err.message);
  }

  const after = await poolCount();
  console.log(
    `[jokes] pool ensure — before=${count}, fetched≈${fetched}, after=${after}`
  );
  return { count: after, fetched };
}

/** Random joke from the cached pool, or null. */
async function getFallbackJoke() {
  await ensureJokePool(false);
  const rows = await dbAll(
    `SELECT id, joke_text FROM joke_pool ORDER BY RANDOM() LIMIT 1`
  );
  return rows[0]?.joke_text || null;
}

module.exports = {
  ensureJokePool,
  getFallbackJoke,
  poolCount,
};
