# Prediction method

Code: `src/quant/features.mjs`, `src/quant/baseline.mjs`, `src/quant/consensus.mjs`, `src/quant/backtest.mjs`. Parameters:
`config/model.json`. Everything here is pure and deterministic: the same verified closes give byte-identical output, and every
output carries a sha256 (`features_sha256`, `baseline_sha256`, `consensus_sha256`) that the server recomputes before storing.

**Bottom line first:** the deterministic baseline has **no demonstrated skill beyond the base rate** (see Backtest). Its
range is reasonably calibrated in-sample. Treat every call as a probabilistic summary, not a forecast to trade on.

## 1. Inputs and as-of discipline

- Only VERIFIED month-end closes (`month_end_prices`: Nasdaq close cross-checked against CNBC within 0.01, trade date equal to
  the last NYSE trading day). Gaps stay null and are never interpolated.
- A prediction for target month M uses data dated up to the end of the as-of month A = M-1 only (closes, news, notes). The
  planner's `start_run` snapshots one immutable research pack per ticker (`research_packs`, `pack_sha256`).
- Short history (fewer than 13 consecutive verified closes, e.g. SPCX listed 2026-06-12) gives null features and a null
  baseline with reason `short_history`; nothing is extrapolated.

## 2. Features (`features-v1`)

M = as-of month, c(m) = verified close, ret(m) = ln(c(m)/c(m-1)).

| Feature | Definition | Needs |
|---|---|---|
| r1, r3, r6, r12 | c(M)/c(M-k) - 1 | both closes |
| vol12 | sample stdev (n-1) of ret over M-11..M | all 12 returns |
| vol36, mean36 | sample stdev / mean of available ret over M-35..M | >= 12 returns |
| up_rate36 | (ups+1)/(n+2) over the same returns (Laplace-smoothed base rate of up months) | >= 12 returns |
| mdd12 | min over t in M-12..M of c(t)/max(c(M-12..t)) - 1 | 13 closes |
| dist_12m_high | c(M)/max(c(M-12..M)) - 1 | 13 closes |
| mom_z | clip((0.5 r3/3 + 0.3 r6/6 + 0.2 r12/12) / vol12, ±3) | r3, r6, r12, vol12 |
| mom_z_k | ln(1+r_k) / (vol12 sqrt(k)) | |
| rel_rk_peers | r_k - mean(r_k of peers with both closes) | peers from companies.peers |

## 3. Baseline (`baseline-v1`, `config/model.json` `baseline`)

```
z1     = clip(ln(1+r1)/vol12, ±3)                                  last month's move in sigma units
p_base = up_rate36
p_mom  = logistic(0.35 · mom_z)
p_mr   = logistic(-0.25 · z1)                                      fade last month's move
p_up   = 0.45 p_base + 0.25 p_mom + 0.10 p_mr + 0.20 · 0.5        (shrinkage toward 0.5)
mu     = 0.5 mean36 + 0.3 (0.25 · vol12 · mom_z) + 0.2 (-0.10 · vol12 · z1)     monthly LOG return
sigma  = vol12
mid = e^mu - 1,  low = e^(mu - k·sigma) - 1,  high = e^(mu + k·sigma) - 1        simple returns, k = 1.10 (FROZEN)
direction  = up if p_up >= 0.55 and mid > 1%;  down if p_up <= 0.45 and mid < -1%;  else flat
confidence = min(0.9, |p_up - 0.5|·2·0.8 + 0.1) · min(1, n_months/36)
label      = < 0.40 low, < 0.65 medium, else high
```

**k = 1.10 is frozen** (`range_k_frozen_at` in `config/model.json`): chosen by `npm run backtest -- --calibrate` as the grid value
whose lo..hi coverage is closest to 68% inside the 60-76% acceptance band. Changing any baseline parameter changes the
meaning of `baseline-v1` and requires re-running the backtest and bumping `code_version`.

## 4. Consensus overlay (`consensus-v1`, `config/model.json` `consensus`)

