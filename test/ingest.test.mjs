// Integration (test DB 127.0.0.1:3320, CRAWL_MODE=fixture): Phase 2 acceptance (PLAN §11).
//  - the MCP write tools ingest_price / add_news_item / add_source re-verify everything server-side;
//  - recheck_sources cascades; npm run ingest (dry-run and real) on a fixture inbox.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { TEST_ENV, testDbAvailable, resetTestDb, roQuery, appConn, ROOT } from './helpers/testdb.mjs';
import { createStockdbClient, McpToolError } from '../src/lib/mcpClient.mjs';
import { createToolContext, recheckSources } from '../src/ingest/tools.mjs';
import { fetchPage } from '../src/crawl/page.mjs';

const up = await testDbAvailable();
const skip = up ? false : 'test DB not running (npm run db:test:up)';
const FIX = path.join(ROOT, 'test/fixtures/http');
const CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-pagecache-'));
const env = { ...TEST_ENV, CRAWL_MODE: 'fixture', CRAWL_FIXTURE_DIR: FIX, NO_SOURCE_HEALTH: '1', SP_PAGE_CACHE_DIR: CACHE };
delete env.MYSQL_ROOT_PASSWORD;
let mcp;
const count = async (t, where = '1=1', a = []) => Number((await roQuery(`SELECT COUNT(*) AS n FROM ${t} WHERE ${where}`, a))[0].n);

before(async () => {
  if (!up) return;
  await resetTestDb();
  mcp = createStockdbClient({ projectDir: ROOT, env, name: 'ingest-test', timeoutMs: 60000 });
});
after(async () => { await mcp?.close(); });

