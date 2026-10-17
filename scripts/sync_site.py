#!/usr/bin/env python3
"""Build the Practice Run JSON from /workspace/paper-trading and POST it to stocks.emgens.com.

Also attaches, when the files exist (never required):
  watchlist   /workspace/watchlist/watchlist_v2.json  (graded 45-name list)
  hot_today   /workspace/watchlist/hot_today.json
  lab         <paper-trading>/lab_bench.json          (SPY and QQQ start/now)
  signals     <account>/signals.csv                   on each account that has one

Usage: python3 sync_site.py [--dry-run]   (token: ~/.secrets/paper_sync_token, never printed)
Copy of the uploader that runs on the paper-trading machine. Paths default to that machine.
"""
import csv, json, os, re, sys, time, datetime as dt, urllib.request, urllib.error
import yfinance as yf
sys.path.insert(0, "/workspace/watchlist")
from sync_watchlist_addon import watchlist_account

ROOT = os.path.dirname(os.path.abspath(__file__))
SITE = "https://stocks.emgens.com"
START, END = "2026-10-15", "2026-10-29"
ACCOUNTS = [  # id, name, label, ccy, benchmark ticker, bench name, bench shares (per 1000 start), paused, optional
    ("ca-swing", "CA-SWING", "Canadian swing trading", "CAD", "XIU.TO", "iShares S&P/TSX 60 ETF", 18.6602, False, False),
    ("glb-branch", "GLB", "Green line breakout", "USD", "VOO", "Vanguard S&P 500 ETF", 1.4158, False, False),
    ("us-day", "US-LT", "US long-term v5 (buy and hold)", "USD", "SPY", "SPDR S&P 500 ETF", 1.2957, False, False),
    ("ca-day", "CA-DAY", "Canadian day trading (paused)", "CAD", "XIU.TO", "iShares S&P/TSX 60 ETF", 18.6602, True, False),
    ("lottery-us", "LOTTERY-US", "US lottery (to Jan 15)", "USD", "VOO", "Vanguard S&P 500 ETF", 1.4158, False, True),
    ("us-ghost", "US-GHOST", "Ghost fixed (Ghost Playbook v1, red-teamed)", "USD", "VOO", "Vanguard S&P 500 ETF", 1.4158, False, True),
    ("lottery-ca", "LOTTERY-CA", "Canadian lottery (to Jan 15)", "CAD", "XIU.TO", "iShares S&P/TSX 60 ETF", 18.6602, False, True),
    # Strategy Lab accounts. Optional: a missing folder is skipped, it does not fail the sync.
    # Bench shares left empty — the lab page reads lab_bench.json for SPY and QQQ, not this share count.
    ("ghost-orig", "GHOST-ORIG", "Gemini Ghost playbook as written", "USD", "SPY", "SPDR S&P 500 ETF", None, False, True),
    ("momentum", "MOMENTUM", "52-week-high breakouts on volume", "USD", "SPY", "SPDR S&P 500 ETF", None, False, True),
    ("baseline", "BASELINE", "Equal-weight A/B names, bought once", "USD", "SPY", "SPDR S&P 500 ETF", None, False, True),
]
PROJ = {"us-swing": (-8, -2, 3, 6), "ca-swing": (-5, -1.5, 2, 4), "ca-day": (0, 0, 0, 0),
        "lottery-us": (-20, -8, 10, 40), "lottery-ca": (-15, -6, 8, 25)}

RESET = {"us-day": "2026-10-15"}  # one-day reset: on this date ignore old site curve/picks/scorecards (day-trade data)
_px = {}
def price(t):
    if t not in _px:
        try:
            h = yf.Ticker(t).history(period="5d", interval="1d")
            _px[t] = round(float(h["Close"].dropna().iloc[-1]), 4) if len(h) else None
        except Exception:
            _px[t] = None
    return _px[t]

def r2(x): return None if x is None else round(x, 2)

def read(p):
    try: return open(p).read()
    except OSError: return ""

