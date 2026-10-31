// Source A: Nasdaq historical quotes API (ported from RIA src/crawl/nasdaq.mjs; canonical unadjusted close).
import { SourceError, defaultHttp } from './http.mjs';
import { parsePrice, parseVolume, usDateToIso, filterTradingBars, formatUnits } from './parse.mjs';
import { crawlConfig } from '../lib/env.mjs';
import { etDate, isTradingDay, addDays, EXTRA_CLOSURES } from '../market/calendar.mjs';

export const name = 'nasdaq';

function firstTradingOnOrAfter(d, extraClosures) {
  let x = d;
  while (!isTradingDay(x, extraClosures)) x = addDays(x, 1);
  return x;
}
export const HOST = 'api.nasdaq.com';
export const HEADERS = { Accept: 'application/json, text/plain, */*', 'Accept-Language': 'en-US', Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/' };

const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1;

export function buildUrl(symbol, from, to) {
  const limit = Math.min(9999, daysBetween(from, to) + 5);
  return `https://${HOST}/api/quote/${encodeURIComponent(symbol)}/historical?assetclass=stocks&fromdate=${from}&todate=${to}&limit=${limit}`;
}

export function isValidHost(url) {
  try { const u = new URL(url); return u.protocol === 'https:' && u.host === HOST && /^\/api\/quote\/[A-Z.]{1,10}\/historical$/.test(u.pathname); } catch { return false; }
}

/** {symbol, from, to} from a Nasdaq URL, or null. */
export function parseUrl(url) {
  if (!isValidHost(url)) return null;
  const u = new URL(url);
  const from = u.searchParams.get('fromdate'), to = u.searchParams.get('todate');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(to ?? '')) return null;
  return { symbol: u.pathname.split('/')[3], from, to };
}

/** Throws SourceError for empty / non-JSON / schema problems. Exposed for tests. */
export function checkBody(url) {
  return (status, text) => {
    if (!text || !text.trim()) throw new SourceError(name, 'empty', url, 'empty body', { retryable: true });
    let j;
    try { j = JSON.parse(text); } catch { throw new SourceError(name, 'non_json', url, 'non-JSON body', { retryable: true }); }
    if (!j || typeof j !== 'object') throw new SourceError(name, 'schema', url, 'body is not an object');
    const d = j.data;
    if (d === null || d === undefined || !d.totalRecords || !(d.tradesTable?.rows?.length))
      throw new SourceError(name, 'empty', url, `no rows (totalRecords=${d?.totalRecords ?? 'null'})`, { retryable: true });
    if (!Array.isArray(d.tradesTable.rows)) throw new SourceError(name, 'schema', url, 'tradesTable.rows is not an array');
  };
}

/** Parses a Nasdaq body into raw bars (no filtering). */
export function parseBody(text) {
  const rows = JSON.parse(text).data.tradesTable.rows;
  return rows.map((r) => {
    const closeUnits = parsePrice(r?.close);
    return { date: usDateToIso(r?.date) ?? r?.date ?? null, close: closeUnits == null ? null : formatUnits(closeUnits), closeUnits,
      volume: parseVolume(r?.volume), raw: { date: r?.date ?? null, close: r?.close ?? null } };
  });
}

// Measured 2026-10-28: Nasdaq silently truncates ranges that end in the past (SPCX 2026-09-01..30 -> only 09-28..30;
// 2026-06-01..30 -> 0 rows; 2026-06-12..08-31 -> only 07-27..08-31), while every range ending today was complete.
// So in live mode the request always ends today (ET) and rows are filtered back to [from, to]. `truncated` flags a
// response whose oldest row is later than the first requested trading day.
export async function fetchDailyCloses(symbol, from, to, { http = defaultHttp(), retries = 4, extraClosures = EXTRA_CLOSURES, rejectZeroVolume = true,
  extendToToday = http.mode !== 'fixture', now = new Date() } = {}) {
  const today = etDate(now);
  const url = buildUrl(symbol, from, extendToToday && today > to ? today : to);
  const r = await http.get(url, { source: name, headers: HEADERS, timeoutMs: 15000, retries,
    backoffMs: [3000, 6000, 12000, 24000], minIntervalMs: crawlConfig().nasdaqMinIntervalMs, check: checkBody(url) });
  let raw;
  try { raw = parseBody(r.text); } catch (e) { throw new SourceError(name, 'schema', url, e.message); }
  const { bars, dropped } = filterTradingBars(raw, null, { from, to, extraClosures, rejectZeroVolume });
  const oldest = raw.map((b) => b.date).filter(Boolean).sort()[0] ?? null;
  return { source: name, url, fetchedAt: r.fetchedAt, bars, dropped: dropped.filter((d) => d.reason !== 'out_of_range'), rawCount: raw.length,
    oldest, truncated: !!oldest && oldest > firstTradingOnOrAfter(from, extraClosures) };
}

