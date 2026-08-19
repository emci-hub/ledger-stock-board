/**
 * Board universe config: seed tickers + configurable live-board cap.
 * Seed list is the starting family set; discovery may grow the live board
 * up to BOARD_MAX_SIZE, archiving (never deleting) overflow.
 *
 * Three explicit tiers on board_picks.status:
 *   candidate  — cheap FMP signal only (not on the public board)
 *   live       — recommended | watch  (public board / "active")
 *   archived   — previously live, retained off-board
 */

const BOARD_TICKERS = [
  "AAPL",
  "MSFT",
  "JNJ",
  "UNH",
  "KO",
  "PG",
  "JPM",
  "V",
];

/** Live board cap (recommended + watch). Override with BOARD_MAX_SIZE env. */
const BOARD_MAX_SIZE = Math.max(
  1,
  Number.parseInt(process.env.BOARD_MAX_SIZE || "15", 10) || 15
);

/** NEW (2026-08-19) — per-CATEGORY live cap (Long/Short/Penny each capped
 * independently), replacing reliance on the old global BOARD_MAX_SIZE for
 * capacity enforcement. BOARD_MAX_SIZE itself is left untouched (still read
 * by 5 other files) to avoid any regression risk — this is an additive,
 * separately-named constant. Default 15/category, per explicit decision. */
const SECTION_MAX_SIZE = Math.max(
  1,
  Number.parseInt(process.env.SECTION_MAX_SIZE || "15", 10) || 15
);

/** Soft cap for archived names. Override with ARCHIVE_MAX_SIZE env.
 * Raised from 40 to 200 (2026-08-16) — archived tickers are never
 * force-refreshed daily (getActiveBoardTickers only pulls live status),
 * so this costs storage only, not API quota. Growing it keeps far more
 * already-analyzed history visible on the public board instead of being
 * purged, directly increasing Long/Short/Penny display totals. */
const ARCHIVE_MAX_SIZE = Math.max(
  1,
  Number.parseInt(process.env.ARCHIVE_MAX_SIZE || "200", 10) || 200
);

/** Synthetic promotion-strength boost for factor-sourced (USMV/QUAL/MTUM)
 * candidates, scaled by their real published rank: boost = CAP - rank*TAPER,
 * floored at 0. Was hardcoded (40, 0.3) — moved here so it can be tuned
 * without a code change, matching every other threshold in this file. */
const FACTOR_BOOST_CAP = Math.max(
  0,
  Number.parseFloat(process.env.FACTOR_BOOST_CAP || "40") || 40
);
const FACTOR_BOOST_TAPER = Math.max(
  0,
  Number.parseFloat(process.env.FACTOR_BOOST_TAPER || "0.3") || 0.3
);

/** Fully remove archived picks untouched this many days. */
const ARCHIVE_RETENTION_DAYS = Math.max(
  1,
  Number.parseInt(process.env.ARCHIVE_RETENTION_DAYS || "90", 10) || 90
);

/** Statuses that count toward the live ("active") board cap. */
const LIVE_BOARD_STATUSES = ["recommended", "watch"];

/**
 * Statuses shown on the public board (/api/board), organized by boardSection.
 * Includes archived (e.g. seed core names bumped off by discovery).
 * Excludes Stage-1 candidates (FMP signal only, no full report).
 */
const BOARD_DISPLAY_STATUSES = ["recommended", "watch", "archived"];

/** Candidate pool soft cap (Stage 1 FMP signals). */
const CANDIDATE_POOL_CAP = Math.max(
  50,
  Number.parseInt(process.env.CANDIDATE_POOL_CAP || "300", 10) || 300
);

/** Delete candidates missing from FMP for this many consecutive discovery runs. */
const CANDIDATE_MISS_STREAK_LIMIT = Math.max(
  1,
  Number.parseInt(process.env.CANDIDATE_MISS_STREAK_LIMIT || "3", 10) || 3
);

/**
 * Optional hard ceiling on Stage 2 promotions.
 * 0 / unset = no hard cap (resource-bound only). Legacy DISCOVERY_MAX_NEW still honored if set.
 */
const DISCOVERY_PROMOTE_HARD_CAP = Math.max(
  0,
  Number.parseInt(process.env.DISCOVERY_MAX_NEW || "0", 10) || 0
);

/** board_picks.source for FMP movers Stage 1. */
const DISCOVERY_MOVERS_SOURCE = "discovery";

/** board_picks.source for Twelve Data universe Stage 1b. */
const DISCOVERY_UNIVERSE_SOURCE = "discovery_universe";

/** How many major-exchange universe symbols to upsert as candidates per discovery run. */
const UNIVERSE_CANDIDATE_BATCH = Math.max(
  1,
  Number.parseInt(process.env.UNIVERSE_CANDIDATE_BATCH || "50", 10) || 50
);

