#!/usr/bin/env node
// npm run validate [-- --sample 20] [--prices 4] [--ticker T] [--json]
// Live re-validation of stored evidence (PLAN §4.7 layer 6). READ-ONLY: reads stockdb as stock_ro and NEVER writes (use
// recheck_sources through MCP to change a status). For a random sample of verified/corroborated sources it re-fetches the page with
// the same fetcher and domain policy the server uses and compares:
//   - content_sha256 (drift is reported; pages change, so drift alone is a warning)
//   - every verified research note on that source: the stored normalised excerpt must still be verbatim page text
// With --prices N it also re-fetches Nasdaq + CNBC for N random verified month-end closes and re-runs the price rule.
// Exit 1 when an excerpt is no longer on a reachable page, a page is now 404/410/denied, or a stored close no longer matches.
// Transient failures (timeouts, 403 bot walls, 429) are reported as "unreachable" and do not fail the run.
import { parseArgs } from '../src/lib/cli.mjs';
import { roPool, closePools } from '../src/lib/db.mjs';
import { clean } from '../src/lib/repo.mjs';
import { fetchPage } from '../src/crawl/page.mjs';
import { createHttp } from '../src/crawl/http.mjs';
import { findExcerpt } from '../src/verify/excerpt.mjs';
import { irDomainsOf } from '../src/verify/domainPolicy.mjs';
import { loadPolicy, loadCompanies, loadVerification } from '../src/verify/config.mjs';
import { refetchBoth } from '../src/verify/priceRefetch.mjs';
import { decidePrice } from '../src/verify/priceRule.mjs';

const args = parseArgs();
const sample = Math.min(200, Math.max(1, Number(args.sample ?? 20)));
const nPrices = Math.min(50, Math.max(0, Number(args.prices ?? 0)));
const ticker = typeof args.ticker === 'string' ? args.ticker.toUpperCase() : null;
const db = roPool();
const q = async (sql, a = []) => clean((await db.query(sql, a))[0]);
const cfg = loadVerification();
const policy = loadPolicy();
const irDomains = irDomainsOf(loadCompanies());
const out = { sources: [], prices: [], problems: [], warnings: [] };

try {
  const tick = ticker ? `AND (EXISTS (SELECT 1 FROM news_items n WHERE n.source_id = s.id AND n.ticker = ?)
      OR EXISTS (SELECT 1 FROM research_notes r WHERE r.source_id = s.id AND r.ticker = ?))` : '';
  const srcs = await q(`SELECT s.id, s.url_canonical, s.content_sha256, s.verification_status FROM sources s
      WHERE s.verification_status IN ('verified','corroborated') ${tick} ORDER BY RAND() LIMIT ?`, ticker ? [ticker, ticker, sample] : [sample]);
  for (const s of srcs) {
    const page = await fetchPage(s.url_canonical, { policy, irDomains, timeoutMs: cfg.news.fetch?.timeout_ms ?? 15000, minTextLen: cfg.news.min_text_len });
    const notes = await q("SELECT id, excerpt FROM research_notes WHERE source_id = ? AND status = 'verified'", [s.id]);
    const row = { source_id: Number(s.id), url: s.url_canonical, status: s.verification_status, fetch: page.ok ? 'ok' : page.reason,
      http_status: page.http_status ?? null, drift: page.ok ? page.content_sha256 !== s.content_sha256 : null, notes: [] };
    if (!page.ok) {
      const hard = page.status_class === 'rejected'; // 404/410, policy/redirect denial (same classification as recheck_sources)
      (hard ? out.problems : out.warnings).push(`source ${s.id} ${hard ? 'now fails' : 'unreachable'}: ${page.reason} ${s.url_canonical}`);
    } else {
      if (row.drift) out.warnings.push(`source ${s.id} content drift (sha ${String(s.content_sha256).slice(0, 12)} -> ${page.content_sha256.slice(0, 12)})`);
      for (const n of notes) {
        const f = findExcerpt(String(n.excerpt), page);
        row.notes.push({ note_id: Number(n.id), excerpt_found: f.found });
        if (!f.found) out.problems.push(`note ${n.id}: excerpt no longer found on ${s.url_canonical}`);
      }
    }
    out.sources.push(row);
  }

  if (nPrices) {
    const http = createHttp();
    const prices = await q(`SELECT ticker, month, trade_date, close FROM month_end_prices ${ticker ? 'WHERE ticker = ?' : ''} ORDER BY RAND() LIMIT ?`,
      ticker ? [ticker, nPrices] : [nPrices]);
    for (const p of prices) {
      const { a, b } = await refetchBoth(p.ticker, p.month, cfg.price, { http });
      const d = decidePrice({ ticker: p.ticker, month: p.month, trade_date: p.trade_date, close: String(p.close) }, a, b, cfg.price);
      out.prices.push({ ticker: p.ticker, month: p.month, close: p.close, status: d.status, reason: d.reason });
      if (d.status === 'rejected') out.problems.push(`price ${p.ticker} ${p.month} ${p.close}: ${d.reason}`);
      else if (d.status !== 'verified') out.warnings.push(`price ${p.ticker} ${p.month}: ${d.reason} (transient)`);
    }
  }

  if (args.json) console.log(JSON.stringify(out, null, 2));
  else {
    for (const s of out.sources) console.log(`source ${s.source_id} ${s.fetch}${s.drift ? ' DRIFT' : ''} notes:${s.notes.map((n) => `${n.note_id}=${n.excerpt_found ? 'ok' : 'MISSING'}`).join(',') || '-'} ${s.url}`);
    for (const p of out.prices) console.log(`price ${p.ticker} ${p.month} ${p.close}: ${p.status} ${p.reason}`);
    for (const w of out.warnings) console.log(`warning ${w}`);
    for (const p of out.problems) console.log(`PROBLEM ${p}`);
    console.log(`[validate] ${out.sources.length} source(s), ${out.prices.length} price(s) re-checked: ${out.problems.length} problem(s), ${out.warnings.length} warning(s)`);
  }
  if (out.problems.length) process.exitCode = 1;
} catch (e) {
  console.error(`[validate] failed: ${e.message}`);
  process.exitCode = 2;
} finally { await closePools(); }
