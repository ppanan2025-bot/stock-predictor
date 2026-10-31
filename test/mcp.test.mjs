// Integration (test DB 127.0.0.1:3320): the stockdb MCP server over stdio.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { TEST_ENV, testDbAvailable, resetTestDb, appQuery, ROOT } from './helpers/testdb.mjs';
import { createStockdbClient, McpToolError } from '../src/lib/mcpClient.mjs';
import { insertVerifiedPrice, insertSource } from './helpers/fixtures.mjs';
import { TOOL_NAMES, READ_TOOLS, IMPLEMENTED_WRITE_TOOLS } from '../src/verify/schemas.mjs';

const up = await testDbAvailable();
const skip = up ? false : 'test DB not running (npm run db:test:up)';
const env = { ...TEST_ENV };
delete env.MYSQL_ROOT_PASSWORD;
let mcp;
const fails = (p, reason) => assert.rejects(p, (e) => { assert.ok(e instanceof McpToolError, String(e)); assert.equal(e.reason, reason, JSON.stringify(e.payload)); return true; });

before(async () => {
  if (!up) return;
  await resetTestDb();
  await insertVerifiedPrice(appQuery, { ticker: 'SPCX', month: '2026-08', trade_date: '2026-08-31', close: '180.0000', b: '180.0000' });
  const src = await insertSource(appQuery);
  await appQuery("INSERT INTO news_items (ticker, scope, source_id, title_submitted, summary_submitted, status) VALUES (NULL, 'macro', ?, 'Fed holds rates steady', 'The Federal Reserve held rates', 'verified')", [src]);
  const run = await appQuery("INSERT INTO runs (target_month, tickers, status) VALUES ('2026-11', JSON_ARRAY('GOOGL','AMZN','AAPL','SPCX'), 'running')");
  for (const [agent, ticker, status] of [['planner', null, 'done'], ['technical', 'SPCX', 'running'], ['fundamental', 'SPCX', 'failed'], ['drawer', null, 'queued']])
    await appQuery('INSERT INTO agent_tasks (run_id, agent, ticker, status, error) VALUES (?,?,?,?,?)', [run.insertId, agent, ticker, status, status === 'failed' ? 'no filings yet' : null]);
  mcp = createStockdbClient({ projectDir: ROOT, env, name: 'mcp-test' });
});
after(async () => { await mcp?.close(); });

test('registers exactly the read tools (readOnlyHint) and the Phase 2+3 write tools (not read-only)', { skip }, async () => {
  const tools = (await mcp.listTools()).tools;
  assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort());
  for (const t of tools) assert.equal(t.annotations?.readOnlyHint, READ_TOOLS.includes(t.name), t.name);
  assert.deepEqual(tools.filter((t) => !t.annotations?.readOnlyHint).map((t) => t.name).sort(), [...IMPLEMENTED_WRITE_TOOLS].sort());
});

test('stats: coverage for all four tickers, SPCX from its listing month', { skip }, async () => {
  const s = await mcp.call('stats');
  assert.deepEqual(s.coverage.map((c) => c.ticker), ['GOOGL', 'AMZN', 'AAPL', 'SPCX']);
  const spcx = s.coverage.find((c) => c.ticker === 'SPCX');
  assert.equal(spcx.from, '2026-06');
  assert.equal(spcx.verified_months, 1);
  assert.equal(spcx.latest_verified, '2026-08');
  assert.equal(s.news_by_scope.macro, 1);
  assert.equal(s.runs_by_status.running, 1);
});

test('list_companies and price_history (gaps are null, never interpolated)', { skip }, async () => {
  const { companies } = await mcp.call('list_companies');
  assert.equal(companies.find((c) => c.ticker === 'SPCX').listed_on, '2026-06-12');
  const h = await mcp.call('price_history', { ticker: 'SPCX', from: '2026-05', to: '2026-09' });
  assert.deepEqual(h.series.map((x) => x.close), [null, null, null, '180.0000', null]);
  assert.equal(h.series[0].gap, 'pre_listing');
  assert.equal(h.series[1].gap, 'missing');
  await fails(mcp.call('price_history', { ticker: 'TSLA' }), 'not_found');
  await fails(mcp.call('price_history', { ticker: 'aapl' }), 'invalid_input');
});

test('run_status summarises runs and agent_tasks', { skip }, async () => {
  const r = await mcp.call('run_status', {});
  assert.equal(r.total_runs, 1);
  assert.equal(r.running_runs, 1);
  const run = r.runs[0];
  assert.equal(run.task_count, 4);
  assert.deepEqual(run.tasks_by_status, { done: 1, running: 1, failed: 1, queued: 1 });
  assert.equal(run.tasks_by_agent.planner.done, 1);
  assert.equal(run.failed_tasks[0].error, 'no filings yet');
  const one = await mcp.call('run_status', { run_id: run.run.id });
  assert.equal(one.runs[0].tasks.length, 4);
  await fails(mcp.call('run_status', { run_id: 999999 }), 'not_found');
});

test('search_resources includes macro news for a ticker; get_source labels untrusted content', { skip }, async () => {
  const r = await mcp.call('search_resources', { ticker: 'AAPL' });
  assert.equal(r.news.length, 1);
  assert.equal(r.news[0].scope, 'macro');
  assert.equal(r.news[0].ticker, null);
  const ft = await mcp.call('search_resources', { query: 'Federal Reserve' });
  assert.equal(ft.news.length, 1);
  const s = await mcp.call('get_source', { source_id: r.news[0].source_id });
  assert.equal(s.news.length, 1);
  await fails(mcp.call('get_source', { source_id: 999999 }), 'not_found');
});

test('run_readonly_sql: reads work, writes are rejected by the guard', { skip }, async () => {
  const r = await mcp.call('run_readonly_sql', { sql: 'SELECT ticker FROM companies ORDER BY ticker' });
  assert.deepEqual(r.rows.map((x) => x.ticker), ['AAPL', 'AMZN', 'GOOGL', 'SPCX']);
  await fails(mcp.call('run_readonly_sql', { sql: 'DELETE FROM companies' }), 'sql_rejected');
  await fails(mcp.call('run_readonly_sql', { sql: 'SELECT 1; DROP TABLE runs' }), 'sql_rejected');
  await fails(mcp.call('run_readonly_sql', { sql: 'SELECT 1', max_rows: 501 }), 'invalid_input');
});

test('predictions/features read tools answer on empty data', { skip }, async () => {
  assert.deepEqual((await mcp.call('list_predictions', {})).predictions, []);
  assert.equal((await mcp.call('get_features', { ticker: 'AAPL', month: '2026-09' })).found, false);
  await fails(mcp.call('get_prediction', { prediction_id: 1 }), 'not_found');
});

test('server refuses CRAWL_MODE=fixture unless connected to the marked test DB', { skip }, () => {
  const run = (extra) => spawnSync(process.execPath, [path.join(ROOT, 'mcp-server/index.mjs')], { input: '', encoding: 'utf8', timeout: 20000,
    env: { PATH: process.env.PATH, ...env, ...extra } });
  const bad = run({ CRAWL_MODE: 'fixture', SP_DB_PORT: '3310' });
  assert.equal(bad.status, 1, bad.stderr);
  assert.match(bad.stderr, /refusing to start/);
  const good = run({ CRAWL_MODE: 'fixture' });
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stderr, /ready/);
});
