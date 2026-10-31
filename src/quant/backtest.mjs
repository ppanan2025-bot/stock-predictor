// Walk-forward backtest of the baseline only (PLAN §6 "Calibration"). Pure over loaded inputs: for every target month T in
// [from..to] and every ticker with a verified close for T and T-1, the features are recomputed from closes <= T-1 only
// (featuresFor -> computeFeatures cuts every series, peers included, at the as-of month: no look-ahead), the baseline is
// computed, and the realised simple return close(T)/close(T-1) - 1 is compared with it.
//   direction hit: up -> r > 0, down -> r < 0, flat -> |r| < flat_band
//   sign hit:      (p_up > 0.5) == (r > 0)  (ties at 0.5 count as a miss)
//   coverage:      low <= r <= high
//   brier:         (p_up - 1[r > 0])^2
import { featuresFor } from './featureStore.mjs';
import { computeBaseline } from './baseline.mjs';
import { monthRange, prevMonth } from '../market/calendar.mjs';
import { fx } from './features.mjs';

export function walkForward(inputs, { from, to, model, k = null, tickers = null }) {
  const out = [];
  const list = tickers ?? inputs.companies.filter((c) => c.active && c.role === 'target').map((c) => c.ticker);
  for (const ticker of list) {
    const closes = new Map((inputs.byTicker.get(ticker) ?? []).map((r) => [r.month, Number(r.close)]));
    for (const target of monthRange(from, to)) {
      const asOf = prevMonth(target);
      if (!closes.has(target) || !closes.has(asOf)) continue;
      const f = featuresFor(inputs, ticker, asOf);
      if (f.error) continue;
      const b = computeBaseline({ ...f.features, features_sha256: f.features_sha256 }, model, { k });
      if (b.status !== 'ok') { out.push({ ticker, target, as_of: asOf, status: 'null', reason: b.reason }); continue; }
      const r = closes.get(target) / closes.get(asOf) - 1;
      const pUp = Number(b.p_up), low = Number(b.low), high = Number(b.high);
      const fb = model.baseline.flat_band;
      const dirHit = b.direction === 'up' ? r > 0 : b.direction === 'down' ? r < 0 : Math.abs(r) < fb;
      out.push({ ticker, target, as_of: asOf, status: 'ok', p_up: pUp, mid: Number(b.mid), low, high, direction: b.direction, actual: r,
        direction_hit: dirHit, sign_hit: pUp !== 0.5 && (pUp > 0.5) === (r > 0), in_range: r >= low && r <= high, brier: (pUp - (r > 0 ? 1 : 0)) ** 2 });
    }
  }
  return out;
}

function metrics(ok) {
  const mean = (fn) => (ok.length ? ok.reduce((s, r) => s + fn(r), 0) / ok.length : null);
  return { n: ok.length, direction_hit_rate: mean((r) => (r.direction_hit ? 1 : 0)), sign_hit_rate: mean((r) => (r.sign_hit ? 1 : 0)),
    coverage: mean((r) => (r.in_range ? 1 : 0)), brier: mean((r) => r.brier), base_rate_up: mean((r) => (r.actual > 0 ? 1 : 0)),
    calls: ok.reduce((acc, r) => { acc[r.direction] = (acc[r.direction] ?? 0) + 1; return acc; }, {}) };
}

export function summarize(rows) {
  const ok = rows.filter((r) => r.status === 'ok');
  const by = {};
  for (const r of ok) (by[r.ticker] ??= []).push(r);
  return {
    overall: metrics(ok),
    per_ticker: Object.fromEntries(Object.entries(by).map(([t, rs]) => [t, metrics(rs)])),
    skipped_null_baseline: rows.length - ok.length,
  };
}

/** Coverage for each k on a grid; picks the k whose coverage is closest to `target` inside [lo, hi] (ties -> smaller k). */
export function calibrateK(inputs, { from, to, model, grid = null, target = 0.68, lo = 0.60, hi = 0.76 }) {
  const ks = grid ?? Array.from({ length: 31 }, (_, i) => Number((0.5 + i * 0.05).toFixed(2)));
  const table = ks.map((k) => ({ k, coverage: summarize(walkForward(inputs, { from, to, model, k })).overall.coverage }));
  const inBand = table.filter((r) => r.coverage !== null && r.coverage >= lo && r.coverage <= hi);
  const pick = (inBand.length ? inBand : table).reduce((best, r) => (best === null || Math.abs(r.coverage - target) < Math.abs(best.coverage - target) - 1e-12 ? r : best), null);
  return { table: table.map((r) => ({ k: r.k, coverage: r.coverage === null ? null : Number(fx(r.coverage, 4)) })), best: pick, band: [lo, hi], target };
}