def ledger(d):
    p = os.path.join(d, "ledger.csv")
    return list(csv.DictReader(open(p))) if os.path.exists(p) else []

def stops_targets(d):
    m = re.search(r"ATR stops.*?:\s*(.+)", read(os.path.join(d, "portfolio.md")))
    out = {}
    if m:
        for tk, s, t in re.findall(r"([A-Z.]+)\s+([\d.]+)/([\d.]+)", m.group(1)):
            out[tk] = (float(s), float(t))
    return out

def lessons(d):
    out = []
    for line in read(os.path.join(d, "lessons.md")).splitlines():
        c = [x.strip() for x in line.strip().strip("|").split("|")]
        if len(c) == 5 and re.match(r"\d{4}-\d\d-\d\d", c[0]):
            et = c[1].upper() if c[1].upper() in ("ANALYSIS", "EXECUTION", "RISK", "REVIEW") else "none"
            out.append({"date": c[0], "errorType": et, "what": c[2], "fix": c[3], "status": c[4]})
    return out

def strategy(d, bench):
    lines = [l.strip() for l in read(os.path.join(d, "strategy.md")).splitlines() if l.strip()]
    title = re.sub(r"^#+\s*", "", lines[0]) if lines else None
    rules = [re.sub(r"^[-\d.]+\s*", "", l) for l in lines if l.startswith("- ")][:12]
    return {"summary": title, "benchmark": bench, "framing": None, "rules": rules, "reviewMetrics": None}

def read_signals(d):
    """Per-account signal log. None when signals.csv is absent (key omitted)."""
    p = os.path.join(d, "signals.csv")
    if not os.path.exists(p):
        return None
    rows = []
    for r in csv.DictReader(open(p)):
        taken_raw = (r.get("taken") or "").strip().lower()
        if taken_raw in ("yes", "y", "true", "1"):
            taken = True
        elif taken_raw in ("no", "n", "false", "0"):
            taken = False
        else:
            taken = None
        rows.append({
            "date": (r.get("date") or "").strip() or None,
            "ticker": (r.get("ticker") or "").strip() or None,
            "trigger": (r.get("trigger") or "").strip() or None,
            "taken": taken,
            "why": (r.get("why") or r.get("reason") or "").strip() or None,
        })
    return rows

def _first_json(paths, accept):
    for p in paths:
        if not p or not os.path.isfile(p):
            continue
        try:
            with open(p) as f:
                doc = json.load(f)
        except Exception as e:
            print(f"WARN could not read {p}: {e}")
            continue
        if accept(doc):
            return p, doc
        print(f"WARN {p} did not match the expected shape; skipping")
    return None, None

def attach_optional(doc):
    """Add watchlist, hot_today, and lab when the source files exist. Never fails the sync."""
    W = "/workspace/watchlist"
    wl_path, wl = _first_json([
        os.environ.get("LEDGER_WATCHLIST_JSON"),
        os.path.join(W, "watchlist_v2.json"),
        os.path.join(W, "snapshot_2026-10-16.json"),
        os.path.join(ROOT, "watchlist_v2.json"),
    ], lambda d: isinstance(d, dict) and isinstance(d.get("stocks"), list))
    if wl is not None:
        doc["watchlist"] = wl
        print(f"watchlist attached from {wl_path} ({len(wl.get('stocks') or [])} names)")
    else:
        print("watchlist not attached (no watchlist_v2.json)")
    hot_path, hot = _first_json([
        os.environ.get("LEDGER_HOT_TODAY_JSON"),
        os.path.join(W, "hot_today.json"),
        os.path.join(ROOT, "hot_today.json"),
    ], lambda d: isinstance(d, dict) and isinstance(d.get("hot"), list))
    if hot is not None:
        doc["hot_today"] = hot
        print(f"hot_today attached from {hot_path} ({len(hot.get('hot') or [])} names)")
    else:
        print("hot_today not attached")
    lab_path, lab = _first_json([
        os.environ.get("LEDGER_LAB_BENCH_JSON"),
        os.path.join(ROOT, "lab_bench.json"),
        os.path.join(ROOT, "lab", "lab_bench.json"),
        "/workspace/paper-trading/lab_bench.json",
    ], lambda d: isinstance(d, dict) and ("SPY" in d or "QQQ" in d))
    if lab is not None:
        doc["lab"] = lab
        print(f"lab benchmarks attached from {lab_path}")
    else:
        print("lab benchmarks not attached")


