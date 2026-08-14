/**
 * Hot-stock discovery via FMP free-tier movers
 * (/stable/biggest-gainers, /stable/biggest-losers, /stable/most-actives).
 *
 * Three board tiers:
 *   candidate — Stage 1 cheap FMP signal only (all unique movers saved)
 *   live      — recommended | watch (Stage 2 promotion builds full reports)
 *   archived  — previously live, retained off-board
 *
 * Stage 1 (free beyond the 3 FMP calls): upsert ALL movers as candidates,
 * flag pennies / non-major exchanges (do not drop), prune miss streaks, trim pool.
 * Stage 2 (quota-bound): promote top-ranked candidates up to what remaining
 * TD/MX/AV/Gemini spendable headroom can safely warm today.
 *
 * Scheduled daily right after the 7am board refresh (see server.js).
 */

const { setSetting, getUsageToday, PROVIDERS } = require("../services/usage");
const {
  getDiscoveryMoversBundle,
  getCompanyProfileFromFmp,
  hasFmpKey,
} = require("../services/dataFetch");
const { warmNewlyPromotedTicker } = require("../services/promotionWarm");
const { ensureTickerIdentity } = require("../services/tickerIdentity");
const {
  hasSourceKey,
  smartRefreshReserve,
  DATA_SOURCES,
} = require("../lib/dataSources");
const {
  generateDiscoveryWriteUp,
  saveDiscoveryBlurb,
} = require("../services/discoveryWriteUp");
const {
  listLiveBoardPicks,
  listArchivedBoardPicks,
  listCandidatePicks,
  countCandidates,
  ensureBoardCapacity,
  previewArchivesForSlots,
  promotePick,
  upsertCandidateFromMover,
  pruneMissingCandidates,
  trimCandidatePool,
  rankCandidatesForPromotion,
  BOARD_MAX_SIZE,
  CANDIDATE_POOL_CAP,
  CANDIDATE_MISS_STREAK_LIMIT,
  DISCOVERY_PROMOTE_HARD_CAP,
} = require("../lib/boardPicks");
const {
  tryAcquireAdminLock,
  releaseAdminLock,
} = require("../services/adminActionLock");

/** FMP calls for gainers + losers + most-actives. */
const MOVERS_FMP_CALLS = 3;

/**
 * Conservative per-ticker warm cost when promoting a candidate to live.
 * Discovery movers themselves never touch AV; warm reports may.
 */
const WARM_COST_PER_TICKER = {
  twelve_data: 1,
  marketaux: 1,
  alpha_vantage: 1,
  finnhub: 1,
  gemini: 1,
};

function statusFromAnalysis(lean, risk) {
  const l = String(lean || "").toLowerCase();
  const r = String(risk || "").toLowerCase();
  if (l === "bearish" || r === "high") return "watch";
  if (l === "bullish" || (l === "neutral" && r === "low")) return "recommended";
  return "watch";
}

function hasFmp() {
  return hasSourceKey("fmp");
}

function pickStatusFromReport(report) {
  const lean = report?.analysis?.lean;
  const risk = report?.analysis?.risk;
  return statusFromAnalysis(lean, risk);
}

function fmpLimit() {
  return Number(DATA_SOURCES.fmp?.rateLimit?.limit) || 250;
}

function fmpReserve() {
  return smartRefreshReserve("fmp");
}

async function fmpQuotaSnapshot() {
  const used = await getUsageToday(PROVIDERS.FMP);
  const limit = fmpLimit();
  const remaining = Math.max(0, limit - Number(used || 0));
  const reserve = fmpReserve();
  const spendable = Math.max(0, remaining - reserve);
  return { used, limit, remaining, reserve, spendable };
}

async function sourceQuotaSnapshot(sourceId, providerKey, limitOverride = null) {
  const used = await getUsageToday(providerKey);
  const limit =
    limitOverride != null
      ? limitOverride
      : DATA_SOURCES[sourceId]?.rateLimit?.limit;
  const reserve = smartRefreshReserve(sourceId);
  if (limit == null) {
    return {
      used,
      limit: null,
      remaining: null,
      reserve,
      spendable: Infinity,
    };
  }
  const remaining = Math.max(0, Number(limit) - Number(used || 0));
  const spendable = Math.max(0, remaining - reserve);
  return { used, limit, remaining, reserve, spendable };
}

/**
 * How many full-report promotions we can safely afford today.
 * Bound by the tightest of TD / MX / AV / Gemini spendable headroom.
 */
