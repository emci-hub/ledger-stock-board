/**
 * Practice Run account page — /account/:id
 *
 * Looks the id up in GET /api/paper. Unknown ids still get a page (a "not in
 * this snapshot" message) rather than being silently skipped. Section order:
 * scorecard → today's picks → trades → analysis.
 */
(function () {
  "use strict";

  const P = window.PracticeRun;
  const el = (id) => document.getElementById(id);

  function accountIdFromPath() {
    const parts = window.location.pathname.split("/").filter(Boolean);
    if (parts[0] !== "account" || !parts[1]) return "";
    try {
      return decodeURIComponent(parts[1]);
    } catch {
      return parts[1];
    }
  }

  function showState(message, isError) {
    const node = el("state-msg");
    node.hidden = false;
    node.textContent = message;
    node.className = isError ? "state-msg err" : "state-msg";
    el("page").hidden = true;
  }

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
    if (!cards.length) {
      return empty("No scorecard yet for this account.");
    }
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
    if (!picks.length) return empty("No pick today.");
    return picks.map(pickCard).join("");
  }

  function positionsSection(account, snapshot) {
    const rows = account.positions || [];
    const swing = P.isSwingAccount(account);
    if (!rows.length) {
      const note = account.valueNote ? ` ${account.valueNote}` : "";
      return empty(`No open positions.${note}`);
    }
    return rows
      .map((pos) => {
        const hold = swing ? P.holdDayLabel(pos, snapshot) : null;
        return `<article class="block pos-item">
          <div>
            <span class="tick">${P.escapeHtml(pos.ticker || "—")}</span>
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
    const rows = (account.trades || []).slice().sort((a, b) => {
      const da = `${a.date || ""} ${a.time || ""}`;
      const db = `${b.date || ""} ${b.time || ""}`;
      return db.localeCompare(da);
    });
    if (!rows.length) return empty("No trades yet.");
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
              <td class="num">${P.escapeHtml(P.formatDay(t.date))}${
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
    if (!svg) return empty("No equity marks yet.");
    const bench = P.benchmarkLabel(account);
    return `<div class="block">
      <div class="chart-legend">
        <span><i class="swatch"></i>${P.escapeHtml(P.displayName(account))}</span>
        <span><i class="swatch bench"></i>${P.escapeHtml(bench)}</span>
      </div>
      ${svg}
      <p class="chart-foot">Indexed to this account’s own starting value. Dashed line is ${P.escapeHtml(
        bench
      )}.</p>
    </div>`;
  }

  function lessonsSection(account) {
    const rows = (account.lessons || [])
      .slice()
      .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    if (!rows.length) return empty("No lessons logged yet.");
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
    return `<article class="block strategy">
      ${s.summary ? `<p>${P.escapeHtml(s.summary)}</p>` : ""}
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

  function hero(account, snapshot) {
    const paused = P.isAccountPaused(account);
    const label = P.displayLabel(account);
    const delta = P.benchmarkDelta(account);
    const bench = P.benchmarkLabel(account);
    const vs = P.isNum(delta)
      ? `<span class="${P.toneText(delta)}">${delta > 0 ? "+" : ""}${delta.toFixed(2)} pts vs ${P.escapeHtml(
          bench
        )}</span>`
      : `<span class="flat-text">vs ${P.escapeHtml(bench)} unavailable</span>`;
    const banner = paused
      ? `<div class="paused-banner" role="status">
          <b>Paused</b>
          <p>${P.escapeHtml(
            account.valueNote || "This account is paused. Marks stay on the board; no new picks or trades."
          )}</p>
        </div>`
      : "";
    return `${banner}
      <header class="acct-hero">
        <p class="acct-kicker">${P.escapeHtml(account.id || "")}${
          snapshot.day != null ? ` · day ${snapshot.day} of ${snapshot.totalDays || 10}` : ""
        }</p>
        <h1>${P.escapeHtml(P.displayName(account))}</h1>
        ${label ? `<p class="hc-label">${P.escapeHtml(label)}</p>` : ""}
        <div class="acct-value-row">
          <span class="hc-value">${P.escapeHtml(P.money(account.value, account.currency))}</span>
          <span class="hc-return ${P.toneText(account.returnPct)}">${P.escapeHtml(
            P.pct(account.returnPct)
          )}</span>
        </div>
        <dl class="acct-stats">
          <div class="acct-stat">
            <dt>Started</dt>
            <dd>${P.escapeHtml(P.money(account.startValue, account.currency, 0))}</dd>
          </div>
          <div class="acct-stat">
            <dt>Cash</dt>
            <dd>${P.escapeHtml(P.money(account.cash, account.currency))}</dd>
          </div>
          <div class="acct-stat">
            <dt>vs ${P.escapeHtml(bench)}</dt>
            <dd>${vs}</dd>
          </div>
          <div class="acct-stat">
            <dt>Status</dt>
            <dd>${paused ? "Paused" : "Active"}</dd>
          </div>
        </dl>
        ${
          account.valueNote && !paused
            ? `<p class="section-intro" style="margin-top:16px">${P.escapeHtml(account.valueNote)}</p>`
            : ""
        }
      </header>`;
  }

  function renderAccount(account, snapshot) {
    document.title = `${P.displayName(account)} — Practice Run — Ledger`;
    el("page").innerHTML = `
      ${hero(account, snapshot)}
      <section class="section" aria-labelledby="score-label">
        <div class="section-label" id="score-label">Scorecard</div>
        ${scorecardSection(account)}
      </section>
      <section class="section" aria-labelledby="picks-label">
        <div class="section-label" id="picks-label">Today's picks</div>
        ${picksSection(account)}
      </section>
      <section class="section" aria-labelledby="trades-label">
        <div class="section-label" id="trades-label">Trades</div>
        <p class="section-intro">Open positions, then the trade log.</p>
        ${positionsSection(account, snapshot)}
        ${tradesSection(account)}
      </section>
      <section class="section" aria-labelledby="analysis-label">
        <div class="section-label" id="analysis-label">Analysis</div>
        <p class="section-intro">Equity vs ${P.escapeHtml(P.benchmarkLabel(account))}, then the self-fix log and the rules this account is measured on.</p>
        ${chartSection(account)}
        <p class="history-label">Self-fix log</p>
        ${lessonsSection(account)}
        <p class="history-label">Strategy rules</p>
        ${strategySection(account)}
      </section>
      <p class="disclaimer" role="note">
        <strong>Pretend money, not financial advice.</strong>
        <span>Updated ${P.escapeHtml(P.formatMt(snapshot.updatedAt))} MT. Every number is from the synced snapshot.</span>
      </p>
    `;
    el("state-msg").hidden = true;
    el("page").hidden = false;
  }

  async function load() {
    const id = accountIdFromPath();
    if (!id) {
      showState("No account id in the URL. Go back to all accounts.", true);
      return;
    }

    let result;
    try {
      result = await P.loadSnapshot();
    } catch (err) {
      showState(
        err && /HTTP/.test(err.message)
          ? `The practice run could not be loaded (${err.message}).`
          : "Could not reach the server to load this account.",
        true
      );
      return;
    }

    if (result.empty) {
      showState("No practice-run snapshot has been synced yet.", false);
      return;
    }

    const account = result.accounts.find((row) => String(row.id) === id);
    if (!account) {
      const known = result.accounts.map((row) => row.id).filter(Boolean);
      showState(
        `Account “${id}” is not in the latest snapshot.${
          known.length ? ` Synced ids: ${known.join(", ")}.` : ""
        }`,
        true
      );
      return;
    }

    renderAccount(account, result.snapshot);
  }

  load();
})();
