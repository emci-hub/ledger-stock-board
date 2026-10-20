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

  function textOrEmpty(value) {
    if (value == null || value === "") return "";
    return String(value);
  }

  function shownDay(value) {
    const text = textOrEmpty(value);
    if (!text) return "—";
    if (/^\d{4}-\d{2}-\d{2}/.test(text)) return P.formatDay(text, true);
    return text;
  }

  function shownSignal(key, value) {
    if (value == null || value === "") return "—";
    if (key === "insider" && value && typeof value === "object" && !Array.isArray(value)) {
      if ("buys_6m" in value || "sales_6m" in value) {
        return `${value.buys_6m ?? "—"} buys and ${value.sales_6m ?? "—"} sales in 6 months`;
      }
    }
    if (key === "buybacks" && typeof value === "number" && Number.isFinite(value)) {
      const abs = Math.abs(value);
      if (abs >= 1e9) return `US$${(value / 1e9).toFixed(1)} billion`;
      if (abs >= 1e6) return `US$${(value / 1e6).toFixed(0)} million`;
    }
    if (key === "short_interest" && typeof value === "number" && value > 0 && value < 1) {
      return `${(value * 100).toFixed(2)}% of shares`;
    }
    if (key === "estimate_revisions" && value && typeof value === "object" && !Array.isArray(value)) {
      if ("up_30d" in value || "down_30d" in value) {
        return `${value.up_30d ?? "—"} up and ${value.down_30d ?? "—"} down in 30 days`;
      }
    }
    return signalText(value);
  }

  function gradeParts(value) {
    if (value == null || value === "") return { letter: "", reason: "", source: "", date: "" };
    if (typeof value === "string" || typeof value === "number") {
      return { letter: String(value), reason: "", source: "", date: "" };
    }
    if (typeof value !== "object") return { letter: "", reason: "", source: "", date: "" };
    return {
      letter: textOrEmpty(value.grade),
      reason: textOrEmpty(value.reason),
      source: textOrEmpty(value.source),
      date: textOrEmpty(value.date),
    };
  }

  function signalText(value) {
    if (value == null || value === "") return "—";
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
    if (Array.isArray(value)) return value.map((item) => signalText(item)).filter((item) => item && item !== "—").join(", ") || "—";
    if (typeof value === "object") {
      return Object.entries(value)
        .map(([key, item]) => `${key}: ${signalText(item)}`)
        .join(" · ");
    }
    return "—";
  }

  function disruptionChip(stock) {
    const label = textOrEmpty(stock.disruption);
    if (!label) return "";
    const key = label.toUpperCase();
    const tone = key === "GREEN" ? "disruption-green" : key === "YELLOW" ? "disruption-yellow" : key === "RED" ? "disruption-red" : "";
    const why = textOrEmpty(stock.disruption_why);
    return `<span class="disruption ${tone}" title="${P.escapeHtml(why)}">${P.escapeHtml(key)}</span>`;
  }

  function percentCap(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) : fallback;
  }

  function capsLine(watchlist) {
    const caps = watchlist && watchlist.config && watchlist.config.caps;
    const perName = percentCap(caps && caps.per_name, 10);
    const perTheme = percentCap(caps && caps.per_theme, 30);
    return `No more than ${perName}% in one stock, and no more than ${perTheme}% in one theme. Yellow means half size.`;
  }

  function failSentence(stock) {
    const reasons = Array.isArray(stock.fail_reasons) ? stock.fail_reasons.map((item) => textOrEmpty(item)).filter(Boolean) : [];
    if (!reasons.length) return "No fail reason was included in this snapshot.";
    return reasons.join(" ");
  }

  function watchOnlyItem(stock, note) {
    const ticker = textOrEmpty(stock.ticker) || "—";
    const name = textOrEmpty(stock.name);
    return `<li>
      <b>${P.escapeHtml(ticker)}</b>${name ? ` <span class="god-name">${P.escapeHtml(name)}</span>` : ""}
      ${note ? `<p>${P.escapeHtml(note)}</p>` : `<p>${P.escapeHtml(failSentence(stock))}</p>`}
    </li>`;
  }

  function gradesHtml(card) {
    const grades = card && card.grades && typeof card.grades === "object" ? card.grades : {};
    const V3 = window.WatchlistV3;
    return V3.GRADE_FIELDS.map(([key, label]) => {
      const parts = gradeParts(grades[key]);
      const letter = parts.letter || "—";
      const sourceBits = [parts.source, parts.date ? shownDay(parts.date) : ""].filter((bit) => bit && bit !== "—");
      return `<article class="god-grade">
        <h3>${P.escapeHtml(label)}</h3>
        <p><span class="letter">${P.escapeHtml(letter)}</span>${parts.reason ? P.escapeHtml(parts.reason) : `<span class="flat-text">No reason in this snapshot.</span>`}</p>
        <p class="god-meta">${sourceBits.length ? P.escapeHtml(sourceBits.join(" · ")) : "Source not in this snapshot."}</p>
      </article>`;
    }).join("");
  }

  function issueTable(rows) {
    const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
    if (!list.length) return `<p class="empty">No issues logged for this name.</p>`;
    const body = list
      .map((row) => {
        if (typeof row === "string") {
          return `<tr><td>${P.escapeHtml(row)}</td><td>—</td><td>—</td><td>—</td></tr>`;
        }
        return `<tr>
          <td>${P.escapeHtml(textOrEmpty(row.issue) || "—")}</td>
          <td>${P.escapeHtml(shownDay(row.date))}</td>
          <td>${P.escapeHtml(textOrEmpty(row.fix_plan) || "—")}</td>
          <td>${P.escapeHtml(textOrEmpty(row.status) || "—")}</td>
        </tr>`;
      })
      .join("");
    return `<div class="table-scroll"><table class="data-table">
      <thead><tr><th>Issue</th><th>Date</th><th>Fix plan</th><th>Status</th></tr></thead>
      <tbody>${body}</tbody></table></div>`;
  }

  function newsHtml(stock) {
    const block = window.WatchlistV3.newsOf(stock);
    const tags = Array.isArray(block.macro_tags) ? block.macro_tags.map((tag) => textOrEmpty(tag)).filter(Boolean) : [];
    const tagHtml = tags.length
      ? `<div class="chip-row">${tags.map((tag) => `<span class="status-pill">${P.escapeHtml(tag)}</span>`).join("")}</div>`
      : `<p class="god-meta">No macro tags in this snapshot.</p>`;
    const log = Array.isArray(block.log) ? block.log.filter(Boolean) : [];
    const logHtml = log.length
      ? `<div class="table-scroll"><table class="data-table"><thead><tr>
          <th>Date</th><th>What happened</th><th>Source</th><th>Why it matters</th><th>Type</th>
        </tr></thead><tbody>${log
          .map((row) => {
            if (typeof row === "string") return `<tr><td colspan="5">${P.escapeHtml(row)}</td></tr>`;
            const kind = textOrEmpty(row.type);
            const kindLabel = kind === "thesis-changing" ? "Thesis-changing" : kind === "price-only" ? "Price only" : kind || "—";
            return `<tr>
              <td>${P.escapeHtml(shownDay(row.date))}</td>
              <td>${P.escapeHtml(textOrEmpty(row.summary) || "—")}</td>
              <td>${P.escapeHtml(textOrEmpty(row.source) || "—")}</td>
              <td>${P.escapeHtml(textOrEmpty(row.impact) || "—")}</td>
              <td>${P.escapeHtml(kindLabel)}</td>
            </tr>`;
          })
          .join("")}</tbody></table></div>`
      : `<p class="empty">No news log in this snapshot.</p>`;
    const catalysts = Array.isArray(block.catalysts) ? block.catalysts.filter(Boolean) : [];
    const catalystHtml = catalysts.length
      ? `<ul class="watch-next">${catalysts
          .map((row) => {
            if (typeof row === "string") return `<li>${P.escapeHtml(row)}</li>`;
            const when = row.date ? shownDay(row.date) : "";
            const event = textOrEmpty(row.event) || "Event not named";
            return `<li>${when ? `${P.escapeHtml(when)} — ` : ""}${P.escapeHtml(event)}</li>`;
          })
          .join("")}</ul>`
      : `<p class="god-meta">No dated catalysts in this snapshot.</p>`;
    const signals = block.signals && typeof block.signals === "object" ? block.signals : {};
    const signalHtml = window.WatchlistV3.SIGNAL_FIELDS.map(([key, label]) => {
      const raw = signals[key] != null && signals[key] !== "" ? signals[key] : key === "buybacks" ? signals.buyback : null;
      return `<div><dt>${P.escapeHtml(label)}</dt><dd>${P.escapeHtml(shownSignal(key, raw))}</dd></div>`;
    }).join("");
    return `<div class="news-block"><h3 class="block-label">Macro tags</h3>${tagHtml}</div>
      <div class="news-block"><h3 class="block-label">News log</h3>${logHtml}</div>
      <div class="news-block"><h3 class="block-label">Catalysts</h3>${catalystHtml}</div>
      <div class="news-block"><h3 class="block-label">Signals</h3><dl class="signal-grid">${signalHtml}</dl></div>`;
  }

  function godCard(stock, open) {
    const V3 = window.WatchlistV3;
    const card = stock.report_card && typeof stock.report_card === "object" ? stock.report_card : {};
    const ticker = textOrEmpty(stock.ticker) || "—";
    const name = textOrEmpty(stock.name);
    const description = textOrEmpty(card.description);
    const overall = V3.overallGrade(stock) || "—";
    const composite = V3.compositeOf(stock);
    const compositeLabel = composite == null ? "—" : Number.isInteger(composite) ? String(composite) : String(Math.round(composite * 10) / 10);
    const statusTag = textOrEmpty(card.status_tag);
    const theme = textOrEmpty(stock.theme);
    const price = P.isNum(stock.price) ? P.money(stock.price, "USD") : "";
    const holdWhy = V3.newsHold(stock) ? textOrEmpty(stock.news_hold_reason) : "";
    const badges = [
      `<span class="grade-badge" title="Overall grade">${P.escapeHtml(overall)}</span>`,
      `<span class="composite-num" title="Company score, 0 to 100">${P.escapeHtml(compositeLabel)}</span>`,
      statusTag ? `<span class="status-pill">${P.escapeHtml(statusTag)}</span>` : "",
      disruptionChip(stock),
      V3.newsHold(stock) ? `<span class="status-pill">News hold</span>` : "",
      V3.halfSize(stock) ? `<span class="status-pill">Half size</span>` : "",
    ]
      .filter(Boolean)
      .join("");
    const watchNext = V3.watchNextOf(stock);
    const watchHtml = watchNext.length
      ? `<ul class="watch-next">${watchNext.map((item) => `<li>${P.escapeHtml(item)}</li>`).join("")}</ul>`
      : `<p class="god-meta">Nothing listed to watch next.</p>`;
    return `<article class="god-card">
      <div class="god-top">
        <div>
          <h2>${P.escapeHtml(ticker)}${name ? `<span class="god-name">${P.escapeHtml(name)}</span>` : ""}</h2>
          ${description ? `<p class="hc-blurb">${P.escapeHtml(description)}</p>` : `<p class="hc-blurb">No one-line description in this snapshot.</p>`}
          ${theme || price ? `<p class="hc-id">${theme ? `Theme: ${P.escapeHtml(theme)}` : ""}${stock.cyclical === true ? " · boom-bust, judged over 7 years" : ""}${price ? `${theme || stock.cyclical === true ? " · " : ""}${P.escapeHtml(price)}` : ""}</p>` : ""}
          ${holdWhy ? `<p class="hc-id">${P.escapeHtml(holdWhy)}</p>` : ""}
        </div>
        <div class="god-badges">${badges}</div>
      </div>
      <details${open ? " open" : ""}>
        <summary>Grades, issues, and news</summary>
        <div class="god-detail">
          <div class="god-grades">${gradesHtml(card)}</div>
          <h3 class="block-label">Issue log</h3>
          ${issueTable(card.issue_log)}
          <h3 class="block-label">What to watch next</h3>
          ${watchHtml}
          <h3 class="block-label">News</h3>
          ${newsHtml(stock)}
        </div>
      </details>
    </article>`;
  }

  function renderV3(watchlist) {
    const V3 = window.WatchlistV3;
    const parts = V3.partition(watchlist);
    el("caps-line").textContent = capsLine(watchlist);
    const godCount = parts.god.length;
    el("god-count").textContent = godCount
      ? `${godCount} name${godCount === 1 ? "" : "s"}, highest score first.`
      : "No god-tier names in this snapshot.";
    el("god-list").innerHTML = godCount
      ? parts.god.map((stock) => godCard(stock, false)).join("")
      : `<p class="empty">No god-tier names in this snapshot.</p>`;
    const watchRows = parts.watchOnly;
    const otherRows = parts.other;
    const watchCount = watchRows.length + otherRows.length;
    el("watch-only-count").textContent = watchCount
      ? `${watchCount} name${watchCount === 1 ? "" : "s"} that did not pass every test.`
      : "No names in this group.";
    const blocks = [];
    if (watchRows.length) {
      blocks.push(`<ul class="watch-only-list">${watchRows.map((stock) => watchOnlyItem(stock)).join("")}</ul>`);
    }
    if (otherRows.length) {
      blocks.push(`<p class="section-intro">These names did not say god or watch-only, so they stay visible and are not treated as god-tier.</p>`);
      blocks.push(
        `<ul class="watch-only-list">${otherRows
          .map((stock) => {
            const status = textOrEmpty(stock.status);
            const note = status
              ? `Status on the snapshot: ${status}. ${failSentence(stock)}`
              : `Status was not on the snapshot. ${failSentence(stock)}`;
            return watchOnlyItem(stock, note);
          })
          .join("")}</ul>`
      );
    }
    el("watch-only-body").innerHTML = blocks.length
      ? blocks.join("")
      : `<p class="empty">No watch-only names in this snapshot.</p>`;
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
    const useV3 = Boolean(window.WatchlistV3 && wl && window.WatchlistV3.isV3(wl));
    el("asof").textContent = asof
      ? `Snapshot ${asof}${useV3 && wl.version ? " · " + wl.version : ""}`
      : "Snapshot date unavailable";
    if (useV3) {
      el("method").textContent = "God-tier names that passed every test. A grade is about the company, not the price.";
    } else if (wl && wl.method) {
      el("method").textContent = wl.method;
    }
    const hotRows = hot && Array.isArray(hot.hot) ? hot.hot : [];
    const hotSection = el("hot-section");
    if (hotSection) hotSection.hidden = useV3 && hotRows.length === 0;
    el("hot-meta").textContent = hot && hot.asof ? `As of ${hot.asof}${hot.generated ? " · generated " + hot.generated : ""}` : "";
    el("hot-body").innerHTML = hotTable(hotRows);
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
    if (useV3) {
      renderV3(wl);
      el("v2").hidden = true;
      el("v3").hidden = false;
    } else {
      renderFilters();
      renderTable();
      el("v2").hidden = false;
      el("v3").hidden = true;
    }
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
