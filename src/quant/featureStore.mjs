// compute_features (PLAN §3): runs the pure, deterministic quant/features.mjs over verified month_end_prices only and stores
// one quant_features row per (ticker, month) with features_sha256 and code_version. Idempotent: an identical sha + code
// version leaves the row untouched; a changed input (e.g. a newly verified peer close) replaces it (REPLACE = DELETE+INSERT,
// the only DELETE grant stock_app has). Also used read-only (loadFeatureInputs) by get_research_pack and npm run context.
import { clean } from '../lib/repo.mjs';
import { computeFeatures, featuresRow, FEATURES_CODE_VERSION } from './features.mjs';

const rows = async (db, sql, args = []) => clean((await db.query(sql, args))[0]);

/** Companies plus every verified close, grouped by ticker. */
export async function loadFeatureInputs(db) {
  const companies = (await rows(db, 'SELECT ticker, peers, role, active, listed_on FROM companies ORDER BY ticker')).map((c) => ({
    ...c, peers: typeof c.peers === 'string' ? JSON.parse(c.peers) : (c.peers ?? []) }));
  const prices = await rows(db, 'SELECT ticker, month, close FROM month_end_prices ORDER BY ticker, month');
  const byTicker = new Map(companies.map((c) => [c.ticker, []]));
  for (const p of prices) byTicker.get(p.ticker)?.push({ month: p.month, close: p.close });
  return { companies, byTicker };
}

/** Features for one ticker/month from loaded inputs (month defaults to the latest verified month). */
export function featuresFor(inputs, ticker, month = null) {
  const co = inputs.companies.find((c) => c.ticker === ticker);
  if (!co) return { error: 'unknown_ticker', ticker, month };
  const own = inputs.byTicker.get(ticker) ?? [];
  const m = month ?? own.map((r) => r.month).sort().pop() ?? null;
  if (!m) return { error: 'no_verified_close', ticker, month: null };
  const bench = inputs.companies.find((c) => c.role === 'benchmark' && c.ticker !== ticker);
  return computeFeatures({
    ticker, month: m, rows: own,
    peers: (co.peers ?? []).filter((p) => p !== ticker && inputs.byTicker.has(p)).map((p) => ({ ticker: p, rows: inputs.byTicker.get(p) })),
    benchmark: bench ? { ticker: bench.ticker, rows: inputs.byTicker.get(bench.ticker) ?? [] } : null,
  });
}

/**
 * @param args {ticker?, month?}: no ticker = every active target company; no month = each ticker's latest verified month.
 * @returns {code_version, results:[{ticker, month, status: inserted|replaced|unchanged|skipped, reason?, features_sha256, features}]}
 */
export async function computeFeaturesTool(db, { ticker, month } = {}) {
  const inputs = await loadFeatureInputs(db);
  const tickers = ticker ? [ticker] : inputs.companies.filter((c) => c.active && c.role === 'target').map((c) => c.ticker);
  const results = [];
  for (const t of tickers) {
    const r = featuresFor(inputs, t, month ?? null);
    if (r.error) { results.push({ ticker: t, month: r.month ?? month ?? null, status: 'skipped', reason: r.error }); continue; }
    const f = r.features;
    const [prev] = await rows(db, 'SELECT features_sha256, code_version FROM quant_features WHERE ticker = ? AND month = ?', [t, f.month]);
    let status;
    if (prev && prev.features_sha256 === r.features_sha256 && prev.code_version === FEATURES_CODE_VERSION) status = 'unchanged';
    else {
      await db.query('REPLACE INTO quant_features SET ?', [featuresRow(f, r.features_sha256)]);
      status = prev ? 'replaced' : 'inserted';
    }
    results.push({ ticker: t, month: f.month, status, ...(prev && status === 'replaced' ? { previous_sha256: prev.features_sha256 } : {}),
      features_sha256: r.features_sha256, features: f });
  }
  const skipped = results.filter((x) => x.status === 'skipped');
  return { code_version: FEATURES_CODE_VERSION, results,
    status: skipped.length === results.length && results.length ? 'rejected' : 'ok', reason: skipped.length === results.length && results.length ? skipped[0].reason : 'ok' };
}
