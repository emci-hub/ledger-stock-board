/**
 * Shared Practice Run helpers (home scoreboard + /account/:id).
 * No dependencies. Every number comes from GET /api/paper.
 */
(function (root) {
  "use strict";

  const GRADE_CATEGORIES = [
    ["analysis", "Analysis"],
    ["execution", "Execution"],
    ["risk", "Risk"],
    ["review", "Review"],
    ["result", "Result"],
  ];

  function groupsApi() {
    return root.AccountGroups || null;
  }

  /** A is the best letter on the long-term rubric; F is the worst. */
  const WATCHLIST_GRADE_RANK = { A: 0, B: 1, C: 2, D: 3, F: 4 };

  function isWatchlistAccount(account) {
    return String(account?.kind || "").toLowerCase() === "watchlist";
  }

  function watchlistItems(account) {
    const items = account?.watchlist?.items;
    return Array.isArray(items) ? items : [];
  }

  function topWatchlistGrade(items) {
    let best = null;
    let bestRank = Infinity;
    for (const item of items) {
      const letter = String(item?.grade || "")
        .trim()
        .charAt(0)
        .toUpperCase();
      const rank = WATCHLIST_GRADE_RANK[letter];
      if (rank == null || rank >= bestRank) continue;
      bestRank = rank;
      best = letter;
    }
    return best;
  }

  /** Scoreboard line for a watchlist account, e.g. "35 names · top grade A". */
  function watchlistSummary(account) {
    const items = watchlistItems(account);
    const names = `${items.length} name${items.length === 1 ? "" : "s"}`;
    const top = topWatchlistGrade(items);
    return top ? `${names} · top grade ${top}` : names;
  }

  function finiteMark(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function formatMarkNumber(value) {
    const rounded = Math.round(value * 100) / 100;
    return String(rounded);
  }

  /**
   * Benchmark line for a watchlist card. A missing level is omitted so the
   * card does not print "SPY —". A real zero still prints.
   */
  function watchlistBenchmarkLine(account) {
    const bench = account?.benchmark || {};
    const ticker = String(bench.ticker || "").trim();
    const hasValue = finiteMark(bench.value);
    const hasReturn = finiteMark(bench.returnPct);
    if (!hasValue && !hasReturn) return "";
    const valueText = hasValue ? formatMarkNumber(bench.value) : "—";
    const returnText = hasReturn ? `${formatMarkNumber(bench.returnPct)}%` : "—";
    return `${ticker ? `${ticker} ` : ""}${valueText} / ${returnText}`;
  }

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

  function sortAccountsForDisplay(accounts) {
    const api = groupsApi();
    if (api) return api.sortAccountsForDisplay(accounts);
    return Array.isArray(accounts) ? accounts.filter(Boolean) : [];
  }

  function isAccountPaused(account) {
    if (!account) return false;
    const profile = groupsApi() && groupsApi().profileFor(account.id);
    if (profile && profile.neverPaused) return false;
    if (account.paused === true) return true;
    return String(account.status || "").toLowerCase() === "paused";
  }

  function displayName(account) {
    const api = groupsApi();
    if (api) return api.displayName(account);
    return account?.name || account?.id || "Account";
  }

  function displayLabel(account) {
    if (groupsApi() && groupsApi().profileFor(account && account.id)) return "";
    if (account?.label && account.label !== account.name) return account.label;
    return "";
  }

  function displayStatus(account) {
    const profile = groupsApi() && groupsApi().profileFor(account && account.id);
    if (profile && profile.shelved) return "shelved";
    if (isAccountPaused(account)) return "paused";
    return "active";
  }

  function accountBlurb(account) {
    const api = groupsApi();
    return api ? api.blurbFor(account && account.id) : "";
  }

  function cardHref(account) {
    const profile = groupsApi() && groupsApi().profileFor(account && account.id);
    if (profile && profile.href) return profile.href;
    return accountHref(account);
  }

  function missingValueLabel() {
    return "Starts at next sync";
  }

  function accountValueText(account) {
    if (isWatchlistAccount(account)) return watchlistSummary(account);
    if (isNum(account?.value)) return money(account.value, account.currency);
    return missingValueLabel();
  }

  function groupSectionsHtml(accounts, renderCard) {
    const api = groupsApi();
    const sections = api
      ? api.groupAccounts(accounts)
      : [{ id: "all", title: "Accounts", summary: "", accounts: accounts || [], collapsed: false }];
    return sections
      .map((group) => {
        const cards = (group.accounts || []).map(renderCard).join("");
        const link = group.href
          ? `<a class="group-link" href="${escapeHtml(group.href)}">${escapeHtml(group.hrefLabel || "Open")}</a>`
          : "";
        const summaryTag = group.collapsed ? "span" : "p";
        const summary = group.summary
          ? `<${summaryTag} class="group-summary">${escapeHtml(group.summary)}</${summaryTag}>`
          : "";
        const grid = `<div class="card-grid">${cards}</div>`;
        const title = escapeHtml(group.title || "Accounts");
        if (group.collapsed) {
          return `<details class="acct-group is-muted">
            <summary>
              <span class="group-head"><span class="group-title">${title}</span>${link}</span>
              ${summary}
            </summary>
            ${grid}
          </details>`;
        }
        return `<section class="acct-group">
          <div class="group-head"><h2 class="group-title">${title}</h2>${link}</div>
          ${summary}
          ${grid}
        </section>`;
      })
      .join("");
  }

  /** Drop a leftover pause sentence on the long-term account. */
  function displayValueNote(account) {
    const note = account?.valueNote;
    if (note == null || note === "") return "";
    if (String(account?.id || "") === "us-day" && /paused/i.test(String(note))) return "";
    return String(note);
  }

  function isSwingAccount(account) {
    const id = String(account?.id || "").toLowerCase();
    const name = String(account?.name || "").toLowerCase();
    const label = String(account?.label || "").toLowerCase();
    return id.includes("swing") || name.includes("swing") || label.includes("swing");
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

  function formatDay(value, withYear) {
    if (!value) return "—";
    const asDate = String(value).slice(0, 10);
    const date = new Date(`${asDate}T12:00:00Z`);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      year: withYear ? "numeric" : undefined,
    }).format(date);
  }

  function markedRows(points) {
    if (root.PaperSeries) return root.PaperSeries.orderedMarks(points);
    return (points || []).filter((point) => isNum(point.value));
  }

  function accountBadge(account) {
    const profile = groupsApi() && groupsApi().profileFor(account && account.id);
    return profile && profile.badge ? profile.badge : "";
  }

  function parseDateValue(value) {
    if (!value) return null;
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value;
    }
    const raw = String(value);
    const isoDay = raw.match(/^(\d{4}-\d{2}-\d{2})/);
    if (isoDay) {
      const d = new Date(`${isoDay[1]}T12:00:00Z`);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function calendarDaysInclusive(from, to) {
    const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
    const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
    return Math.max(1, Math.round((b - a) / 86400000) + 1);
  }

  /** Swing holds are labelled Day N/15 (the Oct 15–29 window). */
  function holdDayLabel(position, snapshot) {
    if (!position) return null;
    if (isNum(position.holdDay)) return `Day ${Math.round(position.holdDay)}/15`;
    if (isNum(position.day) && position.day <= 31) return `Day ${Math.round(position.day)}/15`;
    const opened = parseDateValue(position.openedAt || position.opened || position.date);
    const asOf =
      parseDateValue(snapshot?.updatedAt) ||
      parseDateValue(snapshot?.run?.endDate) ||
      new Date();
    if (!opened) return null;
    return `Day ${calendarDaysInclusive(opened, asOf)}/15`;
  }

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

  function benchmarkLabel(account) {
    const ticker = account?.benchmark?.ticker;
    if (!ticker) return "benchmark";
    if (String(account.id) === "glb-branch" && ticker === "VOO") return "VOO / SPY";
    const extra = account.benchmark.reference || account.benchmark.also;
    return extra ? `${ticker} / ${extra}` : ticker;
  }

  function accountHref(account) {
    return `/account/${encodeURIComponent(account.id)}`;
  }

  function latestPickDate(picks) {
    let latest = null;
    (picks || []).forEach((pick) => {
      if (pick.date && (!latest || String(pick.date) > latest)) latest = String(pick.date);
    });
    return latest;
  }

  function todaysPicks(account) {
    const picks = account.picks || [];
    const date = latestPickDate(picks);
    if (!date) return picks;
    const onDate = picks.filter((pick) => !pick.date || pick.date === date);
    return onDate.length ? onDate : picks;
  }

  let gradientSeq = 0;

  function sparklineSvg(points) {
    const rows = markedRows(points);
    if (!rows.length) {
      return `<svg class="spark" viewBox="0 0 120 36" aria-hidden="true"></svg>`;
    }
    const W = 120;
    const H = 36;
    const pad = 3;
    const values = rows.map((p) => p.value);
    let min = Math.min.apply(null, values);
    let max = Math.max.apply(null, values);
    if (max - min < 0.0001) {
      min -= 1;
      max += 1;
    }
    const xAt = (i) =>
      rows.length === 1 ? W / 2 : pad + ((W - pad * 2) * i) / (rows.length - 1);
    const yAt = (v) => pad + (H - pad * 2) - ((v - min) / (max - min)) * (H - pad * 2);
    const d = rows.map((p, i) => `${i ? "L" : "M"}${xAt(i).toFixed(1)},${yAt(p.value).toFixed(1)}`).join(" ");
    const last = rows[rows.length - 1].value;
    const first = rows[0].value;
    const color = last >= first ? "#3ee0a0" : "#ff6b8a";
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" aria-hidden="true" preserveAspectRatio="none">
      <path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
    </svg>`;
  }

  function equityChartSvg(points, options) {
    const opts = options || {};
    const rows = markedRows(points);
    if (!rows.length) return null;
    const longHistory = root.PaperSeries ? root.PaperSeries.spanDays(rows) > 31 : rows.length > 24;

    const W = 640;
    const H = 280;
    const padL = 56;
    const padR = 16;
    const padT = 16;
    const padB = 36;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;

    const values = [];
    rows.forEach((p) => {
      values.push(p.value);
      if (isNum(p.benchmark)) values.push(p.benchmark);
    });
    let min = Math.min.apply(null, values);
    let max = Math.max.apply(null, values);
    const pad = (max - min) * 0.18;
    min -= pad;
    max += pad;
    const baseline = Math.abs(isNum(opts.baseline) ? opts.baseline : rows[0].value) || 1;
    const minSpan = baseline * 0.02;
    if (max - min < minSpan) {
      const mid = (max + min) / 2;
      min = mid - minSpan / 2;
      max = mid + minSpan / 2;
    }

    const xAt = (i) =>
      rows.length === 1 ? padL + innerW / 2 : padL + (innerW * i) / (rows.length - 1);
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
        return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="rgba(150,186,230,0.2)" stroke-width="1" />`;
      })
      .join("");
    const yLabels = [0, 0.5, 1]
      .map((t) => {
        const value = min + t * (max - min);
        const y = (padT + innerH - t * innerH).toFixed(1);
        return `<text x="${padL - 8}" y="${y}" text-anchor="end" dominant-baseline="middle" font-family="IBM Plex Mono, ui-monospace, sans-serif" font-size="12" fill="#c5d0e0">${escapeHtml(
          Math.round(value).toLocaleString("en-CA")
        )}</text>`;
      })
      .join("");
    const firstLabel = formatDay(rows[0].date, longHistory);
    const lastLabel = formatDay(rows[rows.length - 1].date, longHistory);
    const xLabels =
      `<text x="${padL}" y="${H - 10}" font-family="IBM Plex Mono, ui-monospace, sans-serif" font-size="12" fill="#c5d0e0">${escapeHtml(firstLabel)}</text>` +
      (rows.length > 1
        ? `<text x="${W - padR}" y="${H - 10}" text-anchor="end" font-family="IBM Plex Mono, ui-monospace, sans-serif" font-size="12" fill="#c5d0e0">${escapeHtml(lastLabel)}</text>`
        : "");
    const area =
      mine.length > 1
        ? `<path d="M${mine.join(" L")} L${xAt(rows.length - 1).toFixed(1)},${(padT + innerH).toFixed(1)} L${xAt(0).toFixed(1)},${(padT + innerH).toFixed(1)} Z" fill="url(#${gid})" />`
        : "";
    const benchPath =
      bench.length > 1
        ? `<path d="M${bench.join(" L")}" fill="none" stroke="#b9a0ff" stroke-width="2" stroke-dasharray="5 4" stroke-linejoin="round" />`
        : "";
    const minePath =
      mine.length > 1
        ? `<path d="M${mine.join(" L")}" fill="none" stroke="#3ee0ff" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" />`
        : "";
    const dots = rows
      .map((p, i) => {
        const last = i === rows.length - 1;
        const first = i === 0;
        if (longHistory && !first && !last) return "";
        const parts = [];
        if (isNum(p.benchmark) && (!longHistory || last)) {
          parts.push(
            `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(p.benchmark).toFixed(1)}" r="3" fill="#b9a0ff" />`
          );
        }
        parts.push(
          `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(p.value).toFixed(1)}" r="${last ? 5 : 3.2}" fill="#3ee0ff" stroke="#07090f" stroke-width="${last ? 2 : 0}" />`
        );
        return parts.join("");
      })
      .join("");
    const title = escapeHtml(
      `${opts.title || "Equity curve"}: ${rows.length} mark${rows.length === 1 ? "" : "s"} from ${firstLabel} to ${lastLabel}`
    );
    return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}" preserveAspectRatio="xMidYMid meet">
      <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#3ee0ff" stop-opacity="0.22" />
        <stop offset="100%" stop-color="#3ee0ff" stop-opacity="0" />
      </linearGradient></defs>
      ${gridLines}${yLabels}${xLabels}${area}${benchPath}${minePath}${dots}
    </svg>`;
  }

  function actionPill(action) {
    const value = String(action || "").toUpperCase();
    const known = ["BUY", "SELL", "HOLD", "FLAT"].includes(value) ? value : "FLAT";
    return `<span class="pill pill-${known.toLowerCase()}">${escapeHtml(value || known)}</span>`;
  }

  async function loadSnapshot() {
    const response = await fetch("/api/paper", { headers: { Accept: "application/json" } });
    if (response.status === 404) return { empty: true };
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const snapshot = await response.json();
    const accounts = sortAccountsForDisplay(
      Array.isArray(snapshot.accounts) ? snapshot.accounts : []
    );
    return { snapshot, accounts };
  }

  root.PracticeRun = {
    GRADE_CATEGORIES,
    escapeHtml,
    isNum,
    sortAccountsForDisplay,
    isAccountPaused,
    accountBadge,
    displayName,
    displayLabel,
    displayStatus,
    accountBlurb,
    cardHref,
    missingValueLabel,
    accountValueText,
    groupSectionsHtml,
    displayValueNote,
    isSwingAccount,
    isWatchlistAccount,
    watchlistSummary,
    watchlistBenchmarkLine,
    money,
    plainNum,
    pct,
    tone,
    toneText,
    formatMt,
    formatDay,
    holdDayLabel,
    normalizeGrade,
    gradeClass,
    benchmarkDelta,
    benchmarkLabel,
    accountHref,
    todaysPicks,
    sparklineSvg,
    equityChartSvg,
    actionPill,
    loadSnapshot,
  };
})(window);
