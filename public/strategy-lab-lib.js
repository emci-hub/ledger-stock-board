/**
 * Strategy Lab scoreboard math. Paper numbers only — nothing here calls a model
 * or invents a price. Account return is the synced returnPct. SPY and QQQ
 * returns are the change from the synced start price to the synced latest price.
 *
 * Shared by the page (window.StrategyLab) and by node tests (module.exports).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StrategyLab = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const LAB_SPECS = [
    { role: "Buy & hold A/B names, the bar to beat", ids: ["baseline"] },
    { role: "Ghost Dip, Gemini version", ids: ["ghost-orig"] },
    { role: "Ghost Dip, red-teamed", ids: ["us-ghost", "ghost-fixed"] },
    { role: "Breakout momentum", ids: ["momentum"] },
    { role: "US Long-Term v5", ids: ["us-day"] },
  ];
  const BACKTEST_SPECS = [
    { role: "Ghost Dip, Gemini (backtest)", ids: ["bt-ghost-orig"], started: "2026-07-16" },
    { role: "Ghost Dip, red-teamed (backtest)", ids: ["bt-ghost-fixed"], started: "2026-07-16" },
    { role: "Breakout momentum (backtest)", ids: ["bt-momentum"], started: "2026-07-16" },
  ];
  const TRADE_GOAL = 20;
  const JUDGE_MONTHS = 6;

  function isNum(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function round2(value) {
    if (!isNum(value)) return null;
    return Math.round(value * 100) / 100;
  }

  function parseIsoDay(iso) {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
    if (!match) return null;
    return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }

  function daysBetween(startIso, endIso) {
    const start = parseIsoDay(startIso);
    const end = parseIsoDay(endIso);
    if (start == null || end == null) return null;
    return Math.round((end - start) / 86400000);
  }

  function addMonthsIso(iso, months) {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const cursor = new Date(Date.UTC(year, month - 1 + months, 1));
    const last = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0)).getUTCDate();
    const clamped = Math.min(day, last);
    return new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), clamped))
      .toISOString()
      .slice(0, 10);
  }

  /** Percent change from a synced start price to a synced latest price. */
  function benchReturn(lab, startKey, nowKey) {
    if (!lab) return null;
    const start = lab[startKey];
    const now = lab[nowKey];
    if (!isNum(start) || !isNum(now) || start === 0) return null;
    return Math.round(((now / start) - 1) * 100 * 1e6) / 1e6;
  }

  function closedTradeCount(account) {
    if (!account) return 0;
    if (isNum(account.closedTrades)) return account.closedTrades;
    const trades = Array.isArray(account.trades) ? account.trades : [];
    return trades.filter((trade) => String(trade.side || "").toUpperCase() === "SELL").length;
  }

  /**
   * Judging bar: 6 months from the lab start, or 20 closed trades, whichever
   * comes later. An account is ready only after both have happened.
   */
  function judgingProgress({ start, asof, closedTrades }) {
    const trades = isNum(closedTrades) ? closedTrades : 0;
    const tradeFraction = Math.min(1, trades / TRADE_GOAL);
    const judgeOn = start ? addMonthsIso(start, JUDGE_MONTHS) : null;
    const totalDays = start && judgeOn ? daysBetween(start, judgeOn) : null;
    const elapsedDays = start && asof ? Math.max(0, daysBetween(start, asof)) : null;
    const timeKnown = totalDays != null && elapsedDays != null && totalDays > 0;
    const timeFraction = timeKnown ? Math.min(1, elapsedDays / totalDays) : null;
    const ready = Boolean(timeKnown && elapsedDays >= totalDays && trades >= TRADE_GOAL);
    return {
      ready,
      start: start || null,
      asof: asof || null,
      judgeOn,
      elapsedDays,
      totalDays,
      closedTrades: trades,
      tradeGoal: TRADE_GOAL,
      timeFraction,
      tradeFraction,
      fraction: timeKnown ? Math.min(timeFraction, tradeFraction) : null,
      timeKnown,
    };
  }

  function points(accountReturn, otherReturn) {
    if (!isNum(accountReturn) || !isNum(otherReturn)) return null;
    return round2(accountReturn - otherReturn);
  }

  function findAccount(accounts, ids) {
    const list = Array.isArray(accounts) ? accounts : [];
    for (const id of ids) {
      const hit = list.find((account) => account && String(account.id) === id);
      if (hit) return hit;
    }
    return null;
  }

  function labAsOf(snapshot) {
    const lab = snapshot && snapshot.lab;
    if (lab && lab.asof) return String(lab.asof).slice(0, 10);
    if (snapshot && snapshot.updatedAt) return String(snapshot.updatedAt).slice(0, 10);
    return null;
  }

  function scoreboard(snapshot) {
    const accounts = (snapshot && snapshot.accounts) || [];
    const lab = (snapshot && snapshot.lab) || null;
    const spyReturn = benchReturn(lab, "SPY", "SPY_now");
    const qqqReturn = benchReturn(lab, "QQQ", "QQQ_now");
    const baseline = findAccount(accounts, ["baseline"]);
    const baselineReturn = baseline && isNum(baseline.returnPct) ? baseline.returnPct : null;
    const start = (lab && lab.start) || null;
    const asof = labAsOf(snapshot);
    function rowFor(spec, { backtest }) {
      const account = findAccount(accounts, spec.ids);
      const returnPct = account && isNum(account.returnPct) ? account.returnPct : null;
      const closed = account ? closedTradeCount(account) : null;
      const isBaseline = spec.ids.indexOf("baseline") !== -1;
      const benchReturnPct =
        account && account.benchmark && isNum(account.benchmark.returnPct) ? account.benchmark.returnPct : null;
      const progressStart = backtest ? spec.started || start : start;
      return {
        role: spec.role,
        ids: spec.ids,
        id: account ? account.id : spec.ids[0],
        present: Boolean(account),
        backtest: Boolean(backtest),
        name: account ? account.name || account.id : null,
        label: account ? account.label || "" : "",
        currency: account ? account.currency || null : null,
        value: account && isNum(account.value) ? account.value : null,
        returnPct,
        vsSpy: backtest ? null : points(returnPct, spyReturn),
        vsQqq: backtest ? null : points(returnPct, qqqReturn),
        vsBaseline: backtest ? null : isBaseline ? (isNum(returnPct) ? 0 : null) : points(returnPct, baselineReturn),
        vsBenchmark: backtest ? points(returnPct, benchReturnPct) : null,
        closedTrades: closed,
        progress: account ? judgingProgress({ start: progressStart, asof, closedTrades: closed }) : null,
        signals: account && Array.isArray(account.signals) ? account.signals : [],
        trades: account && Array.isArray(account.trades) ? account.trades : [],
        equityCurve: account && Array.isArray(account.equityCurve) ? account.equityCurve : [],
        status: account ? account.status || null : null,
      };
    }
    const rows = LAB_SPECS.map((spec) => rowFor(spec, { backtest: false }));
    const backtestRows = BACKTEST_SPECS.map((spec) => rowFor(spec, { backtest: true }));
    return {
      spyReturn,
      qqqReturn,
      baselineReturn,
      spyStart: lab && isNum(lab.SPY) ? lab.SPY : null,
      spyNow: lab && isNum(lab.SPY_now) ? lab.SPY_now : null,
      qqqStart: lab && isNum(lab.QQQ) ? lab.QQQ : null,
      qqqNow: lab && isNum(lab.QQQ_now) ? lab.QQQ_now : null,
      start,
      asof,
      rows,
      backtestRows,
    };
  }

  return {
    LAB_SPECS,
    BACKTEST_SPECS,
    TRADE_GOAL,
    JUDGE_MONTHS,
    isNum,
    round2,
    daysBetween,
    addMonthsIso,
    benchReturn,
    closedTradeCount,
    judgingProgress,
    points,
    scoreboard,
  };
});
