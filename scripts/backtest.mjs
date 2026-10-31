#!/usr/bin/env node
// npm run backtest -- [--from 2024-01] [--to 2026-09] [--calibrate] [--json]
// Walk-forward, baseline-only backtest over VERIFIED month-end closes (read-only, stock_ro). Prints direction hit rate, sign hit
// rate, lo-hi coverage and Brier with the FROZEN k from config/model.json. --calibrate also prints coverage for a k grid and the k
// whose coverage is closest to 68% inside 60-76% (the value to freeze in config/model.json baseline.range_k; never auto-written).
import { parseArgs } from '../src/lib/cli.mjs';
import { roPool, closePools } from '../src/lib/db.mjs';
import { loadFeatureInputs } from '../src/quant/featureStore.mjs';
import { walkForward, summarize, calibrateK } from '../src/quant/backtest.mjs';
import { loadModel } from '../src/quant/model.mjs';

const args = parseArgs();
const from = typeof args.from === 'string' ? args.from : '2024-01';
const to = typeof args.to === 'string' ? args.to : '2026-09';
const model = loadModel();
const p = (x) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`);
try {
  const inputs = await loadFeatureInputs(roPool());
  const rows = walkForward(inputs, { from, to, model });
  const s = summarize(rows);
  const cal = args.calibrate ? calibrateK(inputs, { from, to, model }) : null;
  if (args.json) console.log(JSON.stringify({ from, to, k: model.baseline.range_k, summary: s, calibration: cal, rows }, null, 2));
  else {
    const o = s.overall;
    console.log(`[backtest] baseline ${model.baseline.code_version}, target months ${from}..${to}, frozen k=${model.baseline.range_k}`);
    console.log(`overall  n=${o.n}  direction_hit=${p(o.direction_hit_rate)}  sign_hit=${p(o.sign_hit_rate)}  coverage(lo..hi)=${p(o.coverage)}  brier=${o.brier?.toFixed(4)}  base_rate_up=${p(o.base_rate_up)}  calls=${JSON.stringify(o.calls)}`);
    for (const [t, v] of Object.entries(s.per_ticker))
      console.log(`${t.padEnd(7)}  n=${v.n}  direction_hit=${p(v.direction_hit_rate)}  sign_hit=${p(v.sign_hit_rate)}  coverage=${p(v.coverage)}  brier=${v.brier?.toFixed(4)}`);
    if (s.skipped_null_baseline) console.log(`skipped (baseline null, short history): ${s.skipped_null_baseline}`);
    const inBand = o.coverage !== null && o.coverage >= 0.60 && o.coverage <= 0.76;
    console.log(`coverage target 60-76%: ${inBand ? 'OK' : 'OUT OF BAND (re-calibrate k)'}`);
    if (cal) {
      console.log('k grid: ' + cal.table.map((r) => `${r.k.toFixed(2)}:${p(r.coverage)}`).join('  '));
      console.log(`best k (closest to 68% inside 60-76%): ${cal.best.k} -> coverage ${p(cal.best.coverage)}`);
    }
    if (!inBand) process.exitCode = 1;
  }
} finally { await closePools(); }
