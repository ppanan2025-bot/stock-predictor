// Price parsing in integer 1/10000-dollar units (never floats) and trading-bar filtering. Ported verbatim from RIA src/crawl/parse.mjs.
import { isWeekend, isHoliday, EXTRA_CLOSURES } from '../market/calendar.mjs';

/** '$1,148.58' -> 11485800; 'N/A', '--', '' -> null. Rounds half-up beyond 4 decimals using string arithmetic. */
export function parsePrice(str) {
  if (str === null || str === undefined) return null;
  if (typeof str === 'number') { if (!Number.isFinite(str)) return null; str = String(str); }
  if (typeof str !== 'string') return null;
  const s = str.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [intPart, frac = ''] = s.split('.');
  let f4 = (frac + '0000').slice(0, 4);
  let units = BigInt(intPart) * 10000n + BigInt(f4);
  if (frac.length > 4 && frac[4] >= '5') units += 1n;
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(units);
}

/** 1485800 -> '148.5800' */
export function formatUnits(u) {
  if (!Number.isInteger(u) || u < 0) throw new TypeError(`bad units ${u}`);
  const s = String(u).padStart(5, '0');
  return `${s.slice(0, -4)}.${s.slice(-4)}`;
}

export const unitsToNumber = (u) => (u == null ? null : u / 10000);

/** '12,345,678' -> 12345678; 'N/A' -> null */
export function parseVolume(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  const s = String(v).replace(/[,\s]/g, '');
  return /^\d+$/.test(s) ? Number(s) : null;
}

/** 'MM/DD/YYYY' -> 'YYYY-MM-DD' or null */
export function usDateToIso(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const iso = `${m[3]}-${m[1]}-${m[2]}`;
  return isValidIsoDate(iso) ? iso : null;
}

export function isValidIsoDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso ?? '')) return false;
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Keep only real trading bars inside `month` (or inside [from,to] when month is null). Bars must carry
 * {date, closeUnits, volume}. Returns {bars (sorted asc, deduped by date), dropped:[{date, reason}]}.
 */
export function filterTradingBars(bars, month, { extraClosures = EXTRA_CLOSURES, rejectZeroVolume = true, from = null, to = null } = {}) {
  const kept = new Map();
  const dropped = [];
  for (const b of bars ?? []) {
    const date = b?.date;
    if (!isValidIsoDate(date)) { dropped.push({ date: date ?? null, reason: 'unparseable' }); continue; }
    if (month && date.slice(0, 7) !== month) { dropped.push({ date, reason: 'out_of_range' }); continue; }
    if ((from && date < from) || (to && date > to)) { dropped.push({ date, reason: 'out_of_range' }); continue; }
    if (isWeekend(date)) { dropped.push({ date, reason: 'weekend' }); continue; }
    if (rejectZeroVolume && b.volume === 0) { dropped.push({ date, reason: 'zero_volume' }); continue; }
    if (isHoliday(date, extraClosures)) { dropped.push({ date, reason: 'holiday' }); continue; }
    if (!Number.isInteger(b.closeUnits) || b.closeUnits <= 0) { dropped.push({ date, reason: 'unparseable' }); continue; }
    if (kept.has(date)) { dropped.push({ date, reason: 'duplicate' }); continue; }
    kept.set(date, b);
  }
  return { bars: [...kept.values()].sort((a, b) => a.date.localeCompare(b.date)), dropped };
}

/** Last valid trading bar of `month` or null. */
export function lastBarOfMonth(bars, month, opts) {
  const { bars: kept, dropped } = filterTradingBars(bars, month, opts);
  return { bar: kept.at(-1) ?? null, kept, dropped };
}
