/**
 * God-tier v3 watchlist view model. No prices are invented here.
 * The page renders this shape; node tests require the same file.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WatchlistV3 = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const GRADE_FIELDS = [
    ["health", "Health"],
    ["trajectory", "Trajectory"],
    ["runway", "Runway"],
    ["risks", "Risks"],
    ["response", "Response"],
  ];
  const SIGNAL_FIELDS = [
    ["insider", "Insider buying and selling"],
    ["buybacks", "Buybacks"],
    ["short_interest", "Short interest"],
    ["estimate_revisions", "Estimate revisions"],
  ];

  function isV3(watchlist) {
    if (!watchlist || watchlist.version == null) return false;
    return String(watchlist.version).trim().toLowerCase().startsWith("v3");
  }

  function statusKey(stock) {
    return String((stock && stock.status) || "")
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, "-");
  }

  function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function overallGrade(stock) {
    const overall = stock && stock.report_card && stock.report_card.overall;
    if (overall == null || overall === "") return "";
    if (typeof overall === "string" || typeof overall === "number") return String(overall).trim();
    if (typeof overall === "object" && overall.grade != null) return String(overall.grade).trim();
    return "";
  }

  function compositeOf(stock) {
    const card = stock && stock.report_card;
    if (!card || typeof card !== "object") return null;
    if (isFiniteNumber(card.composite)) return card.composite;
    const overall = card.overall;
    if (overall && typeof overall === "object") {
      if (isFiniteNumber(overall.composite_0_100)) return overall.composite_0_100;
      if (isFiniteNumber(overall.composite)) return overall.composite;
    }
    return null;
  }

  function halfSize(stock) {
    const value = stock && stock.size_mult;
    return typeof value === "number" && Number.isFinite(value) && value < 1;
  }

  function holdFlag(value) {
    if (value === true) return true;
    return Boolean(value && typeof value === "object" && value.on === true);
  }

  function newsHold(stock) {
    if (!stock) return false;
    if (holdFlag(stock.news_hold)) return true;
    const card = stock.report_card;
    return Boolean(card && typeof card === "object" && holdFlag(card.news_hold));
  }

  function newsOf(stock) {
    const direct = stock && stock.news;
    const ctx = stock && stock.report_card && stock.report_card.news_context;
    const block = direct && typeof direct === "object" ? direct : ctx && typeof ctx === "object" ? ctx : {};
    const log = Array.isArray(block.log) ? block.log : Array.isArray(block.news_log) ? block.news_log : [];
    return {
      macro_tags: Array.isArray(block.macro_tags) ? block.macro_tags : [],
      log,
      catalysts: Array.isArray(block.catalysts) ? block.catalysts : [],
      signals: block.signals && typeof block.signals === "object" ? block.signals : {},
    };
  }

  function watchNextOf(stock) {
    const card = stock && stock.report_card;
    if (!card || typeof card !== "object") return [];
    if (Array.isArray(card.watch_next)) {
      return card.watch_next.map((item) => String(item || "").trim()).filter(Boolean);
    }
    if (typeof card.watch_next_quarter === "string" && card.watch_next_quarter.trim()) {
      return [card.watch_next_quarter.trim()];
    }
    return [];
  }

  function byTicker(a, b) {
    return String((a && a.ticker) || "").localeCompare(String((b && b.ticker) || ""));
  }

  function sortGod(stocks) {
    return stocks.slice().sort((a, b) => {
      const left = compositeOf(a);
      const right = compositeOf(b);
      if (left == null && right == null) return byTicker(a, b);
      if (left == null) return 1;
      if (right == null) return -1;
      if (right !== left) return right - left;
      return byTicker(a, b);
    });
  }

  /**
   * God-tier names first, by composite. Watch-only stays in its own list.
   * Any other status is returned separately so the page can still show it.
   */
  function partition(watchlist) {
    const stocks = watchlist && Array.isArray(watchlist.stocks) ? watchlist.stocks.filter(Boolean) : [];
    const god = [];
    const watchOnly = [];
    const other = [];
    stocks.forEach((stock) => {
      const key = statusKey(stock);
      if (key === "god") god.push(stock);
      else if (key === "watch-only") watchOnly.push(stock);
      else other.push(stock);
    });
    return {
      god: sortGod(god),
      watchOnly: watchOnly.slice().sort(byTicker),
      other: other.slice().sort(byTicker),
    };
  }

  return {
    GRADE_FIELDS,
    SIGNAL_FIELDS,
    isV3,
    statusKey,
    overallGrade,
    compositeOf,
    halfSize,
    newsHold,
    newsOf,
    watchNextOf,
    sortGod,
    partition,
  };
});
