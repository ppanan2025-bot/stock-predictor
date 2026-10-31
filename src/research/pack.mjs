// get_research_pack (PLAN §3): assembles the evidence for (ticker, as_of_month) and stores it as an immutable snapshot in
// research_packs (pack_id + pack_sha256), so a report can be reproduced from exactly what Claude saw.
//
// INCLUDED (verified only): verified month-end closes (36 months, gaps null, never interpolated); deterministic features
// recomputed from those closes (quant/features.mjs) plus whether the stored quant_features row matches; peers' r1/r3;
// verified/corroborated company and macro news whose source is still verified/corroborated; verified research notes whose
// source is still verified/corroborated; prior predictions/outcomes; calibration.
// NEVER INCLUDED: pending/rejected price submissions, pending/rejected news, news or notes whose source lost verification,
// rejected notes, inbox/leads (unverified files are not in the DB at all). They are only COUNTED in excluded_counts.
// Page-derived text (note excerpts) is returned only inside untrusted_content with the UNTRUSTED label.
//
// AS-OF DISCIPLINE (Phase 4): a pack for as_of month A (target A+1) uses only data dated <= the end of A: closes <= A (features,
// peers and the baseline are cut there too), news whose publication date is <= end of A, research notes whose CONTENT date
// (as_of_date, else the source's published date) is <= end of A (undated notes are excluded), and prior predictions/outcomes
// with target_month <= A. Later rows are only counted in excluded_counts.after_as_of. This lets a run rehearse "predict 2026-10
// with data through 2026-09" and be scored when the October close is verified.
import { clean, UNTRUSTED_LABEL, coverageStart, companiesConfig } from '../lib/repo.mjs';
import { sha256, stableStringify } from '../lib/hash.mjs';
import { lastCompleteMonth, monthRange, nextMonth, lastDayOfMonth } from '../market/calendar.mjs';
import { loadFeatureInputs, featuresFor } from '../quant/featureStore.mjs';
import { monthsBack } from '../quant/features.mjs';
import { computeBaseline } from '../quant/baseline.mjs';
import { loadModel } from '../quant/model.mjs';

export const PACK_VERSION = 'pack-v2';
const OK_SRC = "('verified','corroborated')";
const rows = async (db, sql, args = []) => clean((await db.query(sql, args))[0]);
const num = (v) => Number(v ?? 0);
const LIMITS = { news: 40, macro: 20, notes: 50, predictions: 6 };

export class PackError extends Error {
  constructor(reason, message) { super(message); this.reason = reason; }
}

/**
 * Builds (does not store) the pack. `db` may be any connection with SELECT on stockdb.
 * @returns the pack object (without pack_id / pack_sha256)
 */
