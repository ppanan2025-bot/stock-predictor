// Integration-test helpers: the throwaway MySQL on 127.0.0.1:3320 (npm run db:test:up). Tests skip when it is down.
// Ported from RIA test/helpers/testdb.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { TEST_DB_MARKER, TEST_DB_PORT } from '../../src/lib/env.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const parse = (t) => Object.fromEntries(t.split(/\n/).filter((l) => l.trim() && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
// SP_ENV_FILE lets the MCP server child read the test credentials itself (mcpClient never passes *PASSWORD* keys).
export const TEST_ENV = { ...parse(fs.readFileSync(path.join(ROOT, 'test/db/test.env'), 'utf8')), SP_DB_HOST: '127.0.0.1', SP_DB_PORT: String(TEST_DB_PORT),
  SP_ENV_FILE: path.join(ROOT, 'test/db/test.env') };
export const TEST_PORT = TEST_DB_PORT;
const DB = 'stockdb';

const connect = (user, password) => mysql.createConnection({ host: '127.0.0.1', port: TEST_PORT, user, password, database: DB,
  connectTimeout: 1500, timezone: 'Z', dateStrings: ['DATE'] });
export const rootConn = () => connect('root', TEST_ENV.MYSQL_ROOT_PASSWORD);
export const appConn = () => connect(TEST_ENV.SP_APP_USER, TEST_ENV.SP_APP_PASSWORD);
export const roConn = () => connect(TEST_ENV.SP_RO_USER, TEST_ENV.SP_RO_PASSWORD);

export async function testDbAvailable() {
  try {
    const c = await roConn();
    await c.query('SELECT 1 FROM companies LIMIT 1');
    await c.end();
    return true;
  } catch { return false; }
}

/**
 * Throws unless `conn` is the throwaway test MySQL: the connection's own config must point at 127.0.0.1:3320 and the server
 * must carry the report_host marker that only test/db/docker-compose.test.yml sets (@@port is 3306 in every container).
 */
export async function assertTestDb(conn) {
  const { host, port } = conn.config;
  const [[{ m }]] = await conn.query('SELECT @@report_host AS m');
  if (host !== '127.0.0.1' || Number(port) !== TEST_PORT || m !== TEST_DB_MARKER)
    throw new Error(`refusing to reset a non-test database (${host}:${port}, report_host=${m})`);
}

/** Data tables in child-first order (the seed `companies` table is kept). */
export const DATA_TABLES = ['analyses', 'agent_tasks', 'runs', 'prediction_outcomes', 'reviews', 'prediction_citations', 'predictions',
  'research_packs', 'quant_features', 'research_notes', 'news_references', 'news_items', 'sources', 'month_end_prices',
  'price_submissions', 'backtest_results', 'audit_log'];

/** Empties the data tables of the TEST database only (root on port 3320). */
export async function resetTestDb() {
  const c = await rootConn();
  try {
    await assertTestDb(c);
    for (const t of DATA_TABLES) await c.query(`DELETE FROM ${t}`);
  } finally { await c.end(); }
}

async function run(mk, sql, args) { const c = await mk(); try { return (await c.query(sql, args))[0]; } finally { await c.end(); } }
export const rootQuery = (sql, args = []) => run(rootConn, sql, args);
export const appQuery = (sql, args = []) => run(appConn, sql, args);
export const roQuery = (sql, args = []) => run(roConn, sql, args);
