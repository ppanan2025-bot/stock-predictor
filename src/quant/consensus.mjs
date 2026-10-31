// Consensus of the accepted analyzer views, anchored on the deterministic baseline (Phase 4). Pure and deterministic; the
// stockdb server computes it (get_consensus, save_prediction, finalize_report) so no number of the final call is hand-typed.
//
//   anchor:  baseline mid / low / high / p_up / confidence; with a null baseline (short_history, e.g. SPCX) the anchor is
//            mid 0, sigma = short_history.sigma_floor, band mid ± k sigma, p_up 0.5, confidence 0.
//   m_i = (lo_i + hi_i)/2, s_i = +1 up / -1 down / 0 flat, c_i = analyzer confidence, w_b = consensus.baseline_weight
//   raw_mid = (w_b mid_b + Σ c_i m_i) / (w_b + Σ c_i), then CLAMPED to mid_b ± overlay_max_sigma·sigma (analyzers can never move
//            the call further from the baseline; overlay_clamped records it)
//   band:    low = mid - max(mid_b - low_b, wmean_c(m_i - lo_i)), high = mid + max(high_b - mid_b, wmean_c(hi_i - m_i))
//            (never narrower than the baseline band; never beyond anchor low/high ± overlay_max_sigma·sigma: band_clamped)
//   p_up = clip(p_b + clip(max_p_adj Σ c_i s_i / (w_b + Σ c_i), ±max_p_adj), 0.01, 0.99)
//   direction = decideDirection(p_up, mid)   (same thresholds as the baseline)
//   confidence = clip(0.5 conf_b + 0.5 mean(c_i) agreement, floor, cap), agreement = |Σ c_i s_i| / Σ c_i;
//                short history caps it at short_history.max_confidence
import { sha256, stableStringify } from '../lib/hash.mjs';
import { fx } from './features.mjs';
import { decideDirection, confidenceLabel } from './baseline.mjs';

const f6 = (x) => fx(x, 6);
const clip = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const SIGN = { up: 1, down: -1, flat: 0 };

export class ConsensusError extends Error {
  constructor(reason, message) { super(message); this.reason = reason; }
}

/** Signed percentage string used in reports: 0.02345 -> "+2.3%" (d decimals). */
export function pct(x, d = 1) {
  const v = Number(x) * 100;
  const s = v.toFixed(d);
  const z = Number(s) === 0 ? (0).toFixed(d) : s;
  return `${Number(z) > 0 ? '+' : ''}${z}%`;
}
export const money = (x) => `$${Number(x).toFixed(2)}`;

/**
 * @param baseline  computeBaseline() output (status ok|null)
 * @param analyses  accepted analyses [{id, agent, direction, exp_return_lo, exp_return_hi, confidence}]
 * @param model     loadModel()
 * @param close     as-of close (string/number) for price levels
 */
