// NYSE trading calendar (rule-based holidays) and America/New_York time helpers (ported from regular-investor-agent).
// Dates are 'YYYY-MM-DD' strings; weekday math is done on the calendar date (UTC midnight), never on timestamps.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TZ = 'America/New_York';

/**
 * One-off NYSE closures that the holiday rules cannot derive (e.g. 2025-01-09, national day of mourning), from
 * config/verification.json price.extra_closures (Validator P1 #4). Every calendar function uses them by default.
 * A missing/unreadable config yields [] here; the verification config loader (src/verify/config.mjs) fails closed instead.
 */
export function loadExtraClosures(file = fileURLToPath(new URL('../../config/verification.json', import.meta.url))) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'))?.price?.extra_closures;
    return Array.isArray(v) ? v.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) : [];
  } catch { return []; }
}
export const EXTRA_CLOSURES = Object.freeze(loadExtraClosures());

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const toUtc = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const fromUtc = (dt) => iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());

export const weekday = (s) => toUtc(s).getUTCDay(); // 0 Sun .. 6 Sat
export const isWeekend = (s) => { const w = weekday(s); return w === 0 || w === 6; };
export function addDays(s, n) { const dt = toUtc(s); dt.setUTCDate(dt.getUTCDate() + n); return fromUtc(dt); }
export function lastDayOfMonth(month) { const [y, m] = month.split('-').map(Number); return fromUtc(new Date(Date.UTC(y, m, 0))); }
export function nextMonth(month) { const [y, m] = month.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`; }
export function prevMonth(month) { const [y, m] = month.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`; }
export function monthRange(from, to) { const out = []; for (let m = from; m <= to; m = nextMonth(m)) out.push(m); return out; }

function nthWeekday(y, m, wd, n) { // n-th (1-based) weekday wd in month m
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  return iso(y, m, 1 + ((wd - first + 7) % 7) + (n - 1) * 7);
}
function lastWeekdayOf(y, m, wd) {
  const last = new Date(Date.UTC(y, m, 0));
  const diff = (last.getUTCDay() - wd + 7) % 7;
  return iso(y, m, last.getUTCDate() - diff);
}
function easter(y) { // anonymous Gregorian computus
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(y, month, day);
}
function observed(s) { const w = weekday(s); return w === 6 ? addDays(s, -1) : w === 0 ? addDays(s, 1) : s; }

const cache = new Map();
/** All full-day NYSE closures (rule holidays + extra closures) in [fromYear, toYear], sorted: [{date, name}]. Seeds nyse_closures. */
export function closuresBetween(fromYear, toYear, extraClosures = EXTRA_CLOSURES) {
  const out = [];
  for (let y = fromYear; y <= toYear; y++) {
    for (const [date, name] of nyseHolidays(y)) out.push({ date, name });
    for (const d of extraClosures) if (d.startsWith(String(y)) && !nyseHolidays(y).has(d)) out.push({ date: d, name: 'Special closure' });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Map date -> holiday name for NYSE full-day closures in `year`. */
export function nyseHolidays(year) {
  if (cache.has(year)) return cache.get(year);
  const h = new Map();
  const add = (d, name) => { if (d.startsWith(String(year))) h.set(d, name); };
  const ny = iso(year, 1, 1);
  if (weekday(ny) === 0) add(iso(year, 1, 2), "New Year's Day (observed)");
  else if (weekday(ny) !== 6) add(ny, "New Year's Day"); // Saturday Jan 1 is not observed on Dec 31
  add(nthWeekday(year, 1, 1, 3), 'Martin Luther King Jr. Day');
  add(nthWeekday(year, 2, 1, 3), "Washington's Birthday");
  add(addDays(easter(year), -2), 'Good Friday');
  add(lastWeekdayOf(year, 5, 1), 'Memorial Day');
  if (year >= 2022) add(observed(iso(year, 6, 19)), 'Juneteenth');
  add(observed(iso(year, 7, 4)), 'Independence Day');
  add(nthWeekday(year, 9, 1, 1), 'Labor Day');
  add(nthWeekday(year, 11, 4, 4), 'Thanksgiving Day');
  add(observed(iso(year, 12, 25)), 'Christmas Day');
  cache.set(year, h);
  return h;
}

export function isHoliday(s, extraClosures = EXTRA_CLOSURES) {
  return nyseHolidays(Number(s.slice(0, 4))).has(s) || extraClosures.includes(s);
}
export function isTradingDay(s, extraClosures = EXTRA_CLOSURES) { return !isWeekend(s) && !isHoliday(s, extraClosures); }

export function lastTradingDay(month, extraClosures = EXTRA_CLOSURES) {
  let d = lastDayOfMonth(month);
  while (!isTradingDay(d, extraClosures)) d = addDays(d, -1);
  return d;
}

export function addTradingDays(s, n, extraClosures = EXTRA_CLOSURES) {
  let d = s, k = 0;
  while (k < n) { d = addDays(d, 1); if (isTradingDay(d, extraClosures)) k++; }
  return d;
}

// ---- America/New_York wall-clock helpers ----
const fmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
export function etParts(instant = new Date()) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(instant)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute), second: Number(p.second) };
}
export const etDate = (instant = new Date()) => etParts(instant).date;

/** Offset of `tz` from UTC in minutes at `instant`. */
export function tzOffsetMinutes(instant, tz = TZ) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(instant)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(new Date(instant).getTime() / 1000) * 1000) / 60000);
}

/** The UTC instant of wall time `date hh:mm` in `tz`. */
export function zonedTime(date, hh, mm = 0, tz = TZ) {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let off = tzOffsetMinutes(guess, tz);
  let t = guess - off * 60000;
  const off2 = tzOffsetMinutes(t, tz);
  if (off2 !== off) t = guess - off2 * 60000;
  return new Date(t);
}

/** ISO string with the ET offset, e.g. '2026-10-30T17:30:00-04:00'. */
export function etIso(instant) {
  const p = etParts(instant);
  const off = tzOffsetMinutes(instant);
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  return `${p.date}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** Instant after which the month's close is considered settled (16:00 ET + settle minutes on the last trading day). */
export function monthReadyAt(month, { settleMinutes = 90, extraClosures = EXTRA_CLOSURES } = {}) {
  const d = lastTradingDay(month, extraClosures);
  return zonedTime(d, 16, 0) .getTime() + settleMinutes * 60000;
}

export function monthComplete(month, now = new Date(), { settleMinutes = 90, extraClosures = EXTRA_CLOSURES } = {}) {
  return new Date(now).getTime() >= monthReadyAt(month, { settleMinutes, extraClosures });
}

/** Latest month whose close is settled at `now`. */
export function lastCompleteMonth(now = new Date(), opts = {}) {
  let m = etDate(now).slice(0, 7);
  while (!monthComplete(m, now, opts)) m = prevMonth(m);
  return m;
}

/**
 * Number of trading sessions strictly after `from` that have CLOSED by `now`: trading days up to the ET date of `now`,
 * where today's session counts only once its 16:00 ET close has passed (BUG-008).
 */
export function tradingDaysSince(from, now = new Date(), extraClosures = EXTRA_CLOSURES) {
  const today = etDate(now);
  const todayClosed = new Date(now).getTime() >= zonedTime(today, 16, 0).getTime();
  let n = 0;
  for (let d = addDays(from, 1); d <= today; d = addDays(d, 1)) {
    if (d === today && !todayClosed) break;
    if (isTradingDay(d, extraClosures)) n++;
  }
  return n;
}
