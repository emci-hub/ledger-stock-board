/**
 * Drop math for the long-term screen, per stock-alert-spec.md:
 *
 *   - at least 10% below the 63-trading-day high, OR
 *   - at least 5% down from the T-1 close to the worst close through T+5
 *     after the dated event.
 *
 * Both numbers are always computed and reported together (spec: "write both
 * numbers"); the caller decides which threshold, if any, was crossed.
 *
 * Inputs are plain { date: 'YYYY-MM-DD', close: number } arrays of PRIMARY
 * closes (never TRADE) — order is not assumed, these functions sort defensively.
 */

const HIGH_WINDOW_BARS = 63;
const EVENT_WINDOW_TRADING_DAYS = 5;
const HIGH_DROP_THRESHOLD_PCT = 10;
const EVENT_DROP_THRESHOLD_PCT = 5;

function sortedByDate(closes) {
  return [...closes]
    .filter((c) => c && c.date && Number.isFinite(c.close))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * % below the trailing 63-trading-day high, using the most recent close as
 * "now." Positive pctBelowHigh means below the high; 0 or negative means at
 * or above it.
 */
function compute63DayHigh(closes) {
  const bars = sortedByDate(closes);
  if (bars.length === 0) {
    return {
      windowHigh: null,
      windowHighDate: null,
      latestClose: null,
      latestDate: null,
      windowBars: 0,
      sufficientHistory: false,
      pctBelowHigh: null,
      flagged: false,
    };
  }

  const window = bars.slice(-HIGH_WINDOW_BARS);
  const latest = window[window.length - 1];
  let windowHigh = -Infinity;
  let windowHighDate = null;
  for (const bar of window) {
    if (bar.close > windowHigh) {
      windowHigh = bar.close;
      windowHighDate = bar.date;
    }
  }

  const pctBelowHigh = ((windowHigh - latest.close) / windowHigh) * 100;

  return {
    windowHigh,
    windowHighDate,
    latestClose: latest.close,
    latestDate: latest.date,
    windowBars: window.length,
    sufficientHistory: window.length >= HIGH_WINDOW_BARS,
    pctBelowHigh,
    flagged: pctBelowHigh >= HIGH_DROP_THRESHOLD_PCT,
  };
}

/**
 * T-1 close -> worst close through T+5, where T is the event's trading day
 * (the first close on or after the event date). Worst close is the minimum
 * close from T through T+5 inclusive. pctChange is negative for a drop.
 *
 * If fewer than EVENT_WINDOW_TRADING_DAYS closes exist after T yet (the event
 * is too recent), `complete` is false — the caller should treat this as
 * not-yet-decidable rather than guessing.
 */
function computeEventWindowDrop(closes, eventDate) {
  const bars = sortedByDate(closes);
  const notEnoughData = {
    tIndex: -1,
    t1Date: null,
    t1Close: null,
    worstDate: null,
    worstClose: null,
    pctChange: null,
    complete: false,
    windowBars: 0,
  };
  if (bars.length === 0 || !eventDate) return notEnoughData;

  const tIndex = bars.findIndex((b) => b.date >= eventDate);
  if (tIndex === -1 || tIndex === 0) return notEnoughData;

  const t1 = bars[tIndex - 1];
  const windowEnd = Math.min(bars.length, tIndex + EVENT_WINDOW_TRADING_DAYS + 1);
  const window = bars.slice(tIndex, windowEnd);
  const complete = bars.length - tIndex >= EVENT_WINDOW_TRADING_DAYS + 1;

  let worst = window[0];
  for (const bar of window) {
    if (bar.close < worst.close) worst = bar;
  }

  const pctChange = ((worst.close - t1.close) / t1.close) * 100;

  return {
    tIndex,
    t1Date: t1.date,
    t1Close: t1.close,
    worstDate: worst.date,
    worstClose: worst.close,
    pctChange,
    complete,
    windowBars: window.length,
    flagged: complete && pctChange <= -EVENT_DROP_THRESHOLD_PCT,
  };
}

/**
 * Convenience wrapper combining both drop measures for a candidate, per the
 * spec's "write both numbers" requirement. `dropFlag` is true if either
 * measure crosses its threshold; `decidable` is false only when the event
 * window can't be evaluated yet (event too recent) AND the 63-day high
 * measure didn't already flag on its own.
 */
function computeDropSignals(closes, eventDate) {
  const high63 = compute63DayHigh(closes);
  const eventWindow = computeEventWindowDrop(closes, eventDate);
  const dropFlag = Boolean(high63.flagged || eventWindow.flagged);
  const decidable = high63.flagged || eventWindow.complete;

  return { high63, eventWindow, dropFlag, decidable };
}

module.exports = {
  HIGH_WINDOW_BARS,
  EVENT_WINDOW_TRADING_DAYS,
  HIGH_DROP_THRESHOLD_PCT,
  EVENT_DROP_THRESHOLD_PCT,
  compute63DayHigh,
  computeEventWindowDrop,
  computeDropSignals,
};
