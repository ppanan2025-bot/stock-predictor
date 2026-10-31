// Source B: CNBC harmony bars API (ported from RIA src/crawl/cnbc.mjs). Has deep history; emits weekend / zero-volume bars that must be dropped.
import { SourceError, defaultHttp } from './http.mjs';
import { parsePrice, parseVolume, filterTradingBars, formatUnits } from './parse.mjs';
import { EXTRA_CLOSURES } from '../market/calendar.mjs';

export const name = 'cnbc';
export const HOST = 'ts-api.cnbc.com';
const compact = (d) => d.replaceAll('-', '');

// The end timestamp is exclusive: `{to}000000` omits the bar dated `to` (measured 2026-10-28), so we end at `{to}235959`.
export function buildUrl(symbol, from, to, { basis = 'adjusted' } = {}) {
  return `https://${HOST}/harmony/app/bars/${encodeURIComponent(symbol)}/1D/${compact(from)}000000/${compact(to)}235959/${basis}/EST5EDT.json`;
}

const PATH_RE = /^\/harmony\/app\/bars\/([A-Z.]{1,10})\/1D\/(\d{8})000000\/(\d{8})(000000|235959)\/(adjusted|unadjusted)\/EST5EDT\.json$/;
export function isValidHost(url) {
  try { const u = new URL(url); return u.protocol === 'https:' && u.host === HOST && PATH_RE.test(u.pathname); } catch { return false; }
}

export function parseUrl(url) {
  if (!isValidHost(url)) return null;
  const m = PATH_RE.exec(new URL(url).pathname);
  const iso = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  const end = iso(m[3]);
  // `{d}000000` is exclusive, so the last day actually covered is the day before.
  const to = m[4] === '000000' ? new Date(Date.parse(`${end}T00:00:00Z`) - 86400000).toISOString().slice(0, 10) : end;
  return { symbol: m[1], from: iso(m[2]), to, basis: m[5] };
}

export function checkBody(url) {
  return (status, text) => {
    if (!text || !text.trim()) throw new SourceError(name, 'empty', url, 'empty body', { retryable: true });
    let j;
    try { j = JSON.parse(text); } catch { throw new SourceError(name, 'non_json', url, 'non-JSON body', { retryable: true }); }
    const bars = j?.barData?.priceBars;
    if (bars === null || bars === undefined) throw new SourceError(name, 'empty', url, 'no barData.priceBars');
    if (!Array.isArray(bars)) throw new SourceError(name, 'schema', url, 'priceBars is not an array');
    if (!bars.length) throw new SourceError(name, 'empty', url, 'priceBars is empty');
  };
}

export function parseBody(text) {
  return JSON.parse(text).barData.priceBars.map((b) => {
    const t = String(b?.tradeTime ?? '');
    const date = /^\d{14}$/.test(t) ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}` : null;
    const closeUnits = parsePrice(b?.close);
    return { date, close: closeUnits == null ? null : formatUnits(closeUnits), closeUnits, volume: parseVolume(b?.volume),
      raw: { date: b?.tradeTime ?? null, close: b?.close ?? null } };
  });
}

export async function fetchDailyCloses(symbol, from, to, { http = defaultHttp(), basis = 'adjusted', retries = 3, extraClosures = EXTRA_CLOSURES, rejectZeroVolume = true } = {}) {
  const url = buildUrl(symbol, from, to, { basis });
  const r = await http.get(url, { source: name, timeoutMs: 15000, retries, backoffMs: [1000, 2000, 4000], minIntervalMs: 500, check: checkBody(url) });
  let raw;
  try { raw = parseBody(r.text); } catch (e) { throw new SourceError(name, 'schema', url, e.message); }
  const { bars, dropped } = filterTradingBars(raw, null, { from, to, extraClosures, rejectZeroVolume });
  return { source: name, url, fetchedAt: r.fetchedAt, bars, dropped, rawCount: raw.length };
}
