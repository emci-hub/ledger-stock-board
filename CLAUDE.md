# CLAUDE.md — ledger-stock-board

Read this first, every session. This is the Code-side twin of the "Stock Big" Claude Project's NOW.md — same job, different tool. Don't re-derive these rules from the code; they're already decided.

## What this is
"Ledger" — a Node.js stock information board for family use, live at stocks.emgens.com. Long-term / Short-term / Penny picks, daily auto-refreshed, plus on-demand search. Not a trading platform — no brokerage, no order execution, no portfolio features.

## Stack
- Node.js + Express
- Turso (hosted libSQL/SQLite via @libsql/client, async)
- Hosting: Render free tier; UptimeRobot pings /healthz every 5 min
- Data sources: Twelve Data (price/indicators) · Alpha Vantage (analyst target + fallback news, 25/day) · Finnhub (peers/earnings) · Marketaux (primary news) · Gemini (synthesis, model via GEMINI_MODEL env) · Claude (manual "Deeper Look" button only, never automated)
- **AI kill switch:** Gemini/Claude are **off unless `AI_ENABLED=1`**. See "AI kill switch" below. Paper sync is unaffected.
- Repo: emci-hub/ledger-stock-board (public)

## Screens and routes
- `/` — **Practice Run** dashboard (`public/index.html` + `public/practice.css` + `public/practice.js`). The paper-trading scoreboard. Read-only; it renders whatever `GET /api/paper` returns and nothing else.
- `/board` — the family stock board (`public/board.html`, formerly `public/index.html`). All of its APIs, `/archive`, `/dev-status`, search and watchlist are unchanged.
- `/healthz` — unchanged, still what UptimeRobot pings.
- Top nav on both pages switches between the two.

## Practice Run (paper trading) — `/` and `/api/paper*`
A fixed two-week paper test (Oct 15–29, 2026, pretend money, **never real trades**) across four accounts: `us-day`, `us-swing` (US$1,000 each, benchmark VOO) and `ca-day`, `ca-swing` (C$1,000 each, benchmark XIU.TO). The data is produced on a separate machine and pushed here — this app never computes, estimates or AI-fills a paper number. Anything the snapshot doesn't carry renders as "unavailable" (rule 1 applies to this screen too).

**Endpoints**
| Route | Auth | What it does |
|---|---|---|
| `GET /api/paper` | public | Latest snapshot, plus a `meta` block (`snapshotId`, `receivedAt`, `source`, `docHash`). 404 before the first sync. |
| `GET /api/paper/history?limit=30` | public | Snapshot metadata only, newest first — no documents. |
| `POST /api/paper/sync` | `Authorization: Bearer $PAPER_SYNC_TOKEN` | Stores one snapshot as the new latest. Older rows stay as the history (rolling 500). |

`POST /api/paper/sync` answers **401** without a valid token (compared timing-safely after hashing both sides), **503** when `PAPER_SYNC_TOKEN` is unset — an unset env var closes the endpoint, it never opens it — **400** with a `fields` array when the document shape is wrong, and **201** with `{ok, receivedAt, updatedAt, day, accounts, docHash, unchanged}` on success.

**Document shape** (`services/paperRun.js` validates it; unknown extra keys are stored as-is)
```
{
  updatedAt: ISO string (defaults to now),  day: number,  totalDays: number (default 10),
  run: { name, startDate, endDate, note },
  accounts: [{
    id, name, label, currency: "USD" | "CAD",          // id, currency and value are required
    startValue, value, returnPct, cash, valueNote,
    benchmark:  { ticker, name, value, returnPct },     // ticker required
    projection: { bear, baseLow, baseHigh, bull, note },// percentages
    equityCurve: [{ date: "YYYY-MM-DD", value, benchmark }],
    positions:  [{ ticker, shares, avgPrice, costBasis, lastPrice, marketValue, stop, target, openedAt, note }],
    trades:     [{ date, time, ticker, side: "BUY"|"SELL", shares, price, value, reason, confidence }],
    picks:      [{ date, action: "BUY"|"SELL"|"HOLD"|"FLAT", ticker, headline, entry, stop, target,
                   levels: [{ ticker, stop, target }], size, confidence, reason,
                   pros: [], cons: [], whyProsWin, plan }],
    scorecards: [{ date, derived: bool, basis,
                   grades: { analysis, execution, risk, review, result },  // "B" or { grade, note }
                   weakest, fix }],
    lessons:    [{ date, errorType: "ANALYSIS"|"EXECUTION"|"RISK"|"REVIEW"|"none", what, fix, status }],
    strategy:   { summary, benchmark, framing, rules: [], reviewMetrics }
  }]
}
```
Missing numbers must be `null`, never a placeholder — the dashboard prints "unavailable" for `null` and that is the correct outcome. A snapshot over 2 MB is rejected.

**Push it** (runs on the machine that owns the paper accounts)
```bash
curl -sS -X POST https://stocks.emgens.com/api/paper/sync \
  -H "Authorization: Bearer $PAPER_SYNC_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @data/paper-sync-example.json
```

**Seed / examples**
- `data/paper-run-seed.json` — the Oct 15, 2026 snapshot. Loaded automatically on boot when `paper_run_snapshots` is empty, so `/` is never blank on a fresh deploy. A real sync always supersedes it.
- `data/paper-sync-example.json` — a smaller single-account document to copy from.
- `node scripts/seedPaperRun.js [--force]` — load the seed on demand.