async function computePromotionBudget(options = {}) {
  const overrideSpendable = options.spendableOverrides || null;
  const overrideRemaining = options.remainingOverrides || null;

  async function snap(sourceId, providerKey, limitOverride = null) {
    const base = await sourceQuotaSnapshot(sourceId, providerKey, limitOverride);
    if (overrideSpendable && overrideSpendable[sourceId] != null) {
      base.spendable = Math.max(0, Number(overrideSpendable[sourceId]));
    }
    if (overrideRemaining && overrideRemaining[sourceId] != null) {
      base.remaining = Math.max(0, Number(overrideRemaining[sourceId]));
      if (overrideSpendable?.[sourceId] == null) {
        base.spendable = Math.max(0, base.remaining - Number(base.reserve || 0));
      }
    }
    return base;
  }

  const twelve = await snap("twelve_data", PROVIDERS.TWELVE);
  const marketaux = await snap("marketaux", PROVIDERS.MARKETAUX);
  const alpha = await snap("alpha_vantage", PROVIDERS.ALPHA);
  const gemini = await snap("gemini", PROVIDERS.GEMINI, null);

  const caps = {
    twelve_data: Math.floor(
      twelve.spendable / WARM_COST_PER_TICKER.twelve_data
    ),
    marketaux: Math.floor(
      marketaux.spendable / WARM_COST_PER_TICKER.marketaux
    ),
    alpha_vantage: Math.floor(
      alpha.spendable / WARM_COST_PER_TICKER.alpha_vantage
    ),
    // Gemini has no published daily hard cap — do not bind promotion on it.
    gemini: Infinity,
  };

  let maxPromote = Math.min(
    caps.twelve_data,
    caps.marketaux,
    caps.alpha_vantage
  );
  if (!Number.isFinite(maxPromote) || maxPromote < 0) maxPromote = 0;

  const hardCap =
    options.hardCap != null
      ? Number(options.hardCap)
      : DISCOVERY_PROMOTE_HARD_CAP;
  if (Number.isFinite(hardCap) && hardCap > 0) {
    maxPromote = Math.min(maxPromote, hardCap);
  }
  // Explicit override (e.g. promoteLimit: 0 for Stage-1-only runs).
  if (options.promoteLimit != null && Number.isFinite(Number(options.promoteLimit))) {
    maxPromote = Math.min(maxPromote, Math.max(0, Number(options.promoteLimit)));
  }

  let bindingSource = null;
  for (const [k, v] of Object.entries(caps)) {
    if (v === maxPromote || (maxPromote === 0 && v === 0)) {
      bindingSource = k;
      break;
    }
  }
  // Prefer the true min source when several equal.
  const finiteCaps = Object.entries(caps).filter(([, v]) => Number.isFinite(v));
  finiteCaps.sort((a, b) => a[1] - b[1]);
  bindingSource = finiteCaps[0]?.[0] || bindingSource;

  return {
    maxPromote,
    bindingSource,
    hardCap: hardCap > 0 ? hardCap : null,
    perTicker: { ...WARM_COST_PER_TICKER },
    sources: { twelve_data: twelve, marketaux, alpha_vantage: alpha, gemini },
    caps,
  };
}

function estimateDiscoveryCalls(promoteCount = 0) {
  const n = Math.max(0, Number(promoteCount) || 0);
  return {
    fmp: MOVERS_FMP_CALLS,
    twelve_data: n * WARM_COST_PER_TICKER.twelve_data,
    alpha_vantage: n * WARM_COST_PER_TICKER.alpha_vantage,
    finnhub: n * WARM_COST_PER_TICKER.finnhub,
    marketaux: n * WARM_COST_PER_TICKER.marketaux,
    gemini: n * WARM_COST_PER_TICKER.gemini,
    claude: 0,
  };
}

/** Warm-cost estimate only (no FMP movers) — used by Smart Refresh promote step. */
function estimatePromotionWarmCalls(promoteCount = 0) {
  const n = Math.max(0, Number(promoteCount) || 0);
  return {
    fmp: 0,
    twelve_data: n * WARM_COST_PER_TICKER.twelve_data,
    alpha_vantage: n * WARM_COST_PER_TICKER.alpha_vantage,
    finnhub: n * WARM_COST_PER_TICKER.finnhub,
    marketaux: n * WARM_COST_PER_TICKER.marketaux,
    gemini: n * WARM_COST_PER_TICKER.gemini,
    claude: 0,
  };
}

/**
 * Zero-cost preview of how many candidates would promote under today's budget
 * (optionally after Soft Refresh P1 soft-consumed spendable overrides).
 */
