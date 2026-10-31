// THE month-end price rule (PLAN §4.2). Pure functions shared by the MCP server (ingest_price), the PreToolUse hook
// (verify-price-ingest), ingest/backfill dry-runs and tests. Prices are compared in integer 1/10000-dollar units.
// Adapted from RIA src/verify/rule.mjs: here the submitted close is checked against an independent live re-fetch of Nasdaq (A)
// and CNBC (B); the stored close is always Nasdaq's.
import { parsePrice, formatUnits, filterTradingBars } from '../crawl/parse.mjs';
import { lastTradingDay, monthComplete, monthReadyAt, tradingDaysSince, isTradingDay } from '../market/calendar.mjs';
import { priceStatusFor } from './reasons.mjs';

export const result = (reason, detail = {}, extra = {}) => ({ ok: reason === 'ok', status: priceStatusFor(reason), reason, detail, ...extra });
const calOpts = (cfg) => ({ settleMinutes: cfg.settle_minutes_after_close, extraClosures: cfg.extra_closures });

/**
 * Checks that need no network: known active ticker, listed, month complete, trade_date == last NYSE trading day, close > 0.
 * `companies` is [{ticker, listed_on, active}]. Returns null when the submission may be re-fetched, else a result.
 */
export function checkPriceStatic(sub, { companies, cfg, now = new Date() }) {
  const co = companies.find((c) => c.ticker === sub.ticker);
  if (!co || co.active === false || co.active === 0) return result('unknown_ticker', { ticker: sub.ticker });
  const listedMonth = String(co.listed_on).slice(0, 7);
  if (sub.month < listedMonth) return result('pre_listing', { listed_on: String(co.listed_on).slice(0, 10) });
  const units = parsePrice(sub.close);
  if (units == null || units <= 0) return result('bad_schema', { message: `close must be a positive decimal (got ${sub.close})` });
  const expected = lastTradingDay(sub.month, cfg.extra_closures);
  if (sub.trade_date !== expected) {
    return result('not_month_end', { trade_date: sub.trade_date, expected_date: expected,
      ...(sub.trade_date?.slice(0, 7) === sub.month && !isTradingDay(sub.trade_date, cfg.extra_closures) ? { note: 'not a trading day' } : {}) });
  }
  if (!monthComplete(sub.month, now, calOpts(cfg)))
    return result('month_incomplete', { ready_at: new Date(monthReadyAt(sub.month, calOpts(cfg))).toISOString() });
  return null;
}

/**
 * Decision from the two re-fetched bar lists (fetchDailyCloses results). `a`/`b` are {url, fetchedAt, bars} or {error}.
 * Requires both sources on trade_date, |A-B| <= tolerance and |submitted - A| <= submitted tolerance.
 */
export function decidePrice(sub, a, b, cfg, now = new Date()) {
  if (a?.error || b?.error) {
    const e = a?.error ?? b?.error;
    return result(e?.code === 'rate_limited' ? 'rate_limited' : 'refetch_failed',
      { source: a?.error ? 'nasdaq' : 'cnbc', code: e?.code ?? null, message: String(e?.message ?? e).slice(0, 200) });
  }
  for (const [side, res] of [['nasdaq', a], ['cnbc', b]]) {
    if (res.oldest && res.oldest > `${sub.month}-31` && !res.bars.some((x) => x.date.startsWith(sub.month)))
      return result('refetch_failed', { source: side, code: 'truncated', message: `${side} response starts ${res.oldest}, after ${sub.month}`, url: res.url });
  }
  const opt = { extraClosures: cfg.extra_closures, rejectZeroVolume: cfg.reject_zero_volume };
  const fa = filterTradingBars(a.bars, sub.month, opt).bars.at(-1) ?? null;
  const fb = filterTradingBars(b.bars, sub.month, opt).bars.at(-1) ?? null;
  const expected = lastTradingDay(sub.month, cfg.extra_closures);
  const inGrace = tradingDaysSince(expected, now, cfg.extra_closures) < cfg.stale_grace_trading_days;
  const evidence = {
    expected_date: expected,
    source_a: { name: 'nasdaq', url: a.url, date: fa?.date ?? null, close: fa?.close ?? null, fetched_at: a.fetchedAt },
    source_b: { name: 'cnbc', url: b.url, date: fb?.date ?? null, close: fb?.close ?? null, fetched_at: b.fetchedAt },
  };
  if (!fa) return result(inGrace ? 'source_stale' : 'source_a_missing', evidence);
  if (!fb) return result(inGrace ? 'source_stale' : 'source_b_missing', evidence);
  if (fa.date !== expected || fb.date !== expected) return result(inGrace ? 'source_stale' : 'date_mismatch', evidence);
  const diff = Math.abs(fa.closeUnits - fb.closeUnits);
  const detail = { ...evidence, abs_diff: formatUnits(diff), tolerance_abs: formatUnits(cfg.toleranceUnits) };
  if (diff > cfg.toleranceUnits) return result('price_mismatch', { ...detail, message: `Nasdaq ${fa.close} vs CNBC ${fb.close} differ by more than the tolerance` });
  const subUnits = parsePrice(sub.close);
  const subDiff = Math.abs(subUnits - fa.closeUnits);
  if (subDiff > cfg.submittedToleranceUnits)
    return result('price_mismatch', { ...detail, submitted_close: formatUnits(subUnits), submitted_diff: formatUnits(subDiff),
      message: `submitted close ${formatUnits(subUnits)} != Nasdaq ${fa.close} (re-fetched) beyond ${formatUnits(cfg.submittedToleranceUnits)}` });
  return result('ok', { ...detail, submitted_close: formatUnits(subUnits), submitted_diff: formatUnits(subDiff) }, {
    verified: {
      ticker: sub.ticker, month: sub.month, trade_date: expected, close: fa.close,
      source_a_url: a.url, source_a_close: fa.close, source_a_fetched_at: a.fetchedAt,
      source_b_url: b.url, source_b_close: fb.close, source_b_fetched_at: b.fetchedAt,
      abs_diff: formatUnits(diff), tolerance_abs: formatUnits(cfg.toleranceUnits),
    },
  });
}
