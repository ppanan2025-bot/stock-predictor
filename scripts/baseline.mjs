#!/usr/bin/env node
// npm run baseline -- --target YYYY-MM [--as-of YYYY-MM] [--ticker T[,T2]] [--json]
// Read-only (stock_ro): the deterministic baseline for the target month from verified closes <= the as-of month (default: target-1;
// --as-of must be exactly target-1). Nothing is written; get_research_pack stores the same baseline inside the pack snapshot.
import { parseArgs } from '../src/lib/cli.mjs';
import { roPool, closePools } from '../src/lib/db.mjs';
import { loadFeatureInputs, featuresFor } from '../src/quant/featureStore.mjs';
import { computeBaseline } from '../src/quant/baseline.mjs';
import { loadModel } from '../src/quant/model.mjs';
import { prevMonth } from '../src/market/calendar.mjs';
import { pct } from '../src/quant/consensus.mjs';

const args = parseArgs();
const M = /^\d{4}-(0[1-9]|1[0-2])$/;
if (typeof args.target !== 'string' || !M.test(args.target)) { console.error('usage: npm run baseline -- --target YYYY-MM [--as-of YYYY-MM] [--ticker T]'); process.exit(2); }
const asOf = typeof args.asOf === 'string' ? args.asOf : prevMonth(args.target);
if (asOf !== prevMonth(args.target)) { console.error(`--as-of must be the month before --target (${prevMonth(args.target)})`); process.exit(2); }
const model = loadModel();
try {
  const inputs = await loadFeatureInputs(roPool());
  const tickers = typeof args.ticker === 'string' ? args.ticker.toUpperCase().split(',')
    : inputs.companies.filter((c) => c.active && c.role === 'target').map((c) => c.ticker);
  const order = ['GOOGL', 'AMZN', 'AAPL', 'SPCX'];
  tickers.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99) || a.localeCompare(b));
  const out = [];
  for (const t of tickers) {
    const f = featuresFor(inputs, t, asOf);
    const b = f.error ? computeBaseline({ error: f.error, ticker: t, month: asOf }, model) : computeBaseline({ ...f.features, features_sha256: f.features_sha256 }, model);
    out.push({ ticker: t, as_of_month: asOf, target_month: args.target, close: f.features?.close ?? null, baseline: b });
  }
  if (args.json) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`[baseline] ${model.baseline.code_version} k=${model.baseline.range_k} target=${args.target} as_of=${asOf} (verified closes <= ${asOf} only)`);
    for (const r of out) {
      const b = r.baseline;
      if (b.status !== 'ok') { console.log(`${r.ticker.padEnd(6)} close=${r.close ?? 'n/a'}  baseline=null (${b.reason}${b.missing_inputs ? `: ${b.missing_inputs.join(',')}` : ''})`); continue; }
      const c = Number(r.close);
      console.log(`${r.ticker.padEnd(6)} close=${r.close}  dir=${b.direction.padEnd(4)} p_up=${b.p_up}  mid=${pct(b.mid, 2)} [${pct(b.low, 2)} .. ${pct(b.high, 2)}]`
        + `  price mid=${(c * (1 + Number(b.mid))).toFixed(2)} [${(c * (1 + Number(b.low))).toFixed(2)} .. ${(c * (1 + Number(b.high))).toFixed(2)}]`
        + `  sigma=${b.sigma} conf=${b.confidence}  sha=${b.baseline_sha256.slice(0, 12)}`);
    }
  }
} finally { await closePools(); }
