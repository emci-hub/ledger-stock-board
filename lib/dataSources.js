/**
 * Central registry of external data sources.
 * Adding a provider = one entry here + a fetcher registered in services/dataFetch.js.
 * UI short codes and the footer legend both come from this registry.
 *
 * Formal roles (family board, free/personal tiers):
 * - Twelve Data: primary price + indicators + discovery/movers (≈800/day).
 *   price_target / profile are Grow-plan-only — not used for live target.
 * - Alpha Vantage: scarce specialist for analyst target (OVERVIEW) only;
 *   opportunistic NEWS_SENTIMENT fallback if Marketaux fails (never unconditional parallel).
 * - Finnhub: primary peers + primary earnings calendar (scored news-sentiment is blocked on free).
 * - Marketaux: primary scored news.
 * - Gemini: synthesis/writing only — never a market-data source. Daily limit tracked empirically.
 */

const DATA_SOURCES = {
  twelve_data: {
    id: "twelve_data",
    label: "Twelve Data",
    shortCode: "TD",
    envKey: "TWELVE_DATA_API_KEY",
    role: "price_indicators_discovery_primary",
    provides: ["price", "indicators", "discovery"],
    rateLimit: { window: "day", limit: 800 },
    /** Calls held back from Smart Refresh for live family searches (0 = none). */
    smartRefreshReserve: 0,
    priority: { price: 1, indicators: 1, discovery: 1 },
    notes:
      "Grow-plan-only endpoints (price_target, profile) are probed monthly and not used live for target.",
  },
  alpha_vantage: {
    id: "alpha_vantage",
    label: "Alpha Vantage",
    shortCode: "AV",
    envKey: "ALPHA_VANTAGE_API_KEY",
    role: "analyst_target_specialist_news_fallback",
    provides: ["target", "news_fallback"],
    rateLimit: { window: "day", limit: 25 },
    /** Leave headroom for live family searches — Smart Refresh will not spend these. */
    smartRefreshReserve: 3,
    priority: { target: 1, news_fallback: 1 },
    notes:
      "OVERVIEW for analyst target (+ 52w extras). NEWS_SENTIMENT only when Marketaux fails.",
  },
  finnhub: {
    id: "finnhub",
    label: "Finnhub",
    shortCode: "FH",
    envKey: "FINNHUB_API_KEY",
    role: "peers_and_earnings_primary",
    provides: ["peers", "earnings"],
    rateLimit: { window: "minute", limit: 60, softCap: 50 },
    smartRefreshReserve: 0,
    priority: { peers: 1, earnings: 1 },
    notes:
      "Personal/non-commercial free tier. Scored /news-sentiment is blocked — probed monthly.",
  },
  marketaux: {
    id: "marketaux",
    label: "Marketaux",
    shortCode: "MX",
    envKey: "MARKETAUX_API_KEY",
    role: "news_primary",
    provides: ["news"],
    rateLimit: { window: "day", limit: 100 },
    smartRefreshReserve: 0,
    priority: { news: 1 },
  },
  gemini: {
    id: "gemini",
    label: "Gemini",
    shortCode: "AI",
    envKey: "GEMINI_API_KEY",
    role: "synthesis_default",
    provides: ["analysis"],
    rateLimit: { window: "day", limit: null },
    smartRefreshReserve: 0,
    priority: { analysis: 1 },
    notes:
      "Default automated synthesis (AI_PROVIDER=gemini). Daily limit tracked empirically.",
  },
  claude: {
    id: "claude",
    label: "Claude",
    shortCode: "CL",
    envKey: "ANTHROPIC_API_KEY",
    role: "manual_deeper_look_only",
    provides: ["analysis_manual"],
    rateLimit: { window: "day", limit: null },
    smartRefreshReserve: 0,
    priority: { analysis_manual: 1 },
    notes:
      "Paid credits — only via explicit per-stock Deeper Look. Never part of automated refresh.",
  },
};

/** Usage counter keys (api_usage.provider). */
const USAGE_KEYS = {
  twelve_data: "twelve_data",
  alpha_vantage: "alpha_vantage",
  finnhub: "finnhub",
  finnhub_rate_delay: "finnhub_rate_delay",
  marketaux: "marketaux",
  gemini: "gemini",
  claude: "claude",
};

function getSource(id) {
  return DATA_SOURCES[id] || null;
}

/** Full display name (logs, legend). */
function sourceLabel(id) {
  return DATA_SOURCES[id]?.label || (id ? String(id) : null);
}

/** Compact UI attribution code from the registry. */
function sourceShortCode(id) {
  if (!id) return null;
  return DATA_SOURCES[id]?.shortCode || sourceLabel(id);
}

/** Formal role string for status / docs. */
function sourceRole(id) {
  return DATA_SOURCES[id]?.role || null;
}

function hasSourceKey(id) {
  const src = DATA_SOURCES[id];
  if (!src?.envKey) return false;
  return Boolean(process.env[src.envKey]);
}

/** Sources that provide a capability, sorted by priority (lower = try first). */
function sourcesFor(capability) {
  return Object.values(DATA_SOURCES)
    .filter((s) => Array.isArray(s.provides) && s.provides.includes(capability))
    .sort(
      (a, b) =>
        (a.priority?.[capability] ?? 99) - (b.priority?.[capability] ?? 99)
    );
}

/** Enabled sources for a capability (env key present), priority order. */
function enabledSourcesFor(capability) {
  return sourcesFor(capability).filter((s) => hasSourceKey(s.id));
}

/** UI-facing joined short codes (e.g. "MX + AV"). */
function formatSourceList(ids) {
  const codes = (Array.isArray(ids) ? ids : [])
    .map((id) => sourceShortCode(id))
    .filter(Boolean);
  if (!codes.length) return null;
  return codes.join(" + ");
}

/** Smart Refresh reserve (calls left untouched for live searches). */
function smartRefreshReserve(id) {
  const n = Number(DATA_SOURCES[id]?.smartRefreshReserve);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Legend rows for the page footer — derived only from DATA_SOURCES so new
 * registry entries appear automatically with no UI edits.
 */
function sourcesLegend() {
  return Object.values(DATA_SOURCES).map((s) => ({
    id: s.id,
    shortCode: s.shortCode,
    label: s.label,
    role: s.role || null,
    smartRefreshReserve: smartRefreshReserve(s.id),
  }));
}

module.exports = {
  DATA_SOURCES,
  USAGE_KEYS,
  getSource,
  sourceLabel,
  sourceShortCode,
  sourceRole,
  hasSourceKey,
  sourcesFor,
  enabledSourcesFor,
  formatSourceList,
  sourcesLegend,
  smartRefreshReserve,
};
