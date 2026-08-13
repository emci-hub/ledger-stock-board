/**
 * Board universe config: seed tickers + configurable live-board cap.
 * Seed list is the starting family set; discovery may grow the live board
 * up to BOARD_MAX_SIZE, archiving (never deleting) overflow.
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

/** Statuses that count toward the live board cap. */
const LIVE_BOARD_STATUSES = ["recommended", "watch"];

module.exports = {
  BOARD_TICKERS,
  BOARD_MAX_SIZE,
  LIVE_BOARD_STATUSES,
};
