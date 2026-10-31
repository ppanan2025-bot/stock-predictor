// mysql2/promise pools: app (stock_app: SELECT, INSERT + column UPDATEs) and ro (stock_ro: SELECT). Opened lazily.
// Ported from RIA src/lib/db.mjs.
import mysql from 'mysql2/promise';
import { dbConfig } from './env.mjs';

let pools = {};

function make(kind) {
  const c = dbConfig();
  const cred = kind === 'app' ? c.app : c.ro;
  return mysql.createPool({
    host: c.host, port: c.port, database: c.database, user: cred.user, password: cred.password,
    timezone: 'Z', dateStrings: ['DATE'], connectionLimit: 4, connectTimeout: 5000, charset: 'utf8mb4',
    supportBigNumbers: true, bigNumberStrings: false, decimalNumbers: false,
  });
}

export function appPool() { return (pools.app ??= make('app')); }
export function roPool() { return (pools.ro ??= make('ro')); }

export async function closePools() {
  const ps = Object.values(pools);
  pools = {};
  await Promise.allSettled(ps.map((p) => p.end()));
}
