/**
 * Practice Run (paper trading) snapshot store.
 *
 * The paper-trading data is produced on a separate machine and pushed here with
 * POST /api/paper/sync. This module owns the Turso table, the shape validation
 * and the "latest snapshot + history" reads. No market APIs, no AI — it only
 * stores and returns what was synced, so nothing on the dashboard is ever an
 * AI-guessed number (CLAUDE.md rule 1).
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { dbExecute, dbGet, dbAll, dbRun } = require("../db/schema");

const SEED_FILE = path.join(__dirname, "..", "data", "paper-run-seed.json");
/** Keep the free-tier database small — history is a rolling window, not forever. */
const HISTORY_MAX_ROWS = 500;
/** Guardrail on a single synced document (Turso row size + Express body). */
const MAX_DOC_BYTES = 2 * 1024 * 1024;
const DEFAULT_TOTAL_DAYS = 10;

let tablePromise = null;

async function ensurePaperRunTables() {
  if (tablePromise) return tablePromise;
  tablePromise = (async () => {
    await dbExecute(`
      CREATE TABLE IF NOT EXISTS paper_run_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        updated_at TEXT NOT NULL,
        day INTEGER,
        doc_json TEXT NOT NULL,
        doc_hash TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'sync',
        received_at TEXT NOT NULL
      )
    `);
    await dbExecute(
      `CREATE INDEX IF NOT EXISTS idx_paper_run_snapshots_received
       ON paper_run_snapshots(received_at DESC, id DESC)`
    );
  })();
  return tablePromise;
}

class PaperSnapshotError extends Error {
  constructor(errors) {
    super(`Invalid paper run snapshot: ${errors.join("; ")}`);
    this.name = "PaperSnapshotError";
    this.errors = errors;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function trimOrNull(value) {
  if (value == null) return null;
  const str = String(value).trim();
  return str ? str : null;
}

function asObjectArray(value, label, errors) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return [];
  }
  const out = [];
  value.forEach((item, idx) => {
    if (!isPlainObject(item)) {
      errors.push(`${label}[${idx}] must be an object`);
      return;
    }
    out.push(item);
  });
  return out;
}

function missingNumber(value) {
  return value == null || value === "";
}

/**
 * A watchlist has no paper balance, so a missing benchmark level must stay
 * null. finiteOrNull(null) is 0 because Number(null) is 0, which the card
 * would print as "SPY 0 / 0%".
 */
function normalizeBenchmark(value, label, errors, { preserveMissing = false } = {}) {
  if (!isPlainObject(value)) {
    errors.push(`${label}.benchmark is required and must be an object`);
    return null;
  }
  const ticker = trimOrNull(value.ticker);
  if (!ticker) errors.push(`${label}.benchmark.ticker is required`);
  const num = (field) =>
    preserveMissing && missingNumber(value[field]) ? null : finiteOrNull(value[field]);
  return {
    ...value,
    ticker: ticker || "",
    value: num("value"),
    returnPct: num("returnPct"),
  };
}

function normalizeProjection(value, label, errors) {
  if (value == null) return null;
  if (!isPlainObject(value)) {
    errors.push(`${label}.projection must be an object`);
    return null;
  }
  return {
    ...value,
    bear: finiteOrNull(value.bear),
    baseLow: finiteOrNull(value.baseLow),
    baseHigh: finiteOrNull(value.baseHigh),
    bull: finiteOrNull(value.bull),
  };
}

function normalizeEquityCurve(value, label, errors) {
  const rows = asObjectArray(value, `${label}.equityCurve`, errors);
  return rows.map((point) => ({
    ...point,
    date: trimOrNull(point.date),
    value: finiteOrNull(point.value),
    benchmark: finiteOrNull(point.benchmark),
  }));
}

/**
 * A missing money field stays null. Number(null) is 0, so an explicit null
 * must not be run through finiteOrNull or the dashboard prints $0.
 * An omitted field is also null. Callers decide whether omission is an error.
 */
function softMoney(raw, field) {
  if (!Object.prototype.hasOwnProperty.call(raw, field)) return null;
  if (raw[field] == null || raw[field] === "") return null;
  return finiteOrNull(raw[field]);
}

