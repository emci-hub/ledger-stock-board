/**
 * Smart Refresh — quota-aware, freshness-respecting priority waterfall.
 * Priority 1: live board gaps · Priority 2: recent lookups · Priority 3: 1–2 archived.
 * Never bypasses freshness TTLs. Never double-fires (in-progress lock).
 */
const { dbAll, dbRun } = require("../db/schema");
const {
  getStockCacheEntry,
  getCachedSummary,
  isFullyFresh,
  isPriceFresh,
  isTargetFresh,
  isNewsFresh,
  isEarningsFresh,
  freshnessFromData,
} = require("../services/cache");
const { getStockReport } = require("../services/getStockReport");
const { getUsageToday, PROVIDERS, setSetting } = require("../services/usage");
const { recordJobRun } = require("../services/jobRuns");
const {
  createQuotaBudget,
  runWithBudget,
} = require("../services/quotaBudget");
const {
  getActiveBoardTickers,
  listArchivedBoardPicks,
  getPick,
} = require("../lib/boardPicks");
const { statusFromAnalysis, logRecommendation } = require("./refreshBoard");

let inProgress = false;
let startedAt = null;
let lastResult = null;

const USAGE_PROVIDERS = [
  { key: "twelve_data", provider: PROVIDERS.TWELVE },
  { key: "alpha_vantage", provider: PROVIDERS.ALPHA },
  { key: "finnhub", provider: PROVIDERS.FINNHUB },
  { key: "marketaux", provider: PROVIDERS.MARKETAUX },
  { key: "gemini", provider: PROVIDERS.GEMINI },
  { key: "claude", provider: PROVIDERS.CLAUDE },
];

const ARCHIVE_REFRESH_LIMIT = 2;
const RECENT_LOOKUP_LIMIT = 10;

function emptyTier(id, name) {
  return {
    id,
    name,
    refreshed: [],
    alreadyCurrent: [],
    skippedNoQuota: [],
    skippedReserveProtected: [],
    failed: [],
    tickersConsidered: 0,
  };
}

async function snapshotUsage() {
  const out = {};
  for (const { key, provider } of USAGE_PROVIDERS) {
    out[key] = await getUsageToday(provider);
  }
  return out;
}

function usageDelta(before, after) {
  const calls = {};
  let total = 0;
  for (const { key } of USAGE_PROVIDERS) {
    const n = Math.max(0, Number(after[key] || 0) - Number(before[key] || 0));
    calls[key] = n;
    total += n;
  }
  return { calls, total };
}

function assessNeeds(entry, summary) {
  const data = entry?.data || null;
  const price = !isPriceFresh(data);
  const target = !isTargetFresh(data);
  const news = !isNewsFresh(data);
  const earnings = !isEarningsFresh(data);
  const peers = !(Array.isArray(data?.peers) && data.peers.length > 0);
  const analysis = !summary;
  const fully = data && isFullyFresh(data) && Boolean(summary);
  return {
    price,
    target,
    news,
    earnings,
    peers,
    analysis,
    any: price || target || news || earnings || peers || analysis,
    fullyFresh: Boolean(fully),
  };
}

/**
 * Sources required to satisfy each stale field (primary first).
 * Used only for pre-flight "would this be blocked by zero quota?" messaging.
 */
function sourcesForNeed(needKey) {
  switch (needKey) {
    case "price":
      return ["twelve_data", "alpha_vantage"];
    case "target":
      return ["alpha_vantage"];
    case "news":
      return ["marketaux", "alpha_vantage"];
    case "earnings":
    case "peers":
      return ["finnhub"];
    case "analysis":
      return ["gemini"];
    default:
      return [];
  }
}

function preflightQuotaSkips(needs, budget) {
  const skipped = [];
  for (const key of ["price", "target", "news", "earnings", "peers", "analysis"]) {
    if (!needs[key]) continue;
    const sources = sourcesForNeed(key);
    const anyOk = sources.some((s) => budget.hasQuota(s));
    if (!anyOk) {
      // Prefer reserve_protected if every blocked source is only reserve-blocked
      // (not fully exhausted). Mixed / all-zero → no_quota.
      const reasons = sources.map((s) => budget.blockReason(s, 1));
      const allReserve =
        reasons.length > 0 &&
        reasons.every((r) => r === "reserve_protected" || r == null) &&
        reasons.some((r) => r === "reserve_protected");
      const reason = allReserve ? "reserve_protected" : "no_quota";
      skipped.push({
        field: key,
        reason,
        sources,
      });
    }
  }
  return skipped;
}

