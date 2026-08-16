/**
 * Index tier membership — fetches real, free, public index constituent lists
 * (S&P 500 / S&P 400 / S&P 600) from Wikipedia and derives:
 *   - tier: 1 (S&P 500), 2 (S&P 400 or S&P 600), 3 = not a member (default)
 *   - priority_rank: days-since-epoch of "Date added" — older membership
 *     ranks lower (= considered first). Real, free, zero extra API cost.
 *
 * IMPORTANT — disclosed limitation: this fetch/parse logic could not be
 * live-tested from the build sandbox (no network route to wikipedia.org
 * there). The HTTP fetch pattern and regex table parser are written to a
 * verified real page structure (confirmed via web_fetch earlier in the
 * design session — real columns: Symbol | Security | GICS Sector |
 * GICS Sub-Industry | Headquarters Location | Date added | CIK | Founded),
 * but the parser itself has not been executed against the live page. Run
 * scripts/smokeTestIndexTiers.js in an environment with real internet access
 * (Render, or locally) BEFORE relying on this in production — see that file.
 */

const axios = require("axios");

const SP500_URL = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies";
const SP400_URL = "https://en.wikipedia.org/wiki/List_of_S%26P_400_companies";
const SP600_URL = "https://en.wikipedia.org/wiki/List_of_S%26P_600_companies";

const EPOCH_MS = Date.UTC(1970, 0, 1);

function daysSinceEpoch(dateStr) {
  if (!dateStr) return null;
  const t = Date.parse(dateStr);
  if (!Number.isFinite(t)) return null;
  return Math.floor((t - EPOCH_MS) / 86400000);
}

/**
 * Parse a MediaWiki "wikitable sortable" HTML table into rows of cell text.
 * Regex-based (no cheerio dependency) — targeted at the FIRST such table on
 * the page, which is the constituent table on all three of these pages as of
 * the page structure confirmed during design (2026-08). If Wikipedia changes
 * table structure/class names, this returns [] rather than throwing or
 * silently returning garbage — callers must treat an empty result as
 * "refresh failed, keep prior tier data" not "no companies in this index."
 */
function parseFirstWikitable(html) {
  if (!html || typeof html !== "string") return [];
  const tableMatch = html.match(
    /<table[^>]*class="[^"]*wikitable[^"]*"[^>]*>([\s\S]*?)<\/table>/i
  );
  if (!tableMatch) return [];
  const tableHtml = tableMatch[1];

  const rowMatches = [...tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  if (rowMatches.length < 2) return []; // need header + at least 1 data row

  const rows = [];
  // Skip first row (header)
  for (let i = 1; i < rowMatches.length; i++) {
    const rowHtml = rowMatches[i][1];
    const cellMatches = [
      ...rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi),
    ];
    if (!cellMatches.length) continue;
    const cells = cellMatches.map((m) =>
      m[1]
        .replace(/<[^>]+>/g, "") // strip nested tags (links, spans, refs)
        .replace(/&amp;/g, "&")
        .replace(/&#\d+;/g, "")
        .trim()
    );
    rows.push(cells);
  }
  return rows;
}

/**
 * S&P 500 table columns (confirmed structure): Symbol | Security | GICS
 * Sector | GICS Sub-Industry | Headquarters Location | Date added | CIK |
 * Founded — Symbol is column 0, Date added is column 5.
 */
async function fetchSp500Membership() {
  const { data: html } = await axios.get(SP500_URL, {
    timeout: 15000,
    headers: { "User-Agent": "ledger-stock-board/1.0 (index tier fetch)" },
  });
  const rows = parseFirstWikitable(html);
  const out = new Map();
  for (const cells of rows) {
    const symbol = String(cells[0] || "").trim().toUpperCase();
    const dateAdded = cells[5] || null;
    if (!symbol) continue;
    out.set(symbol, {
      tier: 1,
      priorityRank: daysSinceEpoch(dateAdded) ?? null,
      dateAdded: dateAdded || null,
    });
  }
  return out;
}

/**
 * S&P 400 / 600 tables — confirmed structure lacks a "Date added" column
 * (Symbol | Security | GICS Sector | GICS Sub-Industry | Headquarters
 * Location | SEC filings | CIK). No free tenure signal available for tier 2
 * yet — priorityRank stays null, which correctly falls back to alphabetical
 * WITHIN tier 2 (honest degradation, not fabricated precision).
 */
async function fetchSp400Or600Membership(url) {
  const { data: html } = await axios.get(url, {
    timeout: 15000,
    headers: { "User-Agent": "ledger-stock-board/1.0 (index tier fetch)" },
  });
  const rows = parseFirstWikitable(html);
  const out = new Map();
  for (const cells of rows) {
    const symbol = String(cells[0] || "").trim().toUpperCase();
    if (!symbol) continue;
    out.set(symbol, { tier: 2, priorityRank: null, dateAdded: null });
  }
  return out;
}

/**
 * Fetch all 3 lists, merge (S&P 500 wins if a symbol somehow appears in more
 * than one — shouldn't happen in practice, S&P's indices are disjoint by
 * construction, but defensive anyway). Returns Map<symbol, {tier, priorityRank}>.
 * Any individual fetch failure logs and is treated as "no data from that
 * source this run" — never throws, never wipes prior good data.
 */
async function fetchAllIndexMembership() {
  const merged = new Map();

  const sources = [
    { name: "S&P 400", fn: () => fetchSp400Or600Membership(SP400_URL) },
    { name: "S&P 600", fn: () => fetchSp400Or600Membership(SP600_URL) },
    { name: "S&P 500", fn: fetchSp500Membership }, // last so it overwrites tier 2 dupes
  ];

  const results = { ok: [], failed: [] };
  for (const src of sources) {
    try {
      const map = await src.fn();
      if (map.size === 0) {
        results.failed.push({ name: src.name, reason: "empty_parse" });
        continue;
      }
      for (const [symbol, info] of map) merged.set(symbol, info);
      results.ok.push({ name: src.name, count: map.size });
    } catch (err) {
      results.failed.push({ name: src.name, reason: err.message });
    }
  }

  return { membership: merged, results };
}

module.exports = {
  fetchSp500Membership,
  fetchSp400Or600Membership,
  fetchAllIndexMembership,
  parseFirstWikitable,
  daysSinceEpoch,
  SP500_URL,
  SP400_URL,
  SP600_URL,
};
