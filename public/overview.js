/**
 * Overview — one card per synced account. Never drops an id.
 */
(function () {
  "use strict";

  const P = window.PracticeRun;
  const Lab = window.StrategyLab;
  const el = (id) => document.getElementById(id);

  function showState(message, isError) {
    const node = el("state-msg");
    node.hidden = false;
    node.textContent = message;
    node.className = isError ? "state-msg err" : "state-msg";
    el("dash").hidden = true;
  }

  function vsLine(account) {
    const benchLine = P.watchlistBenchmarkLine(account);
    if (P.isWatchlistAccount(account)) return benchLine;
    const bench = P.benchmarkLabel(account);
    const delta = P.benchmarkDelta(account);
    if (!P.isNum(delta)) return "";
    const abs = Math.abs(delta).toFixed(2);
    const word = delta > 0.0001 ? "ahead of" : delta < -0.0001 ? "behind" : "even with";
    return `${word} ${bench} by ${abs} pts`;
  }

  function card(account) {
    const watchlist = P.isWatchlistAccount(account);
    const blurb = P.accountBlurb(account);
    const badge = P.accountBadge(account);
    const status = P.displayStatus(account);
    const vs = vsLine(account);
    const ret = P.isNum(account.returnPct)
      ? `<span class="hc-return ${P.toneText(account.returnPct)}">${P.escapeHtml(P.pct(account.returnPct))}</span>`
      : "";
    const figures = watchlist
      ? `<div class="hc-value">${P.escapeHtml(P.watchlistSummary(account))}</div>`
      : `<div>
           <span class="hc-value">${P.escapeHtml(P.accountValueText(account))}</span>
           ${ret}
         </div>
         ${vs ? `<div class="hc-bench">${P.escapeHtml(vs)}</div>` : ""}
         <div class="hc-spark">${P.sparklineSvg(account.equityCurve)}</div>`;
    return `<a class="home-card" href="${P.escapeHtml(P.cardHref(account))}">
      <div class="hc-top">
        <div>
          <div class="hc-name">${P.escapeHtml(P.displayName(account))}</div>
          ${blurb ? `<p class="hc-blurb">${P.escapeHtml(blurb)}</p>` : ""}
          <div class="hc-id">${P.escapeHtml(account.id || "")}</div>
        </div>
        ${watchlist ? "" : `<span class="status-pill">${P.escapeHtml(badge || status)}</span>`}
      </div>
      ${figures}
    </a>`;
  }

  function moneyPct(value) {
    if (!Lab.isNum(value)) return "";
    const sign = value > 0 ? "+" : "";
    return `${sign}${value.toFixed(2)}%`;
  }

  function benchCard(title, help, start, now, ret) {
    const hasLevel = Lab.isNum(start) || Lab.isNum(now);
    const level = hasLevel
      ? `${Lab.isNum(start) ? start.toLocaleString("en-CA") : "—"} → ${Lab.isNum(now) ? now.toLocaleString("en-CA") : "—"}`
      : "";
    const retText = moneyPct(ret);
    const waiting = !hasLevel && !retText;
    return `<article class="bench-card">
      <h2>${P.escapeHtml(title)}</h2>
      <p class="hc-blurb">${P.escapeHtml(help)}</p>
      ${level ? `<p>${P.escapeHtml(level)}</p>` : ""}
      ${retText ? `<p class="${P.toneText(ret)}">${P.escapeHtml(retText)} since the lab start</p>` : ""}
      ${waiting ? `<p>Starts at next sync</p>` : ""}
    </article>`;
  }

  async function load() {
    let result;
    try {
      result = await P.loadSnapshot();
    } catch (err) {
      showState("Could not load the latest snapshot.", true);
      return;
    }
    if (result.empty) {
      showState("No snapshot has been synced yet.", false);
      return;
    }
    const doc = result.snapshot;
    const accounts = result.accounts;
    el("updated-label").innerHTML = `<span class="dot"></span>updated ${P.escapeHtml(P.formatMt(doc.updatedAt))} MT`;
    const run = doc.run || {};
    el("run-range").textContent =
      run.startDate && run.endDate ? `${P.formatDay(run.startDate)} – ${P.formatDay(run.endDate)}` : "";
    if (run.note) el("run-note").textContent = run.note;

    const board = Lab.scoreboard(doc);
    const bench = el("bench-section");
    if (doc.lab) {
      bench.hidden = false;
      el("bench-strip").innerHTML = [
        benchCard("SPY", "The S&P 500 fund. A stand-in for the broad US market.", board.spyStart, board.spyNow, board.spyReturn),
        benchCard("QQQ", "The Nasdaq-100 fund. More technology companies than SPY.", board.qqqStart, board.qqqNow, board.qqqReturn),
        benchCard(
          "Baseline",
          "Buy the top-graded names and hold. The bar the other lab accounts have to beat.",
          null,
          null,
          board.baselineReturn
        ),
      ].join("");
    } else {
      bench.hidden = true;
    }

    el("groups").innerHTML = P.groupSectionsHtml(accounts, card);
    el("home-foot").textContent = `${accounts.length} account${accounts.length === 1 ? "" : "s"}, grouped below. Every synced id is shown.`;
    el("state-msg").hidden = true;
    el("dash").hidden = false;
  }

  load();
})();
