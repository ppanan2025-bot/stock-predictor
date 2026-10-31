// Integration (test DB 127.0.0.1:3320): npm run audit invariants (scripts/audit.mjs auditInvariants) detect broken states that
// the triggers cannot prevent (status changes after the fact, edited report files, tampered packs) and stay silent on a clean DB.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { TEST_ENV, TEST_PORT, testDbAvailable, resetTestDb, appQuery } from './helpers/testdb.mjs';
import { insertVerifiedPrice, insertSource, predictionRow, sha } from './helpers/fixtures.mjs';
import { sha256, stableStringify } from '../src/lib/hash.mjs';
import { auditInvariants } from '../scripts/audit.mjs';

const up = await testDbAvailable();
const skip = up ? false : 'test DB not running (npm run db:test:up)';
let ro; let base;
const codes = (r) => r.violations.map((v) => v.code).sort();

before(async () => {
  if (!up) return;
  await resetTestDb();
  ro = mysql.createPool({ host: '127.0.0.1', port: TEST_PORT, user: TEST_ENV.SP_RO_USER, password: TEST_ENV.SP_RO_PASSWORD, database: 'stockdb',
    timezone: 'Z', dateStrings: ['DATE'], connectionLimit: 2 });
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-audit-'));
});
after(async () => { await ro?.end(); if (base) fs.rmSync(base, { recursive: true, force: true }); });

test('audit: clean state -> 0 violations; then each broken state is reported', { skip }, async () => {
  await insertVerifiedPrice(appQuery, { ticker: 'AAPL', month: '2026-08', trade_date: '2026-08-31', close: '230.0000', b: '230.0000' });
  const src = await insertSource(appQuery);
  const news = await appQuery("INSERT INTO news_items (ticker, scope, source_id, title_submitted, status) VALUES ('AAPL', 'company', ?, 'Apple reports record quarter', 'verified')", [src]);
  const pack = { ticker: 'AAPL', as_of_month: '2026-08', target_month: '2026-09', prices: [] };
  const packRes = await appQuery('INSERT INTO research_packs (ticker, as_of_month, target_month, pack_json, pack_sha256) VALUES (?,?,?,?,?)',
    ['AAPL', '2026-08', '2026-09', JSON.stringify(pack), sha256(stableStringify(pack))]);
  const report = '# AAPL report v1\n';
  fs.mkdirSync(path.join(base, '2026-09'), { recursive: true });
  fs.writeFileSync(path.join(base, '2026-09', 'AAPL-prediction.md'), report);
  await appQuery('INSERT INTO predictions SET ?', [predictionRow(packRes.insertId, { report_path: 'reports/2026-09/AAPL-prediction.md', report_sha256: sha(report) })]);

  let r = await auditInvariants(ro, { base });
  assert.deepEqual(r.violations, [], JSON.stringify(r.violations));
  assert.equal(r.counts.month_end_prices, 1);
  assert.ok(r.warnings.some((w) => w.code === 'chart_mismatch'), 'an undrawn draft chart is only a warning');

  // the source is rejected behind the server's back (no cascade) -> verified news on an unverified source
  await appQuery("UPDATE sources SET verification_status = 'rejected' WHERE id = ?", [src]);
  // the report file is edited after save_prediction
  fs.writeFileSync(path.join(base, '2026-09', 'AAPL-prediction.md'), `${report}edited\n`);
  // a pack whose stored sha does not match its JSON
  await appQuery('INSERT INTO research_packs (ticker, as_of_month, target_month, pack_json, pack_sha256) VALUES (?,?,?,?,?)',
    ['AAPL', '2026-08', '2026-09', JSON.stringify(pack), sha('not the pack')]);
  r = await auditInvariants(ro, { base });
  assert.deepEqual(codes(r), ['news_on_unverified_source', 'pack_sha_mismatch', 'report_sha_mismatch']);
  assert.match(r.violations.find((v) => v.code === 'news_on_unverified_source').ref, new RegExp(`news ${news.insertId}`));
});
