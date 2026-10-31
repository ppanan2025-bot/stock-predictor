#!/usr/bin/env node
// Idempotent schema migration for an EXISTING stockdb (db/init/* only runs on a fresh volume):
//   npm run db:migrate              tables (CREATE IF NOT EXISTS), triggers, views, grants, NYSE closures (INSERT IGNORE)
//   npm run db:migrate -- --seed    also upserts the seed companies (db/init/04-seed.sql)
//   npm run db:migrate -- --columns-only   only adds missing nullable columns (ADDED_COLUMNS); never re-creates triggers, so it
//                                   is safe while a backfill writes to month_end_prices
// Never deletes or updates data rows: it counts every table before and after and exits 1 if any count changed (only
// `companies` may grow, and only with --seed; `nyse_closures` may grow). Connects as root with MYSQL_ROOT_PASSWORD (process env, else read from
// .env by this script; the value is never printed).
import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { root, readDotEnv, dbConfig } from '../src/lib/env.mjs';
import { parseArgs } from '../src/lib/cli.mjs';

const initFile = (f) => fs.readFileSync(path.join(root, 'db/init', f), 'utf8');

/** Splits a DELIMITER $$ trigger file into statements. */
export function splitTriggerSql(text) {
  return text.split(/\r?\n/).filter((l) => !/^\s*(DELIMITER\b|--)/i.test(l)).join('\n')
    .split('$$').map((s) => s.trim()).filter(Boolean);
}

/** Splits a plain SQL file on statement-ending semicolons after removing `-- ` comments (no strings contain them). */
export function splitPlainSql(text) {
  return text.split(/\r?\n/).map((l) => l.replace(/(^|\s)--(\s.*)?$/, '')).join('\n')
    .split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
}

/** The GRANT statements of 02-users.sh with its shell variables substituted. */
export function grantStatements(shellText, { db, app, ro }) {
  return shellText.split(/\r?\n/).filter((l) => /^GRANT\b/.test(l.trim()))
    .map((l) => l.trim().replace(/;$/, '').replaceAll('\\`', '`')
      .replaceAll('${DB}', db).replaceAll('${APP}', app).replaceAll('${RO}', ro));
}

/** Nullable columns added after the first schema (CREATE TABLE IF NOT EXISTS never alters an existing table). */
export const ADDED_COLUMNS = [
  { table: 'sources', column: 'wire_agency', ddl: 'VARCHAR(16) NULL AFTER text_len' },
  { table: 'quant_features', column: 'features_json', ddl: 'JSON NULL AFTER n_months' },
  { table: 'research_notes', column: 'page_sha256', ddl: 'CHAR(64) NULL AFTER created_by' },
  { table: 'research_notes', column: 'fetched_at', ddl: 'DATETIME(3) NULL AFTER page_sha256' },
  // Phase 4 (runtime agents)
  { table: 'predictions', column: 'run_id', ddl: 'BIGINT UNSIGNED NULL AFTER finalized_at' },
  { table: 'analyses', column: 'pack_id', ddl: 'BIGINT UNSIGNED NULL AFTER created_at' },
  { table: 'analyses', column: 'evidence_pack_fields', ddl: 'JSON NULL AFTER pack_id' },
  { table: 'analyses', column: 'status', ddl: "ENUM('submitted','accepted','rejected') NOT NULL DEFAULT 'submitted' AFTER pack_id" },
  { table: 'analyses', column: 'attempt', ddl: 'INT UNSIGNED NOT NULL DEFAULT 1 AFTER status' },
  { table: 'analyses', column: 'review_issues', ddl: 'JSON NULL AFTER attempt' },
  { table: 'analyses', column: 'review_summary', ddl: 'TEXT NULL AFTER review_issues' },
  { table: 'analyses', column: 'reviewed_at', ddl: 'DATETIME(3) NULL AFTER review_summary' },
  { table: 'analyses', column: 'active_slot', ddl: "TINYINT AS (IF(status = 'rejected', NULL, 1)) STORED AFTER reviewed_at" },
  { table: 'predictions', column: 'consensus_json', ddl: 'JSON NULL AFTER run_id' },
  { table: 'reviews', column: 'agent_task_id', ddl: 'BIGINT UNSIGNED NULL AFTER created_at' },
  { table: 'agent_tasks', column: 'token_sha256', ddl: 'CHAR(64) NULL AFTER created_at' },
  { table: 'agent_tasks', column: 'ticker_key', ddl: "VARCHAR(10) AS (IFNULL(ticker, '')) STORED AFTER token_sha256" },
];

/** Index changes after the first schema: [{table, name, drop?: true} | {table, name, ddl}] (idempotent). */
export const INDEX_CHANGES = [
  { table: 'reviews', name: 'uq_review', drop: true },                       // a validator may supersede its verdict on the same sha
  { table: 'reviews', name: 'ix_rev_pred', ddl: 'KEY ix_rev_pred (prediction_id, report_sha256, perspective, id)' },
  { table: 'analyses', name: 'uq_an_active', ddl: 'UNIQUE KEY uq_an_active (run_id, ticker, agent, active_slot)' },
  { table: 'agent_tasks', name: 'uq_task', ddl: 'UNIQUE KEY uq_task (run_id, agent, ticker_key)' },
];

