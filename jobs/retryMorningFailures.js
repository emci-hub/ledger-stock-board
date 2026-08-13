/**
 * 1pm lightweight retry — only re-fetches fields/tickers that failed the 7am full refresh.
 * Not a second full board pass.
 */

const { getStockReport } = require("../services/getStockReport");
const {
  loadMorningRefreshFailures,
  clearMorningRefreshFailures,
} = require("../services/morningFailures");
const { setSetting } = require("../services/usage");
const { recordJobRun } = require("../services/jobRuns");
const { prefetchBoardNewsAndPrices } = require("../services/boardBatchPrefetch");

async function retryMorningFailures(options = {}) {
  const startedAt = new Date().toISOString();
  const log = await loadMorningRefreshFailures();
  const failures = Array.isArray(log?.failures) ? log.failures : [];

  if (!failures.length) {
    const result = {
      ok: true,
      skipped: true,
      reason: "no_failures",
      message: "No morning refresh failures to retry.",
      startedAt,
      finishedAt: new Date().toISOString(),
      retried: [],
      stillFailing: [],
    };
    await setSetting("lastNewsCatchupAt", result.finishedAt);
    await setSetting("lastNewsCatchupStatus", "skipped_no_failures");
    await recordJobRun("news_catchup_1pm", {
      ok: true,
      summary: "skipped — no morning failures",
      detail: result,
    }).catch(() => {});
    return result;
  }

  const tickers = [
    ...new Set(
      failures
        .map((f) => String(f.ticker || "").toUpperCase())
        .filter(Boolean)
    ),
  ];

  console.log(
    `[retryMorningFailures] Retrying ${tickers.length} ticker(s) from morning failures`
  );

  // Batch whatever is still stale among the failed set.
  try {
    await prefetchBoardNewsAndPrices(tickers, {
      forceNews: true,
      forcePrice: true,
    });
  } catch (err) {
    console.warn(`[retryMorningFailures] batch prefetch:`, err.message);
  }

  const retried = [];
  const stillFailing = [];

  for (const ticker of tickers) {
    try {
      const report = await getStockReport(ticker, "long", {
        skipPeers: false,
        forceRefresh: true,
        ...(options.smartRefresh ? { smartRefresh: true } : {}),
      });
      if (!report) {
        stillFailing.push({ ticker, error: "no_report" });
        continue;
      }
      retried.push({ ticker, ok: true });
    } catch (err) {
      stillFailing.push({ ticker, error: err.message });
    }
  }

  const finishedAt = new Date().toISOString();
  if (!stillFailing.length) {
    await clearMorningRefreshFailures();
  } else {
    await setSetting(
      "lastMorningRefreshFailures",
      JSON.stringify({
        at: finishedAt,
        failures: stillFailing,
        priorAt: log?.at || null,
      })
    );
  }

  const result = {
    ok: stillFailing.length === 0,
    startedAt,
    finishedAt,
    retried,
    stillFailing,
    message: stillFailing.length
      ? `Retried ${retried.length}; ${stillFailing.length} still failing`
      : `Retried ${retried.length} — all clear`,
  };

  await setSetting("lastNewsCatchupAt", finishedAt);
  await setSetting(
    "lastNewsCatchupStatus",
    stillFailing.length ? "partial" : "success"
  );
  await recordJobRun("news_catchup_1pm", {
    ok: result.ok,
    summary: result.message,
    detail: result,
  }).catch(() => {});

  console.log(`[retryMorningFailures] ${result.message}`);
  return result;
}

module.exports = { retryMorningFailures };
