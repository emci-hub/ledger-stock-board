/**
 * Resolve + persist company identity (name / sector / description) for
 * promoted and discovered tickers. Curated seed blurbs win; otherwise FMP
 * /stable/profile fills the gap without burning Alpha Vantage OVERVIEW.
 */

const { getTickerInfo, resolveTickerIdentity } = require("../lib/tickerInfo");
const { getPick } = require("../lib/boardPicks");
const { dbRun } = require("../db/schema");
const {
  getStockCacheEntry,
  saveStockToCache,
  emptyFreshness,
  freshnessFromData,
} = require("./cache");
const {
  getCompanyProfileFromFmp,
  hasFmpKey,
  QuotaSkippedError,
} = require("./dataFetch");

const IDENTITY_RETRY_MS = 24 * 60 * 60 * 1000;

function shortenDescription(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  const sentence = cleaned.split(/(?<=[.!?])\s+/)[0] || cleaned;
  if (sentence.length <= 220) return sentence;
  return `${sentence.slice(0, 217).trim()}…`;
}

function identityComplete(identity) {
  return Boolean(
    identity?.name && identity?.sector && identity?.description
  );
}

function mergeIdentity(...parts) {
  const out = { name: null, sector: null, description: null, source: null };
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    if (!out.name && part.name) out.name = String(part.name).trim() || null;
    if (!out.sector && part.sector) {
      out.sector = String(part.sector).trim() || null;
    }
    if (!out.description && part.description) {
      out.description = shortenDescription(part.description);
    }
    if (!out.source && part.source) out.source = part.source;
  }
  return out;
}

async function persistIdentity(ticker, identity) {
  const symbol = String(ticker).toUpperCase();
  if (!identity?.name && !identity?.sector && !identity?.description) {
    return;
  }

  await dbRun(
    `UPDATE board_picks
     SET name = COALESCE(?, name),
         sector = COALESCE(?, sector)
     WHERE ticker = ?`,
    [identity.name || null, identity.sector || null, symbol]
  );

  const entry = await getStockCacheEntry(symbol);
  const data = entry?.data
    ? { ...entry.data }
    : {
        quote: null,
        fundamentals: { overview: {}, news: [] },
        peers: [],
        freshness: emptyFreshness(),
      };
  if (!data.fundamentals) data.fundamentals = { overview: {}, news: [] };
  if (!data.fundamentals.overview) data.fundamentals.overview = {};
  const overview = data.fundamentals.overview;
  if (identity.name) overview.name = overview.name || identity.name;
  if (identity.sector) overview.sector = overview.sector || identity.sector;
  if (identity.description) {
    overview.description = overview.description || identity.description;
  }
  data.freshness = {
    ...emptyFreshness(),
    ...freshnessFromData(data),
    identityCheckedAt: new Date().toISOString(),
  };
  await saveStockToCache(symbol, null, data);
}

function recentlyChecked(freshness) {
  const at = freshness?.identityCheckedAt;
  if (!at) return false;
  const then = Date.parse(at);
  if (Number.isNaN(then)) return false;
  return Date.now() - then < IDENTITY_RETRY_MS;
}

/**
 * Ensure name/sector/description are present for a ticker.
 * Safe to call on every promotion warm — curated + existing fields short-circuit.
 *
 * @param {string} ticker
 * @param {{ name?: string|null, sector?: string|null, description?: string|null, force?: boolean }} hints
 */
async function ensureTickerIdentity(ticker, hints = {}) {
  const symbol = String(ticker || "")
    .trim()
    .toUpperCase();
  if (!symbol) {
    return { ok: false, error: "invalid_ticker", identity: null };
  }

  const local = getTickerInfo(symbol);
  const pick = await getPick(symbol);
  const entry = await getStockCacheEntry(symbol);
  const data = entry?.data || null;
  const overview = data?.fundamentals?.overview || {};
  const quote = data?.quote || {};

  let identity = mergeIdentity(
    local
      ? {
          name: local.name,
          sector: local.sector,
          description: local.description,
          source: "curated",
        }
      : null,
    {
      name: hints.name || null,
      sector: hints.sector || null,
      description: hints.description || null,
      source: hints.name || hints.sector || hints.description ? "hint" : null,
    },
    {
      name: pick?.name || null,
      sector: pick?.sector || null,
      source: pick?.name || pick?.sector ? "board_picks" : null,
    },
    {
      name: overview.name || null,
      sector: overview.sector || null,
      description: overview.description || null,
      source: overview.name || overview.sector ? "cache_overview" : null,
    },
    {
      name: quote.name || null,
      source: quote.name ? "quote" : null,
    }
  );

  // Re-resolve through shared helper for consistent precedence.
  identity = mergeIdentity(
    resolveTickerIdentity(symbol, {
      name: identity.name,
      sector: identity.sector,
      description: identity.description,
    }, { name: quote.name }),
    { source: identity.source || (local ? "curated" : null) }
  );

  if (identityComplete(identity)) {
    await persistIdentity(symbol, identity);
    return {
      ok: true,
      identity,
      fetched: false,
      source: identity.source || (local ? "curated" : "existing"),
    };
  }

  if (!hints.force && recentlyChecked(data?.freshness)) {
    await persistIdentity(symbol, identity);
    return {
      ok: Boolean(identity.name),
      identity,
      fetched: false,
      source: identity.source || "stale_partial",
      skipped: "recently_checked",
    };
  }

  if (hasFmpKey()) {
    try {
      const profile = await getCompanyProfileFromFmp(symbol);
      if (profile) {
        identity = mergeIdentity(identity, {
          name: profile.name,
          sector: profile.sector,
          description: profile.description,
          source: "fmp_profile",
        });
      }
    } catch (err) {
      if (err instanceof QuotaSkippedError) {
        console.warn(
          `[tickerIdentity] FMP profile skipped — no quota for ${symbol}`
        );
      } else {
        console.warn(
          `[tickerIdentity] FMP profile failed for ${symbol}:`,
          err.message
        );
      }
    }
  }

  await persistIdentity(symbol, identity);

  return {
    ok: Boolean(identity.name),
    identity,
    fetched: true,
    source: identity.source || null,
    complete: identityComplete(identity),
  };
}

module.exports = {
  ensureTickerIdentity,
  identityComplete,
  shortenDescription,
  mergeIdentity,
};
