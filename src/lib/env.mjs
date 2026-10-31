// Loads <root>/.env without overriding variables already in process.env. Never throws when .env is missing.
// Ported from regular-investor-agent (RIA) src/lib/env.mjs; variable prefix SP_.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

export function readDotEnv(file = path.join(root, '.env')) {
  try { return parseEnv(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

/** Keys that came from .env rather than the real process environment. */
export const dotEnvKeys = new Set();

export function loadDotEnv(file = path.join(root, '.env')) {
  if (!fs.existsSync(file)) return false;
  for (const [k, v] of Object.entries(readDotEnv(file))) if (process.env[k] === undefined) { process.env[k] = v; dotEnvKeys.add(k); }
  return true;
}

/** A variable from the real process environment only (ignores values injected by .env), e.g. SP_DEV_MODE for the guards. */
export const processEnvOnly = (k) => (dotEnvKeys.has(k) ? undefined : process.env[k]);

/**
 * The ONLY alternative credentials file: test/db/test.env (throwaway test DB), selected by SP_ENV_FILE in the real process env.
 * It lets tests start the MCP server without putting any *_PASSWORD on its command environment (visible to `ps eww`). Only SP_*
 * keys are taken from it; any other path is refused.
 */
export const TEST_ENV_FILE = path.join(root, 'test', 'db', 'test.env');
if (process.env.SP_ENV_FILE) {
  if (path.resolve(process.env.SP_ENV_FILE) !== TEST_ENV_FILE) throw new Error(`SP_ENV_FILE may only point to ${TEST_ENV_FILE}`);
  for (const [k, v] of Object.entries(readDotEnv(TEST_ENV_FILE))) if (k.startsWith('SP_') && process.env[k] === undefined) { process.env[k] = v; dotEnvKeys.add(k); }
}
loadDotEnv();

/** report_host of the throwaway test MySQL (test/db/docker-compose.test.yml); the dev DB never has it. */
export const TEST_DB_MARKER = 'sp-test-db';
export const TEST_DB_PORT = 3320;
export const DEV_DB_PORT = 3310;

export function dbConfig() {
  const e = process.env;
  return {
    host: e.SP_DB_HOST || '127.0.0.1',
    port: Number(e.SP_DB_PORT || DEV_DB_PORT),
    database: e.SP_DB_DATABASE || 'stockdb',
    app: { user: e.SP_APP_USER || 'stock_app', password: e.SP_APP_PASSWORD || '' },
    ro: { user: e.SP_RO_USER || 'stock_ro', password: e.SP_RO_PASSWORD || '' },
  };
}

export const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

export function crawlConfig() {
  const e = process.env;
  return {
    // Nasdaq/CNBC and news pages need a browser UA. SP_HTTP_UA is reserved for SEC EDGAR (Phase 3, contact UA).
    userAgent: e.SP_BROWSER_UA || BROWSER_UA,
    secUserAgent: e.SP_HTTP_UA || null,
    nasdaqMinIntervalMs: Number(e.NASDAQ_MIN_INTERVAL_MS || 3000),
    mode: e.CRAWL_MODE === 'fixture' ? 'fixture' : 'live',
  };
}
