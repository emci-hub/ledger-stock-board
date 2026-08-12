/**
 * Deterministic data-limitation caveats for the board UI.
 * Driven by real report fields — not by parsing AI text.
 * Add new caveats here only; cards/Deep Dive loop this list.
 */

const DATA_CAVEATS = {
  limited_history: {
    id: "limited_history",
    label: "Limited history",
    icon: "ⓘ",
    tooltip:
      "Limited historical data — there isn't enough trading history yet for a reliable 200-day average.",
    place: "sparkline",
  },
  no_analyst_target: {
    id: "no_analyst_target",
    label: "No target",
    icon: "ⓘ",
    tooltip:
      "No published analyst 12-month price target is available for this ticker right now.",
    place: "target",
  },
  no_news: {
    id: "no_news",
    label: "No news",
    icon: "ⓘ",
    tooltip:
      "News sentiment isn't available yet for this ticker — analysis leans on price and other fields only.",
    place: "summary",
  },
  no_peers: {
    id: "no_peers",
    label: "No peers",
    icon: "ⓘ",
    tooltip:
      "A peer comparison list isn't available for this ticker yet.",
    place: "peers",
  },
  no_52w_range: {
    id: "no_52w_range",
    label: "No 52w range",
    icon: "ⓘ",
    tooltip:
      "A 52-week high/low range isn't available yet from overview or price history.",
    place: "range",
  },
};

function readSma200(indicators) {
  if (!indicators || typeof indicators !== "object") return null;
  if (indicators.long) return readSma200(indicators.long);
  const raw =
    indicators.sma?.sma200 != null ? indicators.sma.sma200 : indicators.sma200;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Derive active caveats from report fields (and optional shared long indicators).
 * @param {object} report
 * @param {object} [options]
 * @param {object} [options.sharedIndicators] - full quote.indicators ({short,long} or flat)
 */
function deriveDataCaveats(report, options = {}) {
  if (!report || typeof report !== "object") return [];

  const active = [];
  const shared = options.sharedIndicators || report.indicators;
  const sma200 = readSma200(shared) ?? readSma200(report.indicators);
  const hasPrice =
    report.price != null ||
    (Array.isArray(report.priceHistory) && report.priceHistory.length > 0);

  if (hasPrice && sma200 == null) {
    active.push(DATA_CAVEATS.limited_history);
  }

  if (
    report.analystTarget == null ||
    !Number.isFinite(Number(report.analystTarget))
  ) {
    active.push(DATA_CAVEATS.no_analyst_target);
  }

  const newsSources = Array.isArray(report.newsSources)
    ? report.newsSources
    : [];
  if (report.newsPending || newsSources.length === 0) {
    active.push(DATA_CAVEATS.no_news);
  }

  const peers = Array.isArray(report.peers) ? report.peers : [];
  if (!peers.length) {
    active.push(DATA_CAVEATS.no_peers);
  }

  const wr = report.weekRange;
  if (wr?.low == null || wr?.high == null) {
    active.push(DATA_CAVEATS.no_52w_range);
  }

  return active.map((c) => ({
    id: c.id,
    label: c.label,
    icon: c.icon,
    tooltip: c.tooltip,
    place: c.place,
  }));
}

function dataCaveatsCatalog() {
  return Object.values(DATA_CAVEATS).map((c) => ({
    id: c.id,
    label: c.label,
    icon: c.icon,
    tooltip: c.tooltip,
    place: c.place,
  }));
}

module.exports = {
  DATA_CAVEATS,
  deriveDataCaveats,
  dataCaveatsCatalog,
  readSma200,
};
