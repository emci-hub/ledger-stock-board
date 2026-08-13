/**
 * Hot-stock discovery via Twelve Data market movers.
 * Compares movers to the live board, re-promotes archived hits, and
 * adds genuinely new candidates under BOARD_MAX_SIZE (archiving weakest).
 *
 * Scheduled daily right after the 7am board refresh (see server.js).
 */

const { setSetting } = require("../services/usage");
const { getDiscoveryMoversBundle } = require("../services/dataFetch");
const { getStockReport } = require("../services/getStockReport");
const { hasSourceKey } = require("../lib/dataSources");
const {
  generateDiscoveryWriteUp,
  saveDiscoveryBlurb,
} = require("../services/discoveryWriteUp");
const {
  listLiveBoardPicks,
  listArchivedBoardPicks,
  ensureBoardCapacity,
  promotePick,
  BOARD_MAX_SIZE,
} = require("../lib/boardPicks");

/** Max brand-new tickers to onboard per discovery run (limits API spend). */
const MAX_NEW_PER_RUN = Math.max(
  1,
  Number.parseInt(process.env.DISCOVERY_MAX_NEW || "3", 10) || 3
);

function statusFromAnalysis(lean, risk) {
  const l = String(lean || "").toLowerCase();
  const r = String(risk || "").toLowerCase();
  if (l === "bearish" || r === "high") return "watch";
  if (l === "bullish" || (l === "neutral" && r === "low")) return "recommended";
  return "watch";
}

function hasTwelve() {
  return hasSourceKey("twelve_data");
}

function pickStatusFromReport(report) {
  const lean = report?.analysis?.lean;
  const risk = report?.analysis?.risk;
  return statusFromAnalysis(lean, risk);
}

/**
 * discoverHotStocks() — main entry.
 * @param {{ dryRun?: boolean, maxNew?: number, warmReports?: boolean }} options
 */
