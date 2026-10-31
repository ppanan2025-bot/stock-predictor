import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertReadOnlySql, SqlGuardError } from '../src/lib/sqlGuard.mjs';

test('BUG-007: backtick-quoted forbidden functions are rejected', () => {
  for (const sql of ['SELECT `SLEEP`(2)', "SELECT `GET_LOCK`('ria', 1)", 'SELECT `BENCHMARK`(1000000, MD5(1))', 'SELECT `sleep` (1)',
    'SELECT ` SLEEP `(1)', 'SELECT `Release_Lock`(\'ria\')', 'SELECT `SLEEP`/* c */(1)', 'SELECT `LOAD_FILE`(\'/etc/passwd\')'])
    assert.throws(() => assertReadOnlySql(sql), SqlGuardError, sql);
});

test('quoted ordinary identifiers are still allowed', () => {
  for (const sql of ['SELECT `ticker`, `close` FROM `month_end_prices` WHERE `month` = \'2026-09\'', 'SELECT `sleepy` FROM tickers',
    "SELECT 'SLEEP(1)' AS s", 'SHOW TABLES'])
    assert.equal(assertReadOnlySql(sql), true, sql);
});

test('writes, DDL, multi-statements and locking reads are rejected', () => {
  for (const sql of ['INSERT INTO companies (ticker) VALUES (\'X\')', 'UPDATE predictions SET status=\'final\'', 'DELETE FROM sources',
    'DROP TABLE runs', 'SELECT 1; DELETE FROM sources', 'SELECT * FROM sources FOR UPDATE', 'SELECT * INTO OUTFILE \'/tmp/x\' FROM sources',
    'SELECT SLEEP(5)', 'SELECT /*! 1 */', 'SET @a = 1', 'CALL p()', 'EXPLAIN DELETE FROM sources', 'WITH x AS (SELECT 1) DELETE FROM sources',
    'REPLACE INTO quant_features VALUES (1)', 'TRUNCATE audit_log', 'GRANT ALL ON *.* TO x', '', '   ', 'SELECT \'unterminated'])
    assert.throws(() => assertReadOnlySql(sql), SqlGuardError, sql);
});

test('ordinary reads are allowed', () => {
  for (const sql of ['SELECT ticker, name FROM companies', 'SELECT * FROM runs ORDER BY id DESC LIMIT 5;',
    'WITH t AS (SELECT * FROM agent_tasks) SELECT status, COUNT(*) FROM t GROUP BY status', 'DESCRIBE news_items', 'EXPLAIN SELECT 1',
    "SELECT 'DELETE FROM x' AS s", 'SELECT 1 -- DELETE', 'SELECT 1 --1'])
    assert.equal(assertReadOnlySql(sql), true, sql);
});

test('Validator P1 #3: DESC/DESCRIBE/EXPLAIN ANALYZE or FORMAT= cannot bypass the EXPLAIN rule', () => {
  for (const sql of ['DESC ANALYZE SELECT 1', 'DESCRIBE ANALYZE SELECT * FROM sources', 'DESC FORMAT=JSON DELETE FROM sources',
    'DESCRIBE FORMAT=TREE SELECT 1', 'EXPLAIN ANALYZE SELECT 1', 'EXPLAIN FORMAT=JSON SELECT 1', 'DESC FOR CONNECTION 5',
    'DESCRIBE UPDATE sources SET tier = 1', 'DESC TABLE sources', 'EXPLAIN sources'])
    assert.throws(() => assertReadOnlySql(sql), SqlGuardError, sql);
  for (const sql of ['DESC sources', 'DESCRIBE news_items', 'DESC `month_end_prices`', 'DESC sources url_canonical', 'DESCRIBE SELECT 1',
    'DESC WITH t AS (SELECT 1) SELECT * FROM t', 'EXPLAIN SELECT * FROM sources'])
    assert.equal(assertReadOnlySql(sql), true, sql);
});
