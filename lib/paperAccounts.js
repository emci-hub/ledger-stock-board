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

const groups = require("../public/account-groups");

/** Known ids, in section order. Built from public/account-groups.js. */
const PREFERRED_ORDER = groups.preferredOrder();

/** Shelved account. Still shown when the snapshot carries it, inside Older experiments. */
const SHELVED_LAST_ID = "us-swing";

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

function finiteMark(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function formatMarkNumber(value) {
  const rounded = Math.round(value * 100) / 100;
  return String(rounded);
}

/**
 * Benchmark line for a watchlist card. A missing level is omitted, so the
 * card does not print "SPY —". A real zero still prints.
 */
function watchlistBenchmarkLine(account) {
  const bench = account?.benchmark || {};
  const ticker = String(bench.ticker || "").trim();
  const hasValue = finiteMark(bench.value);
  const hasReturn = finiteMark(bench.returnPct);
  if (!hasValue && !hasReturn) return "";
  const valueText = hasValue ? formatMarkNumber(bench.value) : "—";
  const returnText = hasReturn ? `${formatMarkNumber(bench.returnPct)}%` : "—";
  return `${ticker ? `${ticker} ` : ""}${valueText} / ${returnText}`;
}

function sortAccountsForDisplay(accounts) {
  return groups.sortAccountsForDisplay(accounts);
}

function isAccountPaused(account) {
  if (!account) return false;
  const profile = groups.profileFor(account.id);
  if (profile && profile.neverPaused) return false;
  if (account.paused === true) return true;
  return String(account.status || "").toLowerCase() === "paused";
}

function displayName(account) {
  return groups.displayName(account);
}

function displayLabel(account) {
  if (groups.profileFor(account && account.id)) return "";
  if (account?.label && account.label !== account.name) return account.label;
  return "";
}

function displayStatus(account) {
  const profile = groups.profileFor(account && account.id);
  if (profile && profile.shelved) return "shelved";
  if (isAccountPaused(account)) return "paused";
  return "active";
}

/** A missing account value is waiting for a later sync, not a broken number. */
function missingValueLabel() {
  return "Starts at next sync";
}

function isSwingAccount(account) {
  const id = String(account?.id || "").toLowerCase();
  const name = String(account?.name || "").toLowerCase();
  const label = String(account?.label || "").toLowerCase();
  return id.includes("swing") || name.includes("swing") || label.includes("swing");
}

module.exports = {
  PREFERRED_ORDER,
  SHELVED_LAST_ID,
  sortAccountsForDisplay,
  groupAccounts: groups.groupAccounts,
  isAccountPaused,
  isSwingAccount,
  isWatchlistAccount,
  watchlistSummary,
  watchlistBenchmarkLine,
  displayName,
  displayLabel,
  displayStatus,
  missingValueLabel,
  accountBlurb(account) {
    return groups.blurbFor(account && account.id);
  },
};