async function discoverHotStocks(options = {}) {
  const dryRun = Boolean(options.dryRun);
  const maxNew = options.maxNew ?? MAX_NEW_PER_RUN;
  const warmReports = options.warmReports !== false;

  const startedAt = new Date().toISOString();
  console.log(
    `[discoverHotStocks] start at ${startedAt} dryRun=${dryRun} maxNew=${maxNew} boardMax=${BOARD_MAX_SIZE}`
  );

  if (!hasTwelve()) {
    const result = {
      ok: false,
      error: "TWELVE_DATA_API_KEY not configured",
      startedAt,
      finishedAt: new Date().toISOString(),
    };
    await setSetting("lastHotStockDiscovery", JSON.stringify(result));
    await setSetting("lastHotStockDiscoveryAt", result.finishedAt);
    await setSetting("lastHotStockDiscoveryStatus", "failed_no_key");
    return result;
  }

  let movers;
  try {
    movers = await getDiscoveryMoversBundle({ outputsize: 30, country: "USA" });
  } catch (err) {
    const result = {
      ok: false,
      error: err.message,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
    await setSetting("lastHotStockDiscovery", JSON.stringify(result));
    await setSetting("lastHotStockDiscoveryAt", result.finishedAt);
    await setSetting("lastHotStockDiscoveryStatus", "failed_movers");
    console.error("[discoverHotStocks] movers fetch failed:", err.message);
    return result;
  }

  const live = await listLiveBoardPicks();
  const archived = await listArchivedBoardPicks();
  const liveSet = new Set(live.map((p) => String(p.ticker).toUpperCase()));
  const archivedSet = new Set(
    archived.map((p) => String(p.ticker).toUpperCase())
  );
  const moverTickers = movers.all.map((m) => m.ticker);
  const moverByTicker = new Map(movers.all.map((m) => [m.ticker, m]));

  const rePromoteCandidates = moverTickers.filter((t) => archivedSet.has(t));
  const newCandidates = movers.all
    .filter((m) => !liveSet.has(m.ticker) && !archivedSet.has(m.ticker))
    .sort(
      (a, b) =>
        Math.abs(Number(b.percentChange) || 0) -
        Math.abs(Number(a.percentChange) || 0)
    );

  const rePromoted = [];
  const added = [];
  const archivedOut = [];
  const skipped = [];

  // 1) Re-promote archived names that are hot again
  for (const ticker of rePromoteCandidates) {
    const mover = moverByTicker.get(ticker);
    if (dryRun) {
      rePromoted.push({ ticker, dryRun: true, mover });
      continue;
    }
    const cap = await ensureBoardCapacity(1, {
      protect: rePromoteCandidates,
    });
    archivedOut.push(...(cap.archived || []));

    let report = null;
    if (warmReports) {
      try {
        report = await getStockReport(ticker, "long", { skipPeers: false });
      } catch (err) {
        console.warn(
          `[discoverHotStocks] warm report failed for re-promote ${ticker}:`,
          err.message
        );
      }
    }
    const status = report ? pickStatusFromReport(report) : "watch";
    await promotePick(ticker, {
      status,
      sector: report?.sector || null,
      source: "discovery_repromote",
    });
    rePromoted.push({ ticker, status, mover });
    liveSet.add(ticker);
    archivedSet.delete(ticker);
  }

  // 2) Add genuinely new movers under the board cap
  let addedCount = 0;
  for (const mover of newCandidates) {
    if (addedCount >= maxNew) {
      skipped.push({ ticker: mover.ticker, reason: "max_new_per_run" });
      continue;
    }
    if (dryRun) {
      added.push({ ticker: mover.ticker, dryRun: true, mover });
      addedCount += 1;
      continue;
    }

    const cap = await ensureBoardCapacity(1, {
      protect: [...rePromoteCandidates, ...added.map((a) => a.ticker)],
    });
    archivedOut.push(...(cap.archived || []));

    let report = null;
    if (warmReports) {
      try {
        // Seed overview name from movers so cards aren't blank before OVERVIEW
        report = await getStockReport(mover.ticker, "long", {
          skipPeers: false,
        });
      } catch (err) {
        console.warn(
          `[discoverHotStocks] warm report failed for ${mover.ticker}:`,
          err.message
        );
      }
    }

    const status = report ? pickStatusFromReport(report) : "watch";
    await promotePick(mover.ticker, {
      status,
      sector: report?.sector || null,
      source: "discovery",
    });

    let discoveryBlurb = null;
    try {
      discoveryBlurb = await generateDiscoveryWriteUp({
        ticker: mover.ticker,
        name: mover.name || report?.companyName || report?.name,
        sector: report?.sector || null,
        percentChange: mover.percentChange,
        mover,
      });
      await saveDiscoveryBlurb(mover.ticker, discoveryBlurb);
    } catch (err) {
      console.warn(
        `[discoverHotStocks] discovery write-up failed for ${mover.ticker}:`,
        err.message
      );
    }

    added.push({
      ticker: mover.ticker,
      status,
      name: mover.name,
      percentChange: mover.percentChange,
      discoveryBlurb,
    });
    addedCount += 1;
    liveSet.add(mover.ticker);
  }

  const finishedAt = new Date().toISOString();
  const result = {
    ok: true,
    dryRun,
    startedAt,
    finishedAt,
    boardMax: BOARD_MAX_SIZE,
    movers: {
      gainers: movers.gainers.length,
      losers: movers.losers.length,
      mostActiveTop: movers.mostActive.slice(0, 10).map((m) => m.ticker),
      unique: movers.all.length,
    },
    liveBefore: live.length,
    liveAfter: liveSet.size,
    rePromoted,
    added,
    archived: archivedOut,
    skipped,
    newCandidateCount: newCandidates.length,
  };

  await setSetting("lastHotStockDiscovery", JSON.stringify(result));
  await setSetting("lastHotStockDiscoveryAt", finishedAt);
  await setSetting(
    "lastHotStockDiscoveryStatus",
    dryRun ? "dry_run" : "success"
  );

  console.log(
    `[discoverHotStocks] done — added=${added.length} rePromoted=${rePromoted.length} archived=${archivedOut.length}`
  );
  return result;
}

module.exports = {
  discoverHotStocks,
  MAX_NEW_PER_RUN,
};
