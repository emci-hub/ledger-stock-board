/**
 * Frozen graded watchlist + hot-today tape. Numbers come only from the snapshot.
 */
(function () {
  "use strict";

  const P = window.PracticeRun;
  const el = (id) => document.getElementById(id);
  const GRADES = ["A", "B", "C", "D", "F"];

  const COLS = [
    { key: "grade", label: "Grade", plain: "Letter from the checklist. A is strongest, F fails.", tip: null, kind: "grade" },
    { key: "ticker", label: "Name", plain: "The stock ticker.", tip: null, kind: "text" },
    { key: "score", label: "Score", plain: "One number rolled up from the checks to the right.", tip: null, kind: "num" },
    { key: "roic3", label: "3-yr ROIC", plain: "Profit earned on the money the company has invested, over three years.", tip: "roic3", kind: "pct", alts: ["ROIC"] },
    { key: "gm3", label: "Gross margin", plain: "What's left from sales after the cost of making the product.", tip: "gm3", kind: "pct", alts: ["GM"] },
    { key: "om3", label: "Op margin", plain: "What's left after the cost of running the business.", tip: "om3", kind: "pct" },
    { key: "rev_g", label: "Rev growth", plain: "How much sales grew compared with a year ago.", tip: "rev_g", kind: "pct", alts: ["rev_growth"] },
    { key: "netdebt_ebitda", label: "Net debt/EBITDA", plain: "How heavy the debt is next to yearly earnings. Lower is lighter.", tip: "netdebt_ebitda", kind: "num", alts: ["DE"] },
    { key: "val_vs_hist", label: "Val vs history", plain: "Whether today's price is high or low versus this company's own past.", tip: "val_vs_hist", kind: "num" },
    { key: "disruption", label: "Disruption", plain: "Whether a new technology could knock the business down.", tip: "disruption", kind: "text" },
    { key: "capex_dip", label: "Capex dip", plain: "Whether a price drop lines up with a big spending plan.", tip: "capex_dip", kind: "bool" },
    { key: "core", label: "Core", plain: "Yes if this name is one of the main holdings.", tip: "grace", kind: "bool" },
    { key: "fails", label: "Fail flags", plain: "Checklist items this name did not pass.", tip: "grace", kind: "fails" },
  ];

  let stocks = [];
  let explain = {};
  let sortKey = "score";
  let sortDir = -1;
  let gradeFilter = "ALL";

  function showState(message, isError) {
    const node = el("state-msg");
    node.hidden = false;
    node.textContent = message;
    node.className = isError ? "state-msg err" : "state-msg";
    el("dash").hidden = true;
  }

  function field(row, col) {
    const keys = [col.key].concat(col.alts || []);
    for (const key of keys) {
      if (row[key] != null && row[key] !== "") return row[key];
    }
    return null;
  }

  function gradeLetter(value) {
    const letter = String(value || "").trim().charAt(0).toUpperCase();
    return GRADES.includes(letter) ? letter : "";
  }

  function fmtPct(value) {
    if (value == null || value === "") return "—";
    if (value === "inf" || value === "Infinity") return "∞";
    const num = Number(value);
    if (!Number.isFinite(num)) return "—";
    return `${(num * 100).toFixed(1)}%`;
  }

  function fmtNum(value) {
    if (value == null || value === "") return "—";
    const num = Number(value);
    if (!Number.isFinite(num)) return P.escapeHtml(String(value));
    return num.toLocaleString("en-CA", { maximumFractionDigits: 2 });
  }

  function fmtBool(value) {
    if (value === true) return "Yes";
    if (value === false) return "No";
    return "—";
  }

  function sortValue(row, col) {
    if (col.kind === "grade") {
      const letter = gradeLetter(field(row, col));
      return letter ? GRADES.indexOf(letter) : 99;
    }
    if (col.kind === "fails") {
      const fails = Array.isArray(row.fails) ? row.fails.length : 0;
      return fails;
    }
    if (col.kind === "bool") {
      const value = field(row, col);
      if (value === true) return 0;
      if (value === false) return 1;
      return 2;
    }
    if (col.kind === "num" || col.kind === "pct") {
      const value = field(row, col);
      const num = Number(value);
      return Number.isFinite(num) ? num : null;
    }
    return String(field(row, col) || row.ticker || "").toLowerCase();
  }

  function sortedRows() {
    const col = COLS.find((item) => item.key === sortKey) || COLS[2];
    const rows = stocks.filter((row) => gradeFilter === "ALL" || gradeLetter(row.grade) === gradeFilter);
    return rows.slice().sort((a, b) => {
      const av = sortValue(a, col);
      const bv = sortValue(b, col);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (av < bv) return -1 * sortDir;
      if (av > bv) return 1 * sortDir;
      return String(a.ticker || "").localeCompare(String(b.ticker || ""));
    });
  }

  function cell(row, col) {
    const value = field(row, col);
    if (col.key === "ticker") {
      const name = row.name ? `<span class="subname">${P.escapeHtml(row.name)}</span>` : "";
      const price = P.isNum(row.price) ? `<span class="subname">${P.escapeHtml(P.money(row.price, "USD"))}</span>` : "";
      return `<td class="sticky wl-tick">${P.escapeHtml(row.ticker || "—")}${name}${price}</td>`;
    }
    if (col.key === "grade") {
      const letter = gradeLetter(value) || "—";
      return `<td class="wl-grade">${P.escapeHtml(letter)}</td>`;
    }
    if (col.key === "disruption") {
      const why = row.disruption_why ? `<span class="subname">${P.escapeHtml(row.disruption_why)}</span>` : "";
      const label = value || "—";
      return `<td><span class="disruption">${P.escapeHtml(String(label))}</span>${why}</td>`;
    }
    if (col.kind === "fails") {
      const fails = Array.isArray(row.fails) ? row.fails.filter(Boolean) : [];
      return `<td>${fails.length ? P.escapeHtml(fails.join(", ")) : "—"}</td>`;
    }
    if (col.kind === "pct") return `<td class="num">${P.escapeHtml(fmtPct(value))}</td>`;
    if (col.kind === "num") return `<td class="num">${fmtNum(value)}</td>`;
    if (col.kind === "bool") return `<td>${P.escapeHtml(fmtBool(value))}</td>`;
    return `<td>${P.escapeHtml(value == null ? "—" : String(value))}</td>`;
  }

  function renderTable() {
    const rows = sortedRows();
    const head = COLS.map((col) => {
      const sorted = col.key === sortKey;
      const tip = col.tip && explain[col.tip] ? explain[col.tip] : "";
      const plain = col.plain ? `<span class="col-plain">${P.escapeHtml(col.plain)}</span>` : "";
      return `<th scope="col"><button type="button" class="th-btn" data-sort="${P.escapeHtml(col.key)}" data-tip="${P.escapeHtml(
        tip
      )}" aria-sort="${sorted ? (sortDir < 0 ? "descending" : "ascending") : "none"}" title="${P.escapeHtml(
        col.plain || tip || col.label
      )}">${P.escapeHtml(col.label)}${
        sorted ? (sortDir < 0 ? " ↓" : " ↑") : ""
      }</button>${plain}</th>`;
    }).join("");
    const body = rows
      .map((row) => `<tr>${COLS.map((col) => cell(row, col)).join("")}</tr>`)
      .join("");
    el("wl-count").textContent = `${rows.length} of ${stocks.length} names`;
    el("wl-table").innerHTML = `<thead><tr>${head}</tr></thead><tbody>${
      body || `<tr><td colspan="${COLS.length}">No names in this grade.</td></tr>`
    }</tbody>`;
  }

  function renderFilters() {
    const counts = { ALL: stocks.length };
    GRADES.forEach((letter) => {
      counts[letter] = stocks.filter((row) => gradeLetter(row.grade) === letter).length;
    });
    el("filters").innerHTML = ["ALL"].concat(GRADES).map((letter) => {
      const label = letter === "ALL" ? `All ${counts.ALL}` : `${letter} ${counts[letter]}`;
      return `<button type="button" data-grade="${letter}" aria-pressed="${gradeFilter === letter ? "true" : "false"}">${P.escapeHtml(
        label
      )}</button>`;
    }).join("");
  }

  function hotTable(rows) {
    if (!rows.length) return `<p class="empty">Nothing flagged hot on this snapshot.</p>`;
    const body = rows
      .map((row) => {
        const chg = P.isNum(Number(row.chg_pct)) && row.chg_pct != null ? Number(row.chg_pct) : null;
        const chgClass = chg == null ? "" : chg < 0 ? "neg-text" : chg > 0 ? "pos-text" : "";
        const yn = (value) => (value === true ? "Yes" : value === false ? "No" : "—");
        return `<tr>
          <td class="tick">${P.escapeHtml(row.ticker || "—")}</td>
          <td>${P.escapeHtml(row.grade || "—")}</td>
          <td class="num">${row.close == null ? "—" : P.escapeHtml(P.plainNum(Number(row.close)))}</td>
          <td class="num ${chgClass}">${chg == null ? "—" : P.escapeHtml(chg.toFixed(2) + "%")}</td>
          <td class="num">${row.vol_x == null ? "—" : P.escapeHtml(String(row.vol_x))}</td>
          <td>${yn(row.above200)}</td>
          <td class="num">${row.dd18m_pct == null ? "—" : P.escapeHtml(String(row.dd18m_pct) + "%")}</td>
          <td>${yn(row.comeback)}</td>
          <td>${yn(row.leader_dip)}</td>
          <td>${yn(row.fund_check)}</td>
          <td class="reason">${P.escapeHtml(row.why || "—")}</td>
        </tr>`;
      })
      .join("");
    return `<div class="table-scroll"><table class="data-table">
      <thead><tr>
        <th>Ticker</th><th>Grade</th><th class="num">Close</th><th class="num">Day %</th><th class="num">Vol ×</th>
        <th>Above 200</th><th class="num">18m dd</th><th>Comeback</th><th>Leader dip</th><th>Fund check</th><th>Why</th>
      </tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function watchlistFrom(doc) {
    if (doc.watchlist && Array.isArray(doc.watchlist.stocks)) return doc.watchlist;
    const account = (doc.accounts || []).find(
      (row) => String(row.kind || "").toLowerCase() === "watchlist" || row.id === "lt-watch"
    );
    if (!account || !account.watchlist || !Array.isArray(account.watchlist.items)) return null;
    return {
      asof: account.watchlist.asOf || account.watchlist.asof || null,
      method: account.watchlist.rubric || null,
      explain: account.watchlist.explain || {},
      stocks: account.watchlist.items,
    };
  }

  function hotFrom(doc) {
    if (doc.hot_today && (Array.isArray(doc.hot_today.hot) || Array.isArray(doc.hot_today.all))) return doc.hot_today;
    const account = (doc.accounts || []).find((row) => Array.isArray(row.hotToday));
    if (!account) return null;
    return { asof: null, hot: account.hotToday, all: [], note: null };
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
    const wl = watchlistFrom(result.snapshot);
    const hot = hotFrom(result.snapshot);
    if (!wl && !hot) {
      showState("This snapshot has no watchlist and no hot-today tape yet.", false);
      return;
    }
    stocks = wl && Array.isArray(wl.stocks) ? wl.stocks : [];
    explain = (wl && wl.explain) || {};
    const asof = (wl && wl.asof) || (hot && hot.asof) || "";
    el("asof").textContent = asof ? `Snapshot ${asof}` : "Snapshot date unavailable";
    if (wl && wl.method) el("method").textContent = wl.method;
    el("hot-meta").textContent = hot && hot.asof ? `As of ${hot.asof}${hot.generated ? " · generated " + hot.generated : ""}` : "";
    el("hot-body").innerHTML = hotTable((hot && hot.hot) || []);
    const all = hot && Array.isArray(hot.all) ? hot.all : [];
    const tape = el("tape");
    if (all.length) {
      tape.hidden = false;
      tape.open = true;
      el("tape-summary").textContent = `Day tape for every watched name (${all.length})`;
      el("tape-body").innerHTML = hotTable(all);
    } else {
      tape.hidden = true;
    }
    renderFilters();
    renderTable();
    el("state-msg").hidden = true;
    el("dash").hidden = false;
  }

  document.addEventListener("click", (event) => {
    const grade = event.target.closest("[data-grade]");
    if (grade) {
      gradeFilter = grade.dataset.grade;
      renderFilters();
      renderTable();
      return;
    }
    const sort = event.target.closest("[data-sort]");
    if (sort) {
      const key = sort.dataset.sort;
      if (sortKey === key) sortDir = -sortDir;
      else {
        sortKey = key;
        sortDir = key === "ticker" || key === "grade" ? 1 : -1;
      }
      const tip = sort.dataset.tip;
      el("tip-live").textContent = tip || "Tap a heading that has an explanation.";
      renderTable();
    }
  });

  load();
})();
