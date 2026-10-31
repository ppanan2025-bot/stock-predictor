// Deterministic quant features over VERIFIED month-end closes only (PLAN §6, docs/METHOD.md). Pure: no DB, no network, no clock.
// The same closes always give byte-identical output (fixed iteration order, values rounded to fixed decimals and serialised as
// strings), so features_sha256 = sha256(stableStringify(features)) is reproducible and testable against golden fixtures.
//
// Rules
// - Gaps are never interpolated: a value whose inputs are missing is null.
// - Short history (e.g. SPCX, listed 2026-06-12) is never extrapolated: 12-month values need 13 consecutive closes, 36-month
//   statistics need >= 12 monthly returns; otherwise null, and flags carry `short_history` / `partial_36m_window`.
// - Only closes with month <= as_of month are read (no look-ahead), for the ticker, its peers and the benchmark.
//
// Definitions (M = as_of month, c(m) = verified close, ret(m) = ln(c(m)/c(m-1)) when both closes exist)
//   r_k            c(M)/c(M-k) - 1                                   k in 1,3,6,12
//   vol12          sample stdev (n-1) of ret over M-11..M             all 12 returns required
//   vol36, mean36  sample stdev / mean of the available ret over M-35..M   >= 12 returns
//   up_rate36      (ups+1)/(n+2) over the same returns (Laplace-smoothed base rate of up months)
//   mdd12          min over t in M-12..M of c(t)/max(c(M-12..t)) - 1  all 13 closes required
//   dist_12m_high  c(M)/max(c(M-12..M)) - 1                          all 13 closes required
//   mom_z_k        ln(1+r_k) / (vol12 * sqrt(k))   (k-month log return in units of its random-walk stdev)
//   mom_z          clip((0.5*r3/3 + 0.3*r6/6 + 0.2*r12/12) / vol12, -3, 3)   (PLAN §6 baseline input)
//   rel_rk_peers   r_k - mean(r_k of peers that have both closes)    peers from companies.peers
//   rel_r3_bench   r3 - r3(benchmark) when a role=benchmark company has data
import { prevMonth, monthRange } from '../market/calendar.mjs';
import { sha256, stableStringify } from '../lib/hash.mjs';

export const FEATURES_CODE_VERSION = 'features-v1';
export const DECIMALS = 8;
export const MIN_RETURNS_36 = 12;
export const HORIZONS = [1, 3, 6, 12];

/** Fixed-decimal string (no "-0"), or null for missing/non-finite values. */
export function fx(x, d = DECIMALS) {
  if (x === null || x === undefined || !Number.isFinite(x)) return null;
  const s = x.toFixed(d);
  return /^-0\.?0*$/.test(s) ? s.slice(1) : s;
}

export function monthsBack(m, k) { let x = m; for (let i = 0; i < k; i++) x = prevMonth(x); return x; }

/** Map month -> Number(close) from rows [{month, close}] (strings or numbers); rows after `asOf` are dropped. */
export function closeMap(rows, asOf = null) {
  const m = new Map();
  for (const r of rows ?? []) {
    if (asOf && r.month > asOf) continue;
    const v = Number(r.close);
    if (Number.isFinite(v) && v > 0) m.set(r.month, v);
  }
  return m;
}

const mean = (xs) => { let s = 0; for (const x of xs) s += x; return s / xs.length; };
function sampleStdev(xs) {
  if (xs.length < 2) return null;
  const mu = mean(xs);
  let ss = 0;
  for (const x of xs) ss += (x - mu) * (x - mu);
  return Math.sqrt(ss / (xs.length - 1));
}
const clip = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function simpleReturn(closes, m, k) {
  const a = closes.get(m), b = closes.get(monthsBack(m, k));
  return a && b ? a / b - 1 : null;
}

/** Monthly log returns for months in [from..to] where both the month and the previous month have a close (ordered). */
export function logReturns(closes, from, to) {
  const out = [];
  for (const m of monthRange(from, to)) {
    const a = closes.get(m), b = closes.get(prevMonth(m));
    if (a && b) out.push({ month: m, ret: Math.log(a / b) });
  }
  return out;
}

/**
 * @param ticker
 * @param month       as_of month (must have a verified close)
 * @param rows        the ticker's verified closes [{month, close}]
 * @param peers       [{ticker, rows}] (companies.peers); optional
 * @param benchmark   {ticker, rows} or null
 * @returns {features, features_sha256} or {error:'no_verified_close'}
 */
