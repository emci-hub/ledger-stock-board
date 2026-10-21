/**
 * Ingest for the optional watchlist, hot_today, lab, and per-account signals.
 * Also checks Strategy Lab display math. No network, no market APIs.
 * Run: node scripts/testPaperIngest.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { normalizeSnapshot, PaperSnapshotError } = require("../services/paperRun");
const seed = require("../data/paper-run-seed.json");
const { buildSampleSnapshot } = require("./sampleSnapshot");
const Lab = require("../public/strategy-lab-lib");
const Series = require("../public/paper-series");

const bare = normalizeSnapshot(seed);
assert.equal(bare.accounts.length, seed.accounts.length);
assert.equal(Object.prototype.hasOwnProperty.call(bare, "watchlist"), false);
assert.equal(Object.prototype.hasOwnProperty.call(bare, "hot_today"), false);
assert.equal(Object.prototype.hasOwnProperty.call(bare, "lab"), false);
assert.equal(bare.accounts.find((a) => a.id === "us-swing").value, 996.35);
assert.equal(Object.prototype.hasOwnProperty.call(bare.accounts[0], "signals"), false);

const sample = buildSampleSnapshot();
const doc = normalizeSnapshot(sample);
const ids = doc.accounts.map((a) => a.id);
for (const id of [
  "us-swing",
  "ca-swing",
  "glb-branch",
  "lottery-us",
  "lottery-ca",
  "us-day",
  "ca-day",
  "lt-watch",
  "us-ghost",
  "ghost-orig",
  "ghost-macro",
  "momentum",
  "baseline",
]) {
  assert.ok(ids.includes(id), `sample keeps ${id}`);
}
assert.equal(doc.watchlist.stocks.length, 45);
const msft = doc.watchlist.stocks.find((s) => s.ticker === "MSFT");
assert.equal(msft.grade, "A");
assert.equal(msft.score, 85);
assert.equal(msft.roic3, sample.watchlist.stocks.find((s) => s.ticker === "MSFT").roic3);
assert.equal(msft.capex_dip, false);
assert.equal(msft.core, true);
assert.equal(msft.disruption, "GREEN");
assert.ok(doc.watchlist.explain.roic3.includes("invested capital"));
assert.ok(doc.watchlist.explain.capex_dip.includes("capex"));
const nflx = doc.watchlist.stocks.find((s) => s.ticker === "NFLX");
assert.deepStrictEqual(nflx.fails, ["gm"]);
const adobe = doc.watchlist.stocks.find((s) => s.disruption === "RED");
assert.ok(adobe, "a RED disruption check is kept");

assert.equal(doc.hot_today.asof, "2026-10-16");
assert.ok(doc.hot_today.hot.length > 0);
assert.equal(doc.hot_today.hot[0].ticker, "PLTR");
assert.equal(doc.hot_today.hot[0].chg_pct, -7.22);
assert.equal(doc.hot_today.hot[0].hot, true);
assert.ok(Array.isArray(doc.hot_today.all) && doc.hot_today.all.length >= doc.hot_today.hot.length);

assert.equal(doc.lab.SPY, 763.25);
assert.equal(doc.lab.QQQ_now, sample.lab.QQQ_now);
assert.equal(doc.lab.start, "2026-10-16");

const ghost = doc.accounts.find((a) => a.id === "ghost-orig");
assert.equal(ghost.value, null, "explicit null value stays null");
assert.equal(ghost.signals.length, 2);
assert.equal(ghost.signals[0].ticker, "AMAT");
assert.equal(ghost.signals[0].taken, false);
assert.ok(ghost.signals[0].why.includes("frozen Ghost"));
assert.equal(ghost.signals[1].taken, false);

const baseline = doc.accounts.find((a) => a.id === "baseline");
assert.equal(baseline.value, 987.25);
assert.equal(baseline.cash, 0);
assert.equal(baseline.returnPct, null, "omitted return stays null, not zero");

const watch = doc.accounts.find((a) => a.id === "lt-watch");
assert.equal(watch.kind, "watchlist");
assert.equal(watch.value, null);
assert.equal(watch.benchmark.value, null);

assert.ok(Buffer.byteLength(JSON.stringify(doc), "utf8") < 2 * 1024 * 1024);

function rejects(doc, needle) {
  assert.throws(
    () => normalizeSnapshot(doc),
    (err) => err instanceof PaperSnapshotError && err.errors.some((line) => line.includes(needle)),
    `expected rejection mentioning ${needle}`
  );
}

const one = {
  accounts: [{ id: "us-swing", currency: "USD", value: 1000, benchmark: { ticker: "VOO" } }],
};
rejects({ ...one, watchlist: [] }, "watchlist must be an object");
rejects({ ...one, watchlist: { stocks: [{ name: "Nope" }] } }, "ticker is required");
rejects({ ...one, hot_today: [] }, "hot_today must be an object");
rejects({ ...one, hot_today: { hot: [{}] } }, "ticker is required");
rejects({ ...one, lab: [] }, "lab must be an object");
rejects({ ...one, lab: { SPY: "nope" } }, "lab.SPY must be a number");
rejects(
  {
    accounts: [
      {
        id: "us-swing",
        currency: "USD",
        value: 1000,
        benchmark: { ticker: "VOO" },
        signals: { date: "2026-10-16" },
      },
    ],
  },
  "signals must be an array"
);
rejects(
  {
    accounts: [
      {
        id: "us-swing",
        currency: "USD",
        value: 1000,
        benchmark: { ticker: "VOO" },
        signals: [{ date: "2026-10-16", taken: "yes" }],
      },
    ],
  },
  "ticker is required"
);

const yesNo = normalizeSnapshot({
  accounts: [
    {
      id: "ghost-orig",
      currency: "USD",
      value: null,
      benchmark: { ticker: "SPY" },
      signals: [
        { date: "2026-10-16", ticker: "NVDA", trigger: "breakout", taken: "yes", reason: "size ok" },
        { date: "2026-10-16", ticker: "AMD", trigger: "dip", taken: false, why: "spread" },
      ],
    },
  ],
});
assert.equal(yesNo.accounts[0].signals[0].taken, true);
assert.equal(yesNo.accounts[0].signals[0].why, "size ok");
assert.equal(yesNo.accounts[0].signals[1].taken, false);
assert.equal(yesNo.accounts[0].signals[1].why, "spread");

assert.equal(Lab.addMonthsIso("2026-10-16", 6), "2027-04-16");
assert.equal(Lab.daysBetween("2026-10-16", "2027-04-16"), 182);
assert.equal(Lab.benchReturn({ SPY: 100, SPY_now: 110 }, "SPY", "SPY_now"), 10);
assert.equal(Lab.benchReturn({ SPY: 763.25, SPY_now: 763.25 }, "SPY", "SPY_now"), 0);
assert.equal(Lab.benchReturn({}, "SPY", "SPY_now"), null);
assert.equal(Lab.closedTradeCount({ trades: [{ side: "BUY" }, { side: "sell" }, { side: "SELL" }] }), 2);
assert.equal(Lab.closedTradeCount({ closedTrades: 4, trades: [{ side: "SELL" }] }), 4);

const early = Lab.judgingProgress({ start: "2026-10-16", asof: "2026-10-16", closedTrades: 0 });
assert.equal(early.ready, false);
assert.equal(early.elapsedDays, 0);
assert.equal(early.totalDays, 182);
assert.equal(early.fraction, 0);

const tradesOnly = Lab.judgingProgress({ start: "2026-10-16", asof: "2026-10-16", closedTrades: 20 });
assert.equal(tradesOnly.ready, false, "20 trades on day 0 is not yet the later bar");

const timeOnly = Lab.judgingProgress({ start: "2026-10-16", asof: "2027-04-16", closedTrades: 3 });
assert.equal(timeOnly.ready, false, "6 months without 20 trades is not yet the later bar");

const ready = Lab.judgingProgress({ start: "2026-10-16", asof: "2027-04-16", closedTrades: 20 });
assert.equal(ready.ready, true);
assert.equal(ready.fraction, 1);

const board = Lab.scoreboard(doc);
assert.equal(board.spyReturn, 0);
assert.equal(board.qqqReturn, 0);
assert.equal(board.rows.length, 6);
assert.deepStrictEqual(
  board.rows.map((row) => row.id),
  ["baseline", "ghost-orig", "us-ghost", "ghost-macro", "momentum", "us-day"]
);
const usDay = board.rows.find((row) => row.id === "us-day");
assert.equal(usDay.role, "US Long-Term v5");
assert.equal(usDay.returnPct, 0.77);
assert.equal(usDay.vsSpy, 0.77);
assert.equal(usDay.vsQqq, 0.77);
assert.equal(usDay.vsBaseline, null, "baseline has no synced return, so the gap is unavailable");
assert.equal(usDay.closedTrades, 0);
assert.equal(usDay.progress.ready, false);
const baseRow = board.rows.find((row) => row.id === "baseline");
assert.equal(baseRow.value, 987.25);
assert.equal(baseRow.returnPct, null);
assert.equal(baseRow.vsSpy, null);
const ghostRow = board.rows.find((row) => row.id === "ghost-orig");
assert.equal(ghostRow.signals.length, 2);
assert.equal(ghostRow.value, null);
assert.equal(ghostRow.vsSpy, null);
assert.equal(board.backtestRows.length, 4);
assert.deepStrictEqual(
  board.backtestRows.map((row) => row.id),
  ["bt-ghost-orig", "bt-ghost-fixed", "bt-ghost-macro", "bt-momentum"]
);
const replay = board.backtestRows[0];
assert.equal(replay.backtest, true);
assert.equal(replay.role, "Ghost Dip, Gemini (backtest)");
assert.equal(replay.returnPct, 8.4);
assert.equal(replay.vsSpy, null, "a July replay is not scored against the live lab's short SPY window");
assert.equal(replay.vsQqq, null);
assert.equal(replay.vsBaseline, null);
assert.equal(replay.vsBenchmark, 4.2);
assert.equal(replay.closedTrades, 1);
assert.equal(replay.progress.start, "2026-07-16");
assert.ok(replay.progress.elapsedDays > 31, "the replay clock includes the months before October");
const macro = board.rows.find((row) => row.id === "ghost-macro");
assert.equal(macro.role, "Ghost Dip + market weather");
assert.equal(macro.present, true);
assert.equal(macro.returnPct, null);
assert.equal(macro.vsSpy, null);
assert.equal(macro.backtest, false);
const macroReplay = board.backtestRows.find((row) => row.id === "bt-ghost-macro");
assert.equal(macroReplay.backtest, true);
assert.equal(macroReplay.role, "Ghost Dip + market weather (backtest)");
assert.equal(macroReplay.returnPct, 5.5);
assert.equal(macroReplay.vsSpy, null);
assert.equal(macroReplay.vsQqq, null);
assert.equal(macroReplay.vsBaseline, null);
assert.equal(macroReplay.vsBenchmark, 1.3);
assert.equal(macroReplay.progress.start, "2026-07-16");
const stored = doc.accounts.find((account) => account.id === "bt-ghost-orig");
assert.equal(stored.trades.find((trade) => trade.ticker === "AVGO" && trade.side === "BUY").date, "2026-07-16");
assert.equal(stored.equityCurve.find((point) => point.date === "2026-07-16").value, 1000);
const ordered = Series.orderedMarks(stored.equityCurve);
assert.deepStrictEqual(
  ordered.map((point) => point.date),
  ["2026-07-16", "2026-08-20", "2026-09-15", "2026-10-19"]
);
assert.ok(Series.spanDays(ordered) > 90);
const newestFirst = Series.orderedTrades(stored.trades);
assert.equal(newestFirst[0].date, "2026-10-19");
assert.equal(newestFirst[newestFirst.length - 1].date, "2026-07-16");

const V3 = require("../public/watchlist-v3");
const v3Fixture = require("../data/samples/watchlist-v3.json");
assert.equal(V3.isV3(doc.watchlist), false, "the v2 sample stays on the old watchlist page");
assert.equal(doc.watchlist.version, undefined);
assert.equal(V3.isV3(v3Fixture), true);
assert.equal(V3.isV3({ version: " V3.2-beta " }), true);
assert.equal(V3.isV3({ version: "v2" }), false);
assert.equal(V3.isV3({}), false);
const v3Parts = V3.partition(v3Fixture);
assert.equal(v3Parts.god.length, 15);
assert.equal(v3Parts.watchOnly.length, 37);
assert.deepStrictEqual(
  v3Parts.god.map((stock) => stock.ticker),
  ["ANET", "CDNS", "MA", "V", "KLAC", "FTNT", "ISRG", "MCO", "AAPL", "NFLX", "META", "ADBE", "AMAT", "KEYS", "CSCO"],
  "god-tier names sort by company score, highest first"
);
assert.deepStrictEqual(
  v3Parts.god.filter((stock) => V3.overallGrade(stock) === "A").map((stock) => stock.ticker).sort(),
  ["AAPL", "ADBE", "ANET", "CDNS", "FTNT", "ISRG", "KLAC", "MA", "MCO", "META", "NFLX", "V"]
);
assert.deepStrictEqual(
  v3Parts.god.filter((stock) => V3.overallGrade(stock) === "B").map((stock) => stock.ticker),
  ["AMAT", "KEYS", "CSCO"]
);
const meta = v3Parts.god.find((stock) => stock.ticker === "META");
assert.equal(V3.newsHold(meta), true);
assert.equal(V3.compositeOf(meta), 78.3);
assert.equal(V3.halfSize(meta), true);
assert.equal(V3.newsOf(meta).log.length > 0, true);
assert.equal(v3Parts.other.length, 0);
assert.ok(v3Parts.watchOnly.every((stock) => Array.isArray(stock.fail_reasons) && stock.fail_reasons.length));
const sparse = V3.partition({
  version: "v3",
  stocks: [
    { ticker: "LOW", status: "god", report_card: { composite: 10 } },
    { ticker: "NONE", status: "god" },
    { ticker: "HIGH", status: "God", report_card: { composite: 90 } },
    { ticker: "ODD", status: "maybe" },
    null,
  ],
});
assert.deepStrictEqual(
  sparse.god.map((stock) => stock.ticker),
  ["HIGH", "LOW", "NONE"]
);
assert.equal(V3.compositeOf(sparse.god[2]), null);
assert.deepStrictEqual(
  sparse.other.map((stock) => stock.ticker),
  ["ODD"]
);

const storedV3 = normalizeSnapshot({
  accounts: [
    {
      id: "lt-watch",
      kind: "watchlist",
      currency: "USD",
      value: null,
      benchmark: { ticker: "SPY" },
    },
  ],
  watchlist: v3Fixture,
});
assert.equal(storedV3.watchlist.version, "v3.1-specialist-revised-2026-10-19");
assert.equal(storedV3.watchlist.stocks.length, 52);
assert.equal(storedV3.watchlist.config.caps.per_name, 0.1);
assert.equal(storedV3.watchlist.config.caps.per_theme, 0.3);
const storedMeta = storedV3.watchlist.stocks.find((stock) => stock.ticker === "META");
assert.equal(storedMeta.news_hold, true);
assert.equal(storedMeta.size_mult, 0.5);
assert.equal(storedMeta.status, "god");
assert.equal(storedMeta.report_card.overall.grade, "A");
assert.equal(storedMeta.report_card.overall.composite_0_100, 78.3);
assert.equal(storedMeta.report_card.news_context.news_log[0].type != null, true);
const storedWatch = storedV3.watchlist.stocks.find((stock) => stock.status === "watch-only");
assert.ok(storedWatch.fail_reasons[0], "watch-only names keep their fail reasons");

const softV3 = normalizeSnapshot({
  accounts: [
    {
      id: "lt-watch",
      kind: "watchlist",
      currency: "USD",
      benchmark: { ticker: "SPY" },
    },
  ],
  watchlist: {
    version: "  v3.1-test  ",
    stocks: [{ ticker: "ABC", status: "watch-only", fail_reasons: "not-an-array", news_hold: "yes" }],
  },
});
assert.equal(softV3.watchlist.version, "v3.1-test");
assert.deepStrictEqual(softV3.watchlist.stocks[0].fail_reasons, []);
assert.equal(softV3.watchlist.stocks[0].news_hold, true);

const pageHtml = fs.readFileSync(path.join(__dirname, "..", "public", "watchlist.html"), "utf8");
const pageJs = fs.readFileSync(path.join(__dirname, "..", "public", "watchlist.js"), "utf8");
assert.ok(pageHtml.includes("How names get in"), "v3 page explains how a name gets in");
assert.ok(pageHtml.includes("<title>GOD-Tier watchlist</title>"), "page title is GOD-Tier watchlist");
assert.ok(pageHtml.includes("<h1>GOD-Tier watchlist</h1>"), "page heading is GOD-Tier watchlist");
assert.ok(pageHtml.includes(">GOD-Tier watchlist</a>"), "nav label is GOD-Tier watchlist");
assert.ok(pageHtml.includes('href="/watchlist" aria-current="page"'), "watchlist highlights its tab");
assert.ok(pageHtml.includes("watchlist-v3.js"), "the page loads the v3 helper");
assert.ok(pageHtml.includes("one quarter of grace"), "the rules include one quarter of grace");
assert.ok(pageJs.includes("WatchlistV3.isV3"), "v2 rendering stays when the version is not v3");

const Beta = require("../public/beta-watchlist");
const beta = require("../data/samples/beta-watchlist.json");
const betaRows = Beta.ranked(beta);
assert.deepStrictEqual(
  betaRows.map((row) => row.ticker),
  ["PLTR", "CRDO", "CRWD", "ALAB", "NET", "DDOG", "SNOW", "APP", "RKLB", "ARM", "MDB", "RDDT", "IONQ", "SPCX", "NBIS", "SMCI", "CRWV", "CBRS", "TEM", "OKLO"]
);
assert.deepStrictEqual(
  betaRows.slice(0, 3).map((row) => row.score),
  [16, 16, 16]
);
assert.equal(betaRows.find((row) => row.ticker === "PLTR").grade, "B");
assert.equal(betaRows.find((row) => row.ticker === "OKLO").grade, "D");
assert.equal(betaRows.find((row) => row.ticker === "OKLO").score, 7);
assert.deepStrictEqual(Beta.flagsFor(betaRows.find((row) => row.ticker === "NBIS")), ["Eject review"]);
assert.deepStrictEqual(Beta.flagsFor(betaRows.find((row) => row.ticker === "SMCI")), ["Eject review"]);
assert.deepStrictEqual(Beta.flagsFor(betaRows.find((row) => row.ticker === "PLTR")), ["Promotion candidate, not promoted"]);
assert.deepStrictEqual(Beta.flagsFor(betaRows.find((row) => row.ticker === "APP")), [
  "Promotion candidate, not promoted",
  "Upgraded C to B",
]);
assert.deepStrictEqual(Beta.flagsFor(betaRows.find((row) => row.ticker === "RKLB")), ["Upgraded C to B"]);
assert.equal(betaRows.find((row) => row.ticker === "PLTR").price, 194.15);
assert.ok(beta.changelog.some((line) => line.includes("yearly revenue")));
assert.ok(beta.changelog.some((line) => line.includes("net cash")));
const betaHtml = fs.readFileSync(path.join(__dirname, "..", "public", "beta.html"), "utf8");
const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
assert.ok(betaHtml.includes("What this is"));
assert.ok(betaHtml.includes('href="/beta" aria-current="page"'), "beta highlights its tab");
assert.ok(serverSrc.includes('app.get("/beta"'));
assert.ok(serverSrc.includes("/api/beta-watchlist"));

const navCss = fs.readFileSync(path.join(__dirname, "..", "public", "site-nav.css"), "utf8");
assert.ok(navCss.includes("position:sticky"), "the shared header stays on screen");
for (const file of ["index.html", "watchlist.html", "beta.html", "lab.html", "accounts.html", "account.html", "board.html"]) {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", file), "utf8");
  assert.ok(html.includes('class="site-nav"'), `${file} has the shared nav`);
  assert.ok(html.includes("site-nav.css"), `${file} loads the shared nav style`);
  assert.ok(html.includes("site-nav.js"), `${file} loads the shared nav script`);
  assert.ok(html.includes('class="nav-brand">Ledger</span>'), `${file} shows the Ledger header`);
  assert.ok(html.includes(">GOD-Tier watchlist</a>"), `${file} links to the god-tier page`);
  assert.ok(html.includes('href="/beta"'), `${file} links to beta`);
}

const missing = Lab.scoreboard({ accounts: [], lab: { start: "2026-10-16", asof: "2026-10-16", SPY: 1, SPY_now: 1, QQQ: 1, QQQ_now: 1 } });
assert.equal(missing.rows.length, 6);
assert.equal(missing.backtestRows.length, 4);
assert.ok(missing.rows.every((row) => row.present === false));
assert.ok(missing.backtestRows.every((row) => row.present === false));

console.log("paper ingest: ok — watchlist, hot today, lab, signals, and the judging bar");
