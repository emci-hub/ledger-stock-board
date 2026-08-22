/**
 * 90-day dated-event check for the long-term screen, per stock-alert-spec.md:
 * a dated headline or filing — strategic acquisition, or a material step-up
 * in growth CapEx — in the last 90 days. No headline, no flag.
 *
 * Reuses the existing combined-news fetch (Marketaux + Alpha Vantage
 * NEWS_SENTIMENT, services/dataFetch.js) — no new HTTP wrapper needed.
 *
 * source_type classification is a source-domain/name allowlist (wire
 * services: PR Newswire, Business Wire, GlobeNewswire, AccessWire). There is
 * no SEC EDGAR integration in this codebase, so true "filing" detection is a
 * known gap — only "official_press" or "other" are ever produced here.
 * "other" never qualifies as a flaggable event, per stock-pipeline.md.
 */

const { getCombinedNews } = require("./dataFetch");

const DEFAULT_EVENT_WINDOW_DAYS = 90;

const OFFICIAL_PRESS_DOMAINS = [
  "prnewswire.com",
  "businesswire.com",
  "globenewswire.com",
  "accesswire.com",
];

const OFFICIAL_PRESS_SOURCE_NAMES = [
  "pr newswire",
  "business wire",
  "globenewswire",
  "globe newswire",
  "accesswire",
];

// M&A / CapEx step-up phrases only — deliberately excludes the bare words
// "AI", "cloud", "energy", "capacity" per stock-pipeline.md ("not the bare
// words AI, cloud, energy, capacity" — those alone don't count as an event).
const EVENT_KEYWORD_PATTERNS = [
  /\bacquir\w*/i, // acquire, acquires, acquired, acquisition
  /\bmerg\w*/i, // merger, mergers, merge, merging
  /\bcash offer\b/i,
  /\bcapital expenditure\w*/i,
  /\bcapex guidance\b/i,
  /\bdata[- ]?centers?\s+build\w*/i,
  /\bcapacity expansion\b/i,
];

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Classify a news item's source as "official_press" or "other". No "filing"
 * value is ever produced (no SEC EDGAR integration exists yet).
 */
function classifySourceType({ source, url }) {
  const domain = hostnameOf(url);
  if (domain && OFFICIAL_PRESS_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) {
    return "official_press";
  }
  const name = String(source || "").toLowerCase();
  if (name && OFFICIAL_PRESS_SOURCE_NAMES.some((n) => name.includes(n))) {
    return "official_press";
  }
  return "other";
}

function matchesEventKeywords(title) {
  if (!title) return false;
  return EVENT_KEYWORD_PATTERNS.some((re) => re.test(title));
}

/**
 * Parses both Alpha Vantage's "YYYYMMDDTHHMMSS" format and standard ISO
 * strings (Marketaux). Returns null if unparseable.
 */
function parsePublishedAt(raw) {
  if (!raw) return null;
  const avMatch = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(raw);
  if (avMatch) {
    const [, y, mo, d, h, mi, s] = avMatch;
    return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  }
  const dt = new Date(raw);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/**
 * Find the most recent dated M&A/CapEx-step-up headline within the last
 * `sinceDays` days for a PRIMARY-listing ticker, from official-press
 * sources only. Returns null if nothing qualifies — "no headline, no flag."
 */
async function findDatedEvent(primaryTicker, opts = {}) {
  const sinceDays = Math.max(1, Number(opts.sinceDays) || DEFAULT_EVENT_WINDOW_DAYS);
  const cutoffMs = Date.now() - sinceDays * 24 * 60 * 60 * 1000;

  const combined = await getCombinedNews(primaryTicker);

  const candidates = [
    ...(combined?.alpha?.news || []).map((a) => ({
      title: a.title,
      url: a.url,
      publishedAtRaw: a.publishedAt,
      source: a.source,
    })),
    ...(combined?.marketaux?.articles || []).map((a) => ({
      title: a.title,
      url: a.url,
      publishedAtRaw: a.publishedAt,
      source: null,
    })),
  ];

  const qualifying = candidates
    .map((c) => {
      const publishedAt = parsePublishedAt(c.publishedAtRaw);
      return {
        ...c,
        publishedAt,
        sourceType: classifySourceType({ source: c.source, url: c.url }),
      };
    })
    .filter((c) => c.title && c.url && c.publishedAt && c.publishedAt.getTime() >= cutoffMs)
    .filter((c) => c.sourceType === "official_press")
    .filter((c) => matchesEventKeywords(c.title))
    .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());

  if (!qualifying.length) return null;

  const best = qualifying[0];
  return {
    headline: best.title,
    url: best.url,
    date: best.publishedAt.toISOString().slice(0, 10),
    source: best.source || null,
    sourceType: best.sourceType,
  };
}

module.exports = {
  DEFAULT_EVENT_WINDOW_DAYS,
  OFFICIAL_PRESS_DOMAINS,
  OFFICIAL_PRESS_SOURCE_NAMES,
  EVENT_KEYWORD_PATTERNS,
  classifySourceType,
  matchesEventKeywords,
  parsePublishedAt,
  findDatedEvent,
};
