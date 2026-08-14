/**
 * Resolve + persist company identity and profile extras for promoted /
 * discovered tickers. Curated seed blurbs win for name/sector/description;
 * otherwise FMP /stable/profile fills the gap (no Alpha Vantage spend).
 *
 * Retains FMP extras already on the wire: logo, marketCap, ipoDate, exchange,
 * defaultImage, isActivelyTrading, isEtf, isFund.
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
const DESCRIPTION_MAX_LEN = 180;

/** Common corporate abbreviations whose periods are not sentence ends. */
const ABBREV_BEFORE_PERIOD =
  /\b(?:Inc|Corp|Ltd|LLC|Co|Mr|Mrs|Ms|Dr|Jr|Sr|vs|etc|U\.S|U\.K)$/i;

/**
 * Strip a leading FMP-style appositive opener ("Name, a media company, …")
 * so the card blurb doesn't repeat the title line. Leaves other formats alone
 * (e.g. "Name, together with…" or "Name is a …").
 */
function stripLeadingCompanyName(text, companyName) {
  if (!text || !companyName) return text;
  const name = String(companyName).trim();
  if (!name) return text;
  const cleaned = String(text).replace(/\s+/g, " ").trim();
  if (!cleaned.toLowerCase().startsWith(name.toLowerCase())) return cleaned;
  const after = cleaned.slice(name.length);
  const appositive = after.match(/^,\s+((?:a|an|the)\b[\s\S]+)$/i);
  if (!appositive) return cleaned;
  const rest = appositive[1].trim();
  if (!rest) return cleaned;
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/**
 * Prefer a complete sentence within the limit; otherwise word-boundary cut.
 * Never treats "Inc." / "Corp." / similar as sentence endings.
 */
function shortenDescription(text, maxLen = DESCRIPTION_MAX_LEN, options = {}) {
  if (!text) return null;
  let cleaned = String(text).replace(/\s+/g, " ").trim();
  if (!cleaned) return null;

  if (options.name) {
    cleaned = stripLeadingCompanyName(cleaned, options.name);
  }

  const limit = Math.max(40, Number(maxLen) || DESCRIPTION_MAX_LEN);
  if (cleaned.length <= limit) return cleaned;

  // Prefer the last real sentence end that still fits (min ~50 chars of substance).
  let bestSentenceEnd = -1;
  for (let i = 0; i < cleaned.length && i < limit; i += 1) {
    const ch = cleaned[i];
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    const after = cleaned[i + 1];
    if (after && after !== " ") continue;
    const before = cleaned.slice(Math.max(0, i - 6), i);
    if (ABBREV_BEFORE_PERIOD.test(before)) continue;
    // Skip initials / decimal-like "A.I." single-letter before period
    if (/[A-Za-z]$/.test(before) && before.length >= 1) {
      const lastWord = before.split(/\s/).pop() || "";
      if (lastWord.length <= 2 && /[A-Za-z]\.?$/.test(lastWord) && lastWord.replace(/\./g, "").length <= 1) {
        continue;
      }
    }
    if (i + 1 >= 50) bestSentenceEnd = i + 1;
  }
  if (bestSentenceEnd > 0) {
    return cleaned.slice(0, bestSentenceEnd).trim();
  }

  const slice = cleaned.slice(0, limit);
  const lastSpace = slice.lastIndexOf(" ");
  const cut =
    lastSpace > Math.floor(limit * 0.55) ? slice.slice(0, lastSpace) : slice;
  return `${cut.replace(/[.,;:\s]+$/g, "")}…`;
}

function identityCoreComplete(identity) {
  return Boolean(
    identity?.name && identity?.sector && identity?.description
  );
}

function hasProfileExtras(identity) {
  if (!identity || typeof identity !== "object") return false;
  return (
    identity.isActivelyTrading != null ||
    identity.marketCap != null ||
    identity.ipoDate != null ||
    identity.logo != null ||
    identity.exchange != null ||
    identity.isEtf === true ||
    identity.isFund === true
  );
}

function asBoolOrNull(value) {
  if (value === true || value === false) return value;
  if (value === "true" || value === 1 || value === "1") return true;
  if (value === "false" || value === 0 || value === "0") return false;
  return null;
}

function mergeIdentity(...parts) {
  const out = {
    name: null,
    sector: null,
    description: null,
    industry: null,
    exchange: null,
    logo: null,
    defaultImage: null,
    marketCap: null,
    ipoDate: null,
    isActivelyTrading: null,
    isEtf: null,
    isFund: null,
    source: null,
  };
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    if (!out.name && part.name) out.name = String(part.name).trim() || null;
    if (!out.sector && part.sector) {
      out.sector = String(part.sector).trim() || null;
    }
    if (!out.description && part.description) {
      // Final name-aware shorten happens after merge; keep raw-ish here.
      out.description = String(part.description).replace(/\s+/g, " ").trim();
    }
    if (!out.industry && part.industry) {
      out.industry = String(part.industry).trim() || null;
    }
    if (!out.exchange && part.exchange) {
      out.exchange = String(part.exchange).trim() || null;
    }
    if (!out.logo && part.logo) out.logo = String(part.logo).trim() || null;
    if (out.defaultImage == null && part.defaultImage != null) {
      out.defaultImage = asBoolOrNull(part.defaultImage);
    }
    if (out.marketCap == null && part.marketCap != null) {
      const n = Number(part.marketCap);
      if (Number.isFinite(n)) out.marketCap = n;
    }
    if (!out.ipoDate && part.ipoDate) {
      out.ipoDate = String(part.ipoDate).trim() || null;
    }
    if (out.isActivelyTrading == null && part.isActivelyTrading != null) {
      out.isActivelyTrading = asBoolOrNull(part.isActivelyTrading);
    }
    if (out.isEtf == null && part.isEtf != null) {
      out.isEtf = asBoolOrNull(part.isEtf);
    }
    if (out.isFund == null && part.isFund != null) {
      out.isFund = asBoolOrNull(part.isFund);
    }
    if (!out.source && part.source) out.source = part.source;
  }
  return out;
}

