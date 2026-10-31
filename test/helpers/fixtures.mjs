// Row builders for integration tests (test DB only). Values satisfy the triggers unless a test overrides them.
import crypto from 'node:crypto';
export const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export const nasdaqUrl = (t, from, to) => `https://api.nasdaq.com/api/quote/${t}/historical?assetclass=stocks&fromdate=${from}&limit=30&todate=${to}`;
export const cnbcUrl = (t, from, to) => `https://ts-api.cnbc.com/harmony/app/bars/${t}/1D/${from.replaceAll('-', '')}000000/${to.replaceAll('-', '')}000000/adjusted/EST5EDT.json`;

export async function insertVerifiedPrice(q, { ticker = 'AAPL', month = '2026-09', trade_date = '2026-09-30', close = '254.6300', b = '254.6350',
  fetched = null, overrides = {} } = {}) {
  const sub = await q('INSERT INTO price_submissions (ticker, month, trade_date, close, origin, status, reason) VALUES (?,?,?,?,?,?,?)',
    [ticker, month, trade_date, close, 'backfill', 'verified', 'ok']);
  const f = fetched ?? `${trade_date} 23:00:00`;
  const row = { ticker, month, trade_date, close, submission_id: sub.insertId,
    source_a_url: nasdaqUrl(ticker, `${month}-01`, trade_date), source_a_close: close, source_a_fetched_at: f,
    source_b_url: cnbcUrl(ticker, `${month}-01`, trade_date), source_b_close: b, source_b_fetched_at: f,
    abs_diff: Math.abs(Number(close) - Number(b)).toFixed(4), tolerance_abs: '0.0100', ...overrides };
  const res = await q('INSERT INTO month_end_prices SET ?', [row]);
  return { submission_id: sub.insertId, price_id: res.insertId, row };
}

export async function insertSource(q, { status = 'verified', url = `https://www.reuters.com/a/${crypto.randomUUID()}`, kind = 'news', withSha = true } = {}) {
  const res = await q('INSERT INTO sources (url_canonical, url_original, domain, tier, kind, title_fetched, http_status, fetched_at, content_sha256, text_len, verification_status) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [url, url, new URL(url).hostname, 'high', kind, 'Apple reports record quarter', 200, '2026-10-01 00:00:00', withSha ? sha(url) : null, 1200, status]);
  return res.insertId;
}

export const EXCERPT = 'Apple today announced financial results for its fiscal 2026 fourth quarter ended September 27, 2026.';

export async function insertPack(q, { ticker = 'AAPL', as_of = '2026-08', target = '2026-09' } = {}) {
  const pack = { ticker, as_of_month: as_of };
  return (await q('INSERT INTO research_packs (ticker, as_of_month, target_month, pack_json, pack_sha256) VALUES (?,?,?,?,?)',
    [ticker, as_of, target, JSON.stringify(pack), sha(JSON.stringify(pack))])).insertId;
}

export function predictionRow(pack_id, o = {}) {
  return { ticker: 'AAPL', as_of_month: '2026-08', target_month: '2026-09', version: 1, pack_id, baseline_json: JSON.stringify({ p_up: 0.55 }),
    baseline_p_up: '0.5500', baseline_mu: '0.010000', overlay_p_adj: '0.0200', overlay_mu_adj: '0.000000', direction: 'up', p_up: '0.5700',
    exp_return_low: '-0.050000', exp_return_mid: '0.010000', exp_return_high: '0.070000', confidence: '0.300', confidence_label: 'low',
    report_path: 'reports/AAPL/2026-09-prediction.md', report_sha256: sha('report v1'), status: 'draft', ...o };
}

export function reviewRow(prediction_id, perspective, o = {}) {
  return { prediction_id, perspective, report_sha256: sha('report v1'), score: 4, verdict: 'pass', direction_view: 'up', confidence_adj: '0.000',
    issues: JSON.stringify([]), summary: `${perspective} review`, ...o };
}
