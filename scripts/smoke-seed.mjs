#!/usr/bin/env node
// npm run smoke helper: resets the THROWAWAY test DB (127.0.0.1:3320, report_host sp-test-db only; refuses anything else) and seeds a
// minimal clean fixture: AAPL verified month-end closes 2025-06..2026-09 (16 months -> a real baseline for 2026-10) and SPCX
// 2026-08..2026-09 (2 months -> baseline null, short history). Used so the smoke's baseline step proves something and the audit
// step can be gated on a clean state.
import { resetTestDb, appQuery } from '../test/helpers/testdb.mjs';
import { insertVerifiedPrice } from '../test/helpers/fixtures.mjs';
import { lastTradingDay, monthRange } from '../src/market/calendar.mjs';

await resetTestDb(); // throws unless the connection is the marked test DB
const seed = async (ticker, from, to, f) => {
  for (const [i, m] of monthRange(from, to).entries()) {
    const close = f(i).toFixed(4);
    await insertVerifiedPrice(appQuery, { ticker, month: m, trade_date: lastTradingDay(m), close, b: close });
  }
};
await seed('AAPL', '2025-06', '2026-09', (i) => 200 * Math.exp(0.01 * i + 0.05 * Math.sin(i * 1.3)));
await seed('SPCX', '2026-08', '2026-09', (i) => 150 + 5 * i);
console.log('[smoke-seed] test DB reset; seeded AAPL 2025-06..2026-09 (16 closes), SPCX 2026-08..2026-09 (2 closes)');
