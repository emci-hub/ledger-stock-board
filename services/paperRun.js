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

function normalizeBenchmark(value, label, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${label}.benchmark is required and must be an object`);
    return null;
  }
  const ticker = trimOrNull(value.ticker);
  if (!ticker) errors.push(`${label}.benchmark.ticker is required`);
  return {
    ...value,
    ticker: ticker || "",
    value: finiteOrNull(value.value),
    returnPct: finiteOrNull(value.returnPct),
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
  if (finiteOrNull(raw.value) == null) {
    errors.push(`${label}.value must be a number`);
  }

  return {
    ...raw,
    id: id || "",
    name: trimOrNull(raw.name) || id || "",
    currency: currency || "",
    cash: finiteOrNull(raw.cash),
    value: finiteOrNull(raw.value),
    startValue: finiteOrNull(raw.startValue),
    returnPct: finiteOrNull(raw.returnPct),
    benchmark: normalizeBenchmark(raw.benchmark, label, errors),
    projection: normalizeProjection(raw.projection, label, errors),
    equityCurve: normalizeEquityCurve(raw.equityCurve, label, errors),
    positions: asObjectArray(raw.positions, `${label}.positions`, errors),
    trades: asObjectArray(raw.trades, `${label}.trades`, errors),
    picks: asObjectArray(raw.picks, `${label}.picks`, errors),
    scorecards: asObjectArray(raw.scorecards, `${label}.scorecards`, errors),
    lessons: asObjectArray(raw.lessons, `${label}.lessons`, errors),
    strategy: isPlainObject(raw.strategy) ? raw.strategy : null,
  };
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

  if (errors.length) throw new PaperSnapshotError(errors);

  const normalized = {
    ...doc,
    updatedAt: trimOrNull(doc.updatedAt) || new Date().toISOString(),
    day: day == null ? null : Math.round(day),
    totalDays: totalDays == null ? DEFAULT_TOTAL_DAYS : Math.round(totalDays),
    accounts,
  };

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