async function listRecentNonBoardTickers(boardSet, limit = RECENT_LOOKUP_LIMIT) {
  const rows = await dbAll(
    `SELECT ticker, last_updated FROM stock_reports
     ORDER BY last_updated DESC
     LIMIT 40`
  );
  const out = [];
  for (const row of rows || []) {
    const t = String(row.ticker).toUpperCase();
    if (boardSet.has(t)) continue;
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

async function listStaleArchivedTickers(limit = ARCHIVE_REFRESH_LIMIT) {
  const archived = await listArchivedBoardPicks();
  const scored = [];
  for (const pick of archived || []) {
    const ticker = String(pick.ticker).toUpperCase();
    const entry = await getStockCacheEntry(ticker);
    const f = freshnessFromData(entry?.data);
    const times = [
      f.priceUpdatedAt,
      f.targetUpdatedAt,
      f.newsUpdatedAt,
      f.earningsUpdatedAt,
      entry?.lastUpdated,
    ]
      .filter(Boolean)
      .map((x) => Date.parse(x))
      .filter((n) => !Number.isNaN(n));
    const oldest = times.length ? Math.min(...times) : 0;
    scored.push({ ticker, oldest });
  }
  scored.sort((a, b) => a.oldest - b.oldest);
  return scored.slice(0, limit).map((s) => s.ticker);
}

async function upsertLiveStatus(ticker, status, sector) {
  const prev = await getPick(ticker);
  await dbRun(
    `INSERT OR REPLACE INTO board_picks
      (ticker, status, added_at, sector, archived_at, source)
     VALUES (?, ?, ?, ?, NULL, ?)`,
    [
      ticker,
      status,
      prev?.added_at || new Date().toISOString(),
      sector || null,
      prev?.source || "seed",
    ]
  );
}

/**
 * Refresh one ticker respecting freshness + quota budget.
 * Returns a per-ticker outcome for the tier summary.
 */
async function processTicker(ticker, budget, { updateBoard = false } = {}) {
  const symbol = String(ticker).toUpperCase();
  const entry = await getStockCacheEntry(symbol);
  const summary = await getCachedSummary(symbol);
  const needs = assessNeeds(entry, summary);

  if (!needs.any) {
    return {
      ticker: symbol,
      status: "already_current",
      detail: "All fields fresh — left alone",
    };
  }

  const preSkips = preflightQuotaSkips(needs, budget);
  const actionable = ["price", "target", "news", "earnings", "peers", "analysis"].filter(
    (k) => needs[k] && !preSkips.some((s) => s.field === k)
  );

  if (!actionable.length) {
    const reserveOnly = preSkips.every((s) => s.reason === "reserve_protected");
    return {
      ticker: symbol,
      status: reserveOnly ? "skipped_reserve_protected" : "skipped_no_quota",
      detail: reserveOnly
        ? "Stale fields present but required sources are reserve-protected for Smart Refresh"
        : "Stale fields present but every required source has 0 remaining quota",
      skippedFields: preSkips.filter((s) => s.reason === "no_quota"),
      skippedReserveFields: preSkips.filter((s) => s.reason === "reserve_protected"),
      needed: needs,
    };
  }

  const outcomes = {
    ticker: symbol,
    refreshedFields: [],
    skippedNoQuota: preSkips.filter((s) => s.reason === "no_quota"),
    skippedReserveProtected: preSkips.filter(
      (s) => s.reason === "reserve_protected"
    ),
    failedFields: [],
  };

  try {
    const report = await runWithBudget(budget, outcomes, () =>
      getStockReport(symbol, "long", {
        skipPeers: false,
        smartRefresh: true,
      })
    );

    if (!report) {
      return {
        ticker: symbol,
        status: "failed",
        detail: "No report returned",
        skippedFields: outcomes.skippedNoQuota,
        skippedReserveFields: outcomes.skippedReserveProtected,
      };
    }

    if (updateBoard) {
      const lean = report.analysis?.lean;
      const risk = report.analysis?.risk;
      const status = statusFromAnalysis(lean, risk);
      if (status) {
        await upsertLiveStatus(symbol, status, report.sector || null);
        if (status === "recommended" && report.price != null) {
          await logRecommendation(symbol, report.price, lean);
        }
      }
    }

    const blocked =
      (outcomes.skippedNoQuota?.length || 0) +
      (outcomes.skippedReserveProtected?.length || 0);
    let status = "refreshed";
    if (blocked && outcomes.refreshedFields.length) status = "partial";
    else if (blocked && !outcomes.refreshedFields.length) {
      status =
        (outcomes.skippedReserveProtected?.length || 0) >=
        (outcomes.skippedNoQuota?.length || 0)
          ? "skipped_reserve_protected"
          : "skipped_no_quota";
    }

    return {
      ticker: symbol,
      status,
      detail:
        status === "refreshed"
          ? `Refreshed: ${(outcomes.refreshedFields || []).join(", ") || "data"}`
          : status === "partial"
            ? "Partial refresh; some fields skipped (quota or reserve)"
            : status === "skipped_reserve_protected"
              ? "Skipped — reserve protected"
              : "Skipped — no quota",
      refreshedFields: outcomes.refreshedFields,
      skippedFields: outcomes.skippedNoQuota,
      skippedReserveFields: outcomes.skippedReserveProtected,
      needed: needs,
    };
  } catch (err) {
    return {
      ticker: symbol,
      status: "failed",
      detail: err.message,
      skippedFields: outcomes.skippedNoQuota,
      skippedReserveFields: outcomes.skippedReserveProtected,
    };
  }
}

function applyTickerResult(tier, result) {
  tier.tickersConsidered += 1;
  if (result.status === "already_current") {
    tier.alreadyCurrent.push(result);
  } else if (result.status === "skipped_no_quota") {
    tier.skippedNoQuota.push(result);
  } else if (result.status === "skipped_reserve_protected") {
    tier.skippedReserveProtected.push(result);
  } else if (result.status === "failed") {
    tier.failed.push(result);
  } else {
    // refreshed | partial
    tier.refreshed.push(result);
    if (result.skippedFields?.length) {
      tier.skippedNoQuota.push({
        ...result,
        status: "partial_no_quota",
      });
    }
    if (result.skippedReserveFields?.length) {
      tier.skippedReserveProtected.push({
        ...result,
        status: "partial_reserve_protected",
      });
    }
  }
}

async function runTier(tier, tickers, budget, opts) {
  for (const ticker of tickers) {
    const result = await processTicker(ticker, budget, opts);
    applyTickerResult(tier, result);
    console.log(
      `[smartRefresh] ${tier.id} ${ticker} → ${result.status}${
        result.detail ? ` (${result.detail})` : ""
      }`
    );
  }
  return tier;
}

function summarizeTier(tiers) {
  return tiers.map((t) => ({
    id: t.id,
    name: t.name,
    considered: t.tickersConsidered,
    refreshedCount: t.refreshed.length,
    alreadyCurrentCount: t.alreadyCurrent.length,
    skippedNoQuotaCount: t.skippedNoQuota.length,
    skippedReserveProtectedCount: t.skippedReserveProtected.length,
    failedCount: t.failed.length,
    refreshed: t.refreshed.map((r) => ({
      ticker: r.ticker,
      fields: r.refreshedFields || [],
      detail: r.detail,
    })),
    alreadyCurrent: t.alreadyCurrent.map((r) => r.ticker),
    skippedNoQuota: t.skippedNoQuota.map((r) => ({
      ticker: r.ticker,
      detail: r.detail,
      fields: (r.skippedFields || []).map((f) => f.field || f),
    })),
    skippedReserveProtected: t.skippedReserveProtected.map((r) => ({
      ticker: r.ticker,
      detail: r.detail,
      fields: (r.skippedReserveFields || r.skippedFields || []).map(
        (f) => f.field || f
      ),
    })),
    failed: t.failed.map((r) => ({ ticker: r.ticker, detail: r.detail })),
  }));
}

function estimateCallsForNeeds(needs, skippedFields = []) {
  const skipped = new Set((skippedFields || []).map((s) => s.field));
  const calls = {
    twelve_data: 0,
    alpha_vantage: 0,
    finnhub: 0,
    marketaux: 0,
    gemini: 0,
    claude: 0,
  };
  if (needs.price && !skipped.has("price")) calls.twelve_data += 1;
  if (needs.target && !skipped.has("target")) calls.alpha_vantage += 1;
  if (needs.news && !skipped.has("news")) calls.marketaux += 1;
  if (needs.earnings && !skipped.has("earnings")) calls.finnhub += 1;
  if (needs.peers && !skipped.has("peers")) calls.finnhub += 1;
  // Analysis miss OR successful news refresh both trigger one Gemini dual call.
  const analysisFires =
    (needs.analysis && !skipped.has("analysis")) ||
    (needs.news && !skipped.has("news"));
  if (analysisFires) calls.gemini += 1;
  return calls;
}

function addCalls(into, add) {
  for (const [k, v] of Object.entries(add || {})) {
    into[k] = (into[k] || 0) + Number(v || 0);
  }
  return into;
}

function emptyCalls() {
  return {
    twelve_data: 0,
    alpha_vantage: 0,
    finnhub: 0,
    marketaux: 0,
    gemini: 0,
    claude: 0,
  };
}

async function assessTickerPreview(ticker, budget) {
  const symbol = String(ticker).toUpperCase();
  const entry = await getStockCacheEntry(symbol);
  const summary = await getCachedSummary(symbol);
  const needs = assessNeeds(entry, summary);

  if (!needs.any) {
    return {
      ticker: symbol,
      status: "already_current",
      needed: needs,
      estimatedCalls: emptyCalls(),
      skippedFields: [],
      skippedReserveFields: [],
    };
  }

  const preSkips = preflightQuotaSkips(needs, budget);
  const actionable = ["price", "target", "news", "earnings", "peers", "analysis"].filter(
    (k) => needs[k] && !preSkips.some((s) => s.field === k)
  );

  if (!actionable.length) {
    const reserveOnly = preSkips.every((s) => s.reason === "reserve_protected");
    return {
      ticker: symbol,
      status: reserveOnly ? "skipped_reserve_protected" : "skipped_no_quota",
      needed: needs,
      estimatedCalls: emptyCalls(),
      skippedFields: preSkips.filter((s) => s.reason === "no_quota"),
      skippedReserveFields: preSkips.filter((s) => s.reason === "reserve_protected"),
    };
  }

  const estimatedCalls = estimateCallsForNeeds(needs, preSkips);
  // Soft-consume estimated calls so later tickers see shrinking budget in preview.
  for (const [provider, n] of Object.entries(estimatedCalls)) {
    if (n > 0) budget.tryConsume(provider, n, { action: "preview", ticker: symbol });
  }

  return {
    ticker: symbol,
    status: "would_refresh",
    needed: needs,
    fields: actionable,
    estimatedCalls,
    skippedFields: preSkips.filter((s) => s.reason === "no_quota"),
    skippedReserveFields: preSkips.filter((s) => s.reason === "reserve_protected"),
  };
}

/**
 * Zero-cost Smart Refresh preview — cache assessment only, no live API calls.
 */
async function previewSmartRefresh() {
  const usageBefore = await snapshotUsage();
  const budget = await createQuotaBudget();
  const remainingBefore = budget.snapshot().remaining;
  const spendableBefore = budget.snapshot().spendable;
  const reserves = budget.snapshot().reserves;

  const boardTickers = await getActiveBoardTickers();
  const boardSet = new Set(boardTickers.map((t) => String(t).toUpperCase()));
  const recentTickers = await listRecentNonBoardTickers(boardSet);
  const archiveTickers = await listStaleArchivedTickers(ARCHIVE_REFRESH_LIMIT);

  async function previewTier(id, name, tickers) {
    const tier = {
      id,
      name,
      wouldRefresh: [],
      alreadyCurrent: [],
      skippedNoQuota: [],
      skippedReserveProtected: [],
      tickersConsidered: 0,
    };
    for (const ticker of tickers) {
      const row = await assessTickerPreview(ticker, budget);
      tier.tickersConsidered += 1;
      if (row.status === "already_current") tier.alreadyCurrent.push(row);
      else if (row.status === "skipped_no_quota") tier.skippedNoQuota.push(row);
      else if (row.status === "skipped_reserve_protected") {
        tier.skippedReserveProtected.push(row);
      } else tier.wouldRefresh.push(row);
    }
    return tier;
  }

  const tiers = [
    await previewTier("priority_1_board", "Priority 1 — live board gaps", boardTickers),
    await previewTier(
      "priority_2_recent",
      "Priority 2 — recently looked up",
      recentTickers
    ),
    await previewTier(
      "priority_3_archive",
      "Priority 3 — archived (1–2)",
      archiveTickers
    ),
  ];

  const estimatedCalls = emptyCalls();
  for (const tier of tiers) {
    for (const row of tier.wouldRefresh) {
      addCalls(estimatedCalls, row.estimatedCalls);
    }
  }

  const remainingAfter = {};
  const spendableAfter = {};
  for (const key of Object.keys(estimatedCalls)) {
    const before = remainingBefore[key];
    if (before == null) {
      remainingAfter[key] = null;
      spendableAfter[key] = null;
    } else {
      remainingAfter[key] = Math.max(0, before - (estimatedCalls[key] || 0));
      const reserve = Number(reserves[key] || 0);
      spendableAfter[key] = Math.max(0, remainingAfter[key] - reserve);
    }
  }

  const skipFlags = [];
  for (const tier of tiers) {
    for (const row of [...tier.skippedNoQuota, ...tier.skippedReserveProtected]) {
      skipFlags.push({
        ticker: row.ticker,
        status: row.status,
        fields: [
          ...(row.skippedFields || []).map((f) => f.field),
          ...(row.skippedReserveFields || []).map((f) => f.field),
        ],
      });
    }
    for (const row of tier.wouldRefresh) {
      if (row.skippedFields?.length || row.skippedReserveFields?.length) {
        skipFlags.push({
          ticker: row.ticker,
          status: "partial_skip",
          fields: [
            ...(row.skippedFields || []).map((f) => f.field),
            ...(row.skippedReserveFields || []).map((f) => f.field),
          ],
        });
      }
    }
  }

  return {
    ok: true,
    preview: true,
    spendsNothing: true,
    mode: "smart_refresh_preview",
    message:
      "Preview only — no API calls spent. Confirm to run the real Smart Refresh.",
    tiers: tiers.map((t) => ({
      id: t.id,
      name: t.name,
      considered: t.tickersConsidered,
      wouldRefreshCount: t.wouldRefresh.length,
      alreadyCurrentCount: t.alreadyCurrent.length,
      skippedNoQuotaCount: t.skippedNoQuota.length,
      skippedReserveProtectedCount: t.skippedReserveProtected.length,
      wouldRefresh: t.wouldRefresh.map((r) => ({
        ticker: r.ticker,
        fields: r.fields || [],
        estimatedCalls: r.estimatedCalls,
      })),
      alreadyCurrent: t.alreadyCurrent.map((r) => r.ticker),
      skippedNoQuota: t.skippedNoQuota.map((r) => ({
        ticker: r.ticker,
        fields: (r.skippedFields || []).map((f) => f.field),
      })),
      skippedReserveProtected: t.skippedReserveProtected.map((r) => ({
        ticker: r.ticker,
        fields: (r.skippedReserveFields || []).map((f) => f.field),
      })),
    })),
    totals: {
      wouldRefresh: tiers.reduce((n, t) => n + t.wouldRefresh.length, 0),
      alreadyCurrent: tiers.reduce((n, t) => n + t.alreadyCurrent.length, 0),
      skippedNoQuota: tiers.reduce((n, t) => n + t.skippedNoQuota.length, 0),
      skippedReserveProtected: tiers.reduce(
        (n, t) => n + t.skippedReserveProtected.length,
        0
      ),
    },
    estimatedCalls,
    totalEstimatedCalls: Object.values(estimatedCalls).reduce((a, b) => a + b, 0),
    quota: {
      remainingBefore,
      remainingAfter,
      spendableBefore,
      spendableAfter,
      reserves,
      usedToday: usageBefore,
    },
    skipFlags,
    note: "Shared report covers both short and long AI takes in one Gemini call when analysis/news is refreshed. Estimates assume Marketaux news succeeds (no AV news fallback).",
  };
}

function getForceRefreshState() {
  return {
    inProgress,
    startedAt,
    lastResult,
    mode: "smart_refresh",
  };
}

const getSmartRefreshState = getForceRefreshState;

/**
 * Smart refresh once. Returns immediately with alreadyRunning if in flight.
 */
async function smartRefreshAll() {
  if (inProgress) {
    return {
      ok: false,
      alreadyRunning: true,
      startedAt,
      message: "Smart refresh already in progress — not starting another run.",
      lastResult,
    };
  }

  inProgress = true;
  startedAt = new Date().toISOString();
  const usageBefore = await snapshotUsage();
  const budget = await createQuotaBudget();

  try {
    console.log(`[smartRefresh] Starting at ${startedAt}`);
    console.log(
      `[smartRefresh] Quota remaining at start:`,
      budget.snapshot().remaining
    );

    const boardTickers = await getActiveBoardTickers();
    const boardSet = new Set(boardTickers.map((t) => String(t).toUpperCase()));

    const tier1 = emptyTier("priority_1_board", "Priority 1 — live board gaps");
    const tier2 = emptyTier(
      "priority_2_recent",
      "Priority 2 — recently looked up"
    );
    const tier3 = emptyTier("priority_3_archive", "Priority 3 — archived (1–2)");

    await runTier(tier1, boardTickers, budget, { updateBoard: true });

    // Only continue waterfall if any daily-limited source still has room,
    // or Finnhub run budget remains — otherwise P2/P3 would only no-op.
    const recentTickers = await listRecentNonBoardTickers(boardSet);
    await runTier(tier2, recentTickers, budget, { updateBoard: false });

    const archiveTickers = await listStaleArchivedTickers(ARCHIVE_REFRESH_LIMIT);
    await runTier(tier3, archiveTickers, budget, { updateBoard: false });

    const usageAfter = await snapshotUsage();
    const { calls, total } = usageDelta(usageBefore, usageAfter || {});
    const tiers = summarizeTier([tier1, tier2, tier3]);

    const refreshedTotal = tiers.reduce((n, t) => n + t.refreshedCount, 0);
    const currentTotal = tiers.reduce((n, t) => n + t.alreadyCurrentCount, 0);
    const quotaSkipTotal = tiers.reduce((n, t) => n + t.skippedNoQuotaCount, 0);
    const reserveSkipTotal = tiers.reduce(
      (n, t) => n + t.skippedReserveProtectedCount,
      0
    );
    const failedTotal = tiers.reduce((n, t) => n + t.failedCount, 0);

    const result = {
      ok: true,
      alreadyRunning: false,
      mode: "smart_refresh",
      startedAt,
      finishedAt: new Date().toISOString(),
      message:
        "Smart refresh completed — freshness respected; quota + reserve checked before each source.",
      tiers,
      totals: {
        refreshed: refreshedTotal,
        alreadyCurrent: currentTotal,
        skippedNoQuota: quotaSkipTotal,
        skippedReserveProtected: reserveSkipTotal,
        failed: failedTotal,
      },
      callsBySource: calls,
      totalCalls: total,
      usageBefore,
      usageAfter,
      quota: budget.snapshot(),
      note: "Shared report covers both short and long AI takes in one Gemini call when analysis is refreshed. Live searches may still use reserved Alpha Vantage headroom.",
    };

    lastResult = result;
    await setSetting("lastSmartRefresh", result.finishedAt);
    await setSetting(
      "lastSmartRefreshStatus",
      failedTotal && !refreshedTotal ? "failed" : "ok"
    );
    await recordJobRun("manual_force_refresh", {
      ok: true,
      summary: `smart · refreshed=${refreshedTotal} current=${currentTotal} noQuota=${quotaSkipTotal} reserve=${reserveSkipTotal} fail=${failedTotal} · ${total} calls`,
      detail: result,
    });

    console.log(
      `[smartRefresh] Done — refreshed=${refreshedTotal} current=${currentTotal} noQuota=${quotaSkipTotal} reserve=${reserveSkipTotal} calls=${total}`
    );
    return result;
  } catch (err) {
    const usageAfter = await snapshotUsage().catch(() => usageBefore);
    const { calls, total } = usageDelta(usageBefore, usageAfter || {});
    const result = {
      ok: false,
      alreadyRunning: false,
      mode: "smart_refresh",
      startedAt,
      finishedAt: new Date().toISOString(),
      message: err.message || "Smart refresh failed.",
      callsBySource: calls,
      totalCalls: total,
      usageBefore,
      usageAfter,
    };
    lastResult = result;
    await recordJobRun("manual_force_refresh", {
      ok: false,
      summary: `smart failed: ${err.message}`,
      detail: result,
    }).catch(() => {});
    throw err;
  } finally {
    inProgress = false;
  }
}

/** Backward-compatible alias used by existing admin route. */
const forceRefreshAll = smartRefreshAll;

module.exports = {
  smartRefreshAll,
  forceRefreshAll,
  previewSmartRefresh,
  getForceRefreshState,
  getSmartRefreshState,
};
