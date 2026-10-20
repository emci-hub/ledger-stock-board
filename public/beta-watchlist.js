/**
 * Beta watchlist order and flag labels. Numbers come from the Oct 19 file.
 * Shared by the page and by node tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BetaWatchlist = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const FLAG_LABELS = {
    eject: "Eject review",
    promotion: "Promotion candidate, not promoted",
    upgraded: "Upgraded C to B",
  };

  function ranked(doc) {
    const names = doc && Array.isArray(doc.names) ? doc.names.filter(Boolean) : [];
    return names.slice().sort((a, b) => {
      const left = typeof a.rank === "number" && Number.isFinite(a.rank) ? a.rank : 999;
      const right = typeof b.rank === "number" && Number.isFinite(b.rank) ? b.rank : 999;
      if (left !== right) return left - right;
      return String(a.ticker || "").localeCompare(String(b.ticker || ""));
    });
  }

  function flagLabel(flag) {
    const key = String(flag || "");
    return FLAG_LABELS[key] || key;
  }

  function flagsFor(row) {
    const flags = row && Array.isArray(row.flags) ? row.flags : [];
    return flags.map(flagLabel).filter(Boolean);
  }

  return { FLAG_LABELS, ranked, flagLabel, flagsFor };
});
