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

  const CHIP = {
    eject: { label: "Eject review", tone: "red", title: "Eject review" },
    promotion: { label: "Promotion candidate", title: "Promotion candidate, not promoted" },
    upgraded: { label: "Upgraded", title: "Upgraded C to B" },
  };

  function chipsFor(row) {
    const flags = row && Array.isArray(row.flags) ? row.flags : [];
    return flags.map((flag) => CHIP[String(flag)] || { label: B.flagLabel(flag) }).filter((chip) => chip.label);
  }

  function byScore(rows) {
    return rows.slice().sort((a, b) => {
      const left = typeof a.score === "number" && Number.isFinite(a.score) ? a.score : -1;
      const right = typeof b.score === "number" && Number.isFinite(b.score) ? b.score : -1;
      if (right !== left) return right - left;
      const rankA = typeof a.rank === "number" && Number.isFinite(a.rank) ? a.rank : 999;
      const rankB = typeof b.rank === "number" && Number.isFinite(b.rank) ? b.rank : 999;
      if (rankA !== rankB) return rankA - rankB;
      return String(a.ticker || "").localeCompare(String(b.ticker || ""));
    });
  }

  function detailHtml(row) {
    const bits = [];
    if (row.reason) bits.push(`<p>${P.escapeHtml(row.reason)}</p>`);
    const fullFlags = B.flagsFor(row);
    if (fullFlags.length) bits.push(`<p class="god-meta">${P.escapeHtml(fullFlags.join(" · "))}</p>`);
    const where = [row.exchange, P.isNum(row.score) ? `Score ${row.score} of 22` : ""].filter(Boolean);
    if (where.length) bits.push(`<p class="god-meta">${P.escapeHtml(where.join(" · "))}</p>`);
    bits.push(
      `<p class="god-meta">The file records the total out of 22. It does not list a separate score for each of the 11 tests on this name.</p>`
    );
    return bits.join("");
  }

  function compactRow(row) {
    const max = 22;
    const score = P.isNum(row.score) ? `${row.score}/${max}` : "—";
    return {
      ticker: row.ticker || "—",
      name: row.reason || "",
      grade: row.grade || "—",
      score,
      status: row.status || "",
      price: P.isNum(row.price) ? P.money(row.price, "USD") : "",
      flags: chipsFor(row),
      detailHtml: detailHtml(row),
    };
  }

  function render(doc) {
    const rows = byScore(B.ranked(doc));
    el("asof").textContent = doc.asof ? `Updated ${doc.asof}` : "Beta watchlist";
    el("count-line").textContent = `${rows.length} names, highest score first. Prices are the Oct 19, 2026 closes from the research file.`;
    const tests = el("test-names");
    if (tests) tests.innerHTML = listHtml(doc.tests);
    el("beta-list").innerHTML = window.CompactList.list(rows.map(compactRow));
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