Oct 15 scorecards in the seed are marked `derived: true` and the page labels them "derived from rubric": they were computed from each account's own published A–F rubric, not hand-entered. Replace them with recorded cards on the next sync.

## AI kill switch (`AI_ENABLED`)
AI is **off by default**. Set `AI_ENABLED=1` (or `true` / `yes` / `on`) in the environment to turn Gemini and Claude back on. Anything else, including unset, pauses AI.

While paused:
- `lib/aiProvider.js` `generateAnalysis` / `generateJson` return a graceful paused result and **do not call any model API**. The Gemini and Claude providers have the same backstop, so Deeper Look cannot sneak a call through.
- The 07:00 UTC discovery/refresh/mood/didYouKnow job and the 13:00 UTC morning-failure retry **do not run**. The boot-time `refreshBoard` heal and missing-analysis Gemini repair also skip.
- On-demand AI endpoints answer with `{ ok: false, aiPaused: true, code: "ai_paused", message: "AI analysis is paused…" }` — `POST /api/analyze` and `POST /api/stock/:ticker/deeper-look` return **503**; `GET /api/analyze/availability` returns **200** with `available: 0`. Stored Deeper Looks remain readable.
- The family board keeps showing stored prices/analyses and a quiet "AI analysis paused" note. It never shows an error for the pause itself.
- **`POST /api/paper/sync` is not AI** and keeps working.

To resume: set `AI_ENABLED=1` on Render and redeploy. Do not set it unless you mean to spend Gemini/Claude tokens again.

## Rules that don't change
1. Real data or a clear "unavailable" label — never an AI-guessed number presented as real.
2. Plain-English first; jargon behind tap-to-reveal, one shared glossary file.
3. Unknown/missing classification data must block a board placement, never default to pass.
4. `resolveBoardSection()` / `assessBoardPlacement()` is the single source of truth for board placement — never duplicate this logic elsewhere.
5. Discovery sources must be real, published, professionally-managed data — never invented scoring or alphabetical ordering.
6. Every external API call gets rate-limit protection, same rolling-window pattern.
7. Finnhub free-tier is personal/non-commercial use only — Ledger qualifies, family-use only.
8. Never build Track B (trailing-stop bots, auto-execute copy-trading, options wheel). Ledger informs, it doesn't trade. If a "call" is ever asked for, build what informs the decision, not the decision itself.

## THE CURRENT JOB — full revamp, in progress

Three spec files define the target behavior. Full text of each lives at the repo root (or ask emci to re-paste if missing): `stock-alert-spec.md`, `stock-short-and-penny.md`, `stock-pipeline.md`. Do not guess their contents from memory of this file — read them directly before rewriting a screen.

**Scope, in order:**
1. **Long-term screen** → rewrite to match `stock-alert-spec.md`. Key shift: TRADE (what they buy) vs PRIMARY (company facts) are tracked separately; company financials never come from a wrapper's cap/P/E field; a flag needs cap >$100B + a dated 90-day event (deal or capex step-up) + a measured drop (10% off 63-day high, or 5% T-1→T+5) + confirmation the drop has stopped worsening. Four verdicts only: ignore / watch / add / avoid. Remove or reuse existing ranking/scoring code — audit before deleting, note what's reused.
2. **Short-term & penny screens** → rewrite to match `stock-short-and-penny.md`. Key shift: these become tape-checkers, not tape. No add without pasted, time-stamped session data (RVOL, VWAP, spread, opening range, halt status). Missing tape caps the verdict at watch/can't-screen — never add on missing fields. Short and penny are separate universes (price bands, board rules) — don't merge their logic.
3. **Pull pipeline** → rebuild as three hard-separated stages per `stock-pipeline.md`:
   - **PULL** (script only, no AI) — scheduled cadence: long-term once at 14:30 MT weekdays; short/penny pre-list at 6:00 MT, snapshot at 7:45 MT, short-only second snapshot at 8:30 MT for new names only. No jobs on weekends/holidays.
   - **ASSESS** (script only, no AI) — hard filters per screen, one company_id once, cap each screen's output at 25, ranked (not padded).
   - **FINAL** (AI, one pass) — only sees the ≤25-packet list, only runs if the packet changed since last run. This is the only stage that should ever spend a model token.
4. **Audit pass** — find and remove any scoring/ranking logic elsewhere in the app that now duplicates what ASSESS owns.
5. **Cadence wiring** — turn the scheduled runs on for real. **Do not do this without an explicit yes from emci** — this is a "needs a yes" item, not a default-on step.

**Working agreement (from the family board, applies here too):**
- assess → fix → test → move to next issue, repeated
- Real-code-tracing rigor for every claim — trace the actual code, never assume
- Say plainly when a pass comes up clean rather than manufacturing more issues
- One step per message — one thing to do, wait for confirmation, then the next
- Every code/SQL block labeled with exactly where it runs, called out before the code
- Explain in plain language first, then show the technical step
- Double-check before running anything touching security or data

**Report back format:** end each working session with what changed, what's still open, and which Scope number it maps to — that's what gets carried back into NOW.md in the Stock Big Project.
