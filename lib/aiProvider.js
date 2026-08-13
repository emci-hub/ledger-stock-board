/**
 * Swappable AI provider facade.
 * Default automated path: Gemini (AI_PROVIDER=gemini).
 * Claude is available for explicit manual deeper-look calls only.
 */

const geminiProvider = require("./geminiProvider");
const claudeProvider = require("./claudeProvider");

const PROVIDERS = {
  gemini: geminiProvider,
  claude: claudeProvider,
};

function resolveProviderId(override) {
  const raw = String(
    override || process.env.AI_PROVIDER || "gemini"
  )
    .trim()
    .toLowerCase();
  if (PROVIDERS[raw]) return raw;
  console.warn(
    `[aiProvider] Unknown AI_PROVIDER="${raw}" — falling back to gemini`
  );
  return "gemini";
}

function getProvider(override) {
  return PROVIDERS[resolveProviderId(override)];
}

/**
 * Generate dual stock analysis (short/long/quip with structured tags).
 * @param {object} payload — stock data object from analyze.buildPayload
 * @param {{ provider?: 'gemini'|'claude' }} [options]
 */
async function generateAnalysis(payload, options = {}) {
  const id = resolveProviderId(options.provider);
  const provider = PROVIDERS[id];
  const result = await provider.generateAnalysis(payload);
  return {
    ...result,
    provider: result.provider || id,
  };
}

/**
 * Gemini-only JSON helper for board mood / tidbits / discovery write-ups.
 */
async function generateJson(prompt, options = {}) {
  return geminiProvider.generateJson(prompt, options);
}

function listProviders() {
  return Object.values(PROVIDERS).map((p) => ({
    id: p.id,
    label: p.label,
  }));
}

module.exports = {
  generateAnalysis,
  generateJson,
  getProvider,
  resolveProviderId,
  listProviders,
  PROVIDERS,
};