function finalizeIdentityDescription(identity) {
  if (!identity || !identity.description) return identity;
  const opts = {};
  // FMP blurbs often open with "Company Name, a …" — strip that so the card
  // doesn't repeat the title line. Curated blurbs use "Name — …" and are left alone.
  if (
    identity.name &&
    String(identity.description)
      .toLowerCase()
      .startsWith(`${String(identity.name).toLowerCase()},`)
  ) {
    opts.name = identity.name;
  }
  identity.description = shortenDescription(
    identity.description,
    DESCRIPTION_MAX_LEN,
    opts
  );
  return identity;
}

async function persistIdentity(ticker, identity, { force = false } = {}) {
  const symbol = String(ticker).toUpperCase();
  if (
    !identity?.name &&
    !identity?.sector &&
    !identity?.description &&
    !identity?.exchange &&
    identity?.marketCap == null &&
    !identity?.logo &&
    !identity?.ipoDate
  ) {
    return;
  }

  await dbRun(
    `UPDATE board_picks
     SET name = COALESCE(?, name),
         sector = COALESCE(?, sector),
         exchange = COALESCE(?, exchange)
     WHERE ticker = ?`,
    [
      identity.name || null,
      identity.sector || null,
      identity.exchange || null,
      symbol,
    ]
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
    if (
      force ||
      !overview.description ||
      String(identity.description).length >
        String(overview.description).length + 15
    ) {
      overview.description = identity.description;
    }
  }
  if (identity.industry) {
    overview.industry = overview.industry || identity.industry;
  }
  if (identity.logo) {
    if (force || !overview.logo) overview.logo = identity.logo;
  }
  if (identity.defaultImage != null) {
    if (force || overview.defaultImage == null) {
      overview.defaultImage = identity.defaultImage;
    }
  }
  if (identity.marketCap != null) {
    if (force || overview.marketCap == null) {
      overview.marketCap = identity.marketCap;
    }
  }
  if (identity.ipoDate) {
    if (force || !overview.ipoDate) overview.ipoDate = identity.ipoDate;
  }
  if (identity.exchange) {
    if (force || !overview.exchange) overview.exchange = identity.exchange;
  }
  if (identity.isActivelyTrading != null) {
    overview.isActivelyTrading = identity.isActivelyTrading;
  }
  if (identity.isEtf != null) overview.isEtf = identity.isEtf;
  if (identity.isFund != null) overview.isFund = identity.isFund;

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
 * Beginner-friendly market-cap label, e.g. "$12.9M company" / "$2.8T company".
 */
function formatMarketCapLabel(marketCap) {
  const n = Number(marketCap);
  if (!Number.isFinite(n) || n <= 0) return null;
  const abs = Math.abs(n);
  let scaled;
  let suffix;
  if (abs >= 1e12) {
    scaled = abs / 1e12;
    suffix = "T";
  } else if (abs >= 1e9) {
    scaled = abs / 1e9;
    suffix = "B";
  } else if (abs >= 1e6) {
    scaled = abs / 1e6;
    suffix = "M";
  } else if (abs >= 1e3) {
    scaled = abs / 1e3;
    suffix = "K";
  } else {
    return `$${Math.round(abs).toLocaleString("en-US")} company`;
  }
  const rounded =
    scaled >= 100 ? scaled.toFixed(0) : scaled >= 10 ? scaled.toFixed(1) : scaled.toFixed(1);
  const trimmed = String(rounded).replace(/\.0$/, "");
  return `$${trimmed}${suffix} company`;
}

function isIpoWithinLastYear(ipoDate, now = new Date()) {
  if (!ipoDate) return false;
  const t = Date.parse(String(ipoDate));
  if (Number.isNaN(t)) return false;
  const yearMs = 365.25 * 24 * 60 * 60 * 1000;
  const age = now.getTime() - t;
  return age >= 0 && age <= yearMs;
}

function instrumentLabelFromFlags(identityOrOverview) {
  if (!identityOrOverview) return null;
  if (identityOrOverview.isEtf === true) return "ETF";
  if (identityOrOverview.isFund === true) return "Fund";
  return null;
}

/**
 * Display logo URL — skip FMP's generic placeholder when defaultImage is true.
 */
function resolveDisplayLogo(overview = {}) {
  if (!overview || typeof overview !== "object") return null;
  if (overview.defaultImage === true) return null;
  const url = overview.logo || overview.image || null;
  if (!url || typeof url !== "string") return null;
  const trimmed = url.trim();
  return trimmed || null;
}

/**
 * Ensure name/sector/description + profile extras are present for a ticker.
 *
 * @param {string} ticker
 * @param {object} [hints]
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
      industry: hints.industry || null,
      exchange: hints.exchange || null,
      logo: hints.logo || null,
      defaultImage: hints.defaultImage,
      marketCap: hints.marketCap,
      ipoDate: hints.ipoDate || null,
      isActivelyTrading: hints.isActivelyTrading,
      isEtf: hints.isEtf,
      isFund: hints.isFund,
      source:
        hints.name ||
        hints.sector ||
        hints.description ||
        hints.logo ||
        hints.marketCap != null ||
        hints.exchange
          ? "hint"
          : null,
    },
    {
      name: pick?.name || null,
      sector: pick?.sector || null,
      exchange: pick?.exchange || null,
      source: pick?.name || pick?.sector || pick?.exchange ? "board_picks" : null,
    },
    {
      name: overview.name || null,
      sector: overview.sector || null,
      description: overview.description || null,
      industry: overview.industry || null,
      exchange: overview.exchange || null,
      logo: overview.logo || null,
      defaultImage: overview.defaultImage,
      marketCap: overview.marketCap,
      ipoDate: overview.ipoDate || null,
      isActivelyTrading: overview.isActivelyTrading,
      isEtf: overview.isEtf,
      isFund: overview.isFund,
      source: overview.name || overview.sector ? "cache_overview" : null,
    },
    {
      name: quote.name || null,
      source: quote.name ? "quote" : null,
    }
  );

  identity = mergeIdentity(
    resolveTickerIdentity(
      symbol,
      {
        name: identity.name,
        sector: identity.sector,
        description: identity.description,
      },
      { name: quote.name }
    ),
    identity
  );

  const force = hints.force === true;
  const needFetch =
    force ||
    !identityCoreComplete(identity) ||
    !hasProfileExtras(identity);

  if (!needFetch) {
    finalizeIdentityDescription(identity);
    await persistIdentity(symbol, identity, { force });
    return {
      ok: true,
      identity,
      fetched: false,
      source: identity.source || (local ? "curated" : "existing"),
      complete: identityCoreComplete(identity),
    };
  }

  if (!force && recentlyChecked(data?.freshness) && identityCoreComplete(identity)) {
    finalizeIdentityDescription(identity);
    await persistIdentity(symbol, identity, { force });
    return {
      ok: Boolean(identity.name),
      identity,
      fetched: false,
      source: identity.source || "stale_partial",
      skipped: "recently_checked",
      complete: identityCoreComplete(identity),
    };
  }

  // Allow caller to pass a pre-fetched profile to avoid a second FMP call.
  let profile = null;
  if (hints.profile && typeof hints.profile === "object") {
    profile = hints.profile;
  } else if (hasFmpKey() && needFetch) {
    try {
      profile = await getCompanyProfileFromFmp(symbol);
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

  if (profile) {
    const beforeDesc = identity.description;
    identity = mergeIdentity(identity, {
      ...profile,
      source: profile.source || "fmp_profile",
    });
    // Prefer a fuller FMP description over a previously mangled short one
    // (old period-splitter left values like "Gaxos.ai Inc.").
    if (profile.description) {
      const freshRaw = String(profile.description).replace(/\s+/g, " ").trim();
      if (
        freshRaw &&
        (!beforeDesc ||
          force ||
          freshRaw.length > String(beforeDesc).length + 15)
      ) {
        identity.description = freshRaw;
      }
    }
  }

  finalizeIdentityDescription(identity);
  await persistIdentity(symbol, identity, { force });

  return {
    ok: Boolean(identity.name),
    identity,
    fetched: Boolean(profile),
    source: identity.source || null,
    complete: identityCoreComplete(identity),
  };
}

module.exports = {
  ensureTickerIdentity,
  identityComplete: identityCoreComplete,
  identityCoreComplete,
  hasProfileExtras,
  shortenDescription,
  mergeIdentity,
  formatMarketCapLabel,
  isIpoWithinLastYear,
  instrumentLabelFromFlags,
  resolveDisplayLogo,
  stripLeadingCompanyName,
  DESCRIPTION_MAX_LEN,
};
