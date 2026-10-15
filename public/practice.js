/**
 * Practice Run home — one scoreboard card per synced account.
 *
 * Renders every id in GET /api/paper. Display order is PREFERRED_ORDER then
 * unknown ids appended; nothing is dropped (see practice-lib.js).
 */
(function () {
  "use strict";

  const P = window.PracticeRun;
  const el = (id) => document.getElementById(id);

  function showState(message, isError) {
    const node = el("state-msg");
    node.hidden = false;
    node.textContent = message;
    node.className = isError ? "state-msg err" : "state-msg";
    el("dash").hidden = true;
  }

  function renderHeader(snapshot) {
    const day = snapshot.day;
    const total = snapshot.totalDays || 10;
    el("day-pill").textContent = Number.isFinite(day) ? `day ${day} of ${total}` : "day — of —";
    el("updated-label").innerHTML =
      `<span class="dot"></span>updated ${P.escapeHtml(P.formatMt(snapshot.updatedAt))} MT`;
    const run = snapshot.run || {};
    el("run-range").textContent =
      run.startDate && run.endDate
        ? `${P.formatDay(run.startDate)} – ${P.formatDay(run.endDate)}`
        : "";
    if (run.note) el("run-note").textContent = run.note;
  }

  function vsLine(account) {
    const bench = P.benchmarkLabel(account);
    const delta = P.benchmarkDelta(account);
    if (!P.isNum(delta)) {
      return `vs ${P.escapeHtml(bench)} <b class="flat-text">unavailable</b>`;
    }
    const abs = Math.abs(delta).toFixed(2);
    const word = delta > 0.0001 ? "ahead of" : delta < -0.0001 ? "behind" : "even with";
    return `${word} ${P.escapeHtml(bench)} by <b class="${P.toneText(delta)}">${abs} pts</b>`;
  }

  function homeCard(account) {
    const paused = P.isAccountPaused(account);
    const tone = paused ? "paused-card" : P.tone(account.returnPct);
    const label = P.displayLabel(account);
    const status = paused ? "paused" : "active";
    return `<a class="home-card ${tone}" href="${P.accountHref(account)}" id="card-${P.escapeHtml(account.id)}">
      <div class="hc-top">
        <div>
          <div class="hc-name">${P.escapeHtml(P.displayName(account))}</div>
          ${label ? `<div class="hc-label">${P.escapeHtml(label)}</div>` : ""}
        </div>
        <span class="status-pill ${status}">${status}</span>
      </div>
      <div>
        <span class="hc-value">${P.escapeHtml(P.money(account.value, account.currency))}</span>
        <span class="hc-return ${P.toneText(account.returnPct)}">${P.escapeHtml(P.pct(account.returnPct))}</span>
      </div>
      <div class="hc-bench">${vsLine(account)}</div>
      <div class="hc-spark">${P.sparklineSvg(account.equityCurve)}</div>
    </a>`;
  }

  function renderList(accounts) {
    el("home-list").innerHTML = accounts.map(homeCard).join("");
    const n = accounts.length;
    const names = accounts.map((a) => P.displayName(a)).join(", ");
    el("home-foot").textContent =
      n === 0
        ? "The latest snapshot has no accounts in it."
        : `${n} account${n === 1 ? "" : "s"} from the synced document: ${names}.`;
  }

  async function load() {
    let result;
    try {
      result = await P.loadSnapshot();
    } catch (err) {
      showState(
        err && /HTTP/.test(err.message)
          ? `The practice run could not be loaded (${err.message}).`
          : "Could not reach the server to load the practice run.",
        true
      );
      return;
    }

    if (result.empty) {
      showState(
        "No practice-run snapshot has been synced yet. The scoreboard fills in as soon as the first daily push lands.",
        false
      );
      return;
    }

    const { snapshot, accounts } = result;
    if (!accounts.length) {
      showState("The latest snapshot has no accounts in it.", true);
      return;
    }

    renderHeader(snapshot);
    renderList(accounts);
    el("state-msg").hidden = true;
    el("dash").hidden = false;
  }

  load();
})();