def build(prev):
    prev_acc = {a["id"]: a for a in (prev or {}).get("accounts", [])}
    today = dt.date.today().isoformat()
    accounts = []
    for aid, name, label, ccy, bt, bname, bsh, paused, optional in ACCOUNTS:
        d = os.path.join(ROOT, aid)
        if not os.path.isdir(d):
            if optional: continue
            raise SystemExit(f"missing account folder {aid}")
        rows = ledger(d)
        st = stops_targets(d)
        cash, pos, trades = 1000.0, {}, []
        for r in rows:
            if not r.get("side"): continue
            sh, px = float(r["shares"]), float(r["price"])
            val = float(r.get("value") or sh * px)
            tk, side = r["ticker"], r["side"].upper()
            p = pos.setdefault(tk, {"shares": 0.0, "cost": 0.0, "opened": f'{r["date"]} {r.get("time","")}'.strip(), "note": r.get("reason")})
            if side == "BUY":
                cash -= val; p["shares"] += sh; p["cost"] += val
            else:
                cash += val
                if p["shares"]: p["cost"] *= max(0.0, 1 - sh / p["shares"])
                p["shares"] -= sh
            trades.append({"date": r["date"], "time": r.get("time"), "ticker": tk, "side": side, "shares": sh,
                           "price": px, "value": round(val, 2), "reason": r.get("reason"), "confidence": r.get("confidence") or "n/a"})
        positions, mv_total, missing = [], 0.0, False
        for tk, p in pos.items():
            if p["shares"] <= 1e-9: continue
            last = price(tk)
            mv = r2(last * p["shares"]) if last is not None else None
            if mv is None: missing = True
            else: mv_total += mv
            s, t = st.get(tk.replace(".TO", "").replace(".V", ""), st.get(tk, (None, None)))
            positions.append({"ticker": tk, "shares": round(p["shares"], 4), "avgPrice": round(p["cost"] / p["shares"], 4),
                              "costBasis": r2(p["cost"]), "lastPrice": last, "marketValue": mv, "stop": s, "target": t,
                              "openedAt": p["opened"], "note": p["note"]})
        value = None if missing else r2(cash + mv_total)
        bpx = price(bt)
        bval = r2(bpx * bsh) if (bpx is not None and bsh is not None) else None
        notes = []
        if paused: notes.append("PAUSED Oct 15 by user: no new picks or trades.")
        if positions and paused: notes.append("Open position from Oct 15 is marked at the latest price; its exit is not yet logged.")
        if not positions: notes.append("All cash, no open position.")
        if missing: notes.append("A position has no current price, so the total is unavailable.")
        old = {} if RESET.get(aid) == today else prev_acc.get(aid, {})
        curve = [p for p in old.get("equityCurve", []) if p.get("date") != today]
        if not curve: curve = [{"date": START, "value": 1000, "benchmark": 1000}] if today != START else []
        curve.append({"date": today, "value": value, "benchmark": bval})
        pj = PROJ.get(aid)
        acc = {"id": aid, "name": name, "label": label, "currency": ccy, "startValue": 1000, "value": value,
               "returnPct": None if value is None else r2((value / 1000 - 1) * 100), "cash": r2(cash),
               "valueNote": " ".join(notes) or None, "status": "paused" if paused else "active",
               "benchmark": {"ticker": bt, "name": bname, "value": bval, "returnPct": r2((bval / 1000 - 1) * 100) if bval else None},
               "projection": old.get("projection") or ({"bear": pj[0], "baseLow": pj[1], "baseHigh": pj[2], "bull": pj[3], "note": "From projections.md (written Oct 15)."} if pj else None),
               "equityCurve": curve, "positions": positions, "trades": trades,
               "picks": old.get("picks", []), "scorecards": old.get("scorecards", []),
               "lessons": lessons(d) or old.get("lessons", []),
               "strategy": strategy(d, bt) if os.path.exists(os.path.join(d, "strategy.md")) else old.get("strategy")}
        sigs = read_signals(d)
        if sigs is not None:
            acc["signals"] = sigs
        accounts.append(acc)
    accounts.insert(0, watchlist_account())  # LT-WATCH first; US-SWING tracked in files only (off site since Oct 15)
    # trading day count since start
    s, t = dt.date.fromisoformat(START), dt.date.today()
    day = sum(1 for i in range((t - s).days + 1) if (s + dt.timedelta(i)).weekday() < 5)
    doc = {"updatedAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"), "day": max(1, min(day, 11)),
            "totalDays": 10, "run": {"name": "Practice Run", "startDate": START, "endDate": END,
            "note": "Paper only — pretend money, no real trades. CA-DAY paused Oct 15; US-DAY slot is now US Long-Term; US-SWING shelved (files only); LT-WATCH is the long-term watchlist."},
            "sourceNote": f"Synced from /workspace/paper-trading by sync_site.py at {dt.datetime.now().strftime('%Y-%m-%d %H:%M')} MT.",
            "accounts": accounts}
    attach_optional(doc)
    return doc

