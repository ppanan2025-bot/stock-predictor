// Integration (test DB): run_readonly_sql never buffers more than max_rows+1 rows (Validator P1 #1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { TEST_ENV, TEST_PORT, testDbAvailable } from './helpers/testdb.mjs';
import { runReadonlySql } from '../src/lib/repo.mjs';
import { assertReadOnlySql } from '../src/lib/sqlGuard.mjs';

const up = await testDbAvailable();
const skip = up ? false : 'test DB not running (npm run db:test:up)';

test('Validator P1 #1: a 400k-row CTE is cut at max_rows+1 without buffering the result', { skip }, async () => {
  const pool = mysql.createPool({ host: '127.0.0.1', port: TEST_PORT, user: TEST_ENV.SP_RO_USER, password: TEST_ENV.SP_RO_PASSWORD, database: 'stockdb', connectionLimit: 1 });
  try {
    const sql = "WITH RECURSIVE a AS (SELECT 1 n UNION ALL SELECT n+1 FROM a WHERE n<1000) SELECT REPEAT('x',2000) s FROM a a1, a a2 LIMIT 400000";
    assertReadOnlySql(sql);
    global.gc?.();
    const m0 = process.memoryUsage().rss;
    const r = await runReadonlySql(pool, sql, 5);
    assert.equal(r.rows.length, 5);
    assert.equal(r.truncated, true);
    assert.equal(r.mode, 'wrapped');
    assert.ok(process.memoryUsage().rss - m0 < 100e6, `rss grew ${Math.round((process.memoryUsage().rss - m0) / 1e6)} MB`);
    // ORDER BY inside the statement is preserved; trailing semicolon accepted
    const o = await runReadonlySql(pool, 'SELECT ticker FROM companies ORDER BY ticker DESC;', 2);
    assert.deepEqual(o.rows.map((x) => x.ticker), ['SPCX', 'GOOGL']);
    assert.equal(o.truncated, true);
    // duplicate column names cannot be wrapped: streamed instead, still capped
    const d = await runReadonlySql(pool, 'SELECT 1 AS a, 2 AS a FROM companies', 3);
    assert.equal(d.mode, 'streamed');
    assert.equal(d.rows.length, 3);
    // SHOW / DESCRIBE are streamed
    const s = await runReadonlySql(pool, 'DESCRIBE companies', 2);
    assert.equal(s.rows.length, 2);
    assert.equal(s.truncated, true);
  } finally { await pool.end(); }
});
