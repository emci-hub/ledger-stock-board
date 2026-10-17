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
    if (P.isWatchlistAccount(account)) return P.watchlistBenchmarkLine(account);
    const bench = P.benchmarkLabel(account);
    const delta = P.benchmarkDelta(account);
    if (!P.isNum(delta)) return `vs ${bench} unavailable`;
    const abs = Math.abs(delta).toFixed(2);
    const word = delta > 0.0001 ? "ahead of" : delta < -0.0001 ? "behind" : "even with";
    return `${word} ${bench} by ${abs} pts`;
  }

  function card(account) {
    const paused = P.isAccountPaused(account);
    const watchlist = P.isWatchlistAccount(account);
    const label = P.displayLabel(account);
    const status = paused ? "paused" : "active";
    const figures = watchlist
      ? `<div class="hc-value">${P.escapeHtml(P.watchlistSummary(account))}</div>
         <div class="hc-bench">${P.escapeHtml(P.watchlistBenchmarkLine(account))}</div>`
      : `<div>
           <span class="hc-value">${P.escapeHtml(P.money(account.value, account.currency))}</span>
           <span class="hc-return ${P.toneText(account.returnPct)}">${P.escapeHtml(P.pct(account.returnPct))}</span>
         </div>
         <div class="hc-bench">${P.escapeHtml(vsLine(account))}</div>
         <div class="hc-spark">${P.sparklineSvg(account.equityCurve)}</div>`;
    return `<a class="home-card" href="${P.accountHref(account)}">
      <div class="hc-top">
        <div>
          <div class="hc-name">${P.escapeHtml(P.displayName(account))}</div>
          ${label ? `<div class="hc-label">${P.escapeHtml(label)}</div>` : ""}
          <div class="hc-label">${P.escapeHtml(account.id || "")}</div>
        </div>
        <span class="status-pill">${status}</span>
      </div>
      ${figures}
    </a>`;
  }

  function moneyPct(value) {
    if (!Lab.isNum(value)) return "unavailable";
    const sign = value > 0 ? "+" : "";
    return `${sign}${value.toFixed(2)}%`;
  }

  function benchCard(title, start, now, ret) {
    const level =
      Lab.isNum(start) || Lab.isNum(now)
        ? `${Lab.isNum(start) ? start.toLocaleString("en-CA") : "—"} → ${Lab.isNum(now) ? now.toLocaleString("en-CA") : "—"}`
        : "Levels unavailable";
    return `<article class="bench-card">
      <h2>${P.escapeHtml(title)}</h2>
      <p>${P.escapeHtml(level)}</p>
      <p class="${P.toneText(ret)}">${P.escapeHtml(moneyPct(ret))} since the lab start</p>
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
        benchCard("SPY", board.spyStart, board.spyNow, board.spyReturn),
        benchCard("QQQ", board.qqqStart, board.qqqNow, board.qqqReturn),
        `<article class="bench-card"><h2>Baseline</h2><p>${P.escapeHtml(
          board.baselineReturn == null ? "Return unavailable" : moneyPct(board.baselineReturn)
        )}</p><p><a class="page-link" href="/lab">Open Strategy Lab</a></p></article>`,
      ].join("");
    } else {
      bench.hidden = true;
    }

    const names = doc.watchlist && Array.isArray(doc.watchlist.stocks) ? doc.watchlist.stocks.length : null;
    const hot = doc.hot_today && Array.isArray(doc.hot_today.hot) ? doc.hot_today.hot.length : null;
    const bits = [];
    if (names != null) bits.push(`<a class="page-link" href="/watchlist">${names} watchlist names</a>`);
    if (hot != null) bits.push(`<a class="page-link" href="/watchlist">${hot} hot today</a>`);
    bits.push(`<a class="page-link" href="/lab">Strategy Lab</a>`);
    el("pointers").innerHTML = bits.join(" · ");

    el("cards").innerHTML = accounts.map(card).join("");
    el("home-foot").textContent = `${accounts.length} account${accounts.length === 1 ? "" : "s"}: ${accounts
      .map((a) => a.id)
      .join(", ")}.`;
    el("state-msg").hidden = true;
    el("dash").hidden = false;
  }

  load();
})();
