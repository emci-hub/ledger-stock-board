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
    if (!Lab.isNum(value)) return `<span class="flat-text">unavailable</span>`;
    return `<span class="${P.toneText(value)}">${P.escapeHtml(P.pct(value))}</span>`;
  }

  function ptsOr(value) {
    if (!Lab.isNum(value)) return `<span class="flat-text">unavailable</span>`;
    const sign = value > 0 ? "+" : "";
    return `<span class="${P.toneText(value)}">${P.escapeHtml(sign + value.toFixed(2))} pts</span>`;
  }

  function progressHtml(progress) {
    if (!progress) return `<p class="progress-note">Not in this snapshot, so progress is unavailable.</p>`;
    const width = progress.fraction == null ? 0 : Math.round(progress.fraction * 100);
    const time = progress.timeKnown
      ? `${progress.elapsedDays} of ${progress.totalDays} days`
      : "calendar progress unavailable";
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
          <td>${P.escapeHtml(P.formatDay(row.date))}</td>
          <td class="tick">${P.escapeHtml(row.ticker || "—")}</td>
          <td>${P.escapeHtml(row.trigger || "—")}</td>
          <td>${P.escapeHtml(taken)}</td>
          <td class="reason">${P.escapeHtml(row.why || row.reason || "—")}</td>
        </tr>`;
      })
      .join("");
    return `<div class="table-scroll"><table class="data-table">
      <thead><tr><th>Date</th><th>Ticker</th><th>Trigger</th><th>Taken</th><th>Reason</th></tr></thead>
      <tbody>${body}</tbody></table></div>`;
  }

  function card(row) {
    const value = Lab.isNum(row.value) ? P.money(row.value, row.currency) : "Starts at next sync";
    const label = row.id === "us-day" ? "" : row.label;
    const status = row.id === "us-day" ? "" : row.status;
    return `<article class="lab-card">
      <h2>${P.escapeHtml(row.role)}</h2>
      <p class="role-id">${P.escapeHtml(row.id)}${label ? " · " + P.escapeHtml(label) : ""}${
        status ? " · " + P.escapeHtml(status) : ""
      }</p>
      <dl class="lab-stats">
        <div><dt>Value</dt><dd>${P.escapeHtml(value)}</dd></div>
        <div><dt>Return since start</dt><dd>${pctOr(row.returnPct)}</dd></div>
        <div><dt>vs SPY</dt><dd>${ptsOr(row.vsSpy)}</dd></div>
        <div><dt>vs QQQ</dt><dd>${ptsOr(row.vsQqq)}</dd></div>
        <div><dt>vs baseline</dt><dd>${ptsOr(row.vsBaseline)}</dd></div>
        <div><dt>Closed trades</dt><dd>${row.closedTrades == null ? "unavailable" : P.escapeHtml(String(row.closedTrades))}</dd></div>
      </dl>
      ${progressHtml(row.progress)}
      <details open>
        <summary>Signal log${row.signals.length ? ` (${row.signals.length})` : ""}</summary>
        ${signalsHtml(row.signals)}
      </details>
    </article>`;
  }

  function level(start, now) {
    if (!Lab.isNum(start) && !Lab.isNum(now)) return "unavailable";
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
    el("asof").textContent = board.asof ? `Lab marks as of ${board.asof}` : "Lab date unavailable";
    el("window").textContent = board.start
      ? `Started ${board.start}. Judge date if the calendar finishes first: ${board.rows[0] && board.rows[0].progress ? board.rows[0].progress.judgeOn || "—" : "—"}.`
      : "Lab start date is not in this snapshot.";
    el("bench-strip").innerHTML = `
      <article class="bench-card"><h2>SPY</h2><p>${P.escapeHtml(level(board.spyStart, board.spyNow))}</p><p class="${P.toneText(
        board.spyReturn
      )}">${board.spyReturn == null ? "Return unavailable" : P.escapeHtml(P.pct(board.spyReturn))}</p></article>
      <article class="bench-card"><h2>QQQ</h2><p>${P.escapeHtml(level(board.qqqStart, board.qqqNow))}</p><p class="${P.toneText(
        board.qqqReturn
      )}">${board.qqqReturn == null ? "Return unavailable" : P.escapeHtml(P.pct(board.qqqReturn))}</p></article>
      <article class="bench-card"><h2>Baseline</h2><p>Equal-weight A/B account</p><p class="${P.toneText(
        board.baselineReturn
      )}">${board.baselineReturn == null ? "Return unavailable" : P.escapeHtml(P.pct(board.baselineReturn))}</p></article>`;
    el("rows").innerHTML = board.rows.map(card).join("");
    el("state-msg").hidden = true;
    el("dash").hidden = false;
  }

  load();
})();
