/**
 * Display helpers for Practice Run accounts.
 *
 * The renderer must never drop an account id that arrived in the synced
 * document. PREFERRED_ORDER only sorts known names; anything else is appended
 * in the order it was synced.
 *
 * Used by the dashboard JS (copied into public/practice-lib.js as the same
 * functions) and by scripts/tests so the "never drop ids" rule can be checked
 * without a browser.
 */

const PREFERRED_ORDER = [
  "lt-watch",
  "us-swing",
  "ca-swing",
  "glb-branch",
  "lottery-us",
  "lottery-ca",
  "us-day",
  "ca-day",
];

/** A is the best letter on the long-term rubric; F is the worst. */
const WATCHLIST_GRADE_RANK = { A: 0, B: 1, C: 2, D: 3, F: 4 };

function isWatchlistAccount(account) {
  return String(account?.kind || "").toLowerCase() === "watchlist";
}

function watchlistItems(account) {
  const items = account?.watchlist?.items;
  return Array.isArray(items) ? items : [];
}

function topWatchlistGrade(items) {
  let best = null;
  let bestRank = Infinity;
  for (const item of items) {
    const letter = String(item?.grade || "")
      .trim()
      .charAt(0)
      .toUpperCase();
    const rank = WATCHLIST_GRADE_RANK[letter];
    if (rank == null || rank >= bestRank) continue;
    bestRank = rank;
    best = letter;
  }
  return best;
}

/** Scoreboard line for a watchlist account, e.g. "35 names · top grade A". */
function watchlistSummary(account) {
  const items = watchlistItems(account);
  const names = `${items.length} name${items.length === 1 ? "" : "s"}`;
  const top = topWatchlistGrade(items);
  return top ? `${names} · top grade ${top}` : names;
}

function sortAccountsForDisplay(accounts) {
  const list = Array.isArray(accounts) ? accounts.filter(Boolean) : [];
  const rank = new Map(PREFERRED_ORDER.map((id, i) => [id, i]));
  return list
    .map((account, index) => ({ account, index }))
    .sort((a, b) => {
      const idA = String(a.account.id || "");
      const idB = String(b.account.id || "");
      const rankA = rank.has(idA) ? rank.get(idA) : 1000 + a.index;
      const rankB = rank.has(idB) ? rank.get(idB) : 1000 + b.index;
      return rankA - rankB;
    })
    .map((row) => row.account);
}

function isAccountPaused(account) {
  if (!account) return false;
  if (account.paused === true) return true;
  return String(account.status || "").toLowerCase() === "paused";
}

function isSwingAccount(account) {
  const id = String(account?.id || "").toLowerCase();
  const name = String(account?.name || "").toLowerCase();
  const label = String(account?.label || "").toLowerCase();
  return id.includes("swing") || name.includes("swing") || label.includes("swing");
}

module.exports = {
  PREFERRED_ORDER,
  sortAccountsForDisplay,
  isAccountPaused,
  isSwingAccount,
  isWatchlistAccount,
  watchlistSummary,
};