def http(method, path, body=None, token=None):
    req = urllib.request.Request(SITE + path, data=body, method=method, headers={"Content-Type": "application/json", "User-Agent": "paper-sync"})
    if token: req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=90) as r: return r.status, r.read().decode()
    except urllib.error.HTTPError as e: return e.code, e.read().decode()
    except Exception as e: return None, str(e)

def refresh_watchlist():
    import subprocess, time
    W = "/workspace/watchlist"
    try:
        if time.time() - os.path.getmtime(f"{W}/god_tier.csv") > 7 * 86400:
            subprocess.run([sys.executable, f"{W}/grade.py"], cwd=W, check=True, timeout=900, capture_output=True)
            print("grade.py re-run (god_tier.csv was >7 days old)")
    except Exception as e:
        print("WARN grade.py failed, using last god_tier.csv:", e)
    try:
        subprocess.run([sys.executable, f"{W}/hot_today.py"], cwd=W, check=True, timeout=600, capture_output=True)
        print("hot_today.py refreshed")
    except Exception as e:
        print("WARN hot_today.py failed, using last hot_today.json:", e)


def main():
    refresh_watchlist()
    st, txt = http("GET", "/api/paper")
    if st is None or (st and st >= 500):
        time.sleep(60); st, txt = http("GET", "/api/paper")
    prev = json.loads(txt) if st == 200 else None
    doc = build(prev)
    body = json.dumps(doc).encode()
    if "--dry-run" in sys.argv:
        print(json.dumps(doc, indent=1)[:4000]); return
    token = open(os.path.expanduser("~/.secrets/paper_sync_token")).read().strip()
    st, txt = http("POST", "/api/paper/sync", body, token)
    if st is None or st in (502, 503, 504):
        print(f"POST got {st}; site may be asleep, retrying in 60s"); time.sleep(60)
        st, txt = http("POST", "/api/paper/sync", body, token)
    print("POST", st, txt[:300])
    if st != 201: sys.exit(1)
    g, gt = http("GET", "/api/paper")
    live = json.loads(gt) if g == 200 else {}
    print("GET", g, "meta", live.get("meta"))
    for a in live.get("accounts", []):
        print(f'  {a["id"]:<11} {a.get("status","")}  value={a.get("value")} {a.get("currency")} ret={a.get("returnPct")}%  bench {a["benchmark"].get("ticker")}={a["benchmark"].get("value")}  pos={len(a.get("positions",[]))}')

def run_lab():
    try:
        import subprocess; subprocess.run([sys.executable, os.path.join(ROOT, "lab_daily.py")], timeout=600)
    except Exception as e: print("lab_daily failed:", e)

if __name__ == "__main__":
    run_lab()
    main()
