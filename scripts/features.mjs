#!/usr/bin/env node
// npm run features -- [--ticker T[,T2]] [--month YYYY-MM] [--json]
// Calls the stockdb MCP tool compute_features (deterministic, verified closes only; writes quant_features with features_sha256).
// Without --ticker every active target company is computed; without --month each ticker's latest verified month.
import { parseArgs } from '../src/lib/cli.mjs';
import { createStockdbClient } from '../src/lib/mcpClient.mjs';

const args = parseArgs();
const mcp = createStockdbClient({ name: 'features', timeoutMs: 120000 });
const pct = (v) => (v === null || v === undefined ? '   n/a' : `${(Number(v) * 100).toFixed(2)}%`.padStart(8));
try {
  const tickers = args.ticker && args.ticker !== true ? String(args.ticker).toUpperCase().split(',') : [undefined];
  const all = [];
  for (const t of tickers) {
    const r = await mcp.call('compute_features', { ...(t ? { ticker: t } : {}), ...(args.month && args.month !== true ? { month: String(args.month) } : {}) });
    all.push(...r.results);
  }
  if (args.json) console.log(JSON.stringify(all, null, 2));
  else for (const r of all) {
    if (r.status === 'skipped') { console.log(`${r.ticker.padEnd(6)} ${r.month ?? '-'} skipped: ${r.reason}`); continue; }
    const f = r.features;
    console.log(`${r.ticker.padEnd(6)} ${f.month} ${r.status.padEnd(9)} close=${f.close} n=${f.n_months} r1=${pct(f.r1)} r3=${pct(f.r3)} r6=${pct(f.r6)} r12=${pct(f.r12)} `
      + `vol12=${pct(f.vol12)} mdd12=${pct(f.mdd12)} up36=${f.up_rate36 ?? 'n/a'} mom_z=${f.mom_z ?? 'n/a'} rel3=${pct(f.rel_r3_peers)} flags=[${f.flags.join(',')}] sha=${r.features_sha256.slice(0, 12)}`);
  }
} finally { await mcp.close(); }
