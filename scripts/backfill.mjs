#!/usr/bin/env node
// npm run backfill [-- --from 2023-01] [--to YYYY-MM] [--ticker T] [--dry-run] [--json]   (PLAN §6 History)
// Crawls Nasdaq once per ticker (one range fetch, paced) to find each month's last-trading-day close, then submits every
// missing month through ingest_price (origin 'backfill'). The server re-fetches Nasdaq AND CNBC independently and applies the
// same rule as the inbox (not_month_end, |A-B| <= 0.01, ...); this script never stores a price itself. Months that are already
// verified are skipped. --dry-run runs the server functions in one rolled-back transaction (see src/ingest/executor.mjs).
import { parseArgs } from '../src/lib/cli.mjs';
import { roPool, closePools } from '../src/lib/db.mjs';
import { createHttp } from '../src/crawl/http.mjs';
import { nasdaq } from '../src/crawl/index.mjs';
import { filterTradingBars } from '../src/crawl/parse.mjs';
import { lastCompleteMonth, monthRange, lastDayOfMonth, lastTradingDay } from '../src/market/calendar.mjs';
import { loadVerification } from '../src/verify/config.mjs';
import { makeExecutor } from '../src/ingest/executor.mjs';

const args = parseArgs();
const dryRun = !!args.dryRun;
const say = (...a) => { if (!args.json) console.log(...a); };

async function main() {
  const cfg = loadVerification().price;
  const from = args.from ?? '2023-01';
  const to = args.to ?? lastCompleteMonth(new Date(), { settleMinutes: cfg.settle_minutes_after_close, extraClosures: cfg.extra_closures });
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(from) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(to)) throw new Error('--from/--to must be YYYY-MM');
  const [companies] = await roPool().query("SELECT ticker, listed_on FROM companies WHERE active = 1 AND role = 'target' ORDER BY ticker");
  const [have] = await roPool().query('SELECT ticker, month FROM month_end_prices');
  await closePools();
  const verified = new Set(have.map((r) => `${r.ticker}|${r.month}`));
  const http = createHttp();
  const exec = await makeExecutor({ dryRun, name: 'backfill' });
  const totals = {};
  const out = [];
  try {
    for (const c of companies.filter((x) => !args.ticker || x.ticker === args.ticker)) {
      const start = String(c.listed_on).slice(0, 7) > from ? String(c.listed_on).slice(0, 7) : from;
      const months = start <= to ? monthRange(start, to).filter((m) => !verified.has(`${c.ticker}|${m}`)) : [];
      say(`${c.ticker}: ${months.length} month(s) to backfill (${start}..${to})`);
      if (!months.length) continue;
      let res;
      try { res = await nasdaq.fetchDailyCloses(c.ticker, `${months[0]}-01`, lastDayOfMonth(months.at(-1)), { http, extraClosures: cfg.extra_closures }); }
      catch (e) { say(`  nasdaq fetch failed: ${e.message}`); totals['pending:refetch_failed'] = (totals['pending:refetch_failed'] ?? 0) + months.length; continue; }
      for (const m of months) {
        const bar = filterTradingBars(res.bars, m, { extraClosures: cfg.extra_closures }).bars.at(-1);
        if (!bar || bar.date !== lastTradingDay(m, cfg.extra_closures)) {
          const k = 'skipped:no_month_end_bar';
          totals[k] = (totals[k] ?? 0) + 1;
          say(`  ${m}: no Nasdaq bar on ${lastTradingDay(m, cfg.extra_closures)} (last ${bar?.date ?? 'none'}); not submitted`);
          continue;
        }
        const r = await exec.run('ingest_price', { ticker: c.ticker, month: m, trade_date: bar.date, close: bar.close, origin: 'backfill' });
        const k = `${r.status}:${r.reason}`;
        totals[k] = (totals[k] ?? 0) + 1;
        out.push({ ticker: c.ticker, month: m, status: r.status, reason: r.reason });
        say(`  ${m} ${bar.date} ${bar.close}: ${r.status} ${r.reason}`);
      }
    }
  } finally { await exec.close(); }
  if (args.json) console.log(JSON.stringify({ dry_run: dryRun, from, to, totals, items: out }, null, 2));
  else { say(`[backfill] ${dryRun ? 'DRY RUN ' : ''}totals:`); for (const [k, v] of Object.entries(totals).sort()) say(`  ${k.padEnd(32)} ${v}`); }
}

main().then(() => process.exit(0)).catch((e) => { console.error(`[backfill] ${e?.stack || e}`); process.exit(1); });