test('ingest_price: verified (Nasdaq close stored), duplicate, conflict_existing, price_mismatch, not_month_end, refetch_failed, unknown ticker', { skip }, async () => {
  const p = (o) => mcp.call('ingest_price', { ticker: 'AAPL', month: '2026-09', trade_date: '2026-09-30', close: '333.02', origin: 'inbox', ...o });
  const ok = await p({ inbox_file: 'prices/x.csv' });
  assert.equal(ok.status, 'verified');
  assert.equal(ok.reason, 'ok');
  const [row] = await roQuery("SELECT * FROM month_end_prices WHERE ticker = 'AAPL' AND month = '2026-09'");
  assert.equal(row.close, '333.0200');
  assert.equal(row.source_b_close, '333.0200');
  assert.match(row.source_a_url, /^https:\/\/api\.nasdaq\.com\/api\/quote\/AAPL\/historical\?/);
  assert.match(row.source_b_url, /^https:\/\/ts-api\.cnbc\.com\/harmony\/app\/bars\/AAPL\/1D\//);
  const dup = await p({ close: 333.02 });
  assert.equal(dup.duplicate, true);
  assert.equal(await count('price_submissions', "ticker = 'AAPL' AND month = '2026-09'"), 1); // nothing written for a duplicate
  const conflict = await p({ close: '340.00' });
  assert.equal(conflict.reason, 'conflict_existing');
  assert.equal((await roQuery("SELECT close FROM month_end_prices WHERE ticker = 'AAPL' AND month = '2026-09'"))[0].close, '333.0200'); // never overwritten

  const wrong = await p({ ticker: 'AMZN', close: '250.00' });
  assert.deepEqual([wrong.status, wrong.reason], ['rejected', 'price_mismatch']);
  assert.equal(wrong.detail.source_a.close, '249.1500');
  assert.equal(await count('month_end_prices', "ticker = 'AMZN'"), 0);
  assert.equal(await count('price_submissions', "ticker = 'AMZN' AND status = 'rejected' AND reason = 'price_mismatch'"), 1);
  const mid = await p({ ticker: 'GOOGL', trade_date: '2026-09-15', close: '344.08' });
  assert.deepEqual([mid.status, mid.reason, mid.detail.expected_date], ['rejected', 'not_month_end', '2026-09-30']);
  const gf = await p({ ticker: 'GOOGL', month: '2024-03', trade_date: '2024-03-29', close: '150.93', origin: 'ria_import' });
  assert.equal(gf.reason, 'not_month_end'); // importer/backfill go through the same server-side check (Good Friday)
  const pend = await p({ ticker: 'AMZN', month: '2026-07', trade_date: '2026-07-31', close: '231.01' });
  assert.deepEqual([pend.status, pend.reason], ['pending', 'refetch_failed']);
  const unk = await p({ ticker: 'TSLA' });
  assert.equal(unk.reason, 'unknown_ticker');
  await assert.rejects(p({ ticker: 'aapl' }), (e) => e instanceof McpToolError && e.reason === 'invalid_input');
  await assert.rejects(p({ close: '-1' }), (e) => e instanceof McpToolError && e.reason === 'invalid_input');
  const ok2 = await p({ ticker: 'GOOGL', month: '2026-08', trade_date: '2026-08-31', close: '339.35', origin: 'backfill' });
  assert.equal(ok2.status, 'verified');
  assert.ok(await count('audit_log', "tool = 'ingest_price' AND actor = 'mcp'") >= 9);
});

const recall = { ticker: 'AAPL', published_at: '2026-10-20' };
test('add_news_item: 3 independent outlets -> corroborated (earlier items upgraded); wire copy never counts', { skip }, async () => {
  const reuters = await mcp.call('add_news_item', { ...recall, title: 'Apple recalls iPhone Duo chargers over overheating risk',
    url: 'https://www.reuters.com/technology/apple-recalls-iphone-duo-chargers-2026-10-20?utm_source=feed',
    references: [{ url: 'https://apnews.com/article/apple-iphone-duo-charger-recall', title: 'AP' }, { title: 'BBC News' }] });
  assert.equal(reuters.status, 'verified'); // AP (via its reference) is one independent group so far
  assert.equal(reuters.corroboration.count, 1);
  assert.equal(reuters.references_without_url, 1);
  assert.equal(reuters.references.length, 1);
  const bbc = await mcp.call('add_news_item', { ...recall, title: 'Apple recalls iPhone Duo chargers over overheating fears', url: 'https://bbc.co.uk/news/articles/apple-charger-recall', published_at: '2026-10-21T08:00:00Z' });
  assert.equal(bbc.status, 'corroborated');
  assert.deepEqual(bbc.corroboration.independent_groups, ['associated-press', 'thomson-reuters']);
  assert.ok(bbc.upgraded_items.some((u) => u.news_item_id === reuters.news_item_id && u.to === 'corroborated'));
  const [r] = await roQuery('SELECT status, corroboration_count FROM news_items WHERE id = ?', [reuters.news_item_id]);
  assert.deepEqual([r.status, r.corroboration_count], ['corroborated', 2]);
  const wire = await mcp.call('add_news_item', { ...recall, title: 'Apple recalls iPhone Duo chargers after overheating reports',
    url: 'https://abcnews.com/Technology/wireStory/apple-recalls-iphone-duo-chargers-overheating-123456' });
  assert.equal(wire.wire_copy, true);
  const [r2] = await roQuery('SELECT corroboration_count, corroborating_source_ids FROM news_items WHERE id = ?', [reuters.news_item_id]);
  assert.equal(r2.corroboration_count, 2); // the ABC wire copy did not add a third group
  assert.ok(!JSON.parse(JSON.stringify(r2.corroborating_source_ids)).includes(wire.source_id));
  const again = await mcp.call('add_news_item', { ...recall, title: 'Apple recalls iPhone Duo chargers over overheating risk', url: 'https://reuters.com/technology/apple-recalls-iphone-duo-chargers-2026-10-20' });
  assert.equal(again.duplicate, true);
  assert.equal(again.news_item_id, reuters.news_item_id);
  assert.equal(await count('sources', "url_canonical = 'https://reuters.com/technology/apple-recalls-iphone-duo-chargers-2026-10-20'"), 1);
  assert.equal(await count('sources', "verification_status = 'corroborated'"), 3); // Reuters, BBC and the ABC copy itself (others corroborate it)
});

test('add_news_item: fake news is rejected (title mismatch, denied domain, 404, paywall, no mention); no date -> pending; macro ok', { skip }, async () => {
  const n = (o) => mcp.call('add_news_item', { ...recall, title: 'Apple recalls iPhone Duo chargers', ...o });
  const mism = await n({ url: 'https://theverge.com/2026/10/20/pixel-11-launch' });
  assert.deepEqual([mism.status, mism.reason], ['rejected', 'title_mismatch']);
  const denied = await n({ url: 'https://medium.com/@someone/apple-recall' });
  assert.deepEqual([denied.status, denied.reason, denied.source_status, denied.source_reason], ['rejected', 'source_rejected', 'rejected', 'domain_denied']);
  assert.equal((await n({ url: 'https://reuters.com/technology/missing-article' })).reason, 'source_rejected');
  const pw = await n({ url: 'https://wsj.com/tech/apple-recall-chargers' });
  assert.deepEqual([pw.reason, pw.source_status, pw.source_reason], ['source_rejected', 'unreachable', 'paywalled']);
  assert.equal((await n({ title: 'Google faces new EU fine over ad tech practices', url: 'https://dw.com/en/google-eu-fine/a-1' })).reason, 'ticker_not_mentioned');
  const nodate = await n({ url: 'https://techcrunch.com/2026/10/20/apple-chargers-recall-nodate' });
  assert.deepEqual([nodate.status, nodate.reason], ['pending', 'date_unverifiable']);
  const macro = await mcp.call('add_news_item', { ticker: null, scope: 'macro', title: 'Federal Reserve issues FOMC statement holding rates steady',
    url: 'https://federalreserve.gov/newsevents/pressreleases/monetary20261028a.htm', published_at: '2026-10-28', references: [{ title: 'Reuters' }, { title: 'AP' }] });
  assert.deepEqual([macro.status, macro.scope, macro.references_without_url], ['verified', 'macro', 2]);
  const [m] = await roQuery('SELECT ticker, scope FROM news_items WHERE id = ?', [macro.news_item_id]);
  assert.deepEqual([m.ticker, m.scope], [null, 'macro']);
  // the trigger still guards the table: no verified news on a rejected source
  const c = await appConn();
  try { await assert.rejects(c.query("UPDATE news_items SET status = 'verified' WHERE id = ?", [denied.news_item_id]), (e) => e.sqlState === '45000'); }
  finally { await c.end(); }
  const src = await mcp.call('add_source', { url: 'https://www.bbc.co.uk/news/articles/apple-charger-recall' });
  assert.equal(src.reused, true); // idempotent on the canonical URL
  assert.ok(fs.readdirSync(CACHE).length >= 4); // page cache written outside the project for tests
});

test('recheck_sources: 404 rejects the source and downgrades items it corroborated; a dated page resolves date_unverifiable', { skip }, async () => {
  const conn = await appConn();
  try {
    await conn.beginTransaction();
    const [[ap]] = await conn.query("SELECT id FROM sources WHERE url_canonical = 'https://apnews.com/article/apple-iphone-duo-charger-recall'");
    const [[tc]] = await conn.query("SELECT id FROM sources WHERE url_canonical LIKE 'https://techcrunch.com/%'");
    const ctx = createToolContext({ projectDir: ROOT, dryRun: true, pageFetch: async (u) => {
      if (u.startsWith('https://apnews.com/')) return { ok: false, reason: 'not_found', status_class: 'rejected', http_status: 404 };
      const p = await fetchPage(u, { policy: ctx.policy, irDomains: ctx.irDomains, mode: 'fixture', fixtureDir: FIX });
      return u.startsWith('https://techcrunch.com/') ? { ...p, published_at: '2026-10-20T15:00:00.000Z' } : p;
    } });
    const res = await recheckSources(conn, { source_ids: [ap.id] }, ctx);
    const apRes = res.results[0];
    assert.deepEqual([apRes.before, apRes.after, apRes.reason], ['verified', 'rejected', 'not_found']);
    const status = async () => Object.fromEntries((await conn.query("SELECT n.status, s.url_canonical FROM news_items n JOIN sources s ON s.id = n.source_id WHERE n.ticker = 'AAPL'"))[0]
      .map((i) => [i.url_canonical, i.status]));
    const REU = 'https://reuters.com/technology/apple-recalls-iphone-duo-chargers-2026-10-20', BBC = 'https://bbc.co.uk/news/articles/apple-charger-recall';
    let st = await status();
    assert.equal(st[REU], 'verified'); // lost AP: only BBC is left (ABC is a wire copy)
    assert.equal(st[BBC], 'verified'); // lost AP: only Reuters is left
    // TechCrunch's page now carries a date: its pending item is decided and it becomes a third independent outlet
    const res2 = await recheckSources(conn, { source_ids: [tc.id] }, ctx);
    assert.equal(res2.results[0].news[0].to, 'verified');
    st = await status();
    assert.equal(st[REU], 'corroborated');
    assert.equal(st[BBC], 'corroborated');
    assert.ok(res2.corroboration_changes.length >= 2);
    await conn.rollback();
  } finally { await conn.end(); }
});

test('npm run ingest: dry-run writes nothing; real run verifies, writes results and moves files (leads/ ignored)', { skip }, async () => {
  await resetTestDb();
  const inbox = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-inbox-'));
  fs.cpSync(path.join(ROOT, 'test/fixtures/inbox/accept'), inbox, { recursive: true });
  const run = (...extra) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/ingest.mjs'), '--inbox', inbox, '--json', ...extra],
      { encoding: 'utf8', timeout: 240000, cwd: ROOT, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const dry = run('--dry-run');
  assert.equal(dry.dry_run, true);
  const byFile = Object.fromEntries(dry.files.map((f) => [f.file, f]));
  assert.deepEqual(byFile['prices/2026-q3.csv'].totals.by_reason, { 'verified:ok': 2, 'rejected:price_mismatch': 1, 'rejected:not_month_end': 1,
    'pending:refetch_failed': 1, 'rejected:bad_schema': 1 });
  assert.match(byFile['news/broken.json'].fatal, /invalid JSON/);
  const news = byFile['news/recall.json'].totals.by_reason;
  assert.equal(news['corroborated:corroborated'], 2); // BBC + ABC (wire copy itself can be corroborated by others)
  assert.equal(news['rejected:title_mismatch'], 1);
  assert.equal(news['rejected:source_rejected'], 1);
  assert.equal(news['rejected:bad_schema'], 1);
  assert.equal(news['verified:ok'], 2); // Reuters (one group at its turn) + FOMC macro
  assert.deepEqual(byFile['news/nodate.md'].totals.by_reason, { 'pending:date_unverifiable': 1 });
  for (const t of ['price_submissions', 'month_end_prices', 'sources', 'news_items', 'news_references']) assert.equal(await count(t), 0, `${t} after dry-run`);
  assert.ok(fs.existsSync(path.join(inbox, 'news/recall.json')));

  const real = run();
  const rb = Object.fromEntries(real.files.map((f) => [f.file, f]));
  assert.equal(rb['news/recall.json'].moved_to, 'processed/recall.json');
  assert.equal(rb['prices/2026-q3.csv'].moved_to, null); // pending refetch_failed -> stays for retry
  assert.equal(rb['news/nodate.md'].moved_to, null);
  assert.equal(rb['news/broken.json'].moved_to, 'rejected/broken.json');
  assert.ok(fs.existsSync(path.join(inbox, 'processed/recall.json.result.json')));
  assert.ok(fs.existsSync(path.join(inbox, 'processed/2026-q3.csv.result.json')));
  assert.ok(fs.existsSync(path.join(inbox, 'rejected/broken.json.reason.json')));
  assert.ok(fs.existsSync(path.join(inbox, 'leads/leads.md')));
  assert.equal(await count('month_end_prices'), 2);
  assert.equal(await count('news_items', "status = 'corroborated'"), 3); // Reuters upgraded once BBC arrived
  assert.equal(real.totals.by_reason['verified:ok'], 4);

  const again = run('--file', path.join(inbox, 'prices/2026-q3.csv')); // idempotent re-run
  assert.equal(again.totals.by_reason['verified:ok'], 2);
  assert.equal(await count('month_end_prices'), 2);
});
