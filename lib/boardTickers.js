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

/** Soft cap for archived names. Override with ARCHIVE_MAX_SIZE env. */
const ARCHIVE_MAX_SIZE = Math.max(
  1,
  Number.parseInt(process.env.ARCHIVE_MAX_SIZE || "40", 10) || 40
);

/** Fully remove archived picks untouched this many days. */
const ARCHIVE_RETENTION_DAYS = Math.max(
  1,
  Number.parseInt(process.env.ARCHIVE_RETENTION_DAYS || "90", 10) || 90
);

/** Statuses that count toward the live ("active") board cap. */
const LIVE_BOARD_STATUSES = ["recommended", "watch"];

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
  ARCHIVE_MAX_SIZE,
  ARCHIVE_RETENTION_DAYS,
  LIVE_BOARD_STATUSES,
  CANDIDATE_POOL_CAP,
  CANDIDATE_MISS_STREAK_LIMIT,
  DISCOVERY_PROMOTE_HARD_CAP,
  PENNY_PRICE_THRESHOLD,
  EXTREME_MOVE_PCT,
  MAJOR_EXCHANGE_PATTERNS,
  isMajorExchange,
  isPennyPrice,
  isExtremeMove,
};