function optionalNumber(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    if (text === "inf" || text === "Infinity" || text === "+inf") return "inf";
    const num = Number(text);
    return Number.isFinite(num) ? num : text;
  }
  return null;
}

function optionalBool(value) {
  if (value == null || value === "") return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  const text = String(value).trim().toLowerCase();
  if (["true", "yes", "y", "1"].includes(text)) return true;
  if (["false", "no", "n", "0"].includes(text)) return false;
  return null;
}

function normalizeTaken(value) {
  return optionalBool(value);
}

function normalizeDisruption(value) {
  const text = trimOrNull(value);
  if (!text) return null;
  const key = text.toLowerCase();
  if (key === "green" || key === "yellow" || key === "red") return key.toUpperCase();
  if (key === "unchecked") return "unchecked";
  return text;
}

function normalizeFails(value, label, errors) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    errors.push(`${label}.fails must be an array`);
    return [];
  }
  return value.map((item) => trimOrNull(item)).filter(Boolean);
}

function normalizeSignals(value, label, errors) {
  const rows = asObjectArray(value, `${label}.signals`, errors);
  return rows.map((row, idx) => {
    const ticker = trimOrNull(row.ticker);
    if (!ticker) errors.push(`${label}.signals[${idx}].ticker is required`);
    return {
      ...row,
      date: trimOrNull(row.date),
      ticker: ticker || "",
      trigger: trimOrNull(row.trigger),
      taken: normalizeTaken(row.taken),
      why: trimOrNull(row.why) || trimOrNull(row.reason),
    };
  });
}

const STOCK_NUMBER_FIELDS = [
  "mcap_B",
  "roic3",
  "gm3",
  "om3",
  "rev_g",
  "netdebt_ebitda",
  "ps_now",
  "ps_hist_med",
  "off_high",
  "price",
  "score",
  "val_vs_hist",
  "size_mult",
];

function normalizeStock(raw, idx, errors) {
  const label = `watchlist.stocks[${idx}]`;
  const ticker = trimOrNull(raw.ticker);
  if (!ticker) errors.push(`${label}.ticker is required`);
  const stock = {
    ...raw,
    ticker: ticker || "",
    name: trimOrNull(raw.name),
    grade: trimOrNull(raw.grade),
    disruption_why: trimOrNull(raw.disruption_why),
  };
  for (const field of STOCK_NUMBER_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(raw, field)) {
      stock[field] = optionalNumber(raw[field]);
    }
  }
  if (Object.prototype.hasOwnProperty.call(raw, "capex_dip")) stock.capex_dip = optionalBool(raw.capex_dip);
  if (Object.prototype.hasOwnProperty.call(raw, "core")) stock.core = optionalBool(raw.core);
  if (Object.prototype.hasOwnProperty.call(raw, "cyclical")) stock.cyclical = optionalBool(raw.cyclical);
  if (Object.prototype.hasOwnProperty.call(raw, "invest_rising")) {
    stock.invest_rising = optionalBool(raw.invest_rising);
  }
  if (Object.prototype.hasOwnProperty.call(raw, "disruption")) {
    stock.disruption = normalizeDisruption(raw.disruption);
  }
  if (Object.prototype.hasOwnProperty.call(raw, "fails")) {
    stock.fails = normalizeFails(raw.fails, label, errors);
  }
  if (Object.prototype.hasOwnProperty.call(raw, "fail_reasons")) {
    const reasons = raw.fail_reasons;
    stock.fail_reasons = Array.isArray(reasons)
      ? reasons.map((item) => trimOrNull(item)).filter(Boolean)
      : [];
  }
  if (Object.prototype.hasOwnProperty.call(raw, "news_hold")) stock.news_hold = optionalBool(raw.news_hold);
  if (Object.prototype.hasOwnProperty.call(raw, "status")) stock.status = trimOrNull(raw.status);
  if (Object.prototype.hasOwnProperty.call(raw, "theme")) stock.theme = trimOrNull(raw.theme);
  return stock;
}

