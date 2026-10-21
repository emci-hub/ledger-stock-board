/**
 * One compact stock row, shared by the GOD-Tier watchlist and the Beta page.
 * Callers pass already-decided text. This file does not score or sort.
 */
(function (root) {
  "use strict";

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function chip(flag) {
    const tone = flag && flag.tone ? " flag-" + String(flag.tone) : "";
    const title = flag && flag.title ? ' title="' + esc(flag.title) + '"' : "";
    return '<span class="status-pill' + tone + '"' + title + ">" + esc(flag.label) + "</span>";
  }

  function row(item) {
    const entry = item || {};
    const flags = Array.isArray(entry.flags) ? entry.flags.filter((flag) => flag && flag.label) : [];
    return (
      '<details class="compact-row">' +
      '<summary class="compact-main">' +
      '<span class="compact-who">' +
      '<span class="compact-mark" aria-hidden="true"></span>' +
      '<span class="compact-ticker">' +
      esc(entry.ticker || "—") +
      "</span>" +
      '<span class="compact-name">' +
      esc(entry.name || "") +
      "</span>" +
      "</span>" +
      '<span class="compact-meta">' +
      '<span class="compact-grade">' +
      esc(entry.grade || "—") +
      "</span>" +
      '<span class="compact-score">' +
      esc(entry.score || "—") +
      "</span>" +
      '<span class="compact-status">' +
      (entry.status ? '<span class="status-pill">' + esc(entry.status) + "</span>" : "") +
      "</span>" +
      '<span class="compact-flags">' +
      flags.map(chip).join("") +
      "</span>" +
      "</span>" +
      '<span class="compact-price">' +
      esc(entry.price || "") +
      "</span>" +
      "</summary>" +
      '<div class="compact-detail">' +
      (entry.detailHtml || "") +
      "</div>" +
      "</details>"
    );
  }

  function list(items) {
    const rows = Array.isArray(items) ? items : [];
    if (!rows.length) return '<p class="empty">No names in this list.</p>';
    return '<div class="compact-list">' + rows.map(row).join("") + "</div>";
  }

  root.CompactList = { list: list };
})(typeof window !== "undefined" ? window : this);