/**
 * Soft promote floor for universe-sourced candidates inside maxPromote:
 * U = min(UNIVERSE_PROMOTE_FLOOR_MAX, max(0, maxPromote - UNIVERSE_PROMOTE_GENERAL_RESERVE)).
 */
const UNIVERSE_PROMOTE_FLOOR_MAX = Math.max(
  0,
  Number.parseInt(process.env.UNIVERSE_PROMOTE_FLOOR_MAX || "5", 10) || 5
);

/** Seats kept for general/movers before the universe floor is carved out. */
const UNIVERSE_PROMOTE_GENERAL_RESERVE = Math.max(
  0,
  Number.parseInt(process.env.UNIVERSE_PROMOTE_GENERAL_RESERVE || "3", 10) || 3
);

/** Max age of discovery_universe cache before Stage 0 re-fetches Twelve Data /stocks. */
const UNIVERSE_REFRESH_MAX_AGE_MS = Math.max(
  60 * 60 * 1000,
  Number.parseInt(
    process.env.UNIVERSE_REFRESH_MAX_AGE_MS || `${24 * 60 * 60 * 1000}`,
    10
  ) || 24 * 60 * 60 * 1000
);

/** Exchanges kept in the universe working set (TD `exchange` field). */
const UNIVERSE_MAJOR_EXCHANGES = Object.freeze(
  String(process.env.UNIVERSE_MAJOR_EXCHANGES || "NASDAQ,NYSE")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
);

const UNIVERSE_CURSOR_SETTING_KEY = "discovery_universe_cursor";
const UNIVERSE_FETCHED_AT_SETTING_KEY = "discovery_universe_fetched_at";

function universePromoteFloor(maxPromote) {
  const max = Math.max(0, Number(maxPromote) || 0);
  return Math.min(
    UNIVERSE_PROMOTE_FLOOR_MAX,
    Math.max(0, max - UNIVERSE_PROMOTE_GENERAL_RESERVE)
  );
}

/** Penny-stock flag threshold (USD). Flagged, not dropped. */
const PENNY_PRICE_THRESHOLD = 5;

/** Extreme same-day % move warning threshold (absolute). Flagged, not dropped. */
const EXTREME_MOVE_PCT = Math.max(
  5,
  Number.parseFloat(process.env.EXTREME_MOVE_PCT || "15") || 15
);

/**
 * Major US exchanges — anything else is flagged non_major_exchange (kept as candidate).
 * FMP may return variants like "NASDAQ", "New York Stock Exchange", "NYSE Arca".
 */
const MAJOR_EXCHANGE_PATTERNS = [
  /^NYSE$/i,
  /^NASDAQ$/i,
  /^AMEX$/i,
  /^NYSE\s*ARCA$/i,
  /^BATS$/i,
  /^CBOE$/i,
  /NEW YORK STOCK EXCHANGE/i,
  /NASDAQ/i,
  /NYSE/i,
  /AMERICAN STOCK EXCHANGE/i,
];

function isMajorExchange(exchange) {
  const s = String(exchange || "").trim();
  if (!s) return false;
  return MAJOR_EXCHANGE_PATTERNS.some((re) => re.test(s));
}

function isPennyPrice(price) {
  const n = Number(price);
  return Number.isFinite(n) && n > 0 && n < PENNY_PRICE_THRESHOLD;
}

function isExtremeMove(percentChange) {
  const n = Number(percentChange);
  return Number.isFinite(n) && Math.abs(n) >= EXTREME_MOVE_PCT;
}

module.exports = {
  BOARD_TICKERS,
  BOARD_MAX_SIZE,
  SECTION_MAX_SIZE,
  ARCHIVE_MAX_SIZE,
  FACTOR_BOOST_CAP,
  FACTOR_BOOST_TAPER,
  ARCHIVE_RETENTION_DAYS,
  LIVE_BOARD_STATUSES,
  BOARD_DISPLAY_STATUSES,
  CANDIDATE_POOL_CAP,
  CANDIDATE_MISS_STREAK_LIMIT,
  DISCOVERY_PROMOTE_HARD_CAP,
  DISCOVERY_MOVERS_SOURCE,
  DISCOVERY_UNIVERSE_SOURCE,
  UNIVERSE_CANDIDATE_BATCH,
  UNIVERSE_PROMOTE_FLOOR_MAX,
  UNIVERSE_PROMOTE_GENERAL_RESERVE,
  UNIVERSE_REFRESH_MAX_AGE_MS,
  UNIVERSE_MAJOR_EXCHANGES,
  UNIVERSE_CURSOR_SETTING_KEY,
  UNIVERSE_FETCHED_AT_SETTING_KEY,
  universePromoteFloor,
  PENNY_PRICE_THRESHOLD,
  EXTREME_MOVE_PCT,
  MAJOR_EXCHANGE_PATTERNS,
  isMajorExchange,
  isPennyPrice,
  isExtremeMove,
};
