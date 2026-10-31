#!/usr/bin/env node
// npm run crawl -- --ticker T [--source sec|ir|all] [--since YYYY-MM-DD] [--limit n] [--register] [--json]
//
// Discovers candidate primary sources (PLAN §8 /research-company):
//   sec  SEC EDGAR submissions JSON -> recent 10-K/10-Q/8-K primary documents + 8-K (item 2.02) EX-99.1 earnings releases.
//        Refuses with sec_user_agent_unset (exit 2 for --source sec) while SP_HTTP_UA is unset or the .env.example placeholder.
//   ir   company newsroom/IR feeds from config/feeds.json, every URL checked against the domain policy.
// Without --register it only prints candidates (no DB access). With --register each candidate goes through the stockdb MCP
// tool add_source (the server fetches and verifies it; kind filing/ir). Candidates are NEVER evidence by themselves.
import { parseArgs } from '../src/lib/cli.mjs';
import { loadCompanies, loadPolicy } from '../src/verify/config.mjs';
import { irDomainsOf } from '../src/verify/domainPolicy.mjs';
import { secFilings, secSourceUrls } from '../src/crawl/sec.mjs';
import { SEC_UA_REASON } from '../src/crawl/secUa.mjs';
import { irCandidates, loadFeeds } from '../src/crawl/ir.mjs';
import { addDays } from '../src/market/calendar.mjs';

const args = parseArgs();
const say = (...a) => { if (!args.json) console.log(...a); };
const today = new Date().toISOString().slice(0, 10);

async function main() {
  const companies = loadCompanies().companies;
  const tickers = args.ticker && args.ticker !== true ? String(args.ticker).toUpperCase().split(',') : companies.filter((c) => c.active).map((c) => c.ticker);
  const source = args.source && args.source !== true ? String(args.source) : 'all';
  if (!['sec', 'ir', 'all'].includes(source)) throw new Error('--source must be sec, ir or all');
  const feeds = loadFeeds();
  const policy = loadPolicy();
  const irDomains = irDomainsOf(companies);
  const out = { at: new Date().toISOString(), tickers: {}, refused: [] };
  let exit = 0;
  for (const t of tickers) {
    const co = companies.find((c) => c.ticker === t);
    if (!co) { out.tickers[t] = { error: 'unknown_ticker' }; exit = 1; continue; }
    const res = out.tickers[t] = {};
    if (source !== 'ir') {
      const since = args.since && args.since !== true ? String(args.since) : addDays(today, -feeds.sec.since_days);
      try {
        if (!co.cik) res.sec = { skipped: 'no_cik', message: `${t} has no CIK in config/companies.json` };
        else {
          const r = await secFilings({ ticker: t, cik: co.cik, since, forms: feeds.sec.forms, limit: Number(args.limit ?? feeds.sec.limit), log: (m) => console.error(`[crawl] ${m}`) });
          res.sec = { ...r, sources: secSourceUrls(r) };
        }
      } catch (e) {
        if (e.code === SEC_UA_REASON) { res.sec = { refused: SEC_UA_REASON, message: e.message }; out.refused.push(`${t}:sec`); if (source === 'sec') exit = 2; }
        else { res.sec = { error: e.code ?? 'error', message: e.message }; exit = exit || 1; }
      }
    }
    if (source !== 'sec') {
      const since = args.since && args.since !== true ? String(args.since) : addDays(today, -feeds.ir.since_days);
      const list = feeds.ir.tickers[t] ?? [];
      res.ir = list.length ? await irCandidates({ ticker: t, feeds: list, policy, irDomains, since, limit: Number(args.limit ?? feeds.ir.limit) })
        : { ticker: t, candidates: [], feeds: [], note: 'no IR feeds configured (config/feeds.json)' };
    }
  }

  if (args.register) {
    const { createStockdbClient, McpToolError } = await import('../src/lib/mcpClient.mjs');
    const mcp = createStockdbClient({ name: 'crawl', timeoutMs: 120000 });
    try {
      for (const [t, r] of Object.entries(out.tickers)) {
        const todo = [...(r.sec?.sources ?? []).map((s) => ({ url: s.url, kind: 'filing' })), ...(r.ir?.candidates ?? []).map((c) => ({ url: c.url, kind: 'ir' }))];
        r.registered = [];
        for (const s of todo) {
          try { const x = await mcp.call('add_source', { url: s.url, kind: s.kind, ticker: t }); r.registered.push({ url: s.url, source_id: x.source_id, status: x.status, reason: x.reason }); }
          catch (e) { r.registered.push({ url: s.url, status: 'error', reason: e instanceof McpToolError ? e.reason : (e.code ?? 'error'), message: e.message }); }
        }
      }
    } finally { await mcp.close(); }
  }

  if (args.json) console.log(JSON.stringify(out, null, 2));
  else {
    for (const [t, r] of Object.entries(out.tickers)) {
      say(`== ${t}`);
      if (r.error) { say(`  error: ${r.error}`); continue; }
      if (r.sec) {
        if (r.sec.refused) say(`  sec: REFUSED ${r.sec.message}`);
        else if (r.sec.skipped || r.sec.error) say(`  sec: ${r.sec.skipped ?? r.sec.error}: ${r.sec.message}`);
        else { say(`  sec: ${r.sec.filings.length} filings (${r.sec.requests} requests)`); for (const s of r.sec.sources) say(`    ${s.label}  ${s.url}`); }
      }
      if (r.ir) {
        for (const f of r.ir.feeds ?? []) say(`  ir feed ${f.url}: ${f.ok ? `ok items=${f.items} kept=${f.kept}` : `FAILED ${f.reason}${f.http_status ? ` HTTP ${f.http_status}` : ''}`}`);
        if (r.ir.note) say(`  ir: ${r.ir.note}`);
        for (const c of r.ir.candidates) say(`    ${String(c.published_at ?? '').slice(0, 10).padEnd(10)} ${c.url_canonical}  ${String(c.title ?? '').slice(0, 80)}`);
      }
      for (const g of r.registered ?? []) say(`    add_source ${g.status}/${g.reason} #${g.source_id ?? '-'} ${g.url}`);
    }
    if (out.refused.length) say(`refused: ${out.refused.join(', ')} (set SP_HTTP_UA with your own contact e-mail in .env to enable SEC EDGAR)`);
  }
  process.exitCode = exit;
}

main().catch((e) => { console.error(`[crawl] ${e.message}`); process.exit(1); });