function normalizeExplain(value, errors) {
  if (value == null) return {};
  if (!isPlainObject(value)) {
    errors.push("watchlist.explain must be an object");
    return {};
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const text = trimOrNull(item);
    if (text) out[key] = text;
  }
  return out;
}

/** Optional top-level watchlist. v2 is the graded table; v3 is the god-tier list. Absent = unchanged. */
function normalizeWatchlist(value, errors) {
  if (!isPlainObject(value)) {
    errors.push("watchlist must be an object");
    return null;
  }
  const stocks = asObjectArray(value.stocks == null ? [] : value.stocks, "watchlist.stocks", errors).map(
    (raw, idx) => normalizeStock(raw, idx, errors)
  );
  const version = trimOrNull(value.version);
  const watchlist = {
    ...value,
    asof: trimOrNull(value.asof),
    method: trimOrNull(value.method),
    explain: normalizeExplain(value.explain, errors),
    stocks,
  };
  if (version) watchlist.version = version;
  else delete watchlist.version;
  return watchlist;
}

const HOT_NUMBER_FIELDS = ["close", "chg_pct", "vol_x", "dd18m_pct"];
const HOT_BOOL_FIELDS = ["above200", "comeback", "leader_dip", "fund_check", "hot"];

function normalizeHotRow(raw) {
  const row = { ...raw, ticker: trimOrNull(raw.ticker), grade: trimOrNull(raw.grade), why: trimOrNull(raw.why) };
  for (const field of HOT_NUMBER_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(raw, field)) row[field] = optionalNumber(raw[field]);
  }
  for (const field of HOT_BOOL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(raw, field)) row[field] = optionalBool(raw[field]);
  }
  return row;
}

function normalizeHotList(value, label, errors) {
  return asObjectArray(value, label, errors).map((raw, idx) => {
    const row = normalizeHotRow(raw);
    if (!row.ticker) errors.push(`${label}[${idx}].ticker is required`);
    return row;
  });
}

/** Optional top-level hot-today tape. Absent = unchanged. */
function normalizeHotToday(value, errors) {
  if (!isPlainObject(value)) {
    errors.push("hot_today must be an object");
    return null;
  }
  const hot = normalizeHotList(value.hot == null ? [] : value.hot, "hot_today.hot", errors);
  const out = {
    ...value,
    asof: trimOrNull(value.asof),
    generated: trimOrNull(value.generated),
    note: trimOrNull(value.note),
    hot,
  };
  if (value.all != null) out.all = normalizeHotList(value.all, "hot_today.all", errors);
  return out;
}

const LAB_PRICE_FIELDS = ["SPY", "QQQ", "SPY_now", "QQQ_now"];

/** Optional lab benchmarks (start and latest SPY/QQQ). Absent = unchanged. */
function normalizeLab(value, errors) {
  if (!isPlainObject(value)) {
    errors.push("lab must be an object");
    return null;
  }
  const lab = { ...value, start: trimOrNull(value.start), asof: trimOrNull(value.asof) };
  for (const field of LAB_PRICE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
    if (value[field] == null || value[field] === "") {
      lab[field] = null;
      continue;
    }
    const num = finiteOrNull(value[field]);
    if (num == null) errors.push(`lab.${field} must be a number`);
    lab[field] = num;
  }
  return lab;
}

