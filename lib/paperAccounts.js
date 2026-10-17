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
  "ca-swing",
  "glb-branch",
  "lottery-us",
  "lottery-ca",
  "us-ghost",
  "ghost-orig",
  "momentum",
  "baseline",
  "us-day",
  "ca-day",
];

/** Shelved account. Still shown when the snapshot carries it, always last. */
const SHELVED_LAST_ID = "us-swing";

/**
 * Display names that replace a stale snapshot name. The stored document is
 * left as synced; only the page label changes.
 */
const DISPLAY_NAMES = {
  "us-day": "US Long-Term v5",
  [SHELVED_LAST_ID]: "US Swing (shelved)",
};

/** Lab accounts whose missing value means the run has not started yet. */
const LAB_VALUE_IDS = new Set([
  "ghost-orig",
  "us-ghost",
  "ghost-fixed",
  "momentum",
  "baseline",
  "us-day",
]);

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
 * Benchmark line for a watchlist card. Missing value and return stay a dash,
 * so a null SPY level renders as "SPY —" rather than "SPY 0 / 0%".
 */
function watchlistBenchmarkLine(account) {
  const bench = account?.benchmark || {};
  const ticker = String(bench.ticker || "").trim();
  const hasValue = finiteMark(bench.value);
  const hasReturn = finiteMark(bench.returnPct);
  if (!hasValue && !hasReturn) return ticker ? `${ticker} —` : "—";
  const valueText = hasValue ? formatMarkNumber(bench.value) : "—";
  const returnText = hasReturn ? `${formatMarkNumber(bench.returnPct)}%` : "—";
  return `${ticker ? `${ticker} ` : ""}${valueText} / ${returnText}`;
}

function sortAccountsForDisplay(accounts) {
  const list = Array.isArray(accounts) ? accounts.filter(Boolean) : [];
  const rank = new Map(PREFERRED_ORDER.map((id, i) => [id, i]));
  return list
    .map((account, index) => ({ account, index }))
    .sort((a, b) => {
      const idA = String(a.account.id || "");
      const idB = String(b.account.id || "");
      const lastA = idA === SHELVED_LAST_ID;
      const lastB = idB === SHELVED_LAST_ID;
      if (lastA !== lastB) return lastA ? 1 : -1;
      const rankA = rank.has(idA) ? rank.get(idA) : 1000 + a.index;
      const rankB = rank.has(idB) ? rank.get(idB) : 1000 + b.index;
      return rankA - rankB;
    })
    .map((row) => row.account);
}

function isAccountPaused(account) {
  if (!account) return false;
  // us-day is the frozen US Long-Term v5 book. A leftover "paused" flag
  // from the old day-trade label does not mark it paused.
  if (String(account.id || "") === "us-day") return false;
  if (account.paused === true) return true;
  return String(account.status || "").toLowerCase() === "paused";
}

function displayName(account) {
  const id = String(account?.id || "");
  if (DISPLAY_NAMES[id]) return DISPLAY_NAMES[id];
  return account?.name || account?.id || "Account";
}

function displayLabel(account) {
  const id = String(account?.id || "");
  if (DISPLAY_NAMES[id]) return "";
  if (account?.label && account.label !== account.name) return account.label;
  return "";
}

function displayStatus(account) {
  if (String(account?.id || "") === SHELVED_LAST_ID) return "shelved";
  if (isAccountPaused(account)) return "paused";
  return "active";
}

/** Phrase for a missing account value. Lab rows wait for the next sync. */
function missingValueLabel(account) {
  if (LAB_VALUE_IDS.has(String(account?.id || ""))) return "Starts at next sync";
  return "unavailable";
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
  isAccountPaused,
  isSwingAccount,
  isWatchlistAccount,
  watchlistSummary,
  watchlistBenchmarkLine,
  displayName,
  displayLabel,
  displayStatus,
  missingValueLabel,
};