export function computeConsensus({ baseline, analyses, model, close = null }) {
  const c = model.consensus;
  const list = [...(analyses ?? [])].sort((a, b) => (a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : Number(a.id) - Number(b.id)));
  if (list.length < c.min_accepted_analyses)
    throw new ConsensusError('insufficient_analyses', `consensus needs >= ${c.min_accepted_analyses} accepted analyses, got ${list.length}`);
  const short = !baseline || baseline.status !== 'ok';
  const k = model.baseline.range_k;
  const sigma = short ? model.short_history.sigma_floor : Number(baseline.sigma);
  const midB = short ? 0 : Number(baseline.mid);
  const lowB = short ? midB - k * sigma : Number(baseline.low);
  const highB = short ? midB + k * sigma : Number(baseline.high);
  const pB = short ? 0.5 : Number(baseline.p_up);
  const confB = short ? 0 : Number(baseline.confidence);
  const wB = c.baseline_weight;

  const views = list.map((a) => {
    const lo = Number(a.exp_return_lo), hi = Number(a.exp_return_hi), conf = Number(a.confidence);
    return { analysis_id: Number(a.id), agent: a.agent, direction: a.direction, lo, hi, mid: (lo + hi) / 2, confidence: conf, sign: SIGN[a.direction] ?? 0 };
  });
  const sumC = views.reduce((s, v) => s + v.confidence, 0);
  const rawMid = (wB * midB + views.reduce((s, v) => s + v.confidence * v.mid, 0)) / (wB + sumC || 1);
  const bound = c.overlay_max_sigma * sigma;
  const mid = clip(rawMid, midB - bound, midB + bound);
  const wmean = (fn) => (sumC > 0 ? views.reduce((s, v) => s + v.confidence * fn(v), 0) / sumC : 0);
  const downOff = Math.max(midB - lowB, wmean((v) => v.mid - v.lo));
  const upOff = Math.max(highB - midB, wmean((v) => v.hi - v.mid));
  // the band is bounded too (Validator Phase 4 #9): never wider than the anchor band ± overlay_max_sigma·sigma
  const rawLow = mid - downOff, rawHigh = mid + upOff;
  const low = Math.max(rawLow, lowB - bound), high = Math.min(rawHigh, highB + bound);
  const bandClamped = rawLow < low - 1e-12 || rawHigh > high + 1e-12;
  const vote = views.reduce((s, v) => s + v.confidence * v.sign, 0);
  const pAdj = clip(c.max_p_adj * vote / (wB + sumC || 1), -c.max_p_adj, c.max_p_adj);
  const pUp = clip(pB + pAdj, 0.01, 0.99);
  const agreement = sumC > 0 ? Math.abs(vote) / sumC : 0;
  const meanC = views.length ? sumC / views.length : 0;
  let conf = clip(0.5 * confB + 0.5 * meanC * agreement, c.confidence_floor, c.confidence_cap);
  if (short) conf = Math.min(conf, model.short_history.max_confidence);

  const pUpR = Number(f6(pUp)), midR = Number(f6(mid)), confR = Number(fx(conf, 3));
  const out = {
    code_version: 'consensus-v1',
    baseline_status: short ? 'null' : 'ok', baseline_reason: short ? (baseline?.reason ?? 'no_baseline') : null,
    baseline_sha256: baseline?.baseline_sha256 ?? null,
    anchor: { mid: f6(midB), low: f6(lowB), high: f6(highB), p_up: f6(pB), sigma: f6(sigma), confidence: fx(confB, 3) },
    analyses: views.map((v) => ({ analysis_id: v.analysis_id, agent: v.agent, direction: v.direction, lo: f6(v.lo), hi: f6(v.hi), mid: f6(v.mid), confidence: fx(v.confidence, 3) })),
    raw_mid: f6(rawMid), overlay_bound: f6(bound), overlay_clamped: Math.abs(rawMid - mid) > 1e-12, band_clamped: bandClamped,
    p_adj: f6(pAdj), mu_adj: f6(mid - midB),
    p_up: f6(pUp), mid: f6(mid), low: f6(low), high: f6(high),
    direction: decideDirection(pUpR, midR, model.baseline),
    agreement: f6(agreement), confidence: fx(confR, 3), confidence_label: confidenceLabel(confR, c.label_thresholds),
    short_history: short,
  };
  if (close !== null && close !== undefined) {
    const cl = Number(close);
    out.price_levels = { as_of_close: fx(cl, 4), low: fx(cl * (1 + Number(out.low)), 2), mid: fx(cl * (1 + Number(out.mid)), 2), high: fx(cl * (1 + Number(out.high)), 2) };
  }
  out.formatted = formatConsensus(out);
  out.consensus_sha256 = sha256(stableStringify(out));
  return out;
}

/** The exact strings a report must use for the call (Summary / Baseline vs Consensus). */
export function formatConsensus(c) {
  const f = { direction: c.direction, mid: pct(c.mid), low: pct(c.low), high: pct(c.high), p_up: Number(c.p_up).toFixed(2),
    confidence: Number(c.confidence).toFixed(2), confidence_label: c.confidence_label,
    anchor_mid: pct(c.anchor.mid), anchor_low: pct(c.anchor.low), anchor_high: pct(c.anchor.high), anchor_p_up: Number(c.anchor.p_up).toFixed(2) };
  if (c.price_levels) Object.assign(f, { close: money(c.price_levels.as_of_close), price_low: money(c.price_levels.low), price_mid: money(c.price_levels.mid), price_high: money(c.price_levels.high) });
  return f;
}