function normalizeAccount(raw, idx, errors) {
  const label = `accounts[${idx}]`;
  if (!isPlainObject(raw)) {
    errors.push(`${label} must be an object`);
    return null;
  }

  const id = trimOrNull(raw.id);
  if (!id) errors.push(`${label}.id is required`);
  const currency = trimOrNull(raw.currency);
  if (!currency) errors.push(`${label}.currency is required`);
  // A watchlist is a graded research list, not a paper balance. An omitted
  // value is an error on a paper account. An explicit null stays null on
  // every account (Number(null) is 0, which would print as a real zero).
  const watchlist = raw.kind === "watchlist";
  const valueProvided = Object.prototype.hasOwnProperty.call(raw, "value");
  let value = null;
  if (!valueProvided || raw.value === "") {
    if (!watchlist) errors.push(`${label}.value must be a number`);
  } else if (raw.value == null) {
    value = null;
  } else {
    value = finiteOrNull(raw.value);
    if (value == null && !watchlist) errors.push(`${label}.value must be a number`);
  }

  const account = {
    ...raw,
    id: id || "",
    name: trimOrNull(raw.name) || id || "",
    currency: currency || "",
    cash: softMoney(raw, "cash"),
    value,
    startValue: softMoney(raw, "startValue"),
    returnPct: softMoney(raw, "returnPct"),
    benchmark: normalizeBenchmark(raw.benchmark, label, errors, { preserveMissing: watchlist }),
    projection: normalizeProjection(raw.projection, label, errors),
    equityCurve: normalizeEquityCurve(raw.equityCurve, label, errors),
    positions: asObjectArray(raw.positions, `${label}.positions`, errors),
    trades: asObjectArray(raw.trades, `${label}.trades`, errors),
    picks: asObjectArray(raw.picks, `${label}.picks`, errors),
    scorecards: asObjectArray(raw.scorecards, `${label}.scorecards`, errors),
    lessons: asObjectArray(raw.lessons, `${label}.lessons`, errors),
    strategy: isPlainObject(raw.strategy) ? raw.strategy : null,
  };
  if (Object.prototype.hasOwnProperty.call(raw, "signals")) {
    account.signals = normalizeSignals(raw.signals, label, errors);
  }
  return account;
}

/**
 * Validate + normalize a synced document. Throws PaperSnapshotError on a bad
 * shape so the route can answer 400 with the specific field problems — a bad
 * push must never half-land and leave the dashboard showing a broken snapshot.
 */
function normalizeSnapshot(doc) {
  const errors = [];
  if (!isPlainObject(doc)) {
    throw new PaperSnapshotError(["body must be a JSON object"]);
  }

  const accountsRaw = doc.accounts;
  if (!Array.isArray(accountsRaw) || accountsRaw.length === 0) {
    errors.push("accounts must be a non-empty array");
  }

  // Keep every account that passes shape checks. Display order is a renderer
  // concern (lib/paperAccounts.js) — this store never filters by known id.
  const accounts = (Array.isArray(accountsRaw) ? accountsRaw : [])
    .map((raw, idx) => normalizeAccount(raw, idx, errors))
    .filter(Boolean);

  const seen = new Set();
  for (const account of accounts) {
    if (!account.id) continue;
    if (seen.has(account.id)) errors.push(`duplicate account id '${account.id}'`);
    seen.add(account.id);
  }

  const day = finiteOrNull(doc.day);
  if (doc.day != null && day == null) errors.push("day must be a number");
  const totalDays = finiteOrNull(doc.totalDays);

  // Optional blocks. Missing keys are left off the stored document so an
  // older payload keeps the same shape. A present-but-wrong shape is a 400.
  let watchlist;
  let hotToday;
  let lab;
  if (doc.watchlist != null) watchlist = normalizeWatchlist(doc.watchlist, errors);
  if (doc.hot_today != null) hotToday = normalizeHotToday(doc.hot_today, errors);
  if (doc.lab != null) lab = normalizeLab(doc.lab, errors);

  if (errors.length) throw new PaperSnapshotError(errors);

  const normalized = {
    ...doc,
    updatedAt: trimOrNull(doc.updatedAt) || new Date().toISOString(),
    day: day == null ? null : Math.round(day),
    totalDays: totalDays == null ? DEFAULT_TOTAL_DAYS : Math.round(totalDays),
    accounts,
  };
  if (doc.watchlist == null) delete normalized.watchlist;
  else normalized.watchlist = watchlist;
  if (doc.hot_today == null) delete normalized.hot_today;
  else normalized.hot_today = hotToday;
  if (doc.lab == null) delete normalized.lab;
  else normalized.lab = lab;

  const json = JSON.stringify(normalized);
  if (Buffer.byteLength(json, "utf8") > MAX_DOC_BYTES) {
    throw new PaperSnapshotError([
      `snapshot is larger than ${Math.round(MAX_DOC_BYTES / 1024)}KB`,
    ]);
  }

  return normalized;
}

function hashDoc(doc) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(doc))
    .digest("hex");
}

