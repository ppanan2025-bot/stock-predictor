# Independent reference implementation used ONCE to produce golden.json for test/features.test.mjs (python3 gen_golden.py).
# Synthetic closes; definitions from src/quant/features.mjs header / docs PLAN §6, written separately (no shared code).
import json, math

def months(a, b):
    y, m = map(int, a.split('-')); out = []
    while f"{y:04d}-{m:02d}" <= b:
        out.append(f"{y:04d}-{m:02d}"); m += 1
        if m == 13: y, m = y + 1, 1
    return out

def back(mo, k):
    y, m = map(int, mo.split('-')); m -= k
    while m <= 0: y, m = y - 1, m + 12
    return f"{y:04d}-{m:02d}"

def series(start, end, base, drift, amp, skip=()):
    out = []
    for i, mo in enumerate(months(start, end)):
        if mo in skip: continue
        c = round(base * (1 + drift) ** i * (1 + amp * math.sin(i * 1.3)), 4)
        out.append({"month": mo, "close": f"{c:.4f}"})
    return out

def fx(x, d=8):
    if x is None: return None
    s = f"{x:.{d}f}"
    return s[1:] if s.startswith('-') and float(s) == 0 else s

def mean(xs):
    s = 0.0
    for x in xs: s += x
    return s / len(xs)

def sstd(xs):
    if len(xs) < 2: return None
    mu = mean(xs); ss = 0.0
    for x in xs: ss += (x - mu) * (x - mu)
    return math.sqrt(ss / (len(xs) - 1))

def ret(c, M, k):
    a, b = c.get(M), c.get(back(M, k))
    return a / b - 1 if a and b else None

def logrets(c, frm, to):
    return [math.log(c[m] / c[back(m, 1)]) for m in months(frm, to) if m in c and back(m, 1) in c]

def feats(ticker, M, rows, peers):
    c = {r["month"]: float(r["close"]) for r in rows if r["month"] <= M}
    ms = sorted(c); r = {k: ret(c, M, k) for k in (1, 3, 6, 12)}
    win = months(back(M, 12), M); full = all(m in c for m in win)
    r12s = logrets(c, back(M, 11), M); vol12 = sstd(r12s) if len(r12s) == 12 else None
    mdd = dist = None
    if full:
        peak = -1e300; worst = 0.0
        for m in win:
            v = c[m]; peak = max(peak, v); worst = min(worst, v / peak - 1)
        mdd = worst; dist = c[M] / max(c[m] for m in win) - 1
    r36 = logrets(c, back(M, 35), M); ok = len(r36) >= 12
    z = {k: (math.log(1 + r[k]) / (vol12 * math.sqrt(k)) if r[k] is not None and vol12 else None) for k in (1, 3, 6, 12)}
    momz = max(-3, min(3, (0.5 * r[3] / 3 + 0.3 * r[6] / 6 + 0.2 * r[12] / 12) / vol12)) if None not in (r[3], r[6], r[12]) and vol12 else None
    rel, used = {}, {}
    pcs = sorted(peers, key=lambda p: p[0])
    for k in (1, 3, 6, 12):
        vals = [(t, ret({x["month"]: float(x["close"]) for x in pr if x["month"] <= M}, M, k)) for t, pr in pcs]
        vals = [(t, v) for t, v in vals if v is not None]
        used[k] = [t for t, _ in vals]
        rel[k] = r[k] - mean([v for _, v in vals]) if r[k] is not None and vals else None
    flags = set()
    if not pcs: flags.add('no_peers')
    elif not used[1]: flags.add('no_peer_data')
    if len(ms) < 13 or not full: flags.add('short_history')
    if len(r36) < 36: flags.add('partial_36m_window')
    first = ms[0]; lo = back(M, 36); span = months(first if first > lo else lo, M)
    gaps = [m for m in span if m not in c]
    if gaps: flags.add('gaps_in_window')
    return {"ticker": ticker, "month": M, "code_version": "features-v1", "close": fx(c[M], 4), "first_month": first, "n_months": len(ms),
      "n_returns36": len(r36), "r1": fx(r[1]), "r3": fx(r[3]), "r6": fx(r[6]), "r12": fx(r[12]), "vol12": fx(vol12),
      "vol36": fx(sstd(r36) if ok else None), "mean36": fx(mean(r36) if ok else None),
      "up_rate36": fx((sum(1 for x in r36 if x > 0) + 1) / (len(r36) + 2) if ok else None),
      "mdd12": fx(mdd), "dist_12m_high": fx(dist), "mom_z": fx(momz), "mom_z1": fx(z[1]), "mom_z3": fx(z[3]), "mom_z6": fx(z[6]), "mom_z12": fx(z[12]),
      "rel_r1_peers": fx(rel[1]), "rel_r3_peers": fx(rel[3]), "rel_r6_peers": fx(rel[6]), "rel_r12_peers": fx(rel[12]),
      "peers_used": {"r1": used[1], "r3": used[3], "r6": used[6], "r12": used[12]}, "benchmark": None, "rel_r3_bench": None,
      "gap_months": gaps, "flags": sorted(flags)}

S = {
  "AAPL": series("2023-01", "2026-09", 150.0, 0.012, 0.06),
  "GOOGL": series("2023-01", "2026-09", 90.0, 0.018, 0.08),
  "AMZN": series("2023-01", "2026-09", 100.0, 0.010, 0.10, skip=("2025-03",)),
  "SPCX": series("2026-06", "2026-09", 180.0, 0.03, 0.05),
}
peers = {"AAPL": ["GOOGL", "AMZN"], "GOOGL": ["AMZN", "AAPL"], "AMZN": ["GOOGL", "AAPL"], "SPCX": []}
cases = [("AAPL", "2026-09"), ("GOOGL", "2026-09"), ("AMZN", "2026-09"), ("AMZN", "2025-10"), ("SPCX", "2026-09"), ("AAPL", "2024-03")]
out = {"_comment": "SYNTHETIC closes; expected values from the independent reference implementation gen_golden.py", "series": S, "peers": peers,
       "cases": [{"ticker": t, "month": m, "expected": feats(t, m, S[t], [(p, S[p]) for p in peers[t]])} for t, m in cases]}
json.dump(out, open("golden.json", "w"), indent=1, sort_keys=True)
print("ok", len(out["cases"]))
