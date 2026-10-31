// Test-only seam for hooks that fetch pages (PLAN §10 "Hook tests"): active ONLY when SP_HOOK_TEST=1 is in the real process
// environment AND the configured DB is the throwaway test MySQL (127.0.0.1:3320 with report_host sp-test-db). Anything else
// (including the dev DB on 3310) keeps the hooks live.
import { processEnvOnly, dbConfig, TEST_DB_MARKER, TEST_DB_PORT } from '../lib/env.mjs';

export async function hookTestSeamActive() {
  if (processEnvOnly('SP_HOOK_TEST') !== '1') return false;
  const d = dbConfig();
  if (d.port !== TEST_DB_PORT || !['127.0.0.1', 'localhost'].includes(d.host)) return false;
  const { roPool, closePools } = await import('../lib/db.mjs');
  try { const [[r]] = await roPool().query('SELECT @@report_host AS m'); return r.m === TEST_DB_MARKER; }
  catch { return false; }
  finally { await closePools(); }
}
