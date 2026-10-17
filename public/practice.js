/**
 * Practice Run home — scoreboard, then one account’s detail at a time.
 *
 * No global/cross-account sections. Every pick, chart, projection, lesson and
 * rule lives inside the selected account. Tapping a scoreboard card expands
 * that account below. Unknown synced ids are never dropped.
 */
(function () {
  "use strict";

  const P = window.PracticeRun;
  const el = (id) => document.getElementById(id);
  let accounts = [];
  let snapshot = null;
  let activeId = null;

  function showState(message, isError) {
    const node = el("state-msg");
    node.hidden = false;
    node.textContent = message;
    node.className = isError ? "state-msg err" : "state-msg";
    el("dash").hidden = true;
  }

  function renderHeader(doc) {
    const day = doc.day;
    const total = doc.totalDays || 10;
    el("day-pill").textContent = Number.isFinite(day) ? `day ${day} of ${total}` : "day — of —";
    el("updated-label").innerHTML =
      `<span class="dot"></span>updated ${P.escapeHtml(P.formatMt(doc.updatedAt))} MT`;
    const run = doc.run || {};
    el("run-range").textContent =
      run.startDate && run.endDate
        ? `${P.formatDay(run.startDate)} – ${P.formatDay(run.endDate)}`
        : "";
    if (run.note) el("run-note").textContent = run.note;
  }

  function vsLine(account) {
    const bench = P.benchmarkLabel(account);
    const delta = P.benchmarkDelta(account);
    if (!P.isNum(delta)) return "";
    const abs = Math.abs(delta).toFixed(2);
    const word = delta > 0.0001 ? "ahead of" : delta < -0.0001 ? "behind" : "even with";
    return `${word} ${P.escapeHtml(bench)} by <b class="${P.toneText(delta)}">${abs} pts</b>`;
  }

  function homeCard(account) {
    const paused = P.isAccountPaused(account);
    const watchlist = P.isWatchlistAccount(account);
    const tone = paused ? "paused-card" : watchlist ? "flat" : P.tone(account.returnPct);
    const blurb = P.accountBlurb(account);
    const badge = P.accountBadge(account);
    const status = P.displayStatus(account);
    const id = P.escapeHtml(account.id);
    const ret = P.isNum(account.returnPct)
      ? `<span class="hc-return ${P.toneText(account.returnPct)}">${P.escapeHtml(P.pct(account.returnPct))}</span>`
      : "";
    const vs = vsLine(account);
    const figures = watchlist
      ? `<div><span class="hc-value wl-summary">${P.escapeHtml(P.watchlistSummary(account))}</span></div>`
      : `<div>
        <span class="hc-value">${P.escapeHtml(P.accountValueText(account))}</span>
        ${ret}
      </div>
      ${vs ? `<div class="hc-bench">${vs}</div>` : ""}
      <div class="hc-spark">${P.sparklineSvg(account.equityCurve)}</div>`;
    if (watchlist) {
      return `<a class="home-card ${tone}" id="card-${id}" href="/watchlist">
        <div class="hc-top">
          <div>
            <div class="hc-name">${P.escapeHtml(P.displayName(account))}</div>
            ${blurb ? `<p class="hc-blurb">${P.escapeHtml(blurb)}</p>` : ""}
            <div class="hc-id">${id}</div>
          </div>
        </div>
        ${figures}
      </a>`;
    }
    return `<button type="button" class="home-card ${tone}" id="card-${id}"
        data-account="${id}" aria-controls="acct-panel">
      <div class="hc-top">
        <div>
          <div class="hc-name">${P.escapeHtml(P.displayName(account))}</div>
          ${blurb ? `<p class="hc-blurb">${P.escapeHtml(blurb)}</p>` : ""}
          <div class="hc-id">${id}</div>
        </div>
        <span class="status-pill">${P.escapeHtml(badge || status)}</span>
      </div>
      ${figures}
    </button>`;
  }

  function tabButton(account) {
    const id = P.escapeHtml(account.id);
    return `<button type="button" class="acct-tab" role="tab" id="tab-${id}"
        data-account="${id}" aria-controls="acct-panel">${P.escapeHtml(P.displayName(account))}</button>`;
  }

  function idFromHash() {
    const raw = (location.hash || "").replace(/^#/, "");
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }

  function selectAccount(id, { scroll, pushHash } = {}) {
    const account = accounts.find((row) => String(row.id) === String(id)) || accounts[0];
    if (!account) return;
    activeId = account.id;

    document.querySelectorAll(".home-card").forEach((card) => {
      const on = card.dataset.account === activeId;
      card.classList.toggle("is-selected", on);
      if (card.tagName === "BUTTON") card.setAttribute("aria-pressed", on ? "true" : "false");
    });
    const selected = document.getElementById(`card-${activeId}`);
    const details = selected && selected.closest("details");
    if (details) details.open = true;
    document.querySelectorAll(".acct-tab").forEach((tab) => {
      const on = tab.dataset.account === activeId;
      tab.setAttribute("aria-selected", on ? "true" : "false");
      tab.tabIndex = on ? 0 : -1;
      if (on) {
        const scroller = el("acct-tabs");
        const left = tab.offsetLeft - scroller.clientWidth / 2 + tab.offsetWidth / 2;
        scroller.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
      }
    });

    const panel = el("acct-panel");
    panel.innerHTML = P.accountDetailHtml(account, snapshot, {
      compact: true,
      idPrefix: "home",
    });
    panel.dataset.account = activeId;

    const intro = el("detail-intro");
    if (intro) {
      intro.textContent = P.isWatchlistAccount(account)
        ? "One account at a time. Hot names today, then the graded long-term watchlist. Research only — no paper balance."
        : "One account at a time. Scorecard, that account’s picks, its trades, then its chart, projection, lessons and rules.";
    }

    if (pushHash !== false) {
      const next = `#${encodeURIComponent(activeId)}`;
      if (location.hash !== next) history.replaceState(null, "", next);
    }

    if (scroll) {
      el("account-detail").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function renderShell() {
    el("home-list").innerHTML = P.groupSectionsHtml(accounts, homeCard);
    el("acct-tabs").innerHTML = accounts.map(tabButton).join("");
    const n = accounts.length;
    el("home-foot").textContent =
      n === 0
        ? "The latest snapshot has no accounts in it."
        : `${n} account${n === 1 ? "" : "s"}, in the same groups as the overview. Tap a card to open it below.`;
  }

  function wire() {
    el("home-list").addEventListener("click", (event) => {
      const card = event.target.closest("[data-account]");
      if (card) selectAccount(card.dataset.account, { scroll: true });
    });
    el("acct-tabs").addEventListener("click", (event) => {
      const tab = event.target.closest("[data-account]");
      if (tab) selectAccount(tab.dataset.account, { scroll: true });
    });
    el("acct-tabs").addEventListener("keydown", (event) => {
      const keys = { ArrowRight: 1, ArrowLeft: -1 };
      const dir = keys[event.key];
      if (!dir) return;
      event.preventDefault();
      const idx = accounts.findIndex((a) => a.id === activeId);
      const next = accounts[(idx + dir + accounts.length) % accounts.length];
      selectAccount(next.id, { scroll: false });
      const tab = document.getElementById(`tab-${next.id}`);
      if (tab) tab.focus();
    });
    window.addEventListener("hashchange", () => {
      const fromHash = idFromHash();
      if (fromHash && fromHash !== activeId) {
        selectAccount(fromHash, { scroll: true, pushHash: false });
      }
    });
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

    snapshot = result.snapshot;
    accounts = result.accounts;
    if (!accounts.length) {
      showState("The latest snapshot has no accounts in it.", true);
      return;
    }

    renderHeader(snapshot);
    renderShell();
    wire();

    const wanted = idFromHash();
    const start = accounts.some((a) => a.id === wanted) ? wanted : accounts[0].id;
    selectAccount(start, { scroll: false, pushHash: Boolean(wanted) });

    el("state-msg").hidden = true;
    el("dash").hidden = false;
  }

  load();
})();
