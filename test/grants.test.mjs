// Integration (test DB 127.0.0.1:3320): user grants. stock_ro is SELECT-only; stock_app is append-only with column UPDATEs.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { testDbAvailable, resetTestDb, appQuery, roQuery, rootQuery } from './helpers/testdb.mjs';
import { insertSource } from './helpers/fixtures.mjs';

const up = await testDbAvailable();
const skip = up ? false : 'test DB not running (npm run db:test:up)';
const denied = (p, re = /command denied|access denied/i) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });

before(async () => { if (up) await resetTestDb(); });

test('stock_ro can SELECT but cannot INSERT, UPDATE or DELETE', { skip }, async () => {
  const rows = await roQuery('SELECT ticker FROM companies ORDER BY ticker');
  assert.deepEqual(rows.map((r) => r.ticker), ['AAPL', 'AMZN', 'GOOGL', 'SPCX']);
  await denied(roQuery("INSERT INTO runs (target_month, tickers) VALUES ('2026-11', JSON_ARRAY('AAPL'))"));
  await denied(roQuery("INSERT INTO companies (ticker, name, ir_domains, peers, listed_on) VALUES ('TSLA','Tesla',JSON_ARRAY(),JSON_ARRAY(),'2010-06-29')"));
  await denied(roQuery("UPDATE companies SET name = 'x' WHERE ticker = 'AAPL'"));
  await denied(roQuery("DELETE FROM companies WHERE ticker = 'AAPL'"));
});

test('stock_app can INSERT but cannot DELETE (except quant_features) or DROP', { skip }, async () => {
  const id = await insertSource(appQuery, { status: 'pending' });
  await denied(appQuery('DELETE FROM sources WHERE id = ?', [id]));
  await denied(appQuery("DELETE FROM companies WHERE ticker = 'SPCX'"));
  await denied(appQuery('TRUNCATE TABLE audit_log'));
  await denied(appQuery('DROP TABLE runs'));
  await denied(appQuery('CREATE TABLE x (id INT)'));
  assert.equal((await rootQuery('SELECT COUNT(*) AS n FROM sources WHERE id = ?', [id]))[0].n, 1);
});

test('stock_app UPDATE is limited to the granted columns', { skip }, async () => {
  const id = await insertSource(appQuery, { status: 'pending' });
  await appQuery("UPDATE sources SET verification_status = 'unreachable', verification_reason = 'http_404' WHERE id = ?", [id]);
  await denied(appQuery("UPDATE sources SET url_canonical = 'https://evil.example/' WHERE id = ?", [id]));
  await denied(appQuery("UPDATE sources SET tier = 'primary' WHERE id = ?", [id]));
  await denied(appQuery("UPDATE companies SET listed_on = '2020-01-01' WHERE ticker = 'SPCX'"));
  await denied(appQuery("UPDATE month_end_prices SET close = 1 WHERE id = 1"));
  const run = await appQuery("INSERT INTO runs (target_month, tickers) VALUES ('2026-11', JSON_ARRAY('AAPL'))");
  await appQuery("UPDATE runs SET status = 'running', started_at = UTC_TIMESTAMP(3) WHERE id = ?", [run.insertId]);
  await denied(appQuery("UPDATE runs SET target_month = '2026-12' WHERE id = ?", [run.insertId]));
  const t = await appQuery("INSERT INTO agent_tasks (run_id, agent, ticker) VALUES (?, 'technical', 'AAPL')", [run.insertId]);
  await appQuery("UPDATE agent_tasks SET status = 'done', output_ref = 'analyses:1' WHERE id = ?", [t.insertId]);
  await denied(appQuery("UPDATE agent_tasks SET agent = 'validator' WHERE id = ?", [t.insertId]));
  await denied(appQuery('DELETE FROM agent_tasks WHERE id = ?', [t.insertId]));
});

test('stock_app may REPLACE quant_features (DELETE granted on that table only)', { skip }, async () => {
  const row = ['AAPL', '2026-09', '254.6300', 12, 'a'.repeat(64), 'v1'];
  await appQuery('REPLACE INTO quant_features (ticker, month, close, n_months, features_sha256, code_version) VALUES (?,?,?,?,?,?)', row);
  await appQuery('REPLACE INTO quant_features (ticker, month, close, n_months, features_sha256, code_version) VALUES (?,?,?,?,?,?)', row);
  assert.equal((await roQuery("SELECT COUNT(*) AS n FROM quant_features WHERE ticker = 'AAPL'"))[0].n, 1);
});
