// Runs write tools for scripts (ingest, backfill). Real runs go through the stockdb MCP server (the only write path);
// --dry-run runs the SAME server-side functions in-process inside ONE transaction that is always rolled back, so later items
// see earlier ones exactly as in a real run while nothing persists (auto-increment ids may be consumed). The page cache is not
// written in dry-run. CRAWL_MODE=fixture is only allowed against the marked test DB (same rule as the server).
import { crawlConfig, dbConfig, TEST_DB_MARKER, TEST_DB_PORT } from '../lib/env.mjs';

export async function makeExecutor({ dryRun, name = 'script', timeoutMs = 240000, log = (m) => console.error(`[${name}] ${m}`) }) {
  if (!dryRun) {
    const { createStockdbClient, McpToolError } = await import('../lib/mcpClient.mjs');
    const mcp = createStockdbClient({ name, timeoutMs });
    return {
      mode: 'mcp',
      async run(tool, a) {
        try { return await mcp.call(tool, a); }
        catch (e) {
          if (e instanceof McpToolError) return { status: e.reason === 'invalid_input' ? 'rejected' : 'pending', reason: e.reason === 'invalid_input' ? 'bad_schema' : e.reason, message: e.message };
          throw e;
        }
      },
      close: () => mcp.close(),
    };
  }
  const { appPool, closePools } = await import('../lib/db.mjs');
  const tools = await import('./tools.mjs');
  const conn = await appPool().getConnection();
  if (crawlConfig().mode === 'fixture') {
    const [[r]] = await conn.query('SELECT @@report_host AS m');
    const d = dbConfig();
    if (!(d.port === TEST_DB_PORT && r.m === TEST_DB_MARKER)) { conn.release(); await closePools(); throw new Error('CRAWL_MODE=fixture is only allowed with the test database'); }
  }
  const ctx = tools.createToolContext({ dryRun: true, log });
  const fns = { ingest_price: tools.ingestPrice, add_news_item: tools.addNewsItem, add_source: (db, a, c) => tools.addSource(db, a, c), recheck_sources: tools.recheckSources };
  await conn.beginTransaction();
  let n = 0;
  return {
    mode: 'dry-run',
    async run(tool, a) {
      const sp = `sp${++n}`;
      await conn.query(`SAVEPOINT ${sp}`);
      try { const out = tools.publicResult(await fns[tool](conn, a, ctx)); await conn.query(`RELEASE SAVEPOINT ${sp}`); return out; }
      catch (e) { await conn.query(`ROLLBACK TO SAVEPOINT ${sp}`); return { status: 'pending', reason: String(e?.code ?? '').startsWith('ER_') ? 'db_error' : 'internal', message: e?.message ?? String(e) }; }
    },
    /** End-of-batch state inside the (not yet rolled back) transaction: later items can upgrade earlier ones' corroboration. */
    async snapshot() {
      const [news] = await conn.query("SELECT COALESCE(n.ticker, 'macro') AS t, n.status, n.reason, n.corroboration_count, LEFT(n.title_submitted, 70) AS title FROM news_items n ORDER BY n.id");
      const [prices] = await conn.query('SELECT ticker, COUNT(*) AS n FROM month_end_prices GROUP BY ticker ORDER BY ticker');
      return { news, prices };
    },
    async close() { await conn.rollback().catch(() => {}); conn.release(); await closePools(); },
  };
}
