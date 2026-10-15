/**
 * Practice Run dashboard — renders the snapshot served by GET /api/paper.
 *
 * Read-only and dependency-free: every number on the page comes from the synced
 * snapshot, and anything the snapshot doesn't carry renders as "unavailable"
 * rather than an estimate (CLAUDE.md rule 1). Charts are hand-built SVG.
 */

(function () {
  "use strict";

  const GRADE_CATEGORIES = [
    ["analysis", "Analysis"],
    ["execution", "Execution"],
    ["risk", "Risk"],
    ["review", "Review"],
    ["result", "Result"],
  ];

  const el = (id) => document.getElementById(id);
  let activeAccountId = null;

  /* ------------------------------------------------------------------ utils */

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function isNum(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function currencyPrefix(currency) {
    if (currency === "CAD") return "C$";
    if (currency === "USD") return "US$";
    return currency ? `${currency} ` : "$";
  }

  function money(value, currency, decimals = 2) {
    if (!isNum(value)) return "unavailable";
    return (
      currencyPrefix(currency) +
      value.toLocaleString("en-CA", {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })
    );
  }

  function plainNum(value, decimals = 2) {
    if (!isNum(value)) return "—";
    return value.toLocaleString("en-CA", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  }

  function pct(value, decimals = 2) {
    if (!isNum(value)) return "—";
    const sign = value > 0 ? "+" : "";
    return `${sign}${value.toFixed(decimals)}%`;
  }

  /** Tone of a number: positive, negative or flat (used for colour classes). */
  function tone(value) {
    if (!isNum(value)) return "flat";
    if (value > 0.0001) return "pos";
    if (value < -0.0001) return "neg";
    return "flat";
  }

  function toneText(value) {
    return `${tone(value)}-text`;
  }

  function formatMt(iso) {
    if (!iso) return "not synced yet";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return String(iso);
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Edmonton",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      }).format(date);
    } catch {
      return date.toISOString();
    }
  }

  function formatDay(value) {
    if (!value) return "—";
    const date = new Date(`${value}T12:00:00Z`);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
    }).format(date);
  }

  /** Grades arrive as "B" or { grade, note } — normalize both. */
  function normalizeGrade(value) {
    if (value == null) return { grade: null, note: null };
    if (typeof value === "string") return { grade: value.trim() || null, note: null };
    if (typeof value === "object") {
      return {
        grade: value.grade ? String(value.grade).trim() : null,
        note: value.note ? String(value.note) : null,
      };
    }
    return { grade: null, note: null };
  }

  function gradeClass(grade) {
    const letter = String(grade || "").trim().charAt(0).toUpperCase();
    return "ABCDF".includes(letter) ? `g-${letter.toLowerCase()}` : "g-na";
  }

  function benchmarkDelta(account) {
    const mine = account.returnPct;
    const theirs = account.benchmark ? account.benchmark.returnPct : null;
    if (!isNum(mine) || !isNum(theirs)) return null;
    return Number((mine - theirs).toFixed(2));
  }

  function isWinning(account) {
    const delta = benchmarkDelta(account);
    return isNum(delta) && delta > 0;
  }

  /** Where the actual return falls inside the projected bear→bull range. */
  function projectionStanding(account) {
    const actual = account.returnPct;
    const p = account.projection || {};
    if (!isNum(actual)) return { label: "no mark yet", cls: "" };
    if (isNum(p.bear) && actual < p.bear) return { label: "below bear — flag", cls: "bad" };
    if (isNum(p.bull) && actual > p.bull) return { label: "above bull — flag", cls: "warn" };
    if (isNum(p.baseLow) && isNum(p.baseHigh)) {
      if (actual >= p.baseLow && actual <= p.baseHigh) {
        return { label: "inside base range", cls: "ok" };
      }
      if (actual > p.baseHigh) return { label: "above base range", cls: "ok" };
      return { label: "under base range", cls: "warn" };
    }
    return { label: "no range given", cls: "" };
  }

  /* ------------------------------------------------------------- svg charts */

  let gradientSeq = 0;

  /**
   * Equity curve for one account against its benchmark, both in the account's
   * own currency. Pure SVG string — no chart library, no network.
   */
  function equityChartSvg(points, options) {
    const opts = options || {};
    const rows = (points || []).filter((p) => isNum(p.value));
    if (!rows.length) return null;

    const W = 340;
    const H = 168;
    const padL = 46;
    const padR = 10;
    const padT = 12;
    const padB = 26;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;

    const values = [];
    rows.forEach((p) => {
      values.push(p.value);
      if (isNum(p.benchmark)) values.push(p.benchmark);
    });
    let min = Math.min.apply(null, values);
    let max = Math.max.apply(null, values);
    if (max - min < 0.0001) {
      min -= Math.max(1, Math.abs(min) * 0.002);
      max += Math.max(1, Math.abs(max) * 0.002);
    } else {
      const pad = (max - min) * 0.18;
      min -= pad;
      max += pad;
    }

    const xAt = (i) => (rows.length === 1 ? padL + innerW / 2 : padL + (innerW * i) / (rows.length - 1));
    const yAt = (v) => padT + innerH - ((v - min) / (max - min)) * innerH;

    const line = (key) => {
      const pts = [];
      rows.forEach((p, i) => {
        if (isNum(p[key])) pts.push(`${xAt(i).toFixed(1)},${yAt(p[key]).toFixed(1)}`);
      });
      return pts;
    };

    const mine = line("value");
    const bench = line("benchmark");
    const gid = `eqgrad${++gradientSeq}`;

    const gridLines = [0, 0.5, 1]
      .map((t) => {
        const y = (padT + innerH - t * innerH).toFixed(1);
        return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#26302B" stroke-width="1" />`;
      })
      .join("");

    const yLabels = [0, 0.5, 1]
      .map((t) => {
        const value = min + t * (max - min);
        const y = (padT + innerH - t * innerH).toFixed(1);
        return `<text x="${padL - 7}" y="${y}" text-anchor="end" dominant-baseline="middle" font-family="IBM Plex Mono, monospace" font-size="9" fill="#5C6862">${escapeHtml(
          Math.round(value).toLocaleString("en-CA")
        )}</text>`;
      })
      .join("");

    const firstLabel = formatDay(rows[0].date);
    const lastLabel = formatDay(rows[rows.length - 1].date);
    const xLabels =
      `<text x="${padL}" y="${H - 7}" font-family="IBM Plex Mono, monospace" font-size="9" fill="#5C6862">${escapeHtml(firstLabel)}</text>` +
      (rows.length > 1
        ? `<text x="${W - padR}" y="${H - 7}" text-anchor="end" font-family="IBM Plex Mono, monospace" font-size="9" fill="#5C6862">${escapeHtml(lastLabel)}</text>`
        : "");

    const area =
      mine.length > 1
        ? `<path d="M${mine.join(" L")} L${xAt(rows.length - 1).toFixed(1)},${(padT + innerH).toFixed(1)} L${xAt(0).toFixed(1)},${(padT + innerH).toFixed(1)} Z" fill="url(#${gid})" />`
        : "";

    const benchPath =
      bench.length > 1
        ? `<path d="M${bench.join(" L")}" fill="none" stroke="#8B978F" stroke-width="1.6" stroke-dasharray="4 3" stroke-linejoin="round" />`
        : "";

    const minePath =
      mine.length > 1
        ? `<path d="M${mine.join(" L")}" fill="none" stroke="#4FB88A" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" />`
        : "";

    const dots = rows
      .map((p, i) => {
        const parts = [];
        if (isNum(p.benchmark)) {
          parts.push(
            `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(p.benchmark).toFixed(1)}" r="2" fill="#8B978F" />`
          );
        }
        const last = i === rows.length - 1;
        parts.push(
          `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(p.value).toFixed(1)}" r="${last ? 3.6 : 2.4}" fill="#4FB88A" stroke="#0D1210" stroke-width="${last ? 1.6 : 0}" />`
        );
        return parts.join("");
      })
      .join("");

    const title = escapeHtml(
      `${opts.title || "Equity curve"}: ${rows.length} mark${rows.length === 1 ? "" : "s"} from ${firstLabel} to ${lastLabel}`
    );

    return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}" preserveAspectRatio="xMidYMid meet">
      <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#4FB88A" stop-opacity="0.22" />
        <stop offset="100%" stop-color="#4FB88A" stop-opacity="0" />
      </linearGradient></defs>
      ${gridLines}${yLabels}${xLabels}${area}${benchPath}${minePath}${dots}
    </svg>`;
  }

  /* --------------------------------------------------------- render: header */

  function renderHeader(snapshot) {
    const run = snapshot.run || {};
    const day = isNum(snapshot.day) ? snapshot.day : null;
    const total = isNum(snapshot.totalDays) ? snapshot.totalDays : 10;
    el("day-pill").textContent = day ? `day ${day} of ${total}` : "paper trading";
    el("updated-label").innerHTML = `<span class="dot"></span>updated ${escapeHtml(
      formatMt(snapshot.updatedAt)
    )} MT`;

    const range =
      run.startDate && run.endDate
        ? `${formatDay(run.startDate)} – ${formatDay(run.endDate)}, ${String(run.endDate).slice(0, 4)}`
        : "";
    el("run-range").textContent = range;
    if (run.note) el("run-note").textContent = run.note;

    const metaBits = [];
    if (snapshot.meta?.source) metaBits.push(`source: ${snapshot.meta.source}`);
    if (snapshot.meta?.receivedAt) metaBits.push(`stored ${formatMt(snapshot.meta.receivedAt)} MT`);
    el("foot-meta").textContent = metaBits.join(" · ");
  }

  /* ----------------------------------------------------- render: scoreboard */

  function rangeBar(account) {
    const p = account.projection || {};
    const actual = account.returnPct;
    if (!isNum(p.bear) || !isNum(p.bull)) {
      return `<div class="range"><div class="range-foot">No projected range in this snapshot.</div></div>`;
    }
    const lo = Math.min(p.bear, isNum(actual) ? actual : p.bear);
    const hi = Math.max(p.bull, isNum(actual) ? actual : p.bull);
    const span = hi - lo || 1;
    const at = (v) => `${(((v - lo) / span) * 100).toFixed(1)}%`;

    const baseLow = isNum(p.baseLow) ? p.baseLow : null;
    const baseHigh = isNum(p.baseHigh) ? p.baseHigh : null;
    const base =
      baseLow != null && baseHigh != null
        ? `<div class="range-base" style="left:${at(baseLow)};right:${(100 - parseFloat(at(baseHigh))).toFixed(1)}%"></div>`
        : "";
    const zero = lo <= 0 && hi >= 0 ? `<div class="range-zero" style="left:${at(0)}"></div>` : "";
    const mark = isNum(actual)
      ? `<div class="range-mark ${tone(actual)}" style="left:${at(actual)}" title="Actual ${pct(actual)}"></div>`
      : "";
    const standing = projectionStanding(account);

    return `<div class="range">
      <div class="range-head"><span>bear ${pct(p.bear, 1)}</span><span>bull ${pct(p.bull, 1)}</span></div>
      <div class="range-track">${base}${zero}${mark}</div>
      <div class="range-foot">base ${
        baseLow != null && baseHigh != null ? `${pct(baseLow, 1)} to ${pct(baseHigh, 1)}` : "n/a"
      } · ${escapeHtml(standing.label)}</div>
    </div>`;
  }

  function scoreCard(account) {
    const delta = benchmarkDelta(account);
    const bench = account.benchmark || {};
    const winning = isWinning(account);

    return `<article class="score-card ${tone(account.returnPct)}" id="score-${escapeHtml(account.id)}">
      <div class="sc-head">
        <div>
          <div class="sc-name">${escapeHtml(account.name)}</div>
          <div class="sc-sub">${escapeHtml(account.label || "")}${
            account.label ? " · " : ""
          }${escapeHtml(account.currency || "")}</div>
        </div>
        ${winning ? '<span class="sc-badge" title="Ahead of its benchmark">winning</span>' : ""}
      </div>
      <div class="sc-value-row">
        <span class="sc-value">${escapeHtml(money(account.value, account.currency))}</span>
        <span class="sc-return ${toneText(account.returnPct)}">${escapeHtml(pct(account.returnPct))}</span>
      </div>
      <div class="sc-start">started ${escapeHtml(money(account.startValue, account.currency, 0))}${
        isNum(account.cash) ? ` · cash ${escapeHtml(money(account.cash, account.currency))}` : ""
      }</div>
      <dl class="sc-rows">
        <div class="sc-row">
          <dt>${escapeHtml(bench.ticker || "benchmark")}</dt>
          <dd>${escapeHtml(money(bench.value, account.currency))} <b class="${toneText(
            bench.returnPct
          )}">${escapeHtml(pct(bench.returnPct))}</b></dd>
        </div>
        <div class="sc-row">
          <dt>vs benchmark</dt>
          <dd class="${toneText(delta)}"><b>${
            isNum(delta) ? `${delta > 0 ? "+" : ""}${delta.toFixed(2)} pts` : "—"
          }</b></dd>
        </div>
      </dl>
      ${rangeBar(account)}
    </article>`;
  }

  function renderScoreboard(accounts) {
    el("score-grid").innerHTML = accounts.map(scoreCard).join("");
    const winners = accounts.filter(isWinning).map((a) => a.name);
    el("scoreboard-foot").textContent = winners.length
      ? `Ahead of benchmark: ${winners.join(", ")}. "Winning" only means the account is beating the index it is measured against.`
      : "No account is ahead of its benchmark at this mark.";
  }

  /* ---------------------------------------------------------- render: picks */

  function actionPill(action) {
    const value = String(action || "").toUpperCase();
    const known = ["BUY", "SELL", "HOLD", "FLAT"].includes(value) ? value : "FLAT";
    return `<span class="pill pill-${known.toLowerCase()}">${escapeHtml(value || known)}</span>`;
  }

  function levelBlock(pick) {
    if (Array.isArray(pick.levels) && pick.levels.length) {
      return `<div class="leg-list">${pick.levels
        .map(
          (leg) =>
            `<span class="leg"><b>${escapeHtml(leg.ticker || "")}</b> stop ${escapeHtml(
              plainNum(leg.stop)
            )} · target ${escapeHtml(plainNum(leg.target))}</span>`
        )
        .join("")}</div>`;
    }
    if (!isNum(pick.entry) && !isNum(pick.stop) && !isNum(pick.target)) return "";
    return `<dl class="levels">
      <div class="level"><dt>Entry</dt><dd>${escapeHtml(plainNum(pick.entry))}</dd></div>
      <div class="level stop"><dt>Stop</dt><dd>${escapeHtml(plainNum(pick.stop))}</dd></div>
      <div class="level target"><dt>Target</dt><dd>${escapeHtml(plainNum(pick.target))}</dd></div>
    </dl>`;
  }

  function bulletBlock(title, items, cls) {
    const list = Array.isArray(items) ? items.filter(Boolean) : [];
    if (!list.length) return "";
    return `<div class="pc ${cls}"><h4>${escapeHtml(title)}</h4><ul>${list
      .map((item) => `<li>${escapeHtml(item)}</li>`)
      .join("")}</ul></div>`;
  }

  function pickCard(account, pick) {
    const meta = [];
    if (pick.size) meta.push(pick.size);
    if (pick.confidence) meta.push(`confidence ${pick.confidence}`);
    if (pick.date) meta.push(pick.date);

    return `<article class="pick-card">
      <div class="pick-top">
        <div class="pick-id">
          <div class="pick-acct">${escapeHtml(account.name)}</div>
          <div class="pick-ticker">${escapeHtml(pick.ticker || "No trade")}</div>
          ${pick.headline ? `<div class="pick-headline">${escapeHtml(pick.headline)}</div>` : ""}
        </div>
        ${actionPill(pick.action)}
      </div>
      ${levelBlock(pick)}
      ${pick.reason ? `<p class="pick-reason">${escapeHtml(pick.reason)}</p>` : ""}
      <div class="pc-grid">
        ${bulletBlock("Pros", pick.pros, "pros")}
        ${bulletBlock("Cons", pick.cons, "cons")}
      </div>
      ${
        pick.whyProsWin
          ? `<div class="verdict"><h4>Why the pros outweigh the cons</h4><p>${escapeHtml(
              pick.whyProsWin
            )}</p></div>`
          : ""
      }
      ${pick.plan ? `<p class="pick-plan">${escapeHtml(pick.plan)}</p>` : ""}
      ${meta.length ? `<div class="pick-meta">${meta.map((m) => escapeHtml(m)).join(" · ")}</div>` : ""}
    </article>`;
  }

  function latestPickDate(accounts) {
    let latest = null;
    accounts.forEach((account) => {
      (account.picks || []).forEach((pick) => {
        if (pick.date && (!latest || String(pick.date) > latest)) latest = String(pick.date);
      });
    });
    return latest;
  }

  function renderPicks(accounts) {
    const date = latestPickDate(accounts);
    const cards = [];
    accounts.forEach((account) => {
      const picks = (account.picks || []).filter((pick) => !date || !pick.date || pick.date === date);
      if (!picks.length) {
        cards.push(`<article class="pick-card">
          <div class="pick-top">
            <div class="pick-id">
              <div class="pick-acct">${escapeHtml(account.name)}</div>
              <div class="pick-ticker">No pick recorded</div>
            </div>
            ${actionPill("FLAT")}
          </div>
          <p class="pick-reason">This snapshot carries no pick for ${escapeHtml(
            account.name
          )} on this date.</p>
        </article>`);
        return;
      }
      picks.forEach((pick) => cards.push(pickCard(account, pick)));
    });
    el("picks-grid").innerHTML = cards.join("");
    el("picks-date").textContent = date
      ? `What the rules said on ${formatDay(date)} — action, levels, and the honest case against each one.`
      : "Action, levels, and the honest case against each pick.";
  }

  /* --------------------------------------------------------- render: charts */

  function chartCard(account) {
    const bench = account.benchmark || {};
    const svg = equityChartSvg(account.equityCurve, { title: `${account.name} equity curve` });
    const marks = (account.equityCurve || []).filter((p) => isNum(p.value)).length;
    return `<article class="chart-card">
      <div class="chart-head">
        <span class="chart-title">${escapeHtml(account.name)}</span>
        <span class="mono" style="font-size:11px;color:var(--muted-dim)">${escapeHtml(
          account.currency || ""
        )}</span>
      </div>
      <div class="chart-legend">
        <span><i class="swatch"></i>${escapeHtml(account.name)} ${escapeHtml(pct(account.returnPct))}</span>
        <span><i class="swatch bench"></i>${escapeHtml(bench.ticker || "benchmark")} ${escapeHtml(
          pct(bench.returnPct)
        )}</span>
      </div>
      ${svg || '<div class="chart-empty">No marks in this snapshot yet.</div>'}
      <p class="chart-foot">${
        marks === 1
          ? "One mark so far — the curve fills in as each day syncs."
          : `${marks} daily marks, both lines in ${escapeHtml(account.currency || "account currency")}.`
      }</p>
    </article>`;
  }

  function renderCharts(accounts) {
    el("chart-grid").innerHTML = accounts.map(chartCard).join("");
  }

  /* ---------------------------------------------------- render: projections */

  function renderProjections(accounts) {
    el("proj-body").innerHTML = accounts
      .map((account) => {
        const p = account.projection || {};
        const standing = projectionStanding(account);
        const base =
          isNum(p.baseLow) && isNum(p.baseHigh) ? `${pct(p.baseLow, 1)} to ${pct(p.baseHigh, 1)}` : "—";
        return `<tr>
          <td class="tick">${escapeHtml(account.name)}</td>
          <td class="num neg-text">${escapeHtml(pct(p.bear, 1))}</td>
          <td class="num">${escapeHtml(base)}</td>
          <td class="num pos-text">${escapeHtml(pct(p.bull, 1))}</td>
          <td class="num ${toneText(account.returnPct)}"><b>${escapeHtml(pct(account.returnPct))}</b></td>
          <td><span class="tag ${standing.cls}">${escapeHtml(standing.label)}</span></td>
        </tr>`;
      })
      .join("");

    el("proj-notes").innerHTML = accounts
      .filter((account) => account.projection && account.projection.note)
      .map(
        (account) =>
          `<div class="proj-note"><b>${escapeHtml(account.name)}</b> — ${escapeHtml(
            account.projection.note
          )}</div>`
      )
      .join("");
  }

  /* ------------------------------------------------------- render: accounts */

  function positionsBlock(account) {
    const rows = account.positions || [];
    if (!rows.length) {
      return `<div class="panel-block"><p class="block-label">Open positions</p><div class="empty-note">Flat — no open positions in this snapshot.</div></div>`;
    }
    const body = rows
      .map((p) => {
        const gain =
          isNum(p.marketValue) && isNum(p.costBasis) ? p.marketValue - p.costBasis : null;
        return `<tr>
          <td class="tick">${escapeHtml(p.ticker || "—")}</td>
          <td class="num">${escapeHtml(plainNum(p.shares, 4))}</td>
          <td class="num">${escapeHtml(plainNum(p.avgPrice))}</td>
          <td class="num">${escapeHtml(isNum(p.lastPrice) ? plainNum(p.lastPrice) : "unavailable")}</td>
          <td class="num">${escapeHtml(
            isNum(p.marketValue) ? money(p.marketValue, account.currency) : "unavailable"
          )}</td>
          <td class="num ${toneText(gain)}">${escapeHtml(
            isNum(gain) ? money(gain, account.currency) : "—"
          )}</td>
          <td class="num neg-text">${escapeHtml(plainNum(p.stop))}</td>
          <td class="num pos-text">${escapeHtml(plainNum(p.target))}</td>
          <td class="reason">${escapeHtml(p.note || "")}</td>
        </tr>`;
      })
      .join("");

    return `<div class="panel-block">
      <p class="block-label">Open positions <span class="hint">prices the snapshot doesn't carry show as "unavailable"</span></p>
      <div class="table-scroll"><table class="data-table">
        <thead><tr>
          <th scope="col">Ticker</th><th scope="col" class="num">Shares</th><th scope="col" class="num">Avg cost</th>
          <th scope="col" class="num">Mark</th><th scope="col" class="num">Value</th><th scope="col" class="num">Open P&amp;L</th>
          <th scope="col" class="num">Stop</th><th scope="col" class="num">Target</th><th scope="col">Note</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table></div>
    </div>`;
  }

  function tradesBlock(account) {
    const rows = account.trades || [];
    if (!rows.length) {
      return `<div class="panel-block"><p class="block-label">Trade log</p><div class="empty-note">No trades recorded for this account yet.</div></div>`;
    }
    const body = rows
      .slice()
      .reverse()
      .map(
        (t) => `<tr>
          <td class="num">${escapeHtml(t.date || "")}${t.time ? `<br><span style="color:var(--muted-dim)">${escapeHtml(t.time)}</span>` : ""}</td>
          <td class="tick">${escapeHtml(t.ticker || "—")}</td>
          <td><span class="pill pill-${String(t.side || "").toLowerCase() === "sell" ? "sell" : "buy"}">${escapeHtml(
            String(t.side || "").toUpperCase() || "—"
          )}</span></td>
          <td class="num">${escapeHtml(plainNum(t.shares, 4))}</td>
          <td class="num">${escapeHtml(plainNum(t.price, 4))}</td>
          <td class="num">${escapeHtml(money(t.value, account.currency))}</td>
          <td class="num">${escapeHtml(t.confidence || "—")}</td>
          <td class="reason">${escapeHtml(t.reason || "")}</td>
        </tr>`
      )
      .join("");

    return `<div class="panel-block">
      <p class="block-label">Trade log <span class="hint">${rows.length} fill${
        rows.length === 1 ? "" : "s"
      }, newest first</span></p>
      <div class="table-scroll"><table class="data-table">
        <thead><tr>
          <th scope="col" class="num">When</th><th scope="col">Ticker</th><th scope="col">Side</th>
          <th scope="col" class="num">Shares</th><th scope="col" class="num">Price</th><th scope="col" class="num">Value</th>
          <th scope="col" class="num">Confidence</th><th scope="col">Reason</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table></div>
    </div>`;
  }

  function scorecardCard(card, isHistory) {
    const grades = card.grades || {};
    const cells = GRADE_CATEGORIES.map(([key, label]) => {
      const g = normalizeGrade(grades[key]);
      return `<div class="grade ${gradeClass(g.grade)}"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(
        g.grade || "—"
      )}</dd></div>`;
    }).join("");

    const notes = GRADE_CATEGORIES.map(([key, label]) => {
      const g = normalizeGrade(grades[key]);
      if (!g.note) return "";
      return `<div class="grade-note"><b>${escapeHtml(label)}</b> — ${escapeHtml(g.note)}</div>`;
    })
      .filter(Boolean)
      .join("");

    return `<article class="scorecard${isHistory ? " history" : ""}">
      <div class="sc-card-head">
        <span class="sc-date">${escapeHtml(formatDay(card.date) || card.date || "undated")}</span>
        ${card.derived ? '<span class="tag warn">derived from rubric</span>' : '<span class="tag">recorded card</span>'}
      </div>
      <dl class="grade-row">${cells}</dl>
      ${notes ? `<div class="grade-notes">${notes}</div>` : ""}
      <div class="weak-fix">
        ${
          card.weakest
            ? `<div class="weak"><b>Weakest part</b>${escapeHtml(card.weakest)}</div>`
            : ""
        }
        ${card.fix ? `<div class="fix"><b>Tomorrow's fix</b>${escapeHtml(card.fix)}</div>` : ""}
      </div>
      ${card.basis ? `<p class="derived-note">${escapeHtml(card.basis)}</p>` : ""}
    </article>`;
  }

  function scorecardsBlock(account) {
    const cards = (account.scorecards || [])
      .slice()
      .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    if (!cards.length) {
      return `<div class="panel-block"><p class="block-label">Daily scorecards</p><div class="empty-note">No scorecard has been synced for this account yet.</div></div>`;
    }
    return `<div class="panel-block">
      <p class="block-label">Daily scorecards <span class="hint">A-F per part, newest first</span></p>
      ${cards.map((card, idx) => scorecardCard(card, idx > 0)).join("")}
    </div>`;
  }

  function lessonsBlock(account) {
    const rows = account.lessons || [];
    if (!rows.length) return "";
    return `<div class="panel-block">
      <p class="block-label">Self-fix log</p>
      ${rows
        .slice()
        .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))
        .map(
          (lesson) => `<article class="lesson">
            <div class="lesson-head">
              <span class="mono">${escapeHtml(formatDay(lesson.date) || lesson.date || "undated")}</span>
              <span class="tag ${
                String(lesson.errorType || "").toLowerCase() === "none" ? "ok" : "warn"
              }">${escapeHtml(lesson.errorType || "none")}</span>
              ${lesson.status ? `<span class="tag">${escapeHtml(lesson.status)}</span>` : ""}
            </div>
            ${lesson.what ? `<p><b>What happened</b> ${escapeHtml(lesson.what)}</p>` : ""}
            ${lesson.fix ? `<p><b>Fix applied</b> ${escapeHtml(lesson.fix)}</p>` : ""}
          </article>`
        )
        .join("")}
    </div>`;
  }

  function strategyBlock(account) {
    const s = account.strategy;
    if (!s) return "";
    const rules = Array.isArray(s.rules) ? s.rules.filter(Boolean) : [];
    return `<div class="panel-block">
      <p class="block-label">Strategy summary${
        s.benchmark ? ` <span class="hint">measured against ${escapeHtml(s.benchmark)}</span>` : ""
      }</p>
      <div class="strategy">
        ${s.summary ? `<p>${escapeHtml(s.summary)}</p>` : ""}
        ${s.framing ? `<p class="framing">${escapeHtml(s.framing)}</p>` : ""}
        ${rules.length ? `<ul>${rules.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>` : ""}
        ${
          s.reviewMetrics
            ? `<p class="review"><b>Reviewed on</b> ${escapeHtml(s.reviewMetrics)}</p>`
            : ""
        }
      </div>
    </div>`;
  }

  function accountPanel(account) {
    return `<div class="panel" id="panel-${escapeHtml(account.id)}" role="tabpanel"
      aria-labelledby="tab-${escapeHtml(account.id)}" hidden>
      ${positionsBlock(account)}
      ${tradesBlock(account)}
      ${scorecardsBlock(account)}
      ${lessonsBlock(account)}
      ${strategyBlock(account)}
    </div>`;
  }

  function selectAccount(id) {
    activeAccountId = id;
    document.querySelectorAll("#account-tabs button").forEach((button) => {
      const selected = button.dataset.account === id;
      button.setAttribute("aria-selected", selected ? "true" : "false");
      button.tabIndex = selected ? 0 : -1;
    });
    document.querySelectorAll("#account-panels .panel").forEach((panel) => {
      panel.hidden = panel.id !== `panel-${id}`;
    });
  }

  function renderAccounts(accounts) {
    el("account-tabs").innerHTML = accounts
      .map(
        (account) =>
          `<button type="button" role="tab" id="tab-${escapeHtml(account.id)}"
            data-account="${escapeHtml(account.id)}" aria-selected="false"
            aria-controls="panel-${escapeHtml(account.id)}">${escapeHtml(account.name)}</button>`
      )
      .join("");
    el("account-panels").innerHTML = accounts.map(accountPanel).join("");

    el("account-tabs").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-account]");
      if (button) selectAccount(button.dataset.account);
    });

    if (accounts.length) selectAccount(activeAccountId || accounts[0].id);
  }

  /** Tapping a scoreboard card opens that account's detail panel. */
  function wireScoreboardJump(accounts) {
    el("score-grid").addEventListener("click", (event) => {
      const card = event.target.closest(".score-card");
      if (!card) return;
      const id = card.id.replace(/^score-/, "");
      if (!accounts.some((account) => account.id === id)) return;
      selectAccount(id);
      el("account-tabs").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  /* ------------------------------------------------------------------ boot */

  function showState(message, isError) {
    const node = el("state-msg");
    node.hidden = false;
    node.textContent = message;
    node.className = isError ? "state-msg err" : "state-msg";
  }

  async function load() {
    let response;
    try {
      response = await fetch("/api/paper", { headers: { Accept: "application/json" } });
    } catch (err) {
      showState("Could not reach the server to load the practice run.", true);
      return;
    }

    if (response.status === 404) {
      showState(
        "No practice-run snapshot has been synced yet. The dashboard fills in as soon as the first daily push lands.",
        false
      );
      return;
    }
    if (!response.ok) {
      showState(`The practice run could not be loaded (HTTP ${response.status}).`, true);
      return;
    }

    let snapshot;
    try {
      snapshot = await response.json();
    } catch {
      showState("The practice-run snapshot could not be read.", true);
      return;
    }

    const accounts = Array.isArray(snapshot.accounts) ? snapshot.accounts : [];
    if (!accounts.length) {
      showState("The latest snapshot has no accounts in it.", true);
      return;
    }

    renderHeader(snapshot);
    renderScoreboard(accounts);
    renderPicks(accounts);
    renderCharts(accounts);
    renderProjections(accounts);
    renderAccounts(accounts);
    wireScoreboardJump(accounts);

    el("state-msg").hidden = true;
    el("dash").hidden = false;
  }

  load();
})();
