/**
 * Beta watchlist page. The list is the Oct 19 research file, not a paper balance.
 */
(function () {
  "use strict";

  const P = window.PracticeRun;
  const B = window.BetaWatchlist;
  const el = (id) => document.getElementById(id);

  function showState(message, isError) {
    const node = el("state-msg");
    node.hidden = false;
    node.textContent = message;
    node.className = isError ? "state-msg err" : "state-msg";
    el("dash").hidden = true;
  }

  function listHtml(items) {
    return (items || []).map((item) => `<li>${P.escapeHtml(String(item))}</li>`).join("");
  }

  function rowHtml(row) {
    const flags = B.flagsFor(row);
    const price = P.isNum(row.price) ? P.money(row.price, "USD") : "—";
    const max = 22;
    return `<tr>
      <td class="tick" data-label="Ticker">${P.escapeHtml(row.ticker || "—")}${row.reason ? `<span class="subname">${P.escapeHtml(row.reason)}</span>` : ""}</td>
      <td class="num" data-label="Score">${P.escapeHtml(String(row.score))} / ${max}</td>
      <td class="wl-grade" data-label="Grade">${P.escapeHtml(row.grade || "—")}</td>
      <td data-label="Status">${row.status ? `<span class="status-pill">${P.escapeHtml(row.status)}</span>` : "—"}</td>
      <td class="num" data-label="Price">${P.escapeHtml(price)}</td>
      <td data-label="Flags">${flags.length ? flags.map((flag) => `<span class="status-pill">${P.escapeHtml(flag)}</span>`).join(" ") : "—"}</td>
    </tr>`;
  }

  function render(doc) {
    const rows = B.ranked(doc);
    el("asof").textContent = doc.asof ? `Updated ${doc.asof}` : "Beta watchlist";
    el("count-line").textContent = `${rows.length} names, highest score first. Prices are the Oct 19, 2026 closes from the research file.`;
    el("beta-table").innerHTML = `<thead><tr>
      <th>Ticker</th><th class="num">Score</th><th>Grade</th><th>Status</th><th class="num">Price</th><th>Flags</th>
    </tr></thead><tbody>${rows.map(rowHtml).join("")}</tbody>`;
    el("grade-cuts").innerHTML = listHtml((doc.grades || []).map((grade) => `${grade.letter}: ${grade.rule}`));
    el("eject-rules").innerHTML = listHtml(doc.eject);
    el("change-log").innerHTML = listHtml(doc.changelog);
    el("state-msg").hidden = true;
    el("dash").hidden = false;
  }

  async function load() {
    let doc;
    try {
      const response = await fetch("/api/beta-watchlist", { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      doc = await response.json();
    } catch (err) {
      showState("Could not load the beta watchlist.", true);
      return;
    }
    if (!doc || !Array.isArray(doc.names)) {
      showState("The beta watchlist file has no names.", false);
      return;
    }
    render(doc);
  }

  load();
})();
