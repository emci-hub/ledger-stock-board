/**
 * Compare Alpha Vantage vs Marketaux news sentiment when both succeed.
 */

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function avgScores(scores) {
  const vals = (scores || []).filter((n) => n != null && Number.isFinite(n));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/** Bucket continuous sentiment into positive / neutral / negative. */
function sentimentBucket(score) {
  const n = num(score);
  if (n == null) return null;
  if (n > 0.1) return "positive";
  if (n < -0.1) return "negative";
  return "neutral";
}

function alphaAverageScore(fundamentals) {
  const news = Array.isArray(fundamentals?.news) ? fundamentals.news : [];
  return avgScores(news.map((a) => num(a?.sentimentScore)));
}

function marketauxScore(fundamentals) {
  return num(fundamentals?.newsMarketaux?.sentimentScore);
}

/**
 * @returns {{
 *   status: 'agree'|'disagree'|'single'|'none',
 *   alphaBucket: string|null,
 *   marketauxBucket: string|null,
 *   alphaScore: number|null,
 *   marketauxScore: number|null,
 * }}
 */
function computeNewsAgreement(fundamentals) {
  const sources = Array.isArray(fundamentals?.newsSources)
    ? fundamentals.newsSources
    : [];
  const hasAlpha =
    sources.includes("alpha_vantage") ||
    (Array.isArray(fundamentals?.news) && fundamentals.news.length > 0);
  const hasMarketaux =
    sources.includes("marketaux") || Boolean(fundamentals?.newsMarketaux);

  const alphaScore = hasAlpha ? alphaAverageScore(fundamentals) : null;
  const mxScore = hasMarketaux ? marketauxScore(fundamentals) : null;
  const alphaBucket = sentimentBucket(alphaScore);
  const marketauxBucket = sentimentBucket(mxScore);

  const both =
    hasAlpha &&
    hasMarketaux &&
    alphaBucket != null &&
    marketauxBucket != null;

  let status = "none";
  if (both) {
    status = alphaBucket === marketauxBucket ? "agree" : "disagree";
  } else if (
    (hasAlpha && alphaBucket != null) ||
    (hasMarketaux && marketauxBucket != null)
  ) {
    status = "single";
  }

  return {
    status,
    alphaBucket,
    marketauxBucket,
    alphaScore,
    marketauxScore: mxScore,
  };
}

module.exports = {
  computeNewsAgreement,
  sentimentBucket,
  alphaAverageScore,
  marketauxScore,
};
