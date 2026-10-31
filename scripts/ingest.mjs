#!/usr/bin/env node
// npm run ingest [-- --dry-run] [--file <path>] [--from-ria [report.md]] [--inbox <dir>] [--json]   (PLAN §7)
//
// 1. Parses inbox/prices/*.csv|json and inbox/news/*.json|md (inbox/leads/ = unverified crawler leads, processed/, rejected/ are
//    never ingested) and validates every row with the shared zod schemas.
// 2. Real run: calls the stockdb MCP tools ingest_price / add_news_item through mcpClient (the server re-verifies everything:
//    live Nasdaq+CNBC re-fetch, page fetch, domain policy, title/date, corroboration). Writes inbox/processed/<file>.result.json,
//    moves fully decided files to inbox/processed/ and unparseable files to inbox/rejected/ (+ .reason.json). Files with
//    pending items stay in place for a retry.
// 3. --dry-run: runs the SAME server-side functions in-process inside ONE database transaction that is always rolled back
//    (so later items see earlier ones, exactly like the real run), never writes files or the page cache, never moves files.
//    Network fetches are real (live) so the outcome counts are what the real run would report.
// Ingest is idempotent: verified prices and known URLs are de-duplicated server-side.
import fs from 'node:fs';
import path from 'node:path';
import { root } from '../src/lib/env.mjs';
import { makeExecutor } from '../src/ingest/executor.mjs';
import { parseArgs } from '../src/lib/cli.mjs';
import { acquireLock, LockBusyError } from '../src/lib/lock.mjs';
import { listInboxFiles, parseInboxFile } from '../src/ingest/inbox.mjs';
import { readRiaReport, DEFAULT_RIA_REPORT } from '../src/ingest/importers/ria-report.mjs';

const args = parseArgs();
const dryRun = !!args.dryRun;
const inboxDir = path.resolve(args.inbox ?? path.join(root, 'inbox'));
const say = (...a) => { if (!args.json) console.log(...a); };

function toolArgs(kind, data, inboxFile, origin) {
  if (kind === 'prices') {
    return { tool: 'ingest_price', args: { ticker: data.ticker, month: data.month, trade_date: data.trade_date, close: data.close, origin,
      ...(inboxFile ? { inbox_file: inboxFile } : {}), ...(data.source_url ? { submitted_source_url: data.source_url } : {}) } };
  }
  const { ticker, scope, url, title, published_at, outlet, author, summary, references } = data;
  return { tool: 'add_news_item', args: { ticker: ticker ?? null, ...(scope ? { scope } : {}), url, title, published_at, ...(outlet ? { outlet } : {}),
    ...(author ? { author } : {}), ...(summary ? { summary } : {}), ...(references ? { references } : {}), ...(inboxFile ? { inbox_file: inboxFile } : {}) } };
}

function tally(results) {
  const t = { verified: 0, corroborated: 0, pending: 0, rejected: 0, by_reason: {} };
  for (const r of results) {
    t[r.status] = (t[r.status] ?? 0) + 1;
    const k = `${r.status}:${r.reason}`;
    t.by_reason[k] = (t.by_reason[k] ?? 0) + 1;
  }
  return t;
}

const line = (r) => {
  const what = r.kind === 'prices' ? `${r.input.ticker} ${r.input.month} ${r.input.trade_date} ${r.input.close}` : `${(r.input.ticker ?? r.input.scope ?? '').toString().padEnd(5)} ${String(r.input.title).slice(0, 70)}`;
  const extra = r.kind === 'prices'
    ? (r.result.detail?.source_a?.close ? ` nasdaq=${r.result.detail.source_a.close} cnbc=${r.result.detail.source_b?.close}` : '') + (r.result.detail?.expected_date && r.reason === 'not_month_end' ? ` expected=${r.result.detail.expected_date}` : '')
    : ` sim=${r.result.title_similarity ?? '-'} dΔh=${r.result.date_delta_hours ?? '-'}${r.result.corroboration ? ` corr=${r.result.corroboration.count}[${r.result.corroboration.independent_groups.join(',')}]` : ''}${r.result.references_without_url ? ` refs_no_url=${r.result.references_without_url}` : ''}${r.result.message ? ` (${String(r.result.message).slice(0, 110)})` : ''}`;
  return `  ${r.status.padEnd(12)} ${String(r.reason).padEnd(20)} ${what}${extra}`;
};

