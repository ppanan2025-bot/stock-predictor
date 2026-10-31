import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastTradingDay, nyseHolidays, isTradingDay, monthComplete, lastCompleteMonth, zonedTime, etIso, tradingDaysSince, addTradingDays } from '../src/market/calendar.mjs';

test('lastTradingDay per PLAN §10', () => {
  assert.equal(lastTradingDay('2026-10'), '2026-10-30');
  assert.equal(lastTradingDay('2025-11'), '2025-11-28');
  assert.equal(lastTradingDay('2024-03'), '2024-03-28'); // Good Friday 2024-03-29
  assert.equal(lastTradingDay('2026-05'), '2026-05-29');
  assert.equal(lastTradingDay('2026-01'), '2026-01-30');
  assert.equal(lastTradingDay('2027-12'), '2027-12-31');
  assert.equal(lastTradingDay('2025-01', ['2025-01-31']), '2025-01-30'); // extra closure
});
test('holiday rules 2024-2027', () => {
  const h = (y) => [...nyseHolidays(y).keys()];
  assert.deepEqual(h(2024), ['2024-01-01', '2024-01-15', '2024-02-19', '2024-03-29', '2024-05-27', '2024-06-19', '2024-07-04', '2024-09-02', '2024-11-28', '2024-12-25']);
  assert.deepEqual(h(2025), ['2025-01-01', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25']);
  assert.ok(nyseHolidays(2026).has('2026-07-03')); // July 4 on Saturday -> Friday
  assert.ok(nyseHolidays(2027).has('2027-12-24')); // Christmas on Saturday -> Friday
  assert.ok(!nyseHolidays(2022).has('2021-12-31')); // Saturday Jan 1 2022 not observed on Dec 31
  assert.ok(nyseHolidays(2027).has('2027-06-18')); // Juneteenth Saturday -> Friday
  assert.equal(isTradingDay('2026-09-26'), false);
  assert.equal(isTradingDay('2026-09-28'), true);
});
test('monthComplete gates on 16:00 ET + 90 min', () => {
  assert.equal(monthComplete('2026-10', new Date('2026-10-31T02:00:00Z')), true); // 22:00 ET Oct 30
  assert.equal(monthComplete('2026-10', new Date('2026-10-30T19:00:00Z')), false); // 15:00 ET
  assert.equal(monthComplete('2026-10', new Date('2026-10-30T21:29:00Z')), false); // 17:29 ET
  assert.equal(monthComplete('2026-10', new Date('2026-10-30T21:30:00Z')), true);
  assert.equal(lastCompleteMonth(new Date('2026-10-28T12:00:00Z')), '2026-09');
});
test('ET helpers handle DST', () => {
  assert.equal(zonedTime('2026-07-15', 16, 0).toISOString(), '2026-07-15T20:00:00.000Z');
  assert.equal(zonedTime('2026-01-15', 16, 0).toISOString(), '2026-01-15T21:00:00.000Z');
  assert.equal(etIso(new Date('2026-10-30T21:30:00Z')), '2026-10-30T17:30:00-04:00');
  assert.equal(tradingDaysSince('2026-09-30', new Date('2026-10-02T21:00:00Z')), 2); // Fri 17:00 ET: Oct 1 + Oct 2 closed
  assert.equal(addTradingDays('2026-11-25', 1), '2026-11-27');
});

test('BUG-008: tradingDaysSince does not count today\'s session before its 16:00 ET close', () => {
  // Month ends Fri 2026-10-30; Tue 2026-11-03 09:00 ET: only Monday's session has closed.
  assert.equal(tradingDaysSince('2026-10-30', new Date('2026-11-03T14:00:00Z')), 1);
  assert.equal(tradingDaysSince('2026-10-30', new Date('2026-11-03T20:59:00Z')), 1); // 15:59 ET
  assert.equal(tradingDaysSince('2026-10-30', new Date('2026-11-03T21:00:00Z')), 2); // 16:00 ET
  assert.equal(tradingDaysSince('2026-09-30', new Date('2026-10-02T15:00:00Z')), 1); // Fri 11:00 ET
});

test('last trading day of every month 2024-2027 is a trading weekday in the last week of the month', () => {
  for (let y = 2024; y <= 2027; y++) for (let m = 1; m <= 12; m++) {
    const month = `${y}-${String(m).padStart(2, '0')}`;
    const d = lastTradingDay(month);
    assert.ok(d.startsWith(month), month);
    assert.ok(isTradingDay(d), `${month} ${d}`);
    assert.ok(Number(d.slice(8)) >= 22, `${month} ${d}`);
  }
  assert.equal(lastTradingDay('2026-06'), '2026-06-30'); // SPCX listing month
  assert.equal(lastTradingDay('2026-11'), '2026-11-30'); // first target month
  assert.equal(lastTradingDay('2026-12'), '2026-12-31');
  assert.equal(lastTradingDay('2027-04'), '2027-04-30');
});

test('Validator P1 #4: config price.extra_closures feeds the calendar (2025-01-09 national day of mourning)', async () => {
  const cal = await import('../src/market/calendar.mjs');
  assert.ok(cal.EXTRA_CLOSURES.includes('2025-01-09'));
  assert.equal(cal.isTradingDay('2025-01-09'), false);
  assert.equal(cal.isTradingDay('2025-01-09', []), true);
  assert.deepEqual(cal.loadExtraClosures('/nonexistent/verification.json'), []);
});

test('Validator P1 #2: db/init/06-closures.sql equals the calendar-generated seed (2023-2027)', async () => {
  const fs = await import('node:fs');
  const { closuresSql } = await import('../scripts/gen-closures.mjs');
  const file = fs.readFileSync(new URL('../db/init/06-closures.sql', import.meta.url), 'utf8');
  assert.equal(file, closuresSql());
  for (const d of ['2024-03-29', '2025-01-09', '2026-11-26', '2027-03-26']) assert.match(file, new RegExp(`'${d}'`));
});