async function previewPromoteEligibleCandidates(options = {}) {
  const live = await listLiveBoardPicks();
  const liveSet = new Set(live.map((p) => String(p.ticker).toUpperCase()));
  const candidates = await listCandidatePicks();
  const ranked = rankCandidatesForPromotion(
    candidates.filter((c) => !liveSet.has(String(c.ticker).toUpperCase()))
  );
  const promotionBudget = await computePromotionBudget(options);
  const maxPromote = promotionBudget.maxPromote;
  const wouldPromote = ranked.slice(0, maxPromote).map((r) => ({
    ticker: String(r.ticker).toUpperCase(),
    mainPool: Boolean(r.mainPool),
    percentChange:
      r.percent_change != null ? Number(r.percent_change) : null,
    name: r.name || null,
  }));
  const archivePreview = await previewArchivesForSlots(wouldPromote.length, {
    protect: wouldPromote.map((w) => w.ticker),
  });
  return {
    ok: true,
    preview: true,
    spendsNothing: true,
    candidatePoolSize: candidates.length,
    eligibleCount: ranked.length,
    eligibleMainPool: ranked.filter((r) => r.mainPool).length,
    wouldPromoteCount: wouldPromote.length,
    wouldPromote,
    wouldArchive: archivePreview.wouldArchive,
    promotionBudget,
    estimatedCalls: estimatePromotionWarmCalls(wouldPromote.length),
  };
}

/**
 * Prefetch FMP profile for promotion: retain extras + block inactive listings.
 * Returns { ok, profile, identity, skipReason } — skipReason set when inactive.
 */
async function preparePromotionIdentity(ticker, hints = {}) {
  const symbol = String(ticker || "")
    .trim()
    .toUpperCase();
  let profile = null;
  if (hasFmpKey()) {
    try {
      profile = await getCompanyProfileFromFmp(symbol);
    } catch (err) {
      console.warn(
        `[promoteEligibleCandidates] FMP profile precheck failed for ${symbol}:`,
        err.message
      );
    }
  }

  if (profile && profile.isActivelyTrading === false) {
    console.warn(
      `[promoteEligibleCandidates] Excluding ${symbol} from promotion — FMP isActivelyTrading=false (inactive listing)`
    );
    return {
      ok: false,
      skipReason: "not_actively_trading",
      profile,
      identity: null,
    };
  }

  const idResult = await ensureTickerIdentity(symbol, {
    name: hints.name || profile?.name || null,
    sector: hints.sector || profile?.sector || null,
    description: hints.description || profile?.description || null,
    exchange: hints.exchange || profile?.exchange || null,
    profile: profile || undefined,
    force: !profile,
  });

  return {
    ok: true,
    profile,
    identity: idResult?.identity || null,
    idResult,
  };
}

/**
 * Promote top-ranked candidates up to computePromotionBudget().
 * Does NOT fetch FMP movers and does NOT acquire the admin lock — caller
 * (Discovery Stage 2 or Smart Refresh) must hold the shared lock.
 *
 * @param {{
 *   dryRun?: boolean,
 *   warmReports?: boolean,
 *   withWriteUps?: boolean,
 *   pickSource?: string,
 *   rePromoteTickers?: string[],
 *   moverByTicker?: Map<string, object>,
 *   spendableOverrides?: object,
 *   remainingOverrides?: object,
 *   promoteLimit?: number,
 *   hardCap?: number,
 * }} options
 */
