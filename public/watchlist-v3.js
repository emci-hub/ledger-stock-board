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

  function compositeOf(stock) {
    const card = stock && stock.report_card;
    const value = card && card.composite;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  function halfSize(stock) {
    const value = stock && stock.size_mult;
    return typeof value === "number" && Number.isFinite(value) && value < 1;
  }

  function newsHold(stock) {
    return Boolean(stock && stock.news_hold === true);
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
    compositeOf,
    halfSize,
    newsHold,
    sortGod,
    partition,
  };
});
