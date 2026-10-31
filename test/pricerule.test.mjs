// Unit (no DB): Nasdaq/CNBC parsing from recorded fixtures and the month-end price rule's reason codes (PLAN §4.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHttp } from '../src/crawl/http.mjs';
import { nasdaq, cnbc } from '../src/crawl/index.mjs';
import { parsePrice, formatUnits } from '../src/crawl/parse.mjs';
import { checkPriceStatic, decidePrice } from '../src/verify/priceRule.mjs';
import { verifyPrice, refetchBoth } from '../src/verify/priceRefetch.mjs';
import { normalizeVerification, loadVerification } from '../src/verify/config.mjs';
import { priceStatusFor } from '../src/verify/reasons.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/http');
const http = createHttp({ mode: 'fixture', fixtureDir: FIX });
const cfg = loadVerification().price;
const companies = [{ ticker: 'AAPL', listed_on: '1980-12-12', active: 1 }, { ticker: 'AMZN', listed_on: '1997-05-15', active: 1 },
  { ticker: 'GOOGL', listed_on: '2004-08-19', active: 1 }, { ticker: 'SPCX', listed_on: '2026-06-12', active: 1 }, { ticker: 'OLD', listed_on: '2000-01-03', active: 0 }];
const NOW = new Date('2026-10-30T12:00:00Z');
const bar = (date, close, volume = 1000) => ({ date, close, closeUnits: parsePrice(close), volume });
const src = (url, bars) => ({ url, fetchedAt: '2026-10-30T12:00:00.000Z', bars });

test('config: price tolerances in units; extra closures include 2025-01-09; malformed config throws', () => {
  assert.equal(cfg.toleranceUnits, 100);
  assert.equal(cfg.submittedToleranceUnits, 100);
  assert.ok(cfg.extra_closures.includes('2025-01-09'));
  assert.throws(() => normalizeVerification({ price: { ...cfg, required_sources: ['nasdaq'] }, news: {} }));
});

test('nasdaq + cnbc fixtures parse to the same month-end close (integer units)', async () => {
  const a = await nasdaq.fetchDailyCloses('AAPL', '2026-09-01', '2026-09-30', { http });
  const b = await cnbc.fetchDailyCloses('AAPL', '2026-09-01', '2026-09-30', { http });
  assert.equal(a.bars.at(-1).date, '2026-09-30');
  assert.equal(a.bars.at(-1).close, '333.0200');
  assert.equal(b.bars.at(-1).close, '333.0200');
  assert.ok(nasdaq.isValidHost(a.url) && cnbc.isValidHost(b.url));
  assert.equal(parsePrice('$1,148.58'), 11485800);
  assert.equal(formatUnits(1485800), '148.5800');
});

test('static reason codes: unknown_ticker, pre_listing, not_month_end (incl. Good Friday), month_incomplete, bad_schema', () => {
  const s = (o) => checkPriceStatic({ ticker: 'AAPL', month: '2026-09', trade_date: '2026-09-30', close: '333.02', ...o }, { companies, cfg, now: NOW });
  assert.equal(s({}), null);
  assert.equal(s({ ticker: 'TSLA' }).reason, 'unknown_ticker');
  assert.equal(s({ ticker: 'OLD' }).reason, 'unknown_ticker');
  assert.equal(s({ ticker: 'SPCX', month: '2026-05', trade_date: '2026-05-29' }).reason, 'pre_listing');
  assert.equal(s({ trade_date: '2026-09-15' }).reason, 'not_month_end');
  assert.equal(s({ trade_date: '2026-09-29' }).reason, 'not_month_end');
  assert.equal(s({ month: '2024-03', trade_date: '2024-03-29' }).reason, 'not_month_end'); // Good Friday
  assert.equal(s({ month: '2024-03', trade_date: '2024-03-29' }).detail.expected_date, '2024-03-28');
  assert.equal(s({ month: '2024-03', trade_date: '2024-03-28' }), null);
  assert.equal(s({ month: '2026-10', trade_date: '2026-10-30' }).reason, 'month_incomplete'); // close not settled at 12:00 UTC
  assert.equal(checkPriceStatic({ ticker: 'AAPL', month: '2026-10', trade_date: '2026-10-30', close: '1' }, { companies, cfg, now: new Date('2026-10-30T21:31:00Z') }), null);
  assert.equal(s({ close: '0' }).reason, 'bad_schema');
  assert.equal(priceStatusFor('month_incomplete'), 'pending');
  assert.equal(priceStatusFor('price_mismatch'), 'rejected');
});