export function computeFeatures({ ticker, month, rows, peers = [], benchmark = null }) {
  const closes = closeMap(rows, month);
  const c = closes.get(month);
  if (!c) return { error: 'no_verified_close', ticker, month };
  const months = [...closes.keys()].sort();
  const first = months[0];
  const flags = new Set();

  const r = Object.fromEntries(HORIZONS.map((k) => [k, simpleReturn(closes, month, k)]));

  // 12-month window: 13 closes M-12..M
  const win13 = monthRange(monthsBack(month, 12), month);
  const full13 = win13.every((m) => closes.has(m));
  const rets12 = logReturns(closes, monthsBack(month, 11), month);
  const vol12 = rets12.length === 12 ? sampleStdev(rets12.map((x) => x.ret)) : null;
  let mdd12 = null, dist = null;
  if (full13) {
    let peak = -Infinity, worst = 0;
    for (const m of win13) { const v = closes.get(m); if (v > peak) peak = v; const dd = v / peak - 1; if (dd < worst) worst = dd; }
    mdd12 = worst;
    dist = c / Math.max(...win13.map((m) => closes.get(m))) - 1;
  }

  // 36-month window: available returns M-35..M (>= 12)
  const rets36 = logReturns(closes, monthsBack(month, 35), month).map((x) => x.ret);
  const ok36 = rets36.length >= MIN_RETURNS_36;
  const vol36 = ok36 ? sampleStdev(rets36) : null;
  const mean36 = ok36 ? mean(rets36) : null;
  const up_rate36 = ok36 ? (rets36.filter((x) => x > 0).length + 1) / (rets36.length + 2) : null;

  // momentum z-scores (scale = vol12; null without it)
  const z = {};
  for (const k of HORIZONS) z[k] = r[k] !== null && vol12 ? Math.log(1 + r[k]) / (vol12 * Math.sqrt(k)) : null;
  const mom_z = r[3] !== null && r[6] !== null && r[12] !== null && vol12
    ? clip((0.5 * r[3] / 3 + 0.3 * r[6] / 6 + 0.2 * r[12] / 12) / vol12, -3, 3) : null;

  // relative strength vs peers and benchmark (their closes are also cut at the as_of month)
  const peerList = [...(peers ?? [])].sort((a, b) => (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0));
  const peerCloses = peerList.map((p) => ({ ticker: p.ticker, closes: closeMap(p.rows, month) }));
  const rel = {}, peersUsed = {};
  for (const k of HORIZONS) {
    const vals = peerCloses.map((p) => ({ t: p.ticker, v: simpleReturn(p.closes, month, k) })).filter((x) => x.v !== null);
    peersUsed[k] = vals.map((x) => x.t);
    rel[k] = r[k] !== null && vals.length ? r[k] - mean(vals.map((x) => x.v)) : null;
  }
  if (!peerList.length) flags.add('no_peers');
  else if (!peersUsed[1].length) flags.add('no_peer_data');
  let rel_r3_bench = null;
  if (benchmark) {
    const b3 = simpleReturn(closeMap(benchmark.rows, month), month, 3);
    rel_r3_bench = r[3] !== null && b3 !== null ? r[3] - b3 : null;
  }

  const n_months = months.length;
  if (n_months < 13 || !full13) flags.add('short_history');
  if (rets36.length < 36) flags.add('partial_36m_window');
  const span = monthRange(first > monthsBack(month, 36) ? first : monthsBack(month, 36), month);
  const gap_months = span.filter((m) => !closes.has(m));
  if (gap_months.length) flags.add('gaps_in_window');

  const features = {
    ticker, month, code_version: FEATURES_CODE_VERSION,
    close: fx(c, 4), first_month: first, n_months, n_returns36: rets36.length,
    r1: fx(r[1]), r3: fx(r[3]), r6: fx(r[6]), r12: fx(r[12]),
    vol12: fx(vol12), vol36: fx(vol36), mean36: fx(mean36), up_rate36: fx(up_rate36),
    mdd12: fx(mdd12), dist_12m_high: fx(dist),
    mom_z: fx(mom_z), mom_z1: fx(z[1]), mom_z3: fx(z[3]), mom_z6: fx(z[6]), mom_z12: fx(z[12]),
    rel_r1_peers: fx(rel[1]), rel_r3_peers: fx(rel[3]), rel_r6_peers: fx(rel[6]), rel_r12_peers: fx(rel[12]),
    peers_used: { r1: peersUsed[1], r3: peersUsed[3], r6: peersUsed[6], r12: peersUsed[12] },
    benchmark: benchmark?.ticker ?? null, rel_r3_bench: fx(rel_r3_bench),
    gap_months, flags: [...flags].sort(),
  };
  return { features, features_sha256: featuresSha256(features) };
}

export const featuresJson = (features) => stableStringify(features);
export const featuresSha256 = (features) => sha256(featuresJson(features));

/** quant_features columns (DECIMAL columns take the fixed-decimal strings as-is). */
export function featuresRow(features, sha) {
  return { ticker: features.ticker, month: features.month, close: features.close, r1: features.r1, r3: features.r3, r6: features.r6, r12: features.r12,
    vol12: features.vol12, vol36: features.vol36, mdd12: features.mdd12, dist_12m_high: features.dist_12m_high, up_rate36: features.up_rate36,
    mean36: features.mean36, rel_r3_bench: features.rel_r3_bench, n_months: features.n_months, features_json: featuresJson(features),
    features_sha256: sha, code_version: features.code_version };
}
