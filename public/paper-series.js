/**
 * Date order for paper marks. A backtest curve starts in July and runs
 * through October, so points must be drawn from earliest date to latest,
 * even when the snapshot lists a new day first.
 *
 * Browser: window.PaperSeries. Node tests: module.exports.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PaperSeries = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function isNum(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function dayKey(value) {
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value || ""));
    return match ? match[1] : "";
  }

  /** Marks that have a numeric value, earliest date first. Undated rows stay at the end, in input order. */
  function orderedMarks(points) {
    const rows = (Array.isArray(points) ? points : []).filter((point) => point && isNum(point.value));
    return rows
      .map((point, index) => ({ point, index, day: dayKey(point.date) }))
      .sort((a, b) => {
        if (a.day && b.day && a.day !== b.day) return a.day < b.day ? -1 : 1;
        if (a.day && !b.day) return -1;
        if (!a.day && b.day) return 1;
        return a.index - b.index;
      })
      .map((row) => row.point);
  }

  function spanDays(points) {
    const rows = orderedMarks(points);
    if (rows.length < 2) return 0;
    const start = Date.parse(`${dayKey(rows[0].date)}T00:00:00Z`);
    const end = Date.parse(`${dayKey(rows[rows.length - 1].date)}T00:00:00Z`);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
    return Math.round((end - start) / 86400000);
  }

  /** Trades newest first. ISO dates sort correctly, including July before October. */
  function orderedTrades(trades) {
    const rows = Array.isArray(trades) ? trades.filter(Boolean) : [];
    return rows
      .map((trade, index) => ({ trade, index }))
      .sort((a, b) => {
        const da = `${dayKey(a.trade.date) || "0000-00-00"} ${a.trade.time || ""}`;
        const db = `${dayKey(b.trade.date) || "0000-00-00"} ${b.trade.time || ""}`;
        if (da !== db) return da < db ? 1 : -1;
        return b.index - a.index;
      })
      .map((row) => row.trade);
  }

  return { isNum, dayKey, orderedMarks, spanDays, orderedTrades };
});
