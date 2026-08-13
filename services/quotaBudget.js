/**
 * Daily quota budget for Smart Refresh — check remaining before spending.
 * Wired via AsyncLocalStorage so HTTP helpers can refuse calls with 0 left.
 */
const { AsyncLocalStorage } = require("async_hooks");
const { getUsageToday, PROVIDERS } = require("./usage");
const { DATA_SOURCES } = require("../lib/dataSources");

const store = new AsyncLocalStorage();

class QuotaSkippedError extends Error {
  constructor(provider, message) {
    super(message || `Skipped — no quota for ${provider}`);
    this.name = "QuotaSkippedError";
    this.code = "no_quota";
    this.provider = provider;
  }
}

/** Sources with a hard daily limit (Finnhub is per-minute — soft run budget below). */
const DAILY_LIMITS = {
  twelve_data: DATA_SOURCES.twelve_data.rateLimit.limit,
  alpha_vantage: DATA_SOURCES.alpha_vantage.rateLimit.limit,
  marketaux: DATA_SOURCES.marketaux.rateLimit.limit,
  // No published free-tier daily Gemini cap — never block on quota.
  gemini: null,
  claude: null,
};

/** Soft per-run Finnhub budget (free tier is ~60/min; avoid burning a whole minute). */
const FINNHUB_RUN_BUDGET = 40;

class QuotaBudget {
  /**
   * @param {Record<string, number>} usedToday
   * @param {object} [opts]
   */
  constructor(usedToday = {}, opts = {}) {
    this.usedAtStart = { ...usedToday };
    this.spent = {
      twelve_data: 0,
      alpha_vantage: 0,
      finnhub: 0,
      marketaux: 0,
      gemini: 0,
      claude: 0,
    };
    this.limits = {
      twelve_data: DAILY_LIMITS.twelve_data,
      alpha_vantage: DAILY_LIMITS.alpha_vantage,
      marketaux: DAILY_LIMITS.marketaux,
      gemini: DAILY_LIMITS.gemini,
      claude: DAILY_LIMITS.claude,
      // Finnhub: remaining for THIS run only (not calendar-day).
      finnhub: opts.finnhubRunBudget ?? FINNHUB_RUN_BUDGET,
    };
    this.skips = [];
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

  hasQuota(provider, n = 1) {
    return this.remaining(provider) >= n;
  }

  /**
   * Reserve n calls. Returns false if not enough remaining.
   */
  tryConsume(provider, n = 1, meta = {}) {
    const id = String(provider);
    if (!this.hasQuota(id, n)) {
      this.skips.push({
        provider: id,
        action: meta.action || null,
        ticker: meta.ticker || null,
        reason: "no_quota",
      });
      return false;
    }
    this.spent[id] = (this.spent[id] || 0) + n;
    return true;
  }

  snapshot() {
    const remaining = {};
    for (const id of Object.keys(this.spent)) {
      const r = this.remaining(id);
      remaining[id] = r === Infinity ? null : r;
    }
    return {
      usedAtStart: { ...this.usedAtStart },
      spentThisRun: { ...this.spent },
      remaining,
      limits: { ...this.limits },
    };
  }
}

async function createQuotaBudget() {
  const usedToday = {
    twelve_data: await getUsageToday(PROVIDERS.TWELVE),
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