async function main() {
  let lock = null;
  if (!dryRun) {
    try { lock = acquireLock(path.join(root, 'data', 'ingest.lock')); }
    catch (e) { if (e instanceof LockBusyError) { console.error(`[ingest] ${e.message}`); process.exit(3); } throw e; }
  }
  const batches = [];
  if (args.fromRia) {
    const file = typeof args.fromRia === 'string' ? args.fromRia : DEFAULT_RIA_REPORT;
    batches.push({ kind: 'prices', file, label: `ria:${file}`, origin: 'ria_import', parsed: readRiaReport(file), noMove: true });
  } else {
    for (const f of listInboxFiles(inboxDir, { only: args.file ?? null }))
      batches.push({ ...f, label: path.relative(inboxDir, f.file), origin: 'inbox', parsed: parseInboxFile(f) });
  }
  const exec = await makeExecutor({ dryRun, name: 'ingest' });
  const all = [];
  const fileReports = [];
  let finalState = null;
  try {
    say(`[ingest] ${dryRun ? 'DRY RUN (one transaction, rolled back; nothing is written or moved)' : 'live run via MCP'}; ${batches.length} file(s) from ${args.fromRia ? 'RIA report' : inboxDir}`);
    for (const b of batches) {
      const results = [];
      say(`\n${b.label}: ${b.parsed.items.length} row(s)${b.parsed.errors.length ? `, ${b.parsed.errors.length} schema error(s)` : ''}${b.parsed.fatal ? ` FATAL: ${b.parsed.fatal}` : ''}`);
      if (!b.parsed.fatal) {
        for (const e of b.parsed.errors) results.push({ kind: b.kind, input: e.raw, status: 'rejected', reason: 'bad_schema', result: { message: e.message, line: e.line } });
        for (const it of b.parsed.items) {
          const { tool, args: a } = toolArgs(b.kind, it.data, b.noMove ? null : b.label, b.origin);
          const res = await exec.run(tool, a);
          const r = { kind: b.kind, line: it.line, index: it.index, input: a, status: res.status ?? 'pending', reason: res.reason ?? 'unknown', result: res };
          results.push(r);
          say(line(r));
        }
      }
      const t = tally(results);
      const report = { file: b.label, kind: b.kind, dry_run: dryRun, at: new Date().toISOString(), fatal: b.parsed.fatal, totals: t,
        items: results.map((r) => ({ line: r.line ?? null, index: r.index ?? null, status: r.status, reason: r.reason, input: r.input, result: r.result })) };
      fileReports.push(report);
      all.push(...results);
      if (!dryRun && !b.noMove) {
        const processed = path.join(inboxDir, 'processed'), rejected = path.join(inboxDir, 'rejected');
        fs.mkdirSync(processed, { recursive: true });
        const base = path.basename(b.file);
        if (b.parsed.fatal) {
          fs.mkdirSync(rejected, { recursive: true });
          fs.writeFileSync(path.join(rejected, `${base}.reason.json`), JSON.stringify({ file: b.label, at: report.at, reason: 'bad_schema', message: b.parsed.fatal }, null, 2) + '\n');
          fs.renameSync(b.file, path.join(rejected, base));
          report.moved_to = `rejected/${base}`;
        } else {
          fs.writeFileSync(path.join(processed, `${base}.result.json`), JSON.stringify(report, null, 2) + '\n');
          if (t.pending === 0) { fs.renameSync(b.file, path.join(processed, base)); report.moved_to = `processed/${base}`; }
          else report.moved_to = null; // pending items: the file stays for a retry
        }
        say(`  -> ${report.moved_to ?? `kept in place (${t.pending} pending)`}; result: processed/${base}.result.json`);
      }
    }
    if (exec.snapshot) {
      const snap = await exec.snapshot();
      finalState = snap;
      say('\n[ingest] dry-run end state (before rollback; includes upgrades of earlier items by later ones):');
      say(`  month_end_prices: ${snap.prices.map((p) => `${p.ticker} ${p.n}`).join(', ') || 'none'}`);
      const by = {};
      for (const n of snap.news) by[`${n.status}:${n.reason}`] = (by[`${n.status}:${n.reason}`] ?? 0) + 1;
      say(`  news_items: ${Object.entries(by).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
      for (const n of snap.news) say(`    ${n.t.padEnd(5)} ${n.status.padEnd(12)} ${String(n.reason).padEnd(18)} corr=${n.corroboration_count} ${n.title}`);
    }
  } finally {
    await exec.close();
    lock?.release();
  }
  const totals = tally(all);
  if (args.json) console.log(JSON.stringify({ dry_run: dryRun, files: fileReports.map((f) => ({ file: f.file, fatal: f.fatal, totals: f.totals, moved_to: f.moved_to ?? null })), totals, ...(finalState ? { dry_run_end_state: finalState } : {}), ...(args.items ? { reports: fileReports } : {}) }, null, 2));
  else {
    say(`\n[ingest] totals: ${all.length} item(s): verified ${totals.verified}, corroborated ${totals.corroborated}, pending ${totals.pending}, rejected ${totals.rejected}`);
    for (const [k, v] of Object.entries(totals.by_reason).sort()) say(`  ${k.padEnd(36)} ${v}`);
  }
  return totals;
}

main().then(() => process.exit(0)).catch((e) => { console.error(`[ingest] ${e?.stack || e}`); process.exit(1); });