export async function buildResearchPack(db, { ticker, as_of_month = null, as_of = null }, { now = new Date(), model = loadModel() } = {}) {
  if (as_of && as_of_month && as_of !== as_of_month) throw new PackError('invalid_input', 'as_of and as_of_month differ');
  as_of_month = as_of_month ?? as_of ?? null;
  const inputs = await loadFeatureInputs(db);
  const co = (await rows(db, 'SELECT ticker, name, exchange, sector, industry, cik, peers, role, listed_on, active FROM companies WHERE ticker = ?', [ticker]))[0];
  if (!co) throw new PackError('not_found', `company ${ticker} not found`);
  const own = inputs.byTicker.get(ticker) ?? [];
  const through = lastCompleteMonth(now);
  const asOf = as_of_month ?? own.map((r) => r.month).filter((m) => m <= through).sort().pop() ?? null;
  if (!asOf) throw new PackError('no_verified_close', `${ticker} has no verified month-end close`);
  if (!own.some((r) => r.month === asOf)) throw new PackError('no_verified_close', `${ticker} has no verified close for ${asOf}`);
  const target = nextMonth(asOf);

  // prices: 36 months ending at as_of (from listing/history_from at the earliest); gaps are null
  const start0 = monthsBack(asOf, 35);
  const cov = coverageStart(co.listed_on, companiesConfig().history_from);
  const start = start0 > cov ? start0 : cov;
  const priceRows = await rows(db, 'SELECT month, trade_date, close FROM month_end_prices WHERE ticker = ? AND month BETWEEN ? AND ? ORDER BY month', [ticker, start, asOf]);
  const pm = new Map(priceRows.map((p) => [p.month, p]));
  const listedMonth = String(co.listed_on).slice(0, 7);
  const series = (start <= asOf ? monthRange(start, asOf) : []).map((m) => (pm.has(m)
    ? { month: m, trade_date: pm.get(m).trade_date, close: pm.get(m).close }
    : { month: m, trade_date: null, close: null, gap: m < listedMonth ? 'pre_listing' : 'missing' }));

  // features (recomputed, deterministic) + stored row comparison
  const f = featuresFor(inputs, ticker, asOf);
  const stored = (await rows(db, 'SELECT features_sha256, code_version, computed_at FROM quant_features WHERE ticker = ? AND month = ?', [ticker, asOf]))[0] ?? null;
  const peers = [];
  for (const p of co.peers ? (typeof co.peers === 'string' ? JSON.parse(co.peers) : co.peers) : []) {
    const pf = featuresFor(inputs, p, asOf);
    peers.push(pf.error ? { ticker: p, month: asOf, error: pf.error }
      : { ticker: p, month: asOf, close: pf.features.close, r1: pf.features.r1, r3: pf.features.r3, r6: pf.features.r6, r12: pf.features.r12, vol12: pf.features.vol12 });
  }

  // evidence window: from the first day of as_of-2 months to the END OF THE AS-OF MONTH (never later, whatever `now` is)
  const since = `${monthsBack(asOf, 2)}-01 00:00:00`;
  const untilSql = `${lastDayOfMonth(asOf)} 23:59:59.999`;
  const asOfEndDate = lastDayOfMonth(asOf);
  const pub = 'COALESCE(s.published_at_fetched, n.published_at_submitted, n.created_at)';

  const newsSql = (scopeCond) => `SELECT n.id AS news_item_id, n.source_id, n.ticker, n.scope, n.title_submitted AS title, ${pub} AS published_at,
      n.status, n.corroboration_count, n.corroborating_source_ids, n.sentiment, s.url_canonical AS url, s.domain, s.outlet_key, s.ownership_group,
      s.tier, s.kind, s.title_fetched, s.content_sha256, s.verification_status AS source_status
    FROM news_items n JOIN sources s ON s.id = n.source_id
    WHERE ${scopeCond} AND n.status IN ${OK_SRC} AND s.verification_status IN ${OK_SRC} AND s.content_sha256 IS NOT NULL
      AND ${pub} BETWEEN ? AND ? ORDER BY ${pub} DESC, n.id DESC LIMIT ?`;
  const news = await rows(db, newsSql("n.scope = 'company' AND n.ticker = ?"), [ticker, since, untilSql, LIMITS.news + 1]);
  const macro = await rows(db, newsSql("n.scope = 'macro'"), [since, untilSql, LIMITS.macro + 1]);
  const notePub = 'COALESCE(r.as_of_date, DATE(s.published_at_fetched))'; // content date; NULL (undated) is never included
  const notes = await rows(db, `SELECT r.id AS note_id, r.source_id, r.category, r.claim, r.excerpt, r.excerpt_sha256, r.as_of_date, r.created_by,
      r.page_sha256, r.fetched_at, s.url_canonical AS url, s.domain, s.tier, s.kind, s.title_fetched AS source_title, s.verification_status AS source_status
    FROM research_notes r JOIN sources s ON s.id = r.source_id
    WHERE r.ticker = ? AND r.status = 'verified' AND r.excerpt_found = 1 AND s.verification_status IN ${OK_SRC}
      AND ${notePub} <= ? ORDER BY ${notePub} DESC, r.id DESC LIMIT ?`, [ticker, untilSql, LIMITS.notes + 1]);

  // excluded_counts: everything in the same scope/window that is NOT in the pack because it is not (or no longer) verified
  const cnt = async (sql, args) => num((await rows(db, sql, args))[0]?.n);
  const okNews = `n.status IN ${OK_SRC} AND s.verification_status IN ${OK_SRC} AND s.content_sha256 IS NOT NULL`;
  const okNote = `r.status = 'verified' AND r.excerpt_found = 1 AND s.verification_status IN ${OK_SRC}`;
  const newsExcl = async (scopeCond, args) => ({
    pending: await cnt(`SELECT COUNT(*) AS n FROM news_items n JOIN sources s ON s.id = n.source_id WHERE ${scopeCond} AND n.status = 'pending' AND ${pub} BETWEEN ? AND ?`, [...args, since, untilSql]),
    rejected: await cnt(`SELECT COUNT(*) AS n FROM news_items n JOIN sources s ON s.id = n.source_id WHERE ${scopeCond} AND n.status = 'rejected' AND ${pub} BETWEEN ? AND ?`, [...args, since, untilSql]),
    source_not_verified: await cnt(`SELECT COUNT(*) AS n FROM news_items n JOIN sources s ON s.id = n.source_id WHERE ${scopeCond} AND n.status IN ${OK_SRC}
      AND (s.verification_status NOT IN ${OK_SRC} OR s.content_sha256 IS NULL) AND ${pub} BETWEEN ? AND ?`, [...args, since, untilSql]),
  });
  const excluded_counts = {
    news: await newsExcl("n.scope = 'company' AND n.ticker = ?", [ticker]),
    macro_news: await newsExcl("n.scope = 'macro'", []),
    research_notes: {
      rejected: await cnt(`SELECT COUNT(*) AS n FROM research_notes r JOIN sources s ON s.id = r.source_id WHERE r.ticker = ? AND r.status = 'rejected' AND ${notePub} <= ?`, [ticker, untilSql]),
      source_not_verified: await cnt(`SELECT COUNT(*) AS n FROM research_notes r JOIN sources s ON s.id = r.source_id WHERE r.ticker = ? AND r.status = 'verified'
        AND s.verification_status NOT IN ${OK_SRC} AND ${notePub} <= ?`, [ticker, untilSql]),
    },
    price_submissions: {
      pending: await cnt("SELECT COUNT(*) AS n FROM price_submissions WHERE ticker = ? AND status = 'pending' AND month <= ?", [ticker, asOf]),
      rejected: await cnt("SELECT COUNT(*) AS n FROM price_submissions WHERE ticker = ? AND status = 'rejected' AND month <= ?", [ticker, asOf]),
    },
    price_gaps: series.filter((s) => s.close === null && s.gap === 'missing').length,
    after_as_of: {
      news: await cnt(`SELECT COUNT(*) AS n FROM news_items n JOIN sources s ON s.id = n.source_id WHERE n.scope = 'company' AND n.ticker = ? AND ${okNews} AND ${pub} > ?`, [ticker, untilSql]),
      macro_news: await cnt(`SELECT COUNT(*) AS n FROM news_items n JOIN sources s ON s.id = n.source_id WHERE n.scope = 'macro' AND ${okNews} AND ${pub} > ?`, [untilSql]),
      research_notes: await cnt(`SELECT COUNT(*) AS n FROM research_notes r JOIN sources s ON s.id = r.source_id WHERE r.ticker = ? AND ${okNote} AND ${notePub} > ?`, [ticker, asOfEndDate]),
      research_notes_undated: await cnt(`SELECT COUNT(*) AS n FROM research_notes r JOIN sources s ON s.id = r.source_id WHERE r.ticker = ? AND ${okNote} AND ${notePub} IS NULL`, [ticker]),
      prices: await cnt('SELECT COUNT(*) AS n FROM month_end_prices WHERE ticker = ? AND month > ?', [ticker, asOf]),
    },
    // exact numbers left out by the limits (COUNT over the same conditions; Validator Phase 3 #9)
    truncated: {
      news: Math.max(0, await cnt(`SELECT COUNT(*) AS n FROM news_items n JOIN sources s ON s.id = n.source_id WHERE n.scope = 'company' AND n.ticker = ? AND ${okNews} AND ${pub} BETWEEN ? AND ?`, [ticker, since, untilSql]) - LIMITS.news),
      macro_news: Math.max(0, await cnt(`SELECT COUNT(*) AS n FROM news_items n JOIN sources s ON s.id = n.source_id WHERE n.scope = 'macro' AND ${okNews} AND ${pub} BETWEEN ? AND ?`, [since, untilSql]) - LIMITS.macro),
      research_notes: Math.max(0, await cnt(`SELECT COUNT(*) AS n FROM research_notes r JOIN sources s ON s.id = r.source_id WHERE r.ticker = ? AND ${okNote} AND ${notePub} <= ?`, [ticker, untilSql]) - LIMITS.notes),
    },
  };

  const predictions = await rows(db, `SELECT p.id AS prediction_id, p.as_of_month, p.target_month, p.version, p.direction, p.p_up, p.exp_return_low,
      p.exp_return_mid, p.exp_return_high, p.confidence, p.final_confidence, p.status, o.actual_return, o.direction_hit, o.in_range, o.brier
    FROM predictions p LEFT JOIN prediction_outcomes o ON o.prediction_id = p.id
    WHERE p.ticker = ? AND p.status = 'final' AND p.target_month <= ? ORDER BY p.target_month DESC, p.version DESC LIMIT ?`, [ticker, asOf, LIMITS.predictions]);
  // calibration from outcomes of predictions whose target month is <= as_of (as-of discipline; v_calibration is all-time)
  const calSql = `SELECT %s, COUNT(*) AS n_scored, AVG(o.direction_hit) AS hit_rate, AVG(o.brier) AS mean_brier, AVG(o.in_range) AS range_coverage,
      AVG(o.abs_error) AS mean_abs_error FROM prediction_outcomes o JOIN predictions p ON p.id = o.prediction_id
    WHERE p.status = 'final' AND p.target_month <= ?`;
  const calibration = [...await rows(db, `${calSql.replace('%s', 'p.ticker')} GROUP BY p.ticker ORDER BY p.ticker`, [asOf]),
    ...(await rows(db, calSql.replace('%s', "'ALL' AS ticker"), [asOf])).filter((r) => Number(r.n_scored) > 0)];
  const baseline = computeBaseline(f.error ? { error: f.error, ticker, month: asOf } : { ...f.features, features_sha256: f.features_sha256 }, model);

  const shapeNews = (n) => ({ news_item_id: Number(n.news_item_id), source_id: Number(n.source_id), ticker: n.ticker, scope: n.scope, title: n.title,
    published_at: n.published_at, status: n.status, corroboration_count: Number(n.corroboration_count),
    corroborating_source_ids: typeof n.corroborating_source_ids === 'string' ? JSON.parse(n.corroborating_source_ids) : (n.corroborating_source_ids ?? []),
    sentiment: n.sentiment, url: n.url, domain: n.domain, outlet_key: n.outlet_key, ownership_group: n.ownership_group, tier: n.tier, kind: n.kind,
    source_status: n.source_status, content_sha256: n.content_sha256 });
  const noteList = notes.slice(0, LIMITS.notes);
  return {
    pack_version: PACK_VERSION, ticker, as_of_month: asOf, target_month: target, created_at: now.toISOString(),
    company: { name: co.name, exchange: co.exchange, sector: co.sector, industry: co.industry, cik: co.cik, listed_on: co.listed_on, role: co.role },
    window: { news_since: since.replace(' ', 'T') + 'Z', news_until: `${asOfEndDate}T23:59:59.999Z`, notes_content_until: asOfEndDate,
      rule: 'as-of discipline: only data dated <= the end of as_of_month' },
    prices: { from: start, to: asOf, verified: priceRows.length, gaps: series.filter((s) => s.close === null).length, note: 'Verified month-end closes only; nulls are gaps and are never interpolated.', series },
    features: f.error ? { error: f.error } : { ...f.features, features_sha256: f.features_sha256,
      stored: stored ? { features_sha256: stored.features_sha256, code_version: stored.code_version, matches: stored.features_sha256 === f.features_sha256 } : null },
    baseline: baseline.status === 'ok' ? baseline : null,
    baseline_status: baseline.status === 'ok' ? 'ok' : baseline.reason,
    baseline_detail: baseline.status === 'ok' ? null : baseline,
    peers,
    news: news.slice(0, LIMITS.news).map(shapeNews),
    macro_news: macro.slice(0, LIMITS.macro).map(shapeNews),
    research_notes: noteList.map((r) => ({ note_id: Number(r.note_id), source_id: Number(r.source_id), category: r.category, claim: r.claim,
      as_of_date: r.as_of_date, excerpt_sha256: r.excerpt_sha256, page_sha256: r.page_sha256, fetched_at: r.fetched_at, created_by: r.created_by,
      url: r.url, domain: r.domain, tier: r.tier, kind: r.kind, source_status: r.source_status })),
    prior_predictions: predictions,
    calibration,
    excluded_counts,
    untrusted_content: { label: UNTRUSTED_LABEL, note_excerpts: noteList.map((r) => ({ note_id: Number(r.note_id), text: r.excerpt })),
      // page-derived titles are untrusted too (Validator Phase 3 #7)
      note_source_titles: noteList.map((r) => ({ note_id: Number(r.note_id), source_id: Number(r.source_id), title: r.source_title })) },
    rules: ['Cite only [S<source_id>] from news/research_notes in this pack.', 'Numbers come only from prices/features/peers/notes in this pack.',
      'inbox/leads and anything in excluded_counts are unverified and never citable.'],
  };
}