async function pruneHistory() {
  try {
    await dbRun(
      `DELETE FROM paper_run_snapshots
       WHERE id NOT IN (
         SELECT id FROM paper_run_snapshots
         ORDER BY received_at DESC, id DESC
         LIMIT ?
       )`,
      [HISTORY_MAX_ROWS]
    );
  } catch (err) {
    console.warn("[paperRun] history prune skipped:", err.message);
  }
}

/** Store one snapshot as the newest row. Older rows stay as the history. */
async function savePaperSnapshot(doc, { source = "sync" } = {}) {
  await ensurePaperRunTables();
  const normalized = normalizeSnapshot(doc);
  const receivedAt = new Date().toISOString();
  const docHash = hashDoc(normalized);

  const previous = await dbGet(
    `SELECT doc_hash FROM paper_run_snapshots ORDER BY received_at DESC, id DESC LIMIT 1`
  );

  await dbRun(
    `INSERT INTO paper_run_snapshots
       (updated_at, day, doc_json, doc_hash, source, received_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      normalized.updatedAt,
      normalized.day,
      JSON.stringify(normalized),
      docHash,
      String(source || "sync"),
      receivedAt,
    ]
  );

  await pruneHistory();

  return {
    ok: true,
    receivedAt,
    updatedAt: normalized.updatedAt,
    day: normalized.day,
    accounts: normalized.accounts.length,
    docHash,
    unchanged: previous?.doc_hash === docHash,
  };
}

function parseDoc(row) {
  if (!row) return null;
  try {
    return JSON.parse(row.doc_json);
  } catch (err) {
    console.error("[paperRun] stored snapshot is not valid JSON:", err.message);
    return null;
  }
}

async function getLatestPaperSnapshot() {
  await ensurePaperRunTables();
  const row = await dbGet(
    `SELECT id, updated_at, day, doc_json, doc_hash, source, received_at
     FROM paper_run_snapshots
     ORDER BY received_at DESC, id DESC
     LIMIT 1`
  );
  const doc = parseDoc(row);
  if (!doc) return null;
  return {
    ...doc,
    meta: {
      snapshotId: Number(row.id),
      receivedAt: row.received_at,
      source: row.source,
      docHash: row.doc_hash,
    },
  };
}

/** History metadata only — the full documents stay out of the list response. */
async function listPaperSnapshots(limit = 30) {
  await ensurePaperRunTables();
  const capped = Math.max(1, Math.min(Number(limit) || 30, 200));
  const rows = await dbAll(
    `SELECT id, updated_at, day, doc_hash, source, received_at
     FROM paper_run_snapshots
     ORDER BY received_at DESC, id DESC
     LIMIT ?`,
    [capped]
  );
  return (rows || []).map((row) => ({
    snapshotId: Number(row.id),
    updatedAt: row.updated_at,
    day: row.day == null ? null : Number(row.day),
    docHash: row.doc_hash,
    source: row.source,
    receivedAt: row.received_at,
  }));
}

async function countPaperSnapshots() {
  await ensurePaperRunTables();
  const row = await dbGet(`SELECT COUNT(*) AS n FROM paper_run_snapshots`);
  return Number(row?.n || 0);
}

function readSeedFile() {
  const raw = fs.readFileSync(SEED_FILE, "utf8");
  return JSON.parse(raw);
}

/**
 * First-deploy seed so / is never an empty page before the first sync.
 * Runs only when the table has no rows; a real sync always wins afterwards.
 */
async function seedPaperRunIfEmpty() {
  await ensurePaperRunTables();
  const existing = await countPaperSnapshots();
  if (existing > 0) return { seeded: false, reason: "snapshots_exist" };
  if (!fs.existsSync(SEED_FILE)) return { seeded: false, reason: "no_seed_file" };
  const result = await savePaperSnapshot(readSeedFile(), { source: "seed" });
  return { seeded: true, ...result };
}

module.exports = {
  PaperSnapshotError,
  SEED_FILE,
  ensurePaperRunTables,
  normalizeSnapshot,
  savePaperSnapshot,
  getLatestPaperSnapshot,
  listPaperSnapshots,
  countPaperSnapshots,
  seedPaperRunIfEmpty,
  readSeedFile,
};
