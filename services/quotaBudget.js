/**
 * Daily quota budget for Smart Refresh — check remaining before spending.
 * Wired via AsyncLocalStorage so HTTP helpers can refuse calls with 0 left
 * OR when spending would eat into the per-source smartRefreshReserve.
 *
 * Live family searches do NOT use this budget, so they may still dip into
 * the reserved headroom when a real person is waiting.
 */
const { AsyncLocalStorage } = require("async_hooks");
const { getUsageToday, PROVIDERS } = require("./usage");
const { DATA_SOURCES, smartRefreshReserve } = require("../lib/dataSources");

const store = new AsyncLocalStorage();

class QuotaSkippedError extends Error {
  /**
   * @param {string} provider
   * @param {"no_quota"|"reserve_protected"} [reason]
   * @param {string} [message]
   */
  constructor(provider, reason = "no_quota", message) {
    const code = reason === "reserve_protected" ? "reserve_protected" : "no_quota";
    const defaultMsg =
      code === "reserve_protected"
        ? `Skipped — reserve protected for ${provider}`
        : `Skipped — no quota for ${provider}`;
    super(message || defaultMsg);
    this.name = "QuotaSkippedError";
    this.code = code;
    this.reason = code;
    this.provider = provider;
  }
}

/** Sources with a hard daily limit (Finnhub is per-minute — soft run budget below). */
const DAILY_LIMITS = {
  twelve_data: DATA_SOURCES.twelve_data.rateLimit.limit,
  fmp: DATA_SOURCES.fmp.rateLimit.limit,
  alpha_vantage: DATA_SOURCES.alpha_vantage.rateLimit.limit,
  marketaux: DATA_SOURCES.marketaux.rateLimit.limit,
  // No published free-tier daily Gemini cap — never block on quota.
  gemini: null,
  claude: null,
};

/** Soft per-run Finnhub budget (free tier is ~60/min; avoid burning a whole minute). */
const FINNHUB_RUN_BUDGET = 40;

function buildReserves() {
  return {
    twelve_data: smartRefreshReserve("twelve_data"),
    fmp: smartRefreshReserve("fmp"),
    alpha_vantage: smartRefreshReserve("alpha_vantage"),
    marketaux: smartRefreshReserve("marketaux"),
    finnhub: smartRefreshReserve("finnhub"),
    gemini: smartRefreshReserve("gemini"),
    claude: smartRefreshReserve("claude"),
  };
}

class QuotaBudget {
  /**
   * @param {Record<string, number>} usedToday
   * @param {object} [opts]
   */
  constructor(usedToday = {}, opts = {}) {
    this.usedAtStart = { ...usedToday };
    this.spent = {
      twelve_data: 0,
      fmp: 0,
      alpha_vantage: 0,
      finnhub: 0,
      marketaux: 0,
      gemini: 0,
      claude: 0,
    };
    this.limits = {
      twelve_data: DAILY_LIMITS.twelve_data,
      fmp: DAILY_LIMITS.fmp,
      alpha_vantage: DAILY_LIMITS.alpha_vantage,
      marketaux: DAILY_LIMITS.marketaux,
      gemini: DAILY_LIMITS.gemini,
      claude: DAILY_LIMITS.claude,
      // Finnhub: remaining for THIS run only (not calendar-day).
      finnhub: opts.finnhubRunBudget ?? FINNHUB_RUN_BUDGET,
    };
    this.reserves = { ...buildReserves(), ...(opts.reserves || {}) };
    this.skips = [];
  }

  reserveFor(provider) {
    return Number(this.reserves[String(provider)] || 0);
  }

  remaining(provider) {
    const id = String(provider);
    const limit = this.limits[id];
    if (limit == null) return Infinity;
    if (id === "finnhub") {
      return Math.max(0, limit - (this.spent.finnhub || 0));
    }
    const used = Number(this.usedAtStart[id] || 0) + Number(this.spent[id] || 0);
    return Math.max(0, limit - used);
  }

  /**
   * Calls Smart Refresh is allowed to spend (remaining minus reserve).
   * Unlimited sources → Infinity.
   */
  spendable(provider) {
    const rem = this.remaining(provider);
    if (rem === Infinity) return Infinity;
    return Math.max(0, rem - this.reserveFor(provider));
  }

  /**
   * Why a spend of n would be blocked, or null if allowed.
   * @returns {"no_quota"|"reserve_protected"|null}
   */
  blockReason(provider, n = 1) {
    const rem = this.remaining(provider);
    if (rem === Infinity) return null;
    if (rem < n) return "no_quota";
    const reserve = this.reserveFor(provider);
    // Would remaining after this call dip into the protected reserve?
    if (rem - n < reserve) return "reserve_protected";
    return null;
  }

  hasQuota(provider, n = 1) {
    return this.blockReason(provider, n) == null;
  }

  /**
   * Reserve n calls for this Smart Refresh run. Returns false if blocked.
   * Distinguishes hard exhaustion vs reserve protection in skip log + error.
   */
  tryConsume(provider, n = 1, meta = {}) {
    const id = String(provider);
    const reason = this.blockReason(id, n);
    if (reason) {
      this.skips.push({
        provider: id,
        action: meta.action || null,
        ticker: meta.ticker || null,
        reason,
      });
      return false;
    }
    this.spent[id] = (this.spent[id] || 0) + n;
    return true;
  }

  /**
   * Throw QuotaSkippedError with the correct reason, or no-op if no active block.
   * Used by HTTP helpers after a failed tryConsume.
   */
  skipError(provider) {
    const reason = this.blockReason(provider, 1) || "no_quota";
    // If we already consumed past the edge, remaining may still show reserve_protected
    // via the last skip entry.
    const last = [...this.skips].reverse().find((s) => s.provider === String(provider));
    return new QuotaSkippedError(provider, last?.reason || reason);
  }

  snapshot() {
    const remaining = {};
    const spendable = {};
    const reserves = {};
    for (const id of Object.keys(this.spent)) {
      const r = this.remaining(id);
      remaining[id] = r === Infinity ? null : r;
      const s = this.spendable(id);
      spendable[id] = s === Infinity ? null : s;
      reserves[id] = this.reserveFor(id);
    }
    return {
      usedAtStart: { ...this.usedAtStart },
      spentThisRun: { ...this.spent },
      remaining,
      spendable,
      reserves,
      limits: { ...this.limits },
    };
  }
}

async function createQuotaBudget() {
  const usedToday = {
    twelve_data: await getUsageToday(PROVIDERS.TWELVE),
    fmp: await getUsageToday(PROVIDERS.FMP),
    alpha_vantage: await getUsageToday(PROVIDERS.ALPHA),
    finnhub: await getUsageToday(PROVIDERS.FINNHUB),
    marketaux: await getUsageToday(PROVIDERS.MARKETAUX),
    gemini: await getUsageToday(PROVIDERS.GEMINI),
    claude: await getUsageToday(PROVIDERS.CLAUDE),
  };
  return new QuotaBudget(usedToday);
}

function getActiveBudget() {
  return store.getStore()?.budget || null;
}

function getActiveOutcomes() {
  return store.getStore()?.outcomes || null;
}

function runWithBudget(budget, outcomes, fn) {
  return store.run({ budget, outcomes }, fn);
}

module.exports = {
  QuotaBudget,
  QuotaSkippedError,
  DAILY_LIMITS,
  FINNHUB_RUN_BUDGET,
  createQuotaBudget,
  getActiveBudget,
  getActiveOutcomes,
  runWithBudget,
};
