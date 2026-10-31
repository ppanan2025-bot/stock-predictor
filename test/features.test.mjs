// Unit (PLAN §10 "features ... golden fixtures; determinism; sha stability"): src/quant/features.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { computeFeatures, featuresJson, fx, FEATURES_CODE_VERSION } from '../src/quant/features.mjs';

const P = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const G = JSON.parse(fs.readFileSync(path.join(P, 'test/fixtures/features/golden.json'), 'utf8'));
const run = (t, m, series = G.series) => computeFeatures({ ticker: t, month: m, rows: series[t], peers: G.peers[t].map((p) => ({ ticker: p, rows: series[p] })) });

test('golden fixtures: every value equals the independent reference implementation (gen_golden.py)', () => {
  assert.equal(G.cases.length, 6);
  for (const c of G.cases) assert.deepEqual(run(c.ticker, c.month).features, c.expected, `${c.ticker} ${c.month}`);
});

test('determinism: byte-identical JSON and sha256 across runs, input order and separate processes', () => {
  const a = run('AAPL', '2026-09');
  const shuffled = { ...G.series, AAPL: [...G.series.AAPL].reverse(), GOOGL: [...G.series.GOOGL].sort(() => 0.5 - Math.random()) };
  const b = run('AAPL', '2026-09', shuffled);
  assert.equal(featuresJson(a.features), featuresJson(b.features));
  assert.equal(a.features_sha256, b.features_sha256);
  const code = `import { computeFeatures } from './src/quant/features.mjs'; import fs from 'node:fs';
    const G = JSON.parse(fs.readFileSync('test/fixtures/features/golden.json', 'utf8'));
    console.log(G.cases.map((c) => computeFeatures({ ticker: c.ticker, month: c.month, rows: G.series[c.ticker], peers: G.peers[c.ticker].map((p) => ({ ticker: p, rows: G.series[p] })) }).features_sha256).join(','));`;
  const shas = [1, 2].map(() => spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: P, encoding: 'utf8' }).stdout.trim());
  assert.equal(shas[0], shas[1]);
  assert.equal(shas[0], G.cases.map((c) => run(c.ticker, c.month).features_sha256).join(','));
});

test('no look-ahead: closes after the as_of month (own and peers) do not change the features', () => {
  const later = { ...G.series, AAPL: [...G.series.AAPL, { month: '2026-10', close: '1.0000' }], GOOGL: [...G.series.GOOGL, { month: '2026-10', close: '9999.0000' }] };
  assert.equal(run('AAPL', '2026-09', later).features_sha256, run('AAPL', '2026-09').features_sha256);
});

test('short history (SPCX, 4 months): 12m/36m values null + short_history flag, nothing extrapolated', () => {
  const f = run('SPCX', '2026-09').features;
  assert.equal(f.n_months, 4);
  assert.notEqual(f.r1, null);
  assert.notEqual(f.r3, null);
  for (const k of ['r6', 'r12', 'vol12', 'vol36', 'mean36', 'up_rate36', 'mdd12', 'dist_12m_high', 'mom_z', 'mom_z1', 'rel_r1_peers']) assert.equal(f[k], null, k);
  assert.deepEqual(f.flags, ['no_peers', 'partial_36m_window', 'short_history']);
  assert.equal(computeFeatures({ ticker: 'SPCX', month: '2026-05', rows: G.series.SPCX }).error, 'no_verified_close');
});

test('gaps are never interpolated: a missing month nulls the windows that need it and is flagged', () => {
  const f = run('AMZN', '2025-10').features; // 2025-03 missing
  assert.equal(f.vol12, null);
  assert.equal(f.mdd12, null);
  assert.deepEqual(f.gap_months, ['2025-03']);
  assert.ok(f.flags.includes('gaps_in_window'));
  assert.equal(f.code_version, FEATURES_CODE_VERSION);
});

test('fx: fixed decimals, no negative zero, null for non-finite', () => {
  assert.equal(fx(-1e-12), '0.00000000');
  assert.equal(fx(0.123456789), '0.12345679');
  assert.equal(fx(NaN), null);
  assert.equal(fx(null), null);
});