The final call is computed by the server (`get_consensus`, `save_prediction`, `finalize_report`), never typed by an agent.
It needs >= 3 analyses ACCEPTED by the validator. Each analysis i gives direction s_i (+1 up, -1 down, 0 flat), a simple-return
range [lo_i, hi_i] with mid m_i, and confidence c_i. The baseline is the anchor (weight w_b = 1.0).

```
raw_mid = (w_b·mid_b + Σ c_i m_i) / (w_b + Σ c_i)
mid     = clip(raw_mid, mid_b - 1.5·sigma, mid_b + 1.5·sigma)      overlay clamp ±1.5σ (overlay_clamped is recorded)
low     = mid - max(mid_b - low_b, wmean_c(m_i - lo_i))            band never narrower than the baseline band
high    = mid + max(high_b - mid_b, wmean_c(hi_i - m_i))
p_up    = clip(p_b + clip(0.15 · Σ c_i s_i / (w_b + Σ c_i), ±0.15), 0.01, 0.99)
direction  = same rule as the baseline
confidence = clip(0.5 conf_b + 0.5 · mean(c_i) · agreement, 0.05, 0.9),  agreement = |Σ c_i s_i| / Σ c_i
```

- Null baseline (short history): anchor mid 0, sigma = 0.15 (`short_history.sigma_floor`), p 0.5, confidence 0; confidence is
  capped at 0.40 and analyzers must give confidence <= 0.4 and a range at least 0.30 wide.
- `finalize_report`: final_confidence = clip(confidence + validator confidence_adj (-0.3..0.1), 0.05, 0.95), capped at 0.40
  for short history.
- Analyzer rules enforced by `save_analysis`: direction consistent with the range mid, evidence ids verified and in the pack,
  confidence <= 0.2 without evidence (technical exempt), rationale >= 40 characters.

## 5. Backtest (walk-forward, baseline only)

`npm run backtest` (read-only). Target months 2024-01..2026-09, GOOGL/AMZN/AAPL, each month predicted from closes up to the
previous month only. Results with the frozen k = 1.10 (run 2026-10-31):

| Scope | n | direction hit (up/flat/down) | sign hit | lo..hi coverage | Brier |
|---|---|---|---|---|---|
| overall | 96 | 38.5% | 58.3% | 67.7% | 0.2490 |
| AAPL | 32 | 25.0% | 62.5% | 75.0% | 0.2460 |
| AMZN | 32 | 43.8% | 53.1% | 62.5% | 0.2532 |
| GOOGL | 32 | 46.9% | 59.4% | 65.6% | 0.2478 |

Base rate of up months in the sample: 58.3%. Calls: 67 up, 29 flat, 0 down. Skipped (short history): 6.

**Honest reading:**
- **Sign hit 58.3% equals the base rate 58.3%.** Always saying "up" would score the same. The baseline has no
  directional skill beyond the base rate in this sample.
- Brier 0.2490 is barely better than a constant 0.5 forecast (0.25) and worse than a constant forecast of the in-sample base
  rate (0.583 · 0.417 ≈ 0.243). The probabilities carry essentially no information.
- The three-way direction hit (38.5%) is low because "flat" calls almost never match a realised move of less than 1%.
- Coverage 67.7% matches the ~68% target, but k was chosen in-sample on the same 96 rows (k = 1.00 gave 60.4%), so live
  coverage is likely to be somewhat lower. Re-check once at least 6 live predictions are scored (`/score-outcomes`).
- n = 96 overlapping rows over 33 months of a strong bull market for three correlated mega-caps: any estimate here is noisy.

## 6. Calibration and scoring

- `score_outcomes` scores final/reviewed predictions once the target month has a verified close: direction hit, in-range,
  Brier, absolute error vs mid. `v_calibration` aggregates per ticker; the pack carries it to the agents.
- Suggested (never automatic) changes, e.g. re-tuning k when live coverage leaves 60-76% over >= 6 scored months, go through
  a reviewed config change, a backtest re-run and a new `code_version`.