test('decidePrice: ok, price_mismatch (A vs B and submitted vs A), date_mismatch, missing sources, refetch_failed, rate_limited', () => {
  const sub = { ticker: 'AAPL', month: '2026-09', trade_date: '2026-09-30', close: '333.02' };
  const A = (c = '333.0200', d = '2026-09-30') => src('https://api.nasdaq.com/api/quote/AAPL/historical?x', [bar('2026-09-29', '329.40'), bar(d, c)]);
  const B = (c = '333.0200', d = '2026-09-30') => src('https://ts-api.cnbc.com/harmony/app/bars/AAPL/1D/x', [bar('2026-09-29', '329.40'), bar(d, c)]);
  const ok = decidePrice(sub, A(), B('333.0300'), cfg, NOW);
  assert.equal(ok.reason, 'ok');
  assert.equal(ok.verified.close, '333.0200'); // canonical Nasdaq close
  assert.equal(ok.verified.abs_diff, '0.0100');
  assert.equal(decidePrice({ ...sub, close: '333.03' }, A(), B(), cfg, NOW).reason, 'ok'); // within 0.01 of Nasdaq
  assert.equal(decidePrice(sub, A(), B('333.0400'), cfg, NOW).reason, 'price_mismatch');
  const wrong = decidePrice({ ...sub, close: '330.00' }, A(), B(), cfg, NOW);
  assert.equal(wrong.reason, 'price_mismatch');
  assert.equal(wrong.status, 'rejected');
  assert.equal(wrong.detail.submitted_close, '330.0000');
  assert.equal(decidePrice(sub, A('333.02', '2026-09-29'), B(), cfg, NOW).reason, 'date_mismatch');
  assert.equal(decidePrice(sub, src('a', []), B(), cfg, NOW).reason, 'source_a_missing');
  assert.equal(decidePrice(sub, A(), src('b', []), cfg, NOW).reason, 'source_b_missing');
  assert.equal(decidePrice(sub, { error: { code: 'network', message: 'down' } }, B(), cfg, NOW).reason, 'refetch_failed');
  assert.equal(decidePrice(sub, A(), { error: { code: 'rate_limited' } }, cfg, NOW).status, 'pending');
  // a weekend/zero-volume bar on the last calendar day is ignored, not taken as the month-end
  assert.equal(decidePrice(sub, A(), src('b', [bar('2026-09-30', '333.02'), bar('2026-09-30', '999', 0)]), cfg, NOW).reason, 'ok');
});

test('verifyPrice against recorded fixtures: verified, price_mismatch, refetch_failed (no recording)', async () => {
  const v = (o) => verifyPrice({ ticker: 'AMZN', month: '2026-09', trade_date: '2026-09-30', close: '249.15', ...o }, { companies, cfg, http, now: NOW });
  assert.equal((await v({})).reason, 'ok');
  assert.equal((await v({ close: '250.00' })).reason, 'price_mismatch');
  const r = await v({ month: '2026-07', trade_date: '2026-07-31', close: '231.01' });
  assert.equal(r.reason, 'refetch_failed');
  assert.equal(r.status, 'pending');
  const { a } = await refetchBoth('AAPL', '2026-08', cfg, { http, now: NOW });
  assert.equal(a.bars.at(-1).date, '2026-08-31');
});
