/**
 * Per-account HTML for / and /account/:id.
 * Nothing here is shared across accounts — each call renders one account.
 */
(function (root) {
  "use strict";

  const P = root.PracticeRun;
  if (!P) throw new Error("practice-lib.js must load first");

  function empty(text) {
    return `<p class="empty">${P.escapeHtml(text)}</p>`;
  }

  function bullets(title, items, cls) {
    const list = Array.isArray(items) ? items.filter(Boolean) : [];
    if (!list.length) return "";
    return `<div class="pc ${cls}"><h4>${P.escapeHtml(title)}</h4><ul>${list
      .map((item) => `<li>${P.escapeHtml(item)}</li>`)
      .join("")}</ul></div>`;
  }

  function gradeRow(grades) {
    return `<dl class="grade-row">${P.GRADE_CATEGORIES.map(([key, label]) => {
      const g = P.normalizeGrade(grades ? grades[key] : null);
      return `<div class="grade ${P.gradeClass(g.grade)}">
        <dt>${P.escapeHtml(label)}</dt>
        <dd>${P.escapeHtml(g.grade || "—")}</dd>
      </div>`;
    }).join("")}</dl>`;
  }

  function gradeNotes(grades) {
    const notes = P.GRADE_CATEGORIES.map(([key, label]) => {
      const g = P.normalizeGrade(grades ? grades[key] : null);
      if (!g.note) return "";
      return `<div class="grade-note"><b>${P.escapeHtml(label)}</b> ${P.escapeHtml(g.note)}</div>`;
    }).filter(Boolean);
    return notes.length ? `<div class="grade-notes">${notes.join("")}</div>` : "";
  }

  function scorecardArticle(card, { latest }) {
    const grades = card.grades || {};
    const weak = card.weakest ? String(card.weakest) : "";
    const fix = card.fix ? String(card.fix) : "";
    return `<article class="block${latest ? "" : " history"}">
      <div class="scorecard-head">
        <span class="sc-date">${P.escapeHtml(P.formatDay(card.date) || card.date || "undated")}</span>
        ${card.derived ? `<span class="tag">derived from rubric</span>` : ""}
      </div>
      ${gradeRow(grades)}
      ${gradeNotes(grades)}
      ${
        weak || fix
          ? `<div class="weak-fix">
              ${weak ? `<div class="weak"><b>Weakest</b>${P.escapeHtml(weak)}</div>` : ""}
              ${fix ? `<div class="fix"><b>Fix</b>${P.escapeHtml(fix)}</div>` : ""}
            </div>`
          : ""
      }
      ${
        card.derived && card.basis
          ? `<p class="derived-note">${P.escapeHtml(card.basis)}</p>`
          : ""
      }
    </article>`;
  }

  function scorecardSection(account) {
    const cards = (account.scorecards || [])
      .slice()
      .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    if (!cards.length) return empty("No scorecard yet for this account.");
    const latest = cards[0];
    const history = cards.slice(1);
    return (
      scorecardArticle(latest, { latest: true }) +
      (history.length
        ? `<p class="history-label">Earlier cards</p>${history
            .map((card) => scorecardArticle(card, { latest: false }))
            .join("")}`
        : "")
    );
  }

  function levelBlock(pick) {
    if (Array.isArray(pick.levels) && pick.levels.length) {
      return `<div class="leg-list">${pick.levels
        .map(
          (leg) =>
            `<span class="leg"><b>${P.escapeHtml(leg.ticker || "")}</b> stop ${P.escapeHtml(
              P.plainNum(leg.stop)
            )} · target ${P.escapeHtml(P.plainNum(leg.target))}</span>`
        )
        .join("")}</div>`;
    }
    if (!P.isNum(pick.entry) && !P.isNum(pick.stop) && !P.isNum(pick.target)) return "";
    return `<dl class="levels">
      <div class="level"><dt>Entry</dt><dd>${P.escapeHtml(P.plainNum(pick.entry))}</dd></div>
      <div class="level stop"><dt>Stop</dt><dd>${P.escapeHtml(P.plainNum(pick.stop))}</dd></div>
      <div class="level target"><dt>Target</dt><dd>${P.escapeHtml(P.plainNum(pick.target))}</dd></div>
    </dl>`;
  }

  function pickCard(pick) {
    const meta = [];
    if (pick.size) meta.push(pick.size);
    if (pick.confidence) meta.push(`confidence ${pick.confidence}`);
    if (pick.date) meta.push(pick.date);
    return `<article class="block">
      <div class="pick-top">
        <div>
          <div class="pick-ticker">${P.escapeHtml(pick.ticker || "No trade")}</div>
          ${pick.headline ? `<div class="pick-headline">${P.escapeHtml(pick.headline)}</div>` : ""}
        </div>
        ${P.actionPill(pick.action)}
      </div>
      ${levelBlock(pick)}
      ${pick.reason ? `<p class="pick-reason">${P.escapeHtml(pick.reason)}</p>` : ""}
      <div class="pc-grid">
        ${bullets("Pros", pick.pros, "pros")}
        ${bullets("Cons", pick.cons, "cons")}
      </div>
      ${
        pick.whyProsWin
          ? `<div class="verdict"><h4>Why the pros outweigh the cons</h4><p>${P.escapeHtml(
              pick.whyProsWin
            )}</p></div>`
          : ""
      }
      ${pick.plan ? `<p class="pick-plan">${P.escapeHtml(pick.plan)}</p>` : ""}
      ${meta.length ? `<p class="pick-meta">${P.escapeHtml(meta.join(" · "))}</p>` : ""}
    </article>`;
  }

  function picksSection(account) {
    const picks = P.todaysPicks(account);
    if (!picks.length) return empty("No pick today for this account.");
    return picks.map(pickCard).join("");
  }

  function positionsSection(account, snapshot) {
    const rows = account.positions || [];
    const swing = P.isSwingAccount(account);
    if (!rows.length) {
      const note = P.displayValueNote(account) ? ` ${P.displayValueNote(account)}` : "";
      return empty(`No open positions.${note}`);
    }
    return rows
      .map((pos) => {
        const hold = swing ? P.holdDayLabel(pos, snapshot) : null;
        return `<article class="block pos-item">
          <div>
            <span class="pos-ticker">${P.escapeHtml(pos.ticker || "—")}</span>
            ${hold ? `<span class="hold">${P.escapeHtml(hold)}</span>` : ""}
          </div>
          <div class="pos-meta">
            <span>${P.escapeHtml(P.plainNum(pos.shares, 4))} sh @ ${P.escapeHtml(
              P.money(pos.avgPrice, account.currency)
            )}</span>
            <span>last ${P.escapeHtml(P.money(pos.lastPrice, account.currency))}</span>
            <span>value ${P.escapeHtml(P.money(pos.marketValue, account.currency))}</span>
            ${P.isNum(pos.stop) ? `<span>stop ${P.escapeHtml(P.plainNum(pos.stop))}</span>` : ""}
            ${P.isNum(pos.target) ? `<span>target ${P.escapeHtml(P.plainNum(pos.target))}</span>` : ""}
          </div>
          ${pos.note ? `<p class="pos-note">${P.escapeHtml(pos.note)}</p>` : ""}
        </article>`;
      })
      .join("");
  }

  function tradesSection(account) {
    const rows = window.PaperSeries
      ? window.PaperSeries.orderedTrades(account.trades)
      : (account.trades || []).slice();
    if (!rows.length) return empty("No trades yet for this account.");
    return `<div class="table-scroll"><table class="data-table">
      <thead>
        <tr>
          <th scope="col">When</th>
          <th scope="col">Side</th>
          <th scope="col">Ticker</th>
          <th scope="col" class="num">Shares</th>
          <th scope="col" class="num">Price</th>
          <th scope="col" class="num">Value</th>
          <th scope="col">Reason</th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map((t) => {
            const side = String(t.side || "").toUpperCase();
            const tone = side === "SELL" ? "neg-text" : side === "BUY" ? "pos-text" : "";
            return `<tr>
              <td class="num">${P.escapeHtml(P.formatDay(t.date, true))}${
                t.time ? `<br>${P.escapeHtml(t.time)}` : ""
              }</td>
              <td class="${tone}">${P.escapeHtml(side || "—")}</td>
              <td class="tick">${P.escapeHtml(t.ticker || "—")}</td>
              <td class="num">${P.escapeHtml(P.plainNum(t.shares, 4))}</td>
              <td class="num">${P.escapeHtml(P.money(t.price, account.currency))}</td>
              <td class="num">${P.escapeHtml(P.money(t.value, account.currency))}</td>
              <td class="reason">${P.escapeHtml(t.reason || "")}${
                t.confidence ? ` <span class="tag">${P.escapeHtml(t.confidence)}</span>` : ""
              }</td>
            </tr>`;
          })
          .join("")}
      </tbody>
    </table></div>`;
  }

  function chartSection(account) {
    const svg = P.equityChartSvg(account.equityCurve, {
      title: `${P.displayName(account)} equity`,
      baseline: account.startValue,
    });
    if (!svg) return empty("No equity marks yet for this account.");
    const bench = P.benchmarkLabel(account);
    return `<div class="block">
      <div class="chart-legend">
        <span><i class="swatch"></i>${P.escapeHtml(P.displayName(account))}</span>
        <span><i class="swatch bench"></i>${P.escapeHtml(bench)}</span>
      </div>
      ${svg}
      <p class="chart-foot">This account only, earliest mark on the left. A replay that starts in July keeps those dates. Dashed line is ${P.escapeHtml(
        bench
      )}.</p>
    </div>`;
  }

  function projectionStanding(account) {
    const actual = account.returnPct;
    const p = account.projection;
    if (!p || typeof p !== "object") return { label: "no projection on this snapshot", cls: "" };
    if (!P.isNum(actual)) return { label: "no mark yet", cls: "" };
    if (P.isNum(p.bear) && actual < p.bear) return { label: "below bear — flag", cls: "warn" };
    if (P.isNum(p.bull) && actual > p.bull) return { label: "above bull — flag", cls: "warn" };
    if (P.isNum(p.baseLow) && P.isNum(p.baseHigh)) {
      if (actual >= p.baseLow && actual <= p.baseHigh) {
        return { label: "inside base range", cls: "ok" };
      }
      if (actual < p.baseLow) return { label: "below base range", cls: "" };
      return { label: "above base range", cls: "" };
    }
    return { label: "marked", cls: "" };
  }

  function projectionSection(account) {
    const p = account.projection;
    if (!p || typeof p !== "object") {
      return empty("No projection vs actual for this account.");
    }
    const standing = projectionStanding(account);
    const cells = [
      ["Bear", p.bear],
      ["Base low", p.baseLow],
      ["Base high", p.baseHigh],
      ["Bull", p.bull],
      ["Actual", account.returnPct],
    ];
    return `<article class="block">
      <dl class="proj-grid">
        ${cells
          .map(
            ([label, value]) => `<div>
              <dt>${P.escapeHtml(label)}</dt>
              <dd class="${label === "Actual" ? P.toneText(value) : ""}">${P.escapeHtml(P.pct(value))}</dd>
            </div>`
          )
          .join("")}
      </dl>
      <p class="proj-sit">
        <span class="tag ${standing.cls === "ok" ? "ok" : standing.cls === "warn" ? "warn" : ""}">${P.escapeHtml(
          standing.label
        )}</span>
        <span>This account’s return against the range written for it on day 1 — not a cross-account table.</span>
      </p>
      ${p.note ? `<p class="proj-note">${P.escapeHtml(p.note)}</p>` : ""}
    </article>`;
  }

  function lessonsSection(account) {
    const rows = (account.lessons || [])
      .slice()
      .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    if (!rows.length) return empty("No lessons logged yet for this account.");
    return rows
      .map(
        (lesson) => `<article class="block lesson">
          <div class="lesson-head">
            <span class="mono">${P.escapeHtml(P.formatDay(lesson.date) || lesson.date || "undated")}</span>
            <span class="tag ${
              String(lesson.errorType || "").toLowerCase() === "none" ? "ok" : "warn"
            }">${P.escapeHtml(lesson.errorType || "none")}</span>
            ${lesson.status ? `<span class="tag">${P.escapeHtml(lesson.status)}</span>` : ""}
          </div>
          ${lesson.what ? `<p><b>What happened</b> ${P.escapeHtml(lesson.what)}</p>` : ""}
          ${lesson.fix ? `<p><b>Fix applied</b> ${P.escapeHtml(lesson.fix)}</p>` : ""}
        </article>`
      )
      .join("");
  }

  function strategySection(account) {
    const s = account.strategy;
    if (!s) return empty("No strategy summary on this snapshot.");
    const rules = Array.isArray(s.rules) ? s.rules.filter(Boolean) : [];
    const bench = s.benchmark || P.benchmarkLabel(account);
    const summary =
      String(account.id || "") === "us-day" && /paused/i.test(String(s.summary || ""))
        ? ""
        : s.summary || "";
    return `<article class="block strategy">
      ${summary ? `<p>${P.escapeHtml(summary)}</p>` : ""}
      ${s.framing ? `<p class="framing">${P.escapeHtml(s.framing)}</p>` : ""}
      ${bench ? `<p class="framing">Measured against ${P.escapeHtml(bench)}.</p>` : ""}
      ${rules.length ? `<ul>${rules.map((r) => `<li>${P.escapeHtml(r)}</li>`).join("")}</ul>` : ""}
      ${
        s.reviewMetrics
          ? `<p class="review"><b>Reviewed on</b> ${P.escapeHtml(s.reviewMetrics)}</p>`
          : ""
      }
    </article>`;
  }

  function pausedBanner(account) {
    if (!P.isAccountPaused(account)) return "";
    return `<div class="paused-banner" role="status">
      <b>Paused</b>
      <p>${P.escapeHtml(
        P.displayValueNote(account) || "This account is paused. Marks stay on the board; no new picks or trades."
      )}</p>
    </div>`;
  }

  function shownMoney(value, currency, decimals) {
    if (!P.isNum(value)) return "—";
    return P.money(value, currency, decimals);
  }

  function hero(account, snapshot) {
    const paused = P.isAccountPaused(account);
    const blurb = P.accountBlurb(account);
    const delta = P.benchmarkDelta(account);
    const bench = P.benchmarkLabel(account);
    const vs = P.isNum(delta)
      ? `<span class="${P.toneText(delta)}">${delta > 0 ? "+" : ""}${delta.toFixed(2)} pts vs ${P.escapeHtml(
          bench
        )}</span>`
      : "";
    const ret = P.isNum(account.returnPct)
      ? `<span class="hc-return ${P.toneText(account.returnPct)}">${P.escapeHtml(P.pct(account.returnPct))}</span>`
      : "";
    return `${pausedBanner(account)}
      <header class="acct-hero">
        <p class="acct-kicker">${P.escapeHtml(account.id || "")}${
          snapshot.day != null ? ` · day ${snapshot.day} of ${snapshot.totalDays || 10}` : ""
        }</p>
        <h1>${P.escapeHtml(P.displayName(account))}</h1>
        ${blurb ? `<p class="hc-blurb">${P.escapeHtml(blurb)}</p>` : ""}
        <div class="acct-value-row">
          <span class="hc-value">${P.escapeHtml(P.accountValueText(account))}</span>
          ${ret}
        </div>
        <dl class="acct-stats">
          <div class="acct-stat">
            <dt>Started</dt>
            <dd>${P.escapeHtml(shownMoney(account.startValue, account.currency, 0))}</dd>
          </div>
          <div class="acct-stat">
            <dt>Cash</dt>
            <dd>${P.escapeHtml(shownMoney(account.cash, account.currency))}</dd>
          </div>
          ${
            vs
              ? `<div class="acct-stat">
            <dt>vs ${P.escapeHtml(bench)}</dt>
            <dd>${vs}</dd>
          </div>`
              : ""
          }
          <div class="acct-stat">
            <dt>Status</dt>
            <dd>${P.escapeHtml(P.displayStatus(account).replace(/^./, (c) => c.toUpperCase()))}</dd>
          </div>
        </dl>
        ${
          P.displayValueNote(account) && !paused
            ? `<p class="section-intro" style="margin-top:16px">${P.escapeHtml(P.displayValueNote(account))}</p>`
            : ""
        }
      </header>`;
  }

  function compactHead(account, snapshot, extraHtml) {
    const blurb = P.accountBlurb(account);
    return `${pausedBanner(account)}
      <header class="detail-head">
        <div>
          <p class="acct-kicker">${P.escapeHtml(account.id || "")}${
            snapshot.day != null ? ` · day ${snapshot.day} of ${snapshot.totalDays || 10}` : ""
          }</p>
          <h2>${P.escapeHtml(P.displayName(account))}</h2>
          ${blurb ? `<p class="hc-blurb">${P.escapeHtml(blurb)}</p>` : ""}
          ${extraHtml || ""}
        </div>
        <a class="page-link" href="${P.accountHref(account)}">Full page →</a>
      </header>`;
  }

  function watchlistBenchmarkHtml(account) {
    const line = P.watchlistBenchmarkLine(account);
    if (!line) return "";
    return `<p class="hc-bench wl-bench">${P.escapeHtml(line)}</p>`;
  }

  function watchlistHero(account, snapshot) {
    const blurb = P.accountBlurb(account);
    return `${pausedBanner(account)}
      <header class="acct-hero">
        <p class="acct-kicker">${P.escapeHtml(account.id || "")}${
          snapshot.day != null ? ` · day ${snapshot.day} of ${snapshot.totalDays || 10}` : ""
        }</p>
        <h1>${P.escapeHtml(P.displayName(account))}</h1>
        ${blurb ? `<p class="hc-blurb">${P.escapeHtml(blurb)}</p>` : ""}
        <div class="acct-value-row">
          <span class="hc-value wl-summary">${P.escapeHtml(P.watchlistSummary(account))}</span>
        </div>
        ${watchlistBenchmarkHtml(account)}
        <p class="section-intro">Research list — no paper balance on this account.</p>
      </header>`;
  }

  function isCoreFlag(value) {
    if (value === true || value === 1) return true;
    if (value === false || value === 0 || value == null || value === "") return false;
    const text = String(value).trim().toLowerCase();
    return text === "true" || text === "yes";
  }

  function ratioPct(value) {
    if (value == null || value === "") return "—";
    if (value === "inf" || value === "Infinity" || value === Infinity) return "∞";
    const num = Number(value);
    if (!Number.isFinite(num)) return "—";
    return `${(num * 100).toFixed(0)}%`;
  }

  function firstField(row, keys) {
    for (const key of keys) {
      if (row && row[key] != null && row[key] !== "") return row[key];
    }
    return null;
  }

  function takenLabel(value) {
    if (value === true) return "yes";
    if (value === false) return "no";
    return "—";
  }

  function signalsSection(account) {
    if (!Object.prototype.hasOwnProperty.call(account, "signals")) return "";
    const rows = Array.isArray(account.signals) ? account.signals : [];
    const esc = P.escapeHtml;
    const table = rows.length
      ? `<div class="table-scroll"><table class="data-table">
          <thead><tr><th>Date</th><th>Ticker</th><th>Trigger</th><th>Taken</th><th>Reason</th></tr></thead>
          <tbody>${rows
            .map(
              (row) => `<tr>
                <td>${esc(P.formatDay(row.date))}</td>
                <td class="tick">${esc(row.ticker || "—")}</td>
                <td>${esc(row.trigger || "—")}</td>
                <td>${esc(takenLabel(row.taken))}</td>
                <td class="reason">${esc(row.why || row.reason || "—")}</td>
              </tr>`
            )
            .join("")}</tbody></table></div>`
      : empty("No signals in this snapshot.");
    return `<section class="section"><div class="section-label">Signal log</div>
      <p class="section-intro">Every trigger this account recorded, including the ones not taken.</p>
      ${table}</section>`;
  }

  /** Long-term watchlist view (account.kind === "watchlist"): hot today + graded list. Data only from the sync doc. */
  function watchlistDetailHtml(account, snapshot, opts) {
    const head = opts.compact
      ? compactHead(account, snapshot, watchlistBenchmarkHtml(account))
      : watchlistHero(account, snapshot);
    const w = account.watchlist || {};
    const rows = Array.isArray(w.items) ? w.items : [];
    const hot = Array.isArray(account.hotToday) ? account.hotToday : [];
    const esc = P.escapeHtml;
    const hotHtml = hot.length
      ? `<div class="wl-scroll"><table class="wl-table"><thead><tr><th>Ticker</th><th>Grade</th><th>Day %</th><th>Vol x</th><th>Why</th></tr></thead><tbody>${hot
          .map((h) => {
            const chg =
              h.chg_pct == null || h.chg_pct === "" || !Number.isFinite(Number(h.chg_pct))
                ? "—"
                : Number(h.chg_pct).toFixed(2);
            const chgClass =
              chg === "—" ? "" : Number(h.chg_pct) < 0 ? "neg-text" : Number(h.chg_pct) > 0 ? "pos-text" : "";
            return `<tr><td class="wl-tick">${esc(h.ticker)}</td><td class="wl-grade ${P.gradeClass(
              h.grade
            )}">${esc(h.grade || "—")}</td><td class="${chgClass}">${esc(chg)}</td><td>${
              h.vol_x == null || h.vol_x === "" ? "—" : esc(String(h.vol_x))
            }</td><td>${esc(h.why || "")}</td></tr>`;
          })
          .join("")}</tbody></table></div>`
      : empty("Nothing hot today.");
    const listHtml = rows.length
      ? `<div class="wl-scroll"><table class="wl-table"><thead><tr><th>Grade</th><th>Ticker</th><th>ROIC</th><th>GM</th><th>Rev g</th><th>D/E</th><th>Disruption</th><th>Note</th></tr></thead><tbody>${rows
          .map(
            (r) =>
              `<tr><td class="wl-grade ${P.gradeClass(r.grade)}">${esc(r.grade || "—")}</td><td class="wl-tick">${esc(
                r.ticker
              )}${isCoreFlag(r.core) ? " ★" : ""}</td><td>${ratioPct(firstField(r, ["ROIC", "roic3"]))}</td><td>${ratioPct(
                firstField(r, ["GM", "gm3"])
              )}</td><td>${ratioPct(firstField(r, ["rev_growth", "rev_g"]))}</td><td>${
                firstField(r, ["DE", "netdebt_ebitda"]) == null
                  ? "—"
                  : esc(String(firstField(r, ["DE", "netdebt_ebitda"])))
              }</td><td>${esc(r.disruption || "—")}</td><td>${esc(
                r.note || (Array.isArray(r.fails) && r.fails.length ? r.fails.join(", ") : "") || r.disruption_why || ""
              )}</td></tr>`
          )
          .join("")}</tbody></table></div>`
      : empty("No watchlist on this snapshot.");
    const hotIntro = w.hotAsOf ? `Prices as of ${w.hotAsOf}. ` : "";
    const listIntro = `${w.rubric || ""}${w.asOf ? `${w.rubric ? " " : ""}As of ${w.asOf}.` : ""} The full table, with every grade input, is on the Watchlist page.`;
    return `${head}
      <div class="detail-grid">
        <div class="detail-col detail-col-left">
          <section class="section"><div class="section-label">Hot today</div>
            <p class="section-intro">${esc(`${hotIntro}Research only — not advice.`)}</p>${hotHtml}</section>
        </div>
        <div class="detail-col detail-col-mid detail-col-watchlist">
          <section class="section"><div class="section-label">Graded watchlist</div>
            <p class="section-intro">${esc(listIntro)}</p>
            <p class="section-intro"><a class="page-link" href="/watchlist">Open the full watchlist</a></p>
            ${listHtml}</section>
        </div>
      </div>`;
  }

  /**
   * One account’s four sections, in order. Used on / (compact) and /account/:id (full hero).
   * A watchlist account (kind "watchlist") renders the hot-today list and graded table instead.
   */
  function accountDetailHtml(account, snapshot, options) {
    const opts = options || {};
    if (P.isWatchlistAccount(account)) return watchlistDetailHtml(account, snapshot, opts);
    const prefix = opts.idPrefix || account.id || "acct";
    const head = opts.compact ? compactHead(account, snapshot) : hero(account, snapshot);
    const bench = P.benchmarkLabel(account);
    return `${head}
      <div class="detail-grid">
        <div class="detail-col detail-col-left">
          <section class="section" aria-labelledby="${prefix}-score">
            <div class="section-label" id="${prefix}-score">Scorecard</div>
            ${scorecardSection(account)}
          </section>
          <section class="section" aria-labelledby="${prefix}-picks">
            <div class="section-label" id="${prefix}-picks">Today's picks</div>
            <p class="section-intro">This account only.</p>
            ${picksSection(account)}
          </section>
        </div>
        <div class="detail-col detail-col-mid">
          <section class="section" aria-labelledby="${prefix}-trades">
            <div class="section-label" id="${prefix}-trades">Trades</div>
            <p class="section-intro">Open positions, then this account’s trade log.</p>
            ${positionsSection(account, snapshot)}
            ${tradesSection(account)}
            ${signalsSection(account)}
          </section>
        </div>
        <div class="detail-col detail-col-right">
          <section class="section" aria-labelledby="${prefix}-analysis">
            <div class="section-label" id="${prefix}-analysis">Analysis</div>
            <p class="section-intro">This account’s equity vs ${P.escapeHtml(
              bench
            )}, its own projection vs actual, then its self-fix log and rules.</p>
            <p class="history-label">Equity vs ${P.escapeHtml(bench)}</p>
            ${chartSection(account)}
            <p class="history-label">Projection vs actual</p>
            ${projectionSection(account)}
            <p class="history-label">Self-fix log</p>
            ${lessonsSection(account)}
            <p class="history-label">Strategy rules</p>
            ${strategySection(account)}
          </section>
        </div>
      </div>`;
  }

  P.projectionStanding = projectionStanding;
  P.accountDetailHtml = accountDetailHtml;
})(window);
