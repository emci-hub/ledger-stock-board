# CLAUDE.md — ledger-stock-board

Read this first, every session. This is the Code-side twin of the "Stock Big" Claude Project's NOW.md — same job, different tool. Don't re-derive these rules from the code; they're already decided.

## What this is
"Ledger" — a Node.js stock information board for family use, live at stocks.emgens.com. Long-term / Short-term / Penny picks, daily auto-refreshed, plus on-demand search. Not a trading platform — no brokerage, no order execution, no portfolio features.

## Stack
- Node.js + Express
- Turso (hosted libSQL/SQLite via @libsql/client, async)
- Hosting: Render free tier; UptimeRobot pings /healthz every 5 min
- Data sources: Twelve Data (price/indicators) · Alpha Vantage (analyst target + fallback news, 25/day) · Finnhub (peers/earnings) · Marketaux (primary news) · Gemini (synthesis, model via GEMINI_MODEL env) · Claude (manual "Deeper Look" button only, never automated)
- Repo: emci-hub/ledger-stock-board (public)

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
