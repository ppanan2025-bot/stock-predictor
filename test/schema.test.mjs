// Unit tests (no DB): seed <-> config, ENUMs <-> agent roster, trigger/grant files, migration splitters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { root } from '../src/lib/env.mjs';
import { AGENT_ROLES, ANALYZERS, TASK_STATUSES, RUN_STATUSES } from '../src/lib/agents.mjs';
import { splitTriggerSql, splitPlainSql, grantStatements } from '../scripts/migrate.mjs';
import { READ_TOOLS, TOOL_NAMES } from '../src/verify/schemas.mjs';

const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const schema = read('db/init/01-schema.sql');
const enumOf = (table, col) => {
  const body = schema.slice(schema.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`));
  const m = body.match(new RegExp(`\\n\\s*${col}\\s+ENUM\\(([^)]*)\\)`));
  assert.ok(m, `${table}.${col} enum`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
};

test('companies.json lists GOOGL, AMZN, AAPL and SPCX (listed 2026-06-12) and matches the seed SQL', () => {
  const cfg = JSON.parse(read('config/companies.json'));
  assert.deepEqual(cfg.companies.map((c) => c.ticker), ['GOOGL', 'AMZN', 'AAPL', 'SPCX']);
  const spcx = cfg.companies.find((c) => c.ticker === 'SPCX');
  assert.equal(spcx.name, 'Space Exploration Technologies Corp.');
  assert.equal(spcx.listed_on, '2026-06-12');
  const seed = read('db/init/04-seed.sql');
  for (const c of cfg.companies) {
    const row = seed.match(new RegExp(`\\('${c.ticker}', '([^']+)', '([^']+)', '([^']+)', '([^']+)', (NULL|'\\d{10}'),[\\s\\S]*?'(target|benchmark)', '(\\d{4}-\\d{2}-\\d{2})', ([01])\\)`));
    assert.ok(row, `seed row for ${c.ticker}`);
    assert.equal(row[1], c.name);
    assert.equal(row[2], c.exchange);
    assert.equal(row[5] === 'NULL' ? null : row[5].slice(1, -1), c.cik);
    assert.equal(row[6], c.role);
    assert.equal(row[7], c.listed_on);
    assert.equal(row[8] === '1', c.active);
  }
});

test('agent roster ENUMs match src/lib/agents.mjs', () => {
  assert.deepEqual(enumOf('agent_tasks', 'agent'), AGENT_ROLES);
  assert.deepEqual(enumOf('analyses', 'agent'), ANALYZERS);
  assert.deepEqual(enumOf('agent_tasks', 'status'), TASK_STATUSES);
  assert.deepEqual(enumOf('runs', 'status'), RUN_STATUSES);
  assert.ok(ANALYZERS.length >= 3 && ANALYZERS.length <= 5);
  for (const r of ['planner', 'validator', 'reporter_designer', 'drawer', 'project_manager']) assert.ok(AGENT_ROLES.includes(r), r);
  assert.deepEqual(enumOf('analyses', 'direction'), ['up', 'down', 'flat']);
});

test('news_items allows ticker NULL only with scope macro', () => {
  assert.deepEqual(enumOf('news_items', 'scope'), ['company', 'macro']);
  assert.match(schema, /ticker\s+VARCHAR\(10\)\s+NULL,\s*\n\s*scope/);
  assert.match(schema, /CHECK \(scope = 'macro' OR ticker IS NOT NULL\)/);
});

test('every planned table exists in the schema', () => {
  const tables = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
  for (const t of ['companies', 'price_submissions', 'month_end_prices', 'sources', 'news_items', 'news_references', 'research_notes',
    'quant_features', 'research_packs', 'predictions', 'prediction_citations', 'reviews', 'prediction_outcomes', 'backtest_results',
    'audit_log', 'runs', 'agent_tasks', 'analyses', 'nyse_closures']) assert.ok(tables.includes(t), t);
});

test('trigger file defines every planned trigger and splits cleanly', () => {
  const stmts = splitTriggerSql(read('db/init/03-triggers.sql'));
  const created = stmts.filter((s) => /^CREATE TRIGGER/.test(s)).map((s) => s.match(/^CREATE TRIGGER (\w+)/)[1]);
  assert.deepEqual(created.sort(), ['trg_an_bi', 'trg_an_bu', 'trg_cit_bi', 'trg_closure_bi', 'trg_news_bi', 'trg_news_bu', 'trg_note_bi', 'trg_out_bi', 'trg_pred_bi',
    'trg_pred_bu', 'trg_price_bi', 'trg_rev_bi', 'trg_run_bu', 'trg_sub_bi', 'trg_task_bi']);
  assert.equal(stmts.filter((s) => /^DROP TRIGGER IF EXISTS/.test(s)).length, created.length);
});

test('plain SQL splitter ignores semicolons in comments', () => {
  assert.deepEqual(splitPlainSql('-- a; b\nSELECT 1; -- c; d\nSELECT 2;\n'), ['SELECT 1', 'SELECT 2']);
  assert.equal(splitPlainSql(schema).filter((s) => /^CREATE TABLE/.test(s)).length, 19);
});

test('grant statements: app has no DELETE except quant_features; ro is SELECT only', () => {
  const g = grantStatements(read('db/init/02-users.sh'), { db: 'stockdb', app: 'stock_app', ro: 'stock_ro' });
  const app = g.filter((s) => s.includes("'stock_app'"));
  const ro = g.filter((s) => s.includes("'stock_ro'"));
  assert.deepEqual(ro, ["GRANT SELECT ON `stockdb`.* TO 'stock_ro'@'%'"]);
  assert.ok(app.includes("GRANT SELECT, INSERT ON `stockdb`.* TO 'stock_app'@'%'"));
  assert.deepEqual(app.filter((s) => /DELETE/.test(s)), ["GRANT DELETE ON `stockdb`.quant_features TO 'stock_app'@'%'"]);
  for (const s of app) assert.doesNotMatch(s, /\bALL\b|DROP|ALTER|CREATE|UPDATE ON/);
});

test('MCP tool list: read tools incl. get_consensus/run_status/run_readonly_sql + the Phase 2-4 write tools', () => {
  assert.deepEqual(TOOL_NAMES, [...READ_TOOLS, 'ingest_price', 'add_source', 'add_news_item', 'recheck_sources', 'add_research_note', 'compute_features',
    'start_run', 'update_agent_task', 'save_analysis', 'save_prediction', 'save_review', 'finalize_report', 'withdraw_prediction', 'score_outcomes']);
  assert.ok(READ_TOOLS.includes('get_research_pack') && READ_TOOLS.includes('get_consensus'));
  for (const t of ['stats', 'list_companies', 'run_status', 'run_readonly_sql']) assert.ok(TOOL_NAMES.includes(t), t);
  const mcp = JSON.parse(read('.mcp.json')).mcpServers.stockdb;
  assert.equal(mcp.env.SP_DB_PORT, '3310');
  assert.deepEqual(mcp.args, ['mcp-server/index.mjs']);
});

test('reviews.perspective includes validator; analyses carry status/pack_id; migration widens and adds them', () => {
  assert.ok(enumOf('reviews', 'perspective').includes('validator'));
  assert.deepEqual(enumOf('analyses', 'status'), ['submitted', 'accepted', 'rejected']);
});
