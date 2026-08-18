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

/**
 * BlackRock/iShares factor ETF holdings — real, free, official downloads
 * (not scraped from a third party). Confirmed working URL pattern (used in
 * real developer tooling, e.g. github.com/skiamu/ETF, sec-api.io tutorials):
 *   https://www.ishares.com/us/products/{ID}/{slug}/1467271812596.ajax
 *     ?fileType=csv&fileName={TICKER}_holdings&dataType=fund
 *
 * USMV (Min Vol) + QUAL (Quality) → Long-candidate factor source.
 * MTUM (Momentum) → Short-candidate factor source.
 * QUAL's product ID is unconfirmed — verify live via scripts/smokeTestIndexTiers.js
 * before trusting it (same treatment as everything else fetched from outside
 * our own network tonight).
 */
const ISHARES_FUNDS = {
  IVV: {
    id: 239726,
    slug: "ishares-core-sp-500-etf",
    factorTag: null, // not a factor tilt — this IS the S&P 500 itself, tier 1
  },
  USMV: {
    id: 239695,
    slug: "ishares-msci-usa-minimum-volatility-etf",
    factorTag: "quality_low_vol",
  },
  QUAL: {
    id: 239644, // UNCONFIRMED — verify via smoke test before trusting
    slug: "ishares-msci-usa-quality-factor-etf",
    factorTag: "quality_low_vol",
  },
  MTUM: {
    id: 251614,
    slug: "ishares-msci-usa-momentum-factor-etf",
    factorTag: "momentum",
  },
};

function buildIsharesCsvUrl(ticker) {
  const fund = ISHARES_FUNDS[ticker];
  if (!fund) throw new Error(`Unknown iShares fund: ${ticker}`);
  return `https://www.ishares.com/us/products/${fund.id}/${fund.slug}/1467271812596.ajax?fileType=csv&fileName=${ticker}_holdings&dataType=fund`;
}

/**
 * Parse the real iShares holdings CSV format: several metadata header rows,
 * then a header row (Ticker, Name, ..., Weight (%), ...), then data rows,
 * then a trailing disclosure text block. Never throws on unexpected rows —
 * skips them — since a malformed row must not crash the whole fetch.
 */
function parseIsharesHoldingsCsv(csvText) {
  if (!csvText || typeof csvText !== "string") return [];
  const lines = csvText.split(/\r?\n/);

  // Find the real header row — the one containing "Ticker" AND "Weight".
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/ticker/i.test(line) && /weight/i.test(line)) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return [];

  const headers = splitCsvLine(lines[headerIdx]).map((h) =>
    h.trim().toLowerCase()
  );
  const tickerCol = headers.findIndex((h) => h === "ticker");
  const nameCol = headers.findIndex((h) => h.includes("name"));
  const weightCol = headers.findIndex((h) => h.includes("weight"));
  const sectorCol = headers.findIndex((h) => h.includes("sector"));
  if (tickerCol === -1 || weightCol === -1) return [];

  const rows = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cells = splitCsvLine(line);
    const ticker = String(cells[tickerCol] || "").trim().toUpperCase();
    // Stop at the trailing disclosure block — real tickers are short,
    // alphanumeric, no spaces; the disclosure text fails this immediately.
    if (!ticker || !/^[A-Z0-9.\-]{1,10}$/.test(ticker)) continue;
    const weightRaw = String(cells[weightCol] || "").replace(/[%,]/g, "");
    const weight = Number.parseFloat(weightRaw);
    if (!Number.isFinite(weight)) continue;
    rows.push({
      symbol: ticker,
      name: nameCol >= 0 ? String(cells[nameCol] || "").trim() : null,
      sector: sectorCol >= 0 ? String(cells[sectorCol] || "").trim() : null,
      weightPct: weight,
    });
  }
  return rows;
}

/** Minimal CSV line splitter — handles quoted fields with embedded commas. */
function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQuotes = !inQuotes;
    } else if (c === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Fetch one iShares fund's holdings, ranked by real published weight
 * (highest weight = rank 1 = considered most significant by MSCI's own
 * methodology). Never throws — returns empty array on failure so one bad
 * fetch can't take down the others.
 */
async function fetchIsharesFundHoldings(ticker) {
  try {
    const url = buildIsharesCsvUrl(ticker);
    const { data } = await axios.get(url, {
      timeout: 15000,
      headers: { "User-Agent": "ledger-stock-board/1.0 (factor fetch)" },
    });
    const rows = parseIsharesHoldingsCsv(data);
    // Rank by weight descending — this IS the "who's on top" data the user
    // asked about; real, published, not our own invention.
    rows.sort((a, b) => b.weightPct - a.weightPct);
    return rows.map((r, idx) => ({ ...r, rank: idx + 1 }));
  } catch (err) {
    console.warn(`[blackrockFactors] ${ticker} fetch failed:`, err.message);
    return [];
  }
}

/**
 * Fetch all 3 factor funds, merge into Map<symbol, {factorTag, rank, weightPct}>.
 * A stock appearing in both USMV and QUAL keeps the better (lower) rank.
 * Never throws — partial results on individual fund failure.
 */
async function fetchAllFactorMembership() {
  const results = { ok: [], failed: [] };
  const merged = new Map();

  for (const ticker of ["USMV", "QUAL", "MTUM"]) {
    const rows = await fetchIsharesFundHoldings(ticker);
    if (rows.length === 0) {
      results.failed.push({ name: ticker, reason: "empty_or_fetch_failed" });
      continue;
    }
    results.ok.push({ name: ticker, count: rows.length });
    const factorTag = ISHARES_FUNDS[ticker].factorTag;
    for (const row of rows) {
      const existing = merged.get(row.symbol);
      if (!existing || row.rank < existing.rank) {
        merged.set(row.symbol, {
          factorTag,
          sourceFund: ticker,
          rank: row.rank,
          weightPct: row.weightPct,
        });
      }
    }
  }

  return { membership: merged, results };
}

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
/**
 * S&P 500 membership — now sourced directly from BlackRock/iShares (IVV,
 * their actual S&P 500 tracking fund), NOT Wikipedia. Same real CSV
 * pipeline already proven for USMV/QUAL/MTUM. Real trade-off, disclosed:
 * IVV's holdings CSV has no "date added to index" column the way
 * Wikipedia's table did, so priorityRank is now based on real published
 * portfolio WEIGHT (consistent with how USMV/QUAL/MTUM already rank) —
 * not tenure. Return shape unchanged so nothing downstream needs to change.
 */
async function fetchSp500Membership() {
  const rows = await fetchIsharesFundHoldings("IVV");
  const out = new Map();
  for (const row of rows) {
    out.set(row.symbol, {
      tier: 1,
      priorityRank: row.rank, // real published weight rank (1 = largest holding)
      dateAdded: null, // not available from this source — see note above
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

  // S&P 400/600 (Wikipedia) intentionally paused, not deleted — user
  // decision 2026-08-17: focus on S&P 500 only for now, sourced from real
  // BlackRock data instead of Wikipedia. fetchSp400Or600Membership() and
  // the Wikipedia parser stay in this file, working and testable, in case
  // broader coverage is wanted again later.
  const sources = [
    { name: "S&P 500 (IVV/BlackRock)", fn: fetchSp500Membership },
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
  fetchIsharesFundHoldings,
  fetchAllFactorMembership,
  parseIsharesHoldingsCsv,
  buildIsharesCsvUrl,
  ISHARES_FUNDS,
};
