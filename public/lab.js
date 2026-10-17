/**
 * Strategy Lab scoreboard. Comparison math lives in strategy-lab-lib.js.
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

  function pctOr(value) {
    if (!Lab.isNum(value)) return `<span class="flat-text">—</span>`;
    return `<span class="${P.toneText(value)}">${P.escapeHtml(P.pct(value))}</span>`;
  }

  function ptsOr(value) {
    if (!Lab.isNum(value)) return `<span class="flat-text">—</span>`;
    const sign = value > 0 ? "+" : "";
    return `<span class="${P.toneText(value)}">${P.escapeHtml(sign + value.toFixed(2))} pts</span>`;
  }

  function stat(label, help, html) {
    return `<div><dt>${P.escapeHtml(label)}<span class="stat-help">${P.escapeHtml(help)}</span></dt><dd>${html}</dd></div>`;
  }

  function progressHtml(progress) {
    if (!progress) return `<p class="progress-note">This account is not in the snapshot yet.</p>`;
    const width = progress.fraction == null ? 0 : Math.round(progress.fraction * 100);
    const time = progress.timeKnown
      ? `${progress.elapsedDays} of ${progress.totalDays} days`
      : "the calendar start is not in this snapshot";
    const trades = `${progress.closedTrades} of ${progress.tradeGoal} closed trades`;
    const state = progress.ready
      ? "Ready to judge."
      : "Not ready. Judged at 6 months or 20 closed trades, whichever comes later.";
    return `<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${width}"><span style="width:${width}%"></span></div>
      <p class="progress-note">${P.escapeHtml(time)} · ${P.escapeHtml(trades)}. ${P.escapeHtml(state)}</p>`;
  }

  function signalsHtml(rows) {
    if (!rows.length) return `<p class="empty">No signal log on this snapshot.</p>`;
    const body = rows
      .map((row) => {
        const taken = row.taken === true ? "yes" : row.taken === false ? "no" : "—";
        return `<tr>
          <td title="When the rule fired">${P.escapeHtml(P.formatDay(row.date))}</td>
          <td class="tick" title="The stock">${P.escapeHtml(row.ticker || "—")}</td>
          <td title="The rule that spoke">${P.escapeHtml(row.trigger || "—")}</td>
          <td title="Whether the account actually traded">${P.escapeHtml(taken)}</td>
          <td class="reason" title="The plain note">${P.escapeHtml(row.why || row.reason || "—")}</td>
        </tr>`;
      })
      .join("");
    return `<div class="table-scroll"><table class="data-table">
      <thead><tr>
        <th title="When the rule fired">Date</th>
        <th title="The stock">Ticker</th>
        <th title="The rule that spoke">Trigger</th>
        <th title="Whether the account actually traded">Taken</th>
        <th title="The plain note">Reason</th>
      </tr></thead>
      <tbody>${body}</tbody></table></div>`;
  }

  function card(row) {
    const value = Lab.isNum(row.value) ? P.money(row.value, row.currency) : "Starts at next sync";
    const blurb = window.AccountGroups ? window.AccountGroups.blurbFor(row.id) : "";
    const status = row.id === "us-day" || !row.status || row.status === "active" ? "" : row.status;
    const trades = row.closedTrades == null ? "—" : P.escapeHtml(String(row.closedTrades));
    return `<article class="lab-card">
      <h2>${P.escapeHtml(row.role)}</h2>
      ${blurb ? `<p class="hc-blurb">${P.escapeHtml(blurb)}</p>` : ""}
      <p class="role-id">${P.escapeHtml(row.id)}${status ? " · " + P.escapeHtml(status) : ""}</p>
      <dl class="lab-stats">
        ${stat("Value", "Pretend money in the account right now.", P.escapeHtml(value))}
        ${stat("Return since start", "Percent gained or lost since this account began.", pctOr(row.returnPct))}
        ${stat("vs SPY", "Percentage points ahead of the S&P 500 fund. Above zero means this account is ahead.", ptsOr(row.vsSpy))}
        ${stat("vs QQQ", "Percentage points ahead of the Nasdaq-100 fund.", ptsOr(row.vsQqq))}
        ${stat("vs baseline", "Percentage points ahead of simply holding the top-graded names.", ptsOr(row.vsBaseline))}
        ${stat("Closed trades", "Finished sells. Judging waits for 20 of these, or 6 months, whichever is later.", trades)}
      </dl>
      <p class="stat-help">Judging progress: ready only after both 6 months and 20 closed trades. The bar fills toward whichever mark is further along.</p>
      ${progressHtml(row.progress)}
      <details open>
        <summary>Signal log${row.signals.length ? ` (${row.signals.length})` : ""}</summary>
        <p class="stat-help">Date is when the rule fired. Ticker is the stock. Trigger is the rule. Taken means the account actually traded. Reason is the plain note.</p>
        ${signalsHtml(row.signals)}
      </details>
    </article>`;
  }

  function level(start, now) {
    if (!Lab.isNum(start) && !Lab.isNum(now)) return "";
    const a = Lab.isNum(start) ? start.toLocaleString("en-CA") : "—";
    const b = Lab.isNum(now) ? now.toLocaleString("en-CA") : "—";
    return `${a} → ${b}`;
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
    const board = Lab.scoreboard(result.snapshot);
    el("asof").textContent = board.asof ? `Lab marks as of ${board.asof}` : "Lab date is not in this snapshot";
    el("window").textContent = board.start
      ? `Started ${board.start}. Judge date if the calendar finishes first: ${board.rows[0] && board.rows[0].progress ? board.rows[0].progress.judgeOn || "—" : "—"}.`
      : "Lab start date is not in this snapshot.";
    const benchReturn = (value) =>
      value == null ? `<p>Starts at next sync</p>` : `<p class="${P.toneText(value)}">${P.escapeHtml(P.pct(value))}</p>`;
    const spyLevel = level(board.spyStart, board.spyNow);
    const qqqLevel = level(board.qqqStart, board.qqqNow);
    el("bench-strip").innerHTML = `
      <article class="bench-card"><h2>SPY</h2><p class="hc-blurb">The S&P 500 fund. A stand-in for the broad US market.</p>${
        spyLevel ? `<p>${P.escapeHtml(spyLevel)}</p>` : ""
      }${benchReturn(board.spyReturn)}</article>
      <article class="bench-card"><h2>QQQ</h2><p class="hc-blurb">The Nasdaq-100 fund. More technology companies than SPY.</p>${
        qqqLevel ? `<p>${P.escapeHtml(qqqLevel)}</p>` : ""
      }${benchReturn(board.qqqReturn)}</article>
      <article class="bench-card"><h2>Baseline</h2><p class="hc-blurb">Buy the top-graded names and hold. The bar the others have to beat.</p>${benchReturn(
        board.baselineReturn
      )}</article>`;
    el("rows").innerHTML = board.rows.map(card).join("");
    el("state-msg").hidden = true;
    el("dash").hidden = false;
  }

  load();
})();
