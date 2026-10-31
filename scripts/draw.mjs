#!/usr/bin/env node
// npm run draw -- --ticker T --target YYYY-MM [--run N]     reports/<target>/<T>-prediction.svg + .json sidecar
// npm run draw -- --all --target YYYY-MM                    reports/<target>/ALL-indexed.svg + .json
// Deterministic: reads ONLY stockdb (stock_ro: verified month_end_prices, the saved prediction + its analyses, or the run's
// server-computed consensus before save_prediction) and writes the chart files; same DB state -> same bytes (sha printed).
import { parseArgs } from '../src/lib/cli.mjs';
import { roPool, closePools } from '../src/lib/db.mjs';
import { drawPrediction, drawAll } from '../src/report/chart.mjs';
import { runConsensus } from '../src/predict/workflow.mjs';
import { loadModel } from '../src/quant/model.mjs';

const args = parseArgs();
const M = /^\d{4}-(0[1-9]|1[0-2])$/;
if (typeof args.target !== 'string' || !M.test(args.target) || (!args.all && typeof args.ticker !== 'string')) {
  console.error('usage: npm run draw -- --ticker T --target YYYY-MM [--run N] | npm run draw -- --all --target YYYY-MM');
  process.exit(2);
}
const model = loadModel();
try {
  if (args.all) {
    const r = await drawAll(roPool(), { target_month: args.target });
    console.log(`[draw] ${r.svg_path} tickers=${r.tickers.join(',')} sha256=${r.svg_sha256}`);
  } else {
    const consensusFor = (db, runId, ticker) => runConsensus(db, runId, ticker, { model }).then((c) => {
      if (!c.consensus) throw new Error(`run ${runId} ${ticker}: ${c.consensus_error.message}`);
      return c;
    });
    const r = await drawPrediction(roPool(), { ticker: args.ticker.toUpperCase(), target_month: args.target, run_id: args.run ? Number(args.run) : null, consensusFor });
    console.log(`[draw] ${r.svg_path} (+ ${r.json_path}) values=${r.values_source} prediction=${r.prediction_id ?? 'none'} sha256=${r.svg_sha256}`);
  }
} catch (e) { console.error(`[draw] ${e.message}`); process.exitCode = 1; }
finally { await closePools(); }
