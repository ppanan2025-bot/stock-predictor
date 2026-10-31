// Independent re-fetch of Nasdaq (A) and CNBC (B) for one submission (used by the MCP server, the PreToolUse hook, dry-runs).
// URLs are always built here, never taken from the submission. Ported from RIA src/verify/refetch.mjs (cachedFetch).
import { nasdaq, cnbc } from '../crawl/index.mjs';
import { lastDayOfMonth, lastCompleteMonth } from '../market/calendar.mjs';
import { checkPriceStatic, decidePrice } from './priceRule.mjs';

const CACHE_MS = 15 * 60 * 1000;

/** Re-fetch cache (per process): a miss fetches month-01 .. end of the last complete month, so later months of a batch hit. */
export const createPriceCache = () => new Map();

async function cachedFetch(mod, ticker, month, cfg, opt, cache, now) {
  const from = `${month}-01`, monthEnd = lastDayOfMonth(month);
  if (!cache || opt.http?.mode === 'fixture') return mod.fetchDailyCloses(ticker, from, monthEnd, opt);
  const key = `${mod.name}|${ticker}`;
  const hit = cache.get(key);
  if (hit && hit.from <= from && hit.to >= monthEnd && Date.now() - hit.at < CACHE_MS) return hit.result;
  const lc = lastCompleteMonth(now, { settleMinutes: cfg.settle_minutes_after_close, extraClosures: cfg.extra_closures });
  const to = lastDayOfMonth(lc > month ? lc : month);
  const result = await mod.fetchDailyCloses(ticker, from, to, opt);
  cache.set(key, { from, to, at: Date.now(), result });
  return result;
}

/** Fetches both sources; errors are returned as {error} so the rule can classify them. */
export async function refetchBoth(ticker, month, cfg, { http, now = new Date(), cache = null, retries = 2 } = {}) {
  const opt = { http, extraClosures: cfg.extra_closures, rejectZeroVolume: cfg.reject_zero_volume };
  const wrap = (p) => p.then((r) => r, (error) => ({ error }));
  const [a, b] = await Promise.all([
    wrap(cachedFetch(nasdaq, ticker, month, cfg, { ...opt, retries, now }, cache, now)),
    wrap(cachedFetch(cnbc, ticker, month, cfg, { ...opt, basis: cfg.cnbc_basis, retries }, cache, now)),
  ]);
  // a truncated (stale) cached response must not stick
  if (cache) for (const [mod, r] of [[nasdaq, a], [cnbc, b]]) if (r?.error || (r?.oldest && r.oldest > `${month}-31`)) cache.delete(`${mod.name}|${ticker}`);
  return { a, b };
}

/** Full price verification of one submission (static checks, then live A+B). `cfg` is the verification config's price section. */
export async function verifyPrice(sub, { companies, cfg, http, now = new Date(), cache = null, retries = 2 }) {
  const s = checkPriceStatic(sub, { companies, cfg, now });
  if (s) return s;
  const { a, b } = await refetchBoth(sub.ticker, sub.month, cfg, { http, now, cache, retries });
  return decidePrice(sub, a, b, cfg, now);
}
