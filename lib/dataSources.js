/**
 * Central registry of external data sources.
 * Adding a provider = one entry here + a fetcher registered in services/dataFetch.js.
 * UI short codes, footer legend, and /dev-status usage all come from this registry.
 *
 * Formal roles (family board, free/personal tiers):
 * - Twelve Data: primary price + indicators (≈800/day).
 *   price_target / profile are Grow-plan-only — not used for live target.
 *   market_movers is paid-tier — discovery uses FMP instead.
 * - FMP (Financial Modeling Prep): primary discovery/movers (free ≈250/day).
 * - Alpha Vantage: analyst target (OVERVIEW) + parallel NEWS_SENTIMENT with Marketaux
 *   (board-batched to 1 call / refresh; cheap enough to keep as a real second news source).
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
    role: "price_indicators_primary",
    provides: ["price", "indicators"],
    rateLimit: { window: "day", limit: 800 },
    smartRefreshReserve: 0,
    priority: { price: 1, indicators: 1 },
    notes:
      "Primary price + indicators (≈800/day). Grow-only price_target/profile not used live. market_movers paid — discovery movers use FMP. /stocks US Common Stock list feeds discovery_universe (cached daily; 1 credit when refreshed).",
  },
  fmp: {
    id: "fmp",
    label: "Financial Modeling Prep",
    shortCode: "FMP",
    envKey: "FMP_API_KEY",
    role: "discovery_primary",
    provides: ["discovery", "identity"],
    rateLimit: { window: "day", limit: 250 },
    /** Leave headroom for live Discovery / probes — Smart Refresh does not spend FMP today. */
    smartRefreshReserve: 10,
    priority: { discovery: 1, identity: 2 },
    notes:
      "Free-tier biggest-gainers / biggest-losers / most-actives via /stable/*. /stable/profile fills company name/sector/description on promotion catch-up. Confirmed live on free plan.",
    legendDetail: "Financial Modeling Prep (discovery movers + identity)",
  },
  alpha_vantage: {
    id: "alpha_vantage",
    label: "Alpha Vantage",
    shortCode: "AV",
    envKey: "ALPHA_VANTAGE_API_KEY",
    role: "analyst_target_and_parallel_news",
    provides: ["target", "news"],
    rateLimit: { window: "day", limit: 25 },
    /** Leave headroom for live family searches — Smart Refresh will not spend these. */
    smartRefreshReserve: 3,
    priority: { target: 1, news: 2 },
    notes:
      "OVERVIEW for analyst target (+ 52w extras). NEWS_SENTIMENT runs in parallel with Marketaux; board refresh batches all live tickers into one NEWS_SENTIMENT call.",
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
    notes:
      "Primary scored news. Board refresh batches all live tickers into one /news/all call.",
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
    /** Footer legend text after "AI = …" (falls back to label when absent). */
    legendDetail: "Gemini (automatic analysis)",
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
    legendDetail: "Claude (available on request via Deeper Look)",
  },
};

/** Usage counter keys (api_usage.provider). */
const USAGE_KEYS = {
  twelve_data: "twelve_data",
  twelve_data_rate_delay: "twelve_data_rate_delay",
  fmp: "fmp",
  alpha_vantage: "alpha_vantage",
  finnhub: "finnhub",
  finnhub_rate_delay: "finnhub_rate_delay",
  marketaux: "marketaux",
  gemini: "gemini",
  gemini_rate_delay: "gemini_rate_delay",
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

/** Smart Refresh / Discovery reserve (calls left untouched for live searches). */
function smartRefreshReserve(id) {
  const n = Number(DATA_SOURCES[id]?.smartRefreshReserve);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Legend rows for the page footer — derived only from DATA_SOURCES so new
 * registry entries appear automatically with no UI edits.
 * AI providers include legendDetail for public "AI = Gemini (automatic…)" copy.
 */
function sourcesLegend() {
  return Object.values(DATA_SOURCES).map((s) => ({
    id: s.id,
    shortCode: s.shortCode,
    label: s.label,
    /** Prefer legendDetail when set (AI blurbs); else the plain label. */
    legendLabel: s.legendDetail || s.label,
    role: s.role || null,
    smartRefreshReserve: smartRefreshReserve(s.id),
  }));
}

/**
 * Static registry rows for usage tables (used/limit filled by callers).
 * Keeps /dev-status and public header usage driven by DATA_SOURCES only.
 */
function sourcesRegistryRows() {
  return Object.values(DATA_SOURCES).map((s) => ({
    id: s.id,
    shortCode: s.shortCode,
    label: s.label,
    role: s.role || null,
    limit: s.rateLimit?.limit ?? null,
    window: s.rateLimit?.window || null,
    smartRefreshReserve: smartRefreshReserve(s.id),
    configured: hasSourceKey(s.id),
    notes: s.notes || null,
    legendLabel: s.legendDetail || s.label,
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
  sourcesRegistryRows,
  smartRefreshReserve,
};