async function promoteEligibleCandidates(options = {}) {
  const dryRun = Boolean(options.dryRun);
  const warmReports = options.warmReports !== false;
  const withWriteUps = Boolean(options.withWriteUps);
  const pickSource = options.pickSource || "smart_refresh";
  const moverByTicker =
    options.moverByTicker instanceof Map ? options.moverByTicker : new Map();
  const rePromoteTickers = [
    ...new Set(
      (options.rePromoteTickers || [])
        .map((t) => String(t || "").toUpperCase())
        .filter(Boolean)
    ),
  ];

  const live = await listLiveBoardPicks();
  const liveSet = new Set(live.map((p) => String(p.ticker).toUpperCase()));
  const archived = await listArchivedBoardPicks();
  const archivedSet = new Set(
    archived.map((p) => String(p.ticker).toUpperCase())
  );
  const candidates = await listCandidatePicks();
  const promotionBudget = await computePromotionBudget(options);
  let seatsLeft = promotionBudget.maxPromote;

  const rankedCandidates = rankCandidatesForPromotion(
    candidates.filter((c) => !liveSet.has(String(c.ticker).toUpperCase()))
  );

  const rePromoted = [];
  const added = [];
  const archivedOut = [];
  const skipped = [];
  const failed = [];

  // Prefer archived re-promotes first when caller supplies mover tickers
  // (Discovery). Smart Refresh leaves this empty.
  for (const ticker of rePromoteTickers) {
    if (!archivedSet.has(ticker)) continue;
    if (seatsLeft <= 0) {
      skipped.push({ ticker, reason: "promotion_budget_exhausted" });
      continue;
    }
    const mover = moverByTicker.get(ticker) || null;
    if (dryRun) {
      rePromoted.push({ ticker, dryRun: true, mover });
      seatsLeft -= 1;
      continue;
    }

    const prepared = await preparePromotionIdentity(ticker, {
      name: mover?.name || null,
      exchange: mover?.exchange || null,
    });
    if (!prepared.ok) {
      skipped.push({
        ticker,
        reason: prepared.skipReason || "identity_blocked",
        kind: "repromote",
      });
      continue;
    }

    const cap = await ensureBoardCapacity(1, {
      protect: rePromoteTickers,
    });
    archivedOut.push(...(cap.archived || []));

    let report = null;
    const id = prepared.identity || {};
    await promotePick(ticker, {
      status: "watch",
      sector: id.sector || null,
      name: id.name || mover?.name || null,
      exchange: id.exchange || mover?.exchange || null,
      source: `${pickSource}_repromote`,
    });
    if (warmReports) {
      try {
        const warm = await warmNewlyPromotedTicker(ticker, {
          forceNews: true,
          forcePrice: true,
          name: id.name || mover?.name || null,
          sector: id.sector || null,
          exchange: id.exchange || mover?.exchange || null,
        });
        report = warm.report || null;
        if (!warm.ok) {
          failed.push({
            ticker,
            error: warm.error || "warm_failed",
            kind: "repromote",
          });
        }
      } catch (err) {
        console.warn(
          `[promoteEligibleCandidates] warm catch-up failed for re-promote ${ticker}:`,
          err.message
        );
        failed.push({ ticker, error: err.message, kind: "repromote" });
      }
    }
    const status = report ? pickStatusFromReport(report) : "watch";
    if (
      status !== "watch" ||
      report?.sector ||
      report?.name ||
      report?.exchange
    ) {
      await promotePick(ticker, {
        status,
        sector: report?.sector || id.sector || null,
        name: report?.name || report?.companyName || id.name || mover?.name || null,
        exchange: report?.exchange || id.exchange || mover?.exchange || null,
        source: `${pickSource}_repromote`,
      });
    }
    rePromoted.push({ ticker, status, mover });
    liveSet.add(ticker);
    archivedSet.delete(ticker);
    seatsLeft -= 1;
  }

  // Batch-prefetch news/price for the candidate wave we can still afford.
  const candidateWave = [];
  for (const row of rankedCandidates) {
    const ticker = String(row.ticker).toUpperCase();
    if (liveSet.has(ticker)) continue;
    if (candidateWave.length >= seatsLeft) break;
    candidateWave.push(row);
  }

  if (warmReports && !dryRun && candidateWave.length) {
    try {
      const { prefetchBoardNewsAndPrices } = require("../services/boardBatchPrefetch");
      await prefetchBoardNewsAndPrices(
        candidateWave.map((r) => String(r.ticker).toUpperCase()),
        { forceNews: true, forcePrice: true }
      );
    } catch (err) {
      console.warn(
        `[promoteEligibleCandidates] batch prefetch failed:`,
        err.message
      );
    }
  }

  for (const row of candidateWave) {
    const ticker = String(row.ticker).toUpperCase();
    if (liveSet.has(ticker)) continue;
    if (seatsLeft <= 0) {
      skipped.push({
        ticker,
        reason: "promotion_budget_exhausted",
        mainPool: row.mainPool,
      });
      continue;
    }

    const mover = moverByTicker.get(ticker) || {
      ticker,
      name: row.name,
      percentChange: row.percent_change,
      last: row.price,
      exchange: row.exchange,
    };

    if (dryRun) {
      added.push({
        ticker,
        dryRun: true,
        mover,
        mainPool: row.mainPool,
        flags: row.flags,
      });
      seatsLeft -= 1;
      continue;
    }

    const prepared = await preparePromotionIdentity(ticker, {
      name: mover.name || row.name || null,
      exchange: mover.exchange || row.exchange || null,
    });
    if (!prepared.ok) {
      skipped.push({
        ticker,
        reason: prepared.skipReason || "identity_blocked",
        kind: "promote",
        mainPool: row.mainPool,
      });
      continue;
    }
    const id = prepared.identity || {};

    const cap = await ensureBoardCapacity(1, {
      protect: [
        ...rePromoteTickers,
        ...added.map((a) => a.ticker),
        ...candidateWave.map((r) => String(r.ticker).toUpperCase()),
      ],
    });
    archivedOut.push(...(cap.archived || []));

    // Promote first, then immediate catch-up (identity already filled; price/news/target next).
    await promotePick(ticker, {
      status: "watch",
      sector: id.sector || null,
      name: id.name || mover.name || row.name || null,
      exchange: id.exchange || mover.exchange || row.exchange || null,
      source: pickSource,
    });

    let report = null;
    let warmMeta = null;
    if (warmReports) {
      try {
        warmMeta = await warmNewlyPromotedTicker(ticker, {
          // Wave already batch-prefetched when possible — don't double-spend.
          forceNews: false,
          forcePrice: false,
          name: id.name || mover.name || row.name || null,
          sector: id.sector || null,
          exchange: id.exchange || mover.exchange || row.exchange || null,
        });
        report = warmMeta.report || null;
        if (!warmMeta.ok) {
          failed.push({
            ticker,
            error: warmMeta.error || "warm_failed",
            kind: "promote",
          });
        }
      } catch (err) {
        console.warn(
          `[promoteEligibleCandidates] warm catch-up failed for ${ticker}:`,
          err.message
        );
        failed.push({ ticker, error: err.message, kind: "promote" });
      }
    }

    const status = report ? pickStatusFromReport(report) : "watch";
    if (
      status !== "watch" ||
      report?.sector ||
      report?.name ||
      report?.exchange
    ) {
      await promotePick(ticker, {
        status,
        sector: report?.sector || id.sector || null,
        name:
          report?.name ||
          report?.companyName ||
          id.name ||
          mover.name ||
          row.name ||
          null,
        exchange:
          report?.exchange || id.exchange || mover.exchange || row.exchange || null,
        source: pickSource,
      });
    }

    let discoveryBlurb = null;
    if (warmReports && withWriteUps) {
      try {
        discoveryBlurb = await generateDiscoveryWriteUp({
          ticker,
          name: mover.name || report?.companyName || report?.name,
          sector: report?.sector || null,
          percentChange: mover.percentChange ?? row.percent_change,
          mover,
        });
        await saveDiscoveryBlurb(ticker, discoveryBlurb);
      } catch (err) {
        console.warn(
          `[promoteEligibleCandidates] discovery write-up failed for ${ticker}:`,
          err.message
        );
      }
    }

    added.push({
      ticker,
      status,
      name: mover.name || row.name,
      percentChange: mover.percentChange ?? row.percent_change,
      mainPool: row.mainPool,
      flags: row.flags,
      discoveryBlurb,
      warm: warmMeta
        ? {
            price: warmMeta.price,
            news: warmMeta.news,
            target: warmMeta.target,
            targetQueued: warmMeta.targetQueued,
            skippedTargetReason: warmMeta.skippedTargetReason,
          }
        : null,
    });
    liveSet.add(ticker);
    seatsLeft -= 1;
  }

  // Mark remaining ranked candidates skipped for reporting.
  for (const row of rankedCandidates) {
    const ticker = String(row.ticker).toUpperCase();
    if (liveSet.has(ticker)) continue;
    if (added.some((a) => a.ticker === ticker)) continue;
    if (skipped.some((s) => s.ticker === ticker)) continue;
    skipped.push({
      ticker,
      reason: "promotion_budget_exhausted",
      mainPool: row.mainPool,
    });
  }

  return {
    ok: failed.length === 0,
    dryRun,
    promotionBudget,
    seatsRemaining: seatsLeft,
    liveBefore: live.length,
    liveAfter: liveSet.size,
    rePromoted,
    added,
    archived: archivedOut,
    skipped,
    failed,
    candidatePoolSize: candidates.length,
  };
}

