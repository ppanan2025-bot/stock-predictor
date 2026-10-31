// Deterministic baseline forecast for the next month (PLAN §6, Phase 4). Pure: no DB, no network, no clock.
// Input: the features object of src/quant/features.mjs for the as-of month (fixed-decimal strings). Output: fixed-decimal strings,
// so baseline_sha256 = sha256(stableStringify(baseline)) is reproducible; save_prediction recomputes it from the pack and requires
// byte equality.
//
// Model (weights in config/model.json `baseline`, k frozen by the walk-forward backtest):
//   p_base = up_rate36                              Laplace-smoothed base rate of up months (36m window)
//   p_mom  = logistic(momentum_slope * mom_z)       mom_z = clip((0.5 r3/3 + 0.3 r6/6 + 0.2 r12/12) / vol12, ±3)
//   p_mr   = logistic(-mean_reversion_slope * z1)   z1 = ln(1+r1)/vol12 (last month's move, faded)
//   p_up   = w_base p_base + w_mom p_mom + w_mr p_mr + w_prior 0.5
//   mu     = wm_mean36 mean36 + wm_mom (s_mom vol12 mom_z) + wm_mr (-s_mr vol12 clip(z1,±3))     (monthly LOG return)
//   sigma  = vol12 (monthly log-return stdev, 12m)
//   mid = e^mu - 1, low = e^(mu - k sigma) - 1, high = e^(mu + k sigma) - 1                         (simple returns)
//   direction: up if p_up >= up_threshold and mid > flat_band; down if p_up <= down_threshold and mid < -flat_band; else flat
//   confidence = min(confidence_max, |p_up - 0.5|*2*0.8 + 0.1) * min(1, n_months / full_data_months)
// A ticker without vol12 / mean36 / up_rate36 / mom_z (fewer than 13 consecutive verified closes, e.g. SPCX listed 2026-06-12)
// gets baseline null with reason short_history: nothing is extrapolated.
import { sha256, stableStringify } from '../lib/hash.mjs';
import { fx } from './features.mjs';
import { nextMonth } from '../market/calendar.mjs';

export const BASELINE_DECIMALS = 6;
const f6 = (x) => fx(x, BASELINE_DECIMALS);
const clip = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const logistic = (x) => 1 / (1 + Math.exp(-x));
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

/** Direction from p_up and the mid return (shared by baseline and consensus). */
export function decideDirection(pUp, mid, b) {
  if (pUp >= b.up_threshold && mid > b.flat_band) return 'up';
  if (pUp <= b.down_threshold && mid < -b.flat_band) return 'down';
  return 'flat';
}

export function confidenceLabel(c, thresholds) {
  return c < thresholds.low ? 'low' : c < thresholds.medium ? 'medium' : 'high';
}

/**
 * @param features  features object (computeFeatures().features) for the as-of month, or {error}
 * @param model     loadModel()
 * @param opts.k    override range_k (backtest calibration only)
 * @returns {status:'ok', ...} or {status:'null', reason, ...}; always with baseline_sha256
 */
export function computeBaseline(features, model, { k = null } = {}) {
  const b = model.baseline;
  const kk = k ?? b.range_k;
  const head = { code_version: b.code_version, ticker: features?.ticker ?? null, as_of_month: features?.month ?? null,
    target_month: features?.month ? nextMonth(features.month) : null, features_sha256: null };
  if (!features || features.error) return seal({ ...head, status: 'null', reason: features?.error ?? 'no_features' });
  const vol12 = num(features.vol12), mean36 = num(features.mean36), up = num(features.up_rate36), momZ = num(features.mom_z), r1 = num(features.r1);
  const missing = Object.entries({ vol12, mean36, up_rate36: up, mom_z: momZ, r1 }).filter(([, v]) => v === null || !Number.isFinite(v)).map(([n]) => n);
  if (missing.length || !(vol12 > 0)) {
    return seal({ ...head, status: 'null', reason: 'short_history', missing_inputs: missing.sort(), n_months: features.n_months ?? null,
      flags: features.flags ?? [] });
  }
  const z1 = clip(Math.log(1 + r1) / vol12, -3, 3);
  const pBase = up;
  const pMom = logistic(b.momentum_slope * momZ);
  const pMr = logistic(-b.mean_reversion_slope * z1);
  const w = b.weights;
  const pUp = clip(w.base_rate * pBase + w.momentum * pMom + w.mean_reversion * pMr + w.prior * 0.5, 0, 1);
  const mw = b.mu_weights;
  const mu = mw.mean36 * mean36 + mw.momentum * (b.mu_momentum_scale * vol12 * momZ) + mw.mean_reversion * (-b.mu_mean_reversion_scale * vol12 * z1);
  const sigma = vol12;
  const mid = Math.exp(mu) - 1, low = Math.exp(mu - kk * sigma) - 1, high = Math.exp(mu + kk * sigma) - 1;
  const dataFactor = Math.min(1, Number(features.n_months) / b.full_data_months);
  const confidence = Math.min(b.confidence_max, Math.abs(pUp - 0.5) * 2 * 0.8 + 0.1) * dataFactor;
  // rounded first, so direction/label are decided on exactly the stored numbers
  const pUpR = Number(f6(pUp)), midR = Number(f6(mid));
  return seal({
    ...head, status: 'ok', features_sha256: features.features_sha256 ?? null,
    inputs: { close: features.close, r1: features.r1, vol12: features.vol12, mean36: features.mean36, up_rate36: features.up_rate36,
      mom_z: features.mom_z, n_months: features.n_months },
    z1: f6(z1), p_base: f6(pBase), p_mom: f6(pMom), p_mr: f6(pMr), p_up: f6(pUp),
    mu_log: f6(mu), sigma: f6(sigma), k: fx(kk, 4),
    mid: f6(mid), low: f6(low), high: f6(high),
    direction: decideDirection(pUpR, midR, b),
    confidence: fx(Number(f6(confidence)), 3),
    data_factor: f6(dataFactor),
  });
}

function seal(obj) {
  const { baseline_sha256: _, ...rest } = obj;
  return { ...rest, baseline_sha256: sha256(stableStringify(rest)) };
}

/**
 * Recomputes the baseline from a pack (features inside the pack) and compares it byte-for-byte with pack.baseline, or, for a
 * null baseline (short history), with the sealed {status:'null', reason, ...} object the pack keeps in baseline_detail.
 */
export function verifyPackBaseline(pack, model) {
  const want = pack?.baseline ?? pack?.baseline_detail ?? null;
  const fts = pack?.features && !pack.features.error ? stripFeatureExtras(pack.features) : { error: pack?.features?.error ?? 'no_features', ticker: pack?.ticker, month: pack?.as_of_month };
  const got = computeBaseline(fts, model);
  return { ok: stableStringify(got) === stableStringify(want), got, want };
}

/** pack.features = {...features, features_sha256, stored}: the baseline input is the features object itself plus its sha. */
export function stripFeatureExtras(pf) {
  const { stored: _s, ...rest } = pf;
  return rest;
}
