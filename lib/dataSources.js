/**
 * Central registry of external data sources.
 * Adding a provider = one entry here + a fetcher registered in services/dataFetch.js.
 * UI short codes and the footer legend both come from this registry.
 */

const DATA_SOURCES = {
  twelve_data: {
    id: "twelve_data",
    label: "Twelve Data",
    shortCode: "TD",
    envKey: "TWELVE_DATA_API_KEY",
    provides: ["price", "target"],
    rateLimit: { window: "day", limit: 800 },
    priority: { price: 1, target: 1 },
  },
  alpha_vantage: {
    id: "alpha_vantage",
    label: "Alpha Vantage",
    shortCode: "AV",
    envKey: "ALPHA_VANTAGE_API_KEY",
    provides: ["price", "target", "news", "overview"],
    rateLimit: { window: "day", limit: 25 },
    priority: { price: 2, target: 2, news: 1, overview: 1 },
  },
  finnhub: {
    id: "finnhub",
    label: "Finnhub",
    shortCode: "FH",
    envKey: "FINNHUB_API_KEY",
    provides: ["news", "peers"],
    rateLimit: { window: "minute", limit: 60, softCap: 50 },
    priority: { news: 3, peers: 1 },
  },
  marketaux: {
    id: "marketaux",
    label: "Marketaux",
    shortCode: "MX",
    envKey: "MARKETAUX_API_KEY",
    provides: ["news"],
    rateLimit: { window: "day", limit: 100 },
    priority: { news: 2 },
  },
  gemini: {
    id: "gemini",
    label: "Gemini",
    shortCode: "AI",
    envKey: "GEMINI_API_KEY",
    provides: ["analysis"],
    rateLimit: { window: "day", limit: null },
    priority: { analysis: 1 },
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

/**
 * Legend rows for the page footer — derived only from DATA_SOURCES so new
 * registry entries appear automatically with no UI edits.
 */
function sourcesLegend() {
  return Object.values(DATA_SOURCES).map((s) => ({
    id: s.id,
    shortCode: s.shortCode,
    label: s.label,
  }));
}

module.exports = {
  DATA_SOURCES,
  USAGE_KEYS,
  getSource,
  sourceLabel,
  sourceShortCode,
  hasSourceKey,
  sourcesFor,
  enabledSourcesFor,
  formatSourceList,
  sourcesLegend,
};