export async function ensureIndexes(c, db) {
  const changed = [];
  for (const ix of INDEX_CHANGES) {
    const [have] = await c.query('SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1', [db, ix.table, ix.name]);
    if (ix.drop && have.length) {
      // the FK on prediction_id needs some index starting with it: create the replacement first
      await c.query(`ALTER TABLE \`${ix.table}\` DROP INDEX \`${ix.name}\``).catch(async (e) => {
        if (e.code !== 'ER_DROP_INDEX_FK') throw e;
        await c.query('ALTER TABLE `reviews` ADD KEY ix_rev_pred (prediction_id, report_sha256, perspective, id)');
        await c.query(`ALTER TABLE \`${ix.table}\` DROP INDEX \`${ix.name}\``);
      });
      changed.push(`-${ix.table}.${ix.name}`);
    } else if (!ix.drop && !have.length) {
      await c.query(`ALTER TABLE \`${ix.table}\` ADD ${ix.ddl}`);
      changed.push(`+${ix.table}.${ix.name}`);
    }
  }
  return changed;
}

/** ENUM columns widened after the first schema (values are only ever ADDED, so existing rows stay valid). */
export const WIDENED_ENUMS = [
  { table: 'reviews', column: 'perspective', value: 'validator',
    ddl: "ENUM('fundamental','quant','news_sentiment','macro_sector','risk','source_audit','validator') NOT NULL" },
];

/** Applies WIDENED_ENUMS where the value is missing (idempotent). Returns the changed column names. */
export async function ensureEnums(c, db) {
  const changed = [];
  for (const { table, column, value, ddl } of WIDENED_ENUMS) {
    const [[r]] = await c.query('SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?', [db, table, column]);
    if (!r || String(r.t).includes(`'${value}'`)) continue;
    await c.query(`ALTER TABLE \`${table}\` MODIFY COLUMN \`${column}\` ${ddl}`);
    changed.push(`${table}.${column}`);
  }
  return changed;
}

/** Adds every missing ADDED_COLUMNS column (idempotent; MySQL 8.4 has no ADD COLUMN IF NOT EXISTS). Returns the added names. */
export async function ensureColumns(c, db) {
  const added = [];
  for (const { table, column, ddl } of ADDED_COLUMNS) {
    const [have] = await c.query('SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?', [db, table, column]);
    if (have.length) continue;
    await c.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${ddl}`);
    added.push(`${table}.${column}`);
  }
  return added;
}

async function counts(c, db) {
  const [tables] = await c.query("SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY 1", [db]);
  const out = {};
  for (const { t } of tables) out[t] = Number((await c.query(`SELECT COUNT(*) AS n FROM \`${t}\``))[0][0].n);
  return out;
}

async function main() {
  const args = parseArgs();
  const d = dbConfig();
  const password = process.env.MYSQL_ROOT_PASSWORD ?? readDotEnv(path.join(root, '.env')).MYSQL_ROOT_PASSWORD;
  if (!password) throw new Error('MYSQL_ROOT_PASSWORD not found (run npm run setup)');
  const c = await mysql.createConnection({ host: d.host, port: d.port, user: 'root', password, database: d.database });
  try {
    if (args.columnsOnly) { // ALTER only adds nullable columns + re-applies the column grants; no rows are touched (row counts are not compared: a backfill may be running)
      const added = await ensureColumns(c, d.database);
      const grants = grantStatements(initFile('02-users.sh'), { db: d.database, app: d.app.user, ro: d.ro.user });
      const [users] = await c.query('SELECT User AS u FROM mysql.user WHERE User IN (?, ?)', [d.app.user, d.ro.user]);
      if (users.length === 2) for (const g of grants) await c.query(g);
      console.log(`[migrate] ${d.host}:${d.port}/${d.database} columns added: ${added.join(', ') || 'none'}; grants re-applied: ${users.length === 2}`);
      return;
    }
    const before = await counts(c, d.database);
    for (const s of splitPlainSql(initFile('01-schema.sql'))) await c.query(s);
    const added = await ensureColumns(c, d.database);
    if (added.length) console.log(`[migrate] columns added: ${added.join(', ')}`);
    const widened = await ensureEnums(c, d.database);
    if (widened.length) console.log(`[migrate] enums widened: ${widened.join(', ')}`);
    const idx = await ensureIndexes(c, d.database);
    if (idx.length) console.log(`[migrate] indexes: ${idx.join(', ')}`);
    for (const s of splitTriggerSql(initFile('03-triggers.sql'))) await c.query(s);
    if (args.seed) for (const s of splitPlainSql(initFile('04-seed.sql'))) await c.query(s);
    for (const s of splitPlainSql(initFile('05-views.sql'))) await c.query(s);
    for (const s of splitPlainSql(initFile('06-closures.sql'))) await c.query(s);
    const grants = grantStatements(initFile('02-users.sh'), { db: d.database, app: d.app.user, ro: d.ro.user });
    const [users] = await c.query('SELECT User AS u FROM mysql.user WHERE User IN (?, ?)', [d.app.user, d.ro.user]);
    if (users.length === 2) for (const g of grants) await c.query(g);
    else console.error(`[migrate] users ${d.app.user}/${d.ro.user} missing; grants skipped (fresh volume runs 02-users.sh)`);
    const after = await counts(c, d.database);
    const [trg] = await c.query('SELECT TRIGGER_NAME AS t FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY 1', [d.database]);
    console.log(`[migrate] ${d.host}:${d.port}/${d.database} tables=${Object.keys(after).length} triggers: ${trg.map((r) => r.t).join(', ')}`);
    const changed = Object.keys({ ...before, ...after }).filter((t) => before[t] !== undefined && before[t] !== after[t]
      && !(args.seed && t === 'companies' && after[t] >= before[t]) && !(t === 'nyse_closures' && after[t] >= before[t]));
    if (changed.length) { console.error(`[migrate] row counts changed: ${changed.join(', ')}`); process.exitCode = 1; }
    else console.log(`[migrate] row counts unchanged${args.seed ? ' (companies upserted)' : ''}`);
  } finally { await c.end(); }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(`[migrate] ${e.message}`); process.exit(1); });
