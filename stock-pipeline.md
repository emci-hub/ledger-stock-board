# Pipeline: pull → assess → final

Three jobs. The model never sees the universe. Tokens only hit FINAL.

PULL = API / script. No AI.
ASSESS = hard filters, one company once, cut to 25. No AI.
FINAL = the screen spec. AI. One pass. Only the 25 packets, and only if they changed.

Cheap APIs (Finnhub-class, delayed quotes, no minute bars) cannot support an add on short or penny. Those screens are watch-only until PULL can store real bid/ask, time-of-day RVOL, VWAP, and halt. If those fields are missing, FINAL must not add.

---

## Cadence

Market holidays: no jobs. Weekend: no jobs.
US cash: 7:30–14:00 MT. First 15 minutes end 7:45 MT.

| Screen | Script pulls | Model runs |
|---|---|---|
| Long-term | Once, 14:30 MT weekdays | Once, same job, after ASSESS |
| Short-term | Pre-list 6:00 MT. One live snapshot 7:45 MT. Optional second snapshot 8:30 MT only for names not already packeted | Once at 7:45. Second FINAL only if the 8:30 snapshot produced new packets |
| Penny | Same pre-list. One live snapshot 7:45 MT. No second snapshot | Once at 7:45. Then stop |

No 5-minute loop. No all-day poll. No long-term job at the morning window. No short job at 14:30.

---

## Stage 1 — PULL (script only)

Weekly cache (Sunday or Monday pre-open)
- One row per operating company, not per listing.
- PRIMARY = main listing. TRADE = what they can buy (US share, CDR, ADR). Map wrappers to the same company_id. GOOG / GOOGL / a CAD CDR are one company.
- Company market cap in USD only. Drop if cap < $100B USD for the long bucket.
- Boards: NYSE, Nasdaq, TSX senior. No OTC. No Venture. No pink.
- Store: company_id, name, PRIMARY, TRADE, TRADE currency, exchange, cap_usd.

Daily long pull (14:30 MT)
- For the long bucket only: daily OHLCV on PRIMARY (company facts and the drop use PRIMARY closes). If they hold a TRADE wrapper, also store TRADE close for display, not for the rank.
- 63-day high, 20-day low, 20-day MA on PRIMARY.
- Cash, debt, OCF if the fundamentals endpoint is cheap. Else mark missing.
- Event list, last 90 days, headlines only: datetime, source, url, source_type.
- source_type must be filing or official_press or other. other does not count as an event.

Morning short / penny pull (6:00 MT, then 7:45 MT)
- Do not walk the whole market.
- 6:00: scanner of premarket heat, max 150 company_ids after dedupe. Split into short (TRADE price 10+) and penny (0.50–5.00 in TRADE currency).
- 7:45: snapshot those 150 plus a fresh heat list (max 50 new company_ids that just showed up). Still cap 150+50, then dedupe.
- Store if the API has them: last, bid, ask, spread, volume so far, VWAP, session open, halt. If it does not, write missing. Do not invent time-of-day RVOL. You may only write RVOL if you have today's volume by this clock time and the average volume by this same clock time for the last 20 sessions. Otherwise missing.
- Headlines: overnight + today, filing or official_press only. No bodies.

8:30 short-only snapshot
- Only company_ids not already in the 7:45 packet list. Max 25 new. Same fields.

Never pull article bodies in PULL.

---

## Stage 2 — ASSESS (script only)

One company_id once. If three listings exist, keep the TRADE they can buy and the PRIMARY for facts.

### Long-term
Keep only if all of these hold:
- cap_usd > 100B
- a real event in 90 days: source_type is filing or official_press, and the title is a deal or a spend step-up (acquire, merger, cash offer, capital expenditure, capex guidance, data-center build, capacity expansion). Not the bare words AI, cloud, energy, capacity.
- PRIMARY close is ≥ 10% under the 63-day high, or ≥ 5% down from the T-1 close to the worst close through T+5, where T is that event's date. One T per company: the most recent real event.

Rank by the % drop tied to that T. Not by "any drawdown." Take at most 25. Do not pad. Drop names with missing PRIMARY bars.

### Short-term (7:45)
Keep only if:
- TRADE price 10+ in TRADE currency
- a same-session or overnight filing / official_press headline
- spread < 0.3% if spread is present; if spread is missing, keep for watch rank only
- RVOL ≥ 2× only if RVOL is not missing

Rank by RVOL if present, else by today's dollar volume. Kick names already > 1 ATR past VWAP if both fields exist. Top 25. Do not pad.

If RVOL, VWAP, bid/ask, or halt is missing, packet those as missing. These names may go to FINAL as watch candidates only.

### Penny (7:45)
Keep only if:
- TRADE price 0.50–5.00, allowed board
- filing or official_press today/overnight
- dollar volume so far ≥ 2M in TRADE currency, or RVOL ≥ 3× if RVOL exists
- spread ≤ 2% if present

Rank by dollar volume so far. Top 25. Do not pad. Missing tape fields stay missing.

### Packets
ASSESS writes one JSON list per screen. That list is the only FINAL input. If the list is empty, do not call the model.

A packet did not change if ticker, close/last, event id, and verdict-fields are the same as the last run. Unchanged lists: skip FINAL.

---

## Stage 3 — FINAL (AI, once)

You are FINAL. You do not ask for more tickers. You do not browse the market. You do not fetch more than 3 article bodies, and only from urls already in the packets, and only when the title cannot classify the event.

Run that screen's spec only.

Long-term: add / watch / avoid / ignore / can't screen.
Short and penny: if any of RVOL, VWAP, bid/ask, halt is missing → cannot add. watch, ignore, avoid, or can't screen only.

Output at most 25 lines: company_id, TRADE, verdict, one reason. Stop.

---

## Log

They keep a local log. The model does not remember. The weekend script does not change PULL or FINAL.

After 40 logged lines on one screen, a human may change ASSESS rank weights. The script does not auto-delete setups. Forty is still noise. Say so.

---

## Waste / lies

Waste: per-ticker loops, article bodies before top 25, a model call on more than 25 names, a model call on an unchanged list, 5-minute FINAL, padding to 25, three listings of one company.

Lies: keyword "AI" as an event, invented RVOL, wrapper P/E as company cap, add on a cheap delayed feed.

Cheap: weekly company cache, USD cap, bulk snapshots, headlines with a source_type, 25 packets, one FINAL, second short FINAL only on new names.