function blockReasonForFmp(snapshot, need) {
  if (snapshot.remaining < need) return "no_quota";
  if (snapshot.spendable < need) return "reserve_protected";
  return null;
}

function candidateSummary(rows) {
  let penny = 0;
  let nonMajor = 0;
  let mainPool = 0;
  for (const row of rows || []) {
    let flags = row.flags;
    if (!flags && row.flags_json) {
      try {
        flags = JSON.parse(row.flags_json);
      } catch {
        flags = {};
      }
    }
    flags = flags || {};
    if (flags.penny) penny += 1;
    if (flags.nonMajorExchange) nonMajor += 1;
    if (!flags.penny && !flags.nonMajorExchange) mainPool += 1;
  }
  return {
    total: (rows || []).length,
    penny,
    nonMajorExchange: nonMajor,
    mainPool,
  };
}

/**
 * Zero-cost discovery preview — no movers fetch, no promotions.
 * Shows current candidate pool + how many promotions today's quota allows.
 */
async function previewDiscovery(options = {}) {
  const startedAt = new Date().toISOString();

  if (!hasFmp()) {
    return {
      ok: false,
      preview: true,
      spendsNothing: true,
      error: "FMP_API_KEY not configured",
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  const live = await listLiveBoardPicks();
  const archived = await listArchivedBoardPicks();
  const candidates = await listCandidatePicks();
  const liveCount = live.length;
  const freeSlots = Math.max(0, BOARD_MAX_SIZE - liveCount);
  const fmp = await fmpQuotaSnapshot();
  const promotionBudget = await computePromotionBudget(options);
  const maxPromote = promotionBudget.maxPromote;
  const estimatedCalls = estimateDiscoveryCalls(maxPromote);
  const needFmp = estimatedCalls.fmp;
  const skipReason = blockReasonForFmp(fmp, needFmp);

  const ranked = rankCandidatesForPromotion(candidates);
  const eligibleMain = ranked.filter((r) => r.mainPool);
  const promotableToday = ranked.slice(0, maxPromote).map((r) => r.ticker);
  const archivePreview = await previewArchivesForSlots(maxPromote, {
    protect: [],
  });

  const remainingAfter = {
    fmp: skipReason ? fmp.remaining : Math.max(0, fmp.remaining - needFmp),
    twelve_data: Math.max(
      0,
      (promotionBudget.sources.twelve_data.remaining || 0) -
        (skipReason ? 0 : estimatedCalls.twelve_data || 0)
    ),
    alpha_vantage: Math.max(
      0,
      (promotionBudget.sources.alpha_vantage.remaining || 0) -
        (skipReason ? 0 : estimatedCalls.alpha_vantage || 0)
    ),
    marketaux: Math.max(
      0,
      (promotionBudget.sources.marketaux.remaining || 0) -
        (skipReason ? 0 : estimatedCalls.marketaux || 0)
    ),
    finnhub: null,
    gemini: null,
    claude: null,
  };

  return {
    ok: true,
    preview: true,
    spendsNothing: true,
    mode: "discovery_preview",
    message: skipReason
      ? skipReason === "reserve_protected"
        ? "Skipped — reserve protected: FMP spendable headroom is below this run's estimate."
        : "Skipped — no quota: FMP remaining is below this run's estimate."
      : "Preview only — no API calls spent. Stage 1 will upsert all FMP movers as candidates; Stage 2 promotes up to today's resource-bound budget. Exact new movers unknown until confirm.",
    startedAt,
    finishedAt: new Date().toISOString(),
    board: {
      liveCount,
      max: BOARD_MAX_SIZE,
      freeSlots,
      archivedCount: archived.length,
      candidateCount: candidates.length,
      candidatePoolCap: CANDIDATE_POOL_CAP,
    },
    candidates: {
      ...candidateSummary(candidates),
      eligibleMainPool: eligibleMain.length,
      promotableToday: maxPromote,
      promotableTickersPreview: promotableToday,
      bindingSource: promotionBudget.bindingSource,
      hardCap: promotionBudget.hardCap,
      missStreakLimit: CANDIDATE_MISS_STREAK_LIMIT,
    },
    promotionBudget,
    wouldAdd: {
      note: "Stage 2 promotes top-ranked candidates (main pool first) up to promotableToday from the live candidate pool. Exact list refreshes after Stage 1 upserts today's FMP movers.",
      upTo: maxPromote,
      wouldPromoteCount: promotableToday.length,
      tickers: promotableToday.length ? promotableToday : null,
    },
    wouldRePromote: {
      note: "Archived movers that appear hot again are re-promoted first and count against the same promotion budget.",
      tickers: null,
    },
    wouldArchive: archivePreview.wouldArchive,
    estimatedCalls,
    totalEstimatedCalls: Object.values(estimatedCalls).reduce(
      (a, b) => a + b,
      0
    ),
    quota: {
      remainingBefore: {
        fmp: fmp.remaining,
        twelve_data: promotionBudget.sources.twelve_data.remaining,
        alpha_vantage: promotionBudget.sources.alpha_vantage.remaining,
        marketaux: promotionBudget.sources.marketaux.remaining,
        finnhub: null,
        gemini: null,
        claude: null,
      },
      remainingAfter,
      spendableBefore: {
        fmp: fmp.spendable,
        twelve_data: promotionBudget.sources.twelve_data.spendable,
        alpha_vantage: promotionBudget.sources.alpha_vantage.spendable,
        marketaux: promotionBudget.sources.marketaux.spendable,
      },
      reserves: {
        fmp: fmp.reserve,
        twelve_data: promotionBudget.sources.twelve_data.reserve,
        alpha_vantage: promotionBudget.sources.alpha_vantage.reserve,
        marketaux: promotionBudget.sources.marketaux.reserve,
      },
      usedToday: {
        fmp: fmp.used,
        twelve_data: promotionBudget.sources.twelve_data.used,
        alpha_vantage: promotionBudget.sources.alpha_vantage.used,
        marketaux: promotionBudget.sources.marketaux.used,
      },
    },
    skipFlags: skipReason
      ? [
          {
            source: "fmp",
            reason: skipReason,
            detail:
              skipReason === "reserve_protected"
                ? `need≈${needFmp} FMP · spendable=${fmp.spendable} (reserve ${fmp.reserve})`
                : `need≈${needFmp} FMP · remaining=${fmp.remaining}`,
          },
        ]
      : [],
    wouldSkipEntireRun: Boolean(skipReason),
    alphaVantageTouched: false,
    note: "Stage 1 is FMP-only. Stage 2 warm reports may use TD/MX/AV/Gemini within reserves. Candidate pennies/non-major exchanges are flagged but kept.",
  };
}

/**
 * discoverHotStocks() — main entry.
 * Real runs share the admin in-progress lock with Smart Refresh.
 */
async function discoverHotStocks(options = {}) {
  const dryRun = Boolean(options.dryRun);
  const warmReports = options.warmReports !== false;

  const startedAt = new Date().toISOString();
  console.log(
    `[discoverHotStocks] start at ${startedAt} dryRun=${dryRun} boardMax=${BOARD_MAX_SIZE}`
  );

  if (dryRun && options.previewOnly !== false && options.fetchMovers !== true) {
    return previewDiscovery(options);
  }

  if (!hasFmp()) {
    const result = {
      ok: false,
      error: "FMP_API_KEY not configured",
      startedAt,
      finishedAt: new Date().toISOString(),
    };
    await setSetting("lastHotStockDiscovery", JSON.stringify(result));
    await setSetting("lastHotStockDiscoveryAt", result.finishedAt);
    await setSetting("lastHotStockDiscoveryStatus", "failed_no_key");
    return result;
  }

  const fmp = await fmpQuotaSnapshot();
  const needFmp = MOVERS_FMP_CALLS;
  const skipReason = blockReasonForFmp(fmp, needFmp);
  if (skipReason) {
    const promotionBudget = await computePromotionBudget(options);
    const result = {
      ok: false,
      skipped: true,
      reason: skipReason,
      message:
        skipReason === "reserve_protected"
          ? "Skipped — reserve protected for fmp"
          : "Skipped — no quota for fmp",
      detail: `need≈${needFmp} · remaining=${fmp.remaining} · spendable=${fmp.spendable} · reserve=${fmp.reserve}`,
      promotionBudget,
      candidates: {
        poolSize: await countCandidates(),
        promotableToday: promotionBudget.maxPromote,
      },
      quota: fmp,
      startedAt,
      finishedAt: new Date().toISOString(),
      alphaVantageTouched: false,
    };
    await setSetting("lastHotStockDiscovery", JSON.stringify(result));
    await setSetting("lastHotStockDiscoveryAt", result.finishedAt);
    await setSetting(
      "lastHotStockDiscoveryStatus",
      skipReason === "reserve_protected" ? "skipped_reserve" : "skipped_no_quota"
    );
    console.warn(`[discoverHotStocks] ${result.message} (${result.detail})`);
    return result;
  }

  const acquired = tryAcquireAdminLock("discovery");
  if (!acquired.ok) {
    const result = {
      ok: false,
      alreadyRunning: true,
      action: acquired.action,
      startedAt: acquired.startedAt,
      message: acquired.message,
      finishedAt: new Date().toISOString(),
    };
    console.warn(`[discoverHotStocks] ${result.message}`);
    return result;
  }

  try {
    return await discoverHotStocksInner({
      dryRun,
      warmReports,
      startedAt: acquired.startedAt,
      options,
    });
  } finally {
    releaseAdminLock("discovery");
  }
}

async function discoverHotStocksInner({
  dryRun,
  warmReports,
  startedAt,
  options = {},
}) {
  let movers;
  try {
    movers = await getDiscoveryMoversBundle();
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

  // ── Stage 1: cheap candidate upsert (no full reports) ──────────────
  const stage1 = {
    inserted: 0,
    updated: 0,
    refreshedLive: 0,
    refreshedArchived: 0,
    flaggedPenny: 0,
    flaggedNonMajor: 0,
  };

  if (!dryRun) {
    for (const mover of movers.all) {
      const res = await upsertCandidateFromMover(mover);
      if (res.action === "inserted") stage1.inserted += 1;
      else if (res.action === "updated") stage1.updated += 1;
      else if (res.action === "refreshed_live") stage1.refreshedLive += 1;
      else if (res.action === "refreshed_archived") stage1.refreshedArchived += 1;
      if (res.flags?.penny) stage1.flaggedPenny += 1;
      if (res.flags?.nonMajorExchange) stage1.flaggedNonMajor += 1;
    }
  }

  const prune = dryRun
    ? { bumped: [], removed: [], missLimit: CANDIDATE_MISS_STREAK_LIMIT }
    : await pruneMissingCandidates(
        movers.all.map((m) => m.ticker),
        { missLimit: CANDIDATE_MISS_STREAK_LIMIT }
      );
  const trim = dryRun
    ? { trimmed: [], kept: 0, max: CANDIDATE_POOL_CAP }
    : await trimCandidatePool({ max: CANDIDATE_POOL_CAP });

  const live = await listLiveBoardPicks();
  const archived = await listArchivedBoardPicks();
  const archivedSet = new Set(
    archived.map((p) => String(p.ticker).toUpperCase())
  );
  const moverByTicker = new Map(movers.all.map((m) => [m.ticker, m]));
  const moverTickers = movers.all.map((m) => m.ticker);

  // ── Stage 2: resource-bound promotion (shared with Smart Refresh) ──
  const rePromoteCandidates = moverTickers.filter((t) => archivedSet.has(t));
  const promotion = await promoteEligibleCandidates({
    ...options,
    dryRun,
    warmReports,
    withWriteUps: true,
    pickSource: "discovery",
    rePromoteTickers: rePromoteCandidates,
    moverByTicker,
  });

  const promotionBudget = promotion.promotionBudget;
  const rePromoted = promotion.rePromoted;
  const added = promotion.added;
  const archivedOut = promotion.archived;
  const skipped = promotion.skipped;
  const liveAfter = promotion.liveAfter;

  const candidateCountAfter = await countCandidates();
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
    stage1: {
      ...stage1,
      pruned: prune.removed,
      pruneBumped: prune.bumped.length,
      trimmed: trim.trimmed,
      candidatePoolCap: CANDIDATE_POOL_CAP,
      missStreakLimit: CANDIDATE_MISS_STREAK_LIMIT,
    },
    candidates: {
      poolSize: candidateCountAfter,
      ...candidateSummary(await listCandidatePicks()),
      promotableToday: promotionBudget.maxPromote,
      bindingSource: promotionBudget.bindingSource,
      hardCap: promotionBudget.hardCap,
      promoted: added.length,
      rePromoted: rePromoted.length,
    },
    promotionBudget,
    liveBefore: live.length,
    liveAfter,
    rePromoted,
    added,
    archived: archivedOut,
    skipped,
    alphaVantageTouched: false,
  };

  await setSetting("lastHotStockDiscovery", JSON.stringify(result));
  await setSetting("lastHotStockDiscoveryAt", finishedAt);
  await setSetting(
    "lastHotStockDiscoveryStatus",
    dryRun ? "dry_run" : "success"
  );

  console.log(
    `[discoverHotStocks] done — candidates=${candidateCountAfter} promoted=${added.length} rePromoted=${rePromoted.length} budget=${promotionBudget.maxPromote} (bound by ${promotionBudget.bindingSource})`
  );
  return result;
}

module.exports = {
  discoverHotStocks,
  previewDiscovery,
  estimateDiscoveryCalls,
  estimatePromotionWarmCalls,
  computePromotionBudget,
  promoteEligibleCandidates,
  previewPromoteEligibleCandidates,
  MOVERS_FMP_CALLS,
  WARM_COST_PER_TICKER,
  /** @deprecated use computePromotionBudget().maxPromote — kept for older callers */
  MAX_NEW_PER_RUN: DISCOVERY_PROMOTE_HARD_CAP || 3,
};