/** A stored snapshot by id: {pack_id, pack_sha256, ...pack}; the sha is re-checked against the stored JSON. */
export async function loadPack(db, packId) {
  const [r] = await rows(db, 'SELECT id, ticker, as_of_month, target_month, pack_json, pack_sha256 FROM research_packs WHERE id = ?', [packId]);
  if (!r) throw new PackError('not_found', `pack ${packId} not found`);
  const pack = typeof r.pack_json === 'string' ? JSON.parse(r.pack_json) : r.pack_json;
  if (sha256(stableStringify(pack)) !== r.pack_sha256) throw new PackError('pack_tampered', `pack ${packId}: stored JSON does not hash to pack_sha256`);
  return { pack_id: Number(r.id), pack_sha256: r.pack_sha256, ...pack };
}

/** Builds the pack, stores the snapshot (pack_sha256 = sha256 of the canonical JSON) and returns {pack_id, pack_sha256, ...pack}.
 *  With args.pack_id the stored snapshot is returned instead (nothing is built or written). */
export async function getResearchPack(db, args, { now = new Date() } = {}) {
  if (args.pack_id) {
    const p = await loadPack(db, args.pack_id);
    if (args.ticker && p.ticker !== args.ticker) throw new PackError('pack_mismatch', `pack ${args.pack_id} is for ${p.ticker}, not ${args.ticker}`);
    return p;
  }
  const pack = await buildResearchPack(db, args, { now });
  const json = stableStringify(pack);
  const pack_sha256 = sha256(json);
  const [res] = await db.query('INSERT INTO research_packs (ticker, as_of_month, target_month, pack_json, pack_sha256) VALUES (?,?,?,?,?)',
    [pack.ticker, pack.as_of_month, pack.target_month, json, pack_sha256]);
  return { pack_id: Number(res.insertId), pack_sha256, ...pack };
}
