// Integration (test DB 127.0.0.1:3320): BEFORE INSERT/UPDATE triggers (db/init/03-triggers.sql) against an empty schema.
// Every insert runs as stock_app, the user the MCP server writes with.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { testDbAvailable, resetTestDb, appQuery as q } from './helpers/testdb.mjs';
import { sha, insertVerifiedPrice, insertSource, insertPack, predictionRow, reviewRow, EXCERPT, nasdaqUrl } from './helpers/fixtures.mjs';

const up = await testDbAvailable();
const skip = up ? false : 'test DB not running (npm run db:test:up)';
const blocked = (p, re) => assert.rejects(p, (e) => { assert.ok(e.sqlState === '45000' || e.code === 'ER_CHECK_CONSTRAINT_VIOLATED', `${e.code} ${e.message}`); if (re) assert.match(e.message, re); return true; });

before(async () => { if (up) await resetTestDb(); });

test('price_submissions: reason ok <=> verified', { skip }, async () => {
  await blocked(q("INSERT INTO price_submissions (ticker, month, trade_date, close, origin, status, reason) VALUES ('AAPL','2026-07','2026-07-31',1,'inbox','verified','price_mismatch')"));
  await blocked(q("INSERT INTO price_submissions (ticker, month, origin, status, reason) VALUES ('AAPL','2026-07','inbox','rejected','ok')"));
  await q("INSERT INTO price_submissions (ticker, month, trade_date, close, origin, status, reason) VALUES ('AAPL','2026-07','2026-07-15',1,'inbox','rejected','not_month_end')");
});

test('month_end_prices: needs a matching verified submission, valid URLs, |A-B| <= 0.01, last NYSE trading day, fetched after close', { skip }, async () => {
  await blocked(insertVerifiedPrice(q, { month: '2026-07', trade_date: '2026-07-31', overrides: { submission_id: 999999 } }), /verified price_submission/);
  await blocked(insertVerifiedPrice(q, { month: '2026-07', trade_date: '2026-07-31', b: '254.6500' }), /abs_diff/);
  await blocked(insertVerifiedPrice(q, { month: '2026-07', trade_date: '2026-07-31', overrides: { source_a_url: 'https://example.com/AAPL' } }), /URLs/);
  await blocked(insertVerifiedPrice(q, { month: '2026-07', trade_date: '2026-07-31', overrides: { source_b_url: nasdaqUrl('AAPL', '2026-07-01', '2026-07-31') } }), /URLs/);
  await blocked(insertVerifiedPrice(q, { month: '2026-07', trade_date: '2026-07-31', fetched: '2026-07-31 15:00:00' }), /after the close/);
  await blocked(insertVerifiedPrice(q, { month: '2026-07', trade_date: '2026-07-31', fetched: '2099-01-01 00:00:00' }), /not in the future/);
  await blocked(insertVerifiedPrice(q, { month: '2026-07', trade_date: '2026-07-15' }), /last NYSE trading day/);
  await blocked(insertVerifiedPrice(q, { month: '2026-08', trade_date: '2026-08-30' }), /last NYSE trading day/); // Sunday
  await blocked(insertVerifiedPrice(q, { month: '2026-07', trade_date: '2026-07-31', overrides: { close: '254.6350' } })); // close must be Nasdaq's
  await blocked(insertVerifiedPrice(q, { month: '2026-07', trade_date: '2026-07-31', overrides: { tolerance_abs: '0.0500' } }), /tolerance/);
  const ok = await insertVerifiedPrice(q, { month: '2026-07', trade_date: '2026-07-31' });
  assert.ok(ok.price_id > 0);
  await assert.rejects(insertVerifiedPrice(q, { month: '2026-07', trade_date: '2026-07-31' }), /Duplicate/); // one row per ticker/month
});

test('research_notes: verified needs found excerpt, matching sha, 40-1200 chars and a verified source', { skip }, async () => {
  const good = await insertSource(q);
  const pending = await insertSource(q, { status: 'pending' });
  const note = (source_id, o = {}) => q('INSERT INTO research_notes SET ?', [{ ticker: 'AAPL', source_id, category: 'earnings', claim: 'Apple reported Q4 FY2026 results',
    excerpt: EXCERPT, excerpt_sha256: sha(EXCERPT), excerpt_found: 1, status: 'verified', ...o }]);
  await blocked(note(pending), /verified source/);
  await blocked(note(good, { excerpt_found: 0 }));
  await blocked(note(good, { excerpt_sha256: sha('other') }));
  await blocked(note(good, { excerpt: 'too short', excerpt_sha256: sha('too short') }));
  await note(good);
  await note(pending, { status: 'rejected', reason: 'excerpt_not_found', excerpt_found: 0 }); // rejects are logged
});

test('news_items: verified/corroborated rules on insert and update; macro news may have ticker NULL', { skip }, async () => {
  const good = await insertSource(q);
  const noSha = await insertSource(q, { withSha: false });
  const pending = await insertSource(q, { status: 'pending' });
  const news = (source_id, o = {}) => q('INSERT INTO news_items SET ?', [{ ticker: 'AAPL', source_id, title_submitted: 'Apple reports record quarter', status: 'verified', ...o }]);
  await blocked(news(pending), /verified\/corroborated source/);
  await blocked(news(noSha), /content_sha256/);
  await blocked(news(good, { status: 'corroborated', corroboration_count: 1 }), />= 2/);
  await news(good, { status: 'corroborated', corroboration_count: 2 });
  const p = await news(pending, { status: 'pending' });
  await blocked(q("UPDATE news_items SET status = 'verified' WHERE id = ?", [p.insertId]));
  // macro scope: world-news context without a ticker
  await news(good, { ticker: null, scope: 'macro', title_submitted: 'Fed holds rates steady' });
  await blocked(news(good, { ticker: null, scope: 'company' })); // company news needs a ticker (CHECK)
});

test('prediction_citations: only verified/corroborated sources; predictions BI rules', { skip }, async () => {
  await insertVerifiedPrice(q, { month: '2026-08', trade_date: '2026-08-31' });
  const pack = await insertPack(q);
  await blocked(q('INSERT INTO predictions SET ?', [predictionRow(pack, { target_month: '2026-10' })]), /as_of_month \+ 1/);
  await blocked(q('INSERT INTO predictions SET ?', [predictionRow(pack, { as_of_month: '2026-06', target_month: '2026-07' })]), /verified close/);
  await blocked(q('INSERT INTO predictions SET ?', [predictionRow(pack, { exp_return_low: '0.020000' })]), /low <= mid/);
  await blocked(q('INSERT INTO predictions SET ?', [predictionRow(pack, { overlay_p_adj: '0.2000' })]), /overlay_p_adj/);
  await blocked(q('INSERT INTO predictions SET ?', [predictionRow(pack, { status: 'final' })]), /draft/);
  const pred = (await q('INSERT INTO predictions SET ?', [predictionRow(pack)])).insertId;
  const pending = await insertSource(q, { status: 'pending' });
  await blocked(q('INSERT INTO prediction_citations (prediction_id, source_id) VALUES (?, ?)', [pred, pending]), /verified or corroborated/);
  await q('INSERT INTO prediction_citations (prediction_id, source_id) VALUES (?, ?)', [pred, await insertSource(q)]);
});

/**
 * Phase 4 roster: a run for AAPL 2026-09 with a validator task, `n` analyses (distinct agents, accepted unless `status`), and a
 * run-based prediction whose stored consensus lists exactly those analyses; the analyses are linked to it.
 */
async function runPrediction(pack, version, { n = 3, status = 'accepted', sha256 = sha('report v1') } = {}) {
  const run = (await q("INSERT INTO runs (target_month, tickers, status, plan) VALUES ('2026-09', JSON_ARRAY('AAPL'), 'running', JSON_OBJECT('packs', JSON_OBJECT('AAPL', JSON_OBJECT('pack_id', ?))))", [pack])).insertId;
  const task = (await q("INSERT INTO agent_tasks (run_id, agent, ticker) VALUES (?, 'validator', 'AAPL')", [run])).insertId;
  const agents = ['fundamental', 'technical', 'news_sentiment', 'macro_sector', 'risk_skeptic'];
  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = (await q("INSERT INTO analyses (run_id, agent, ticker, target_month, direction, exp_return_lo, exp_return_hi, confidence, evidence_source_ids, rationale) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [run, agents[i], 'AAPL', '2026-09', 'up', '-0.02', '0.05', '0.400', '[]', 'test analysis'])).insertId;
    if (status !== 'submitted') await q('UPDATE analyses SET status = ?, reviewed_at = UTC_TIMESTAMP(3) WHERE id = ?', [i === n - 1 && status === 'last_rejected' ? 'rejected' : 'accepted', id]);
    ids.push(id);
  }
  // the pack has no baseline (short history anchor: mid 0, sigma 0.15, p 0.5): mid/p_up as the finalize trigger recomputes them
  const acc = status === 'last_rejected' ? n - 1 : n;
  const sc = 0.4 * acc, mid = (sc * 0.015) / (1 + sc), pUp = Math.min(0.99, 0.5 + Math.min(0.15, (0.15 * sc) / (1 + sc)));
  const consensus = { mid: mid.toFixed(6), low: '-0.050000', high: '0.070000', p_up: pUp.toFixed(4), direction: 'up', analyses: ids.map((analysis_id) => ({ analysis_id })) };
  const pred = (await q('INSERT INTO predictions SET ?', [predictionRow(pack, { version, run_id: run, consensus_json: JSON.stringify(consensus), report_sha256: sha256,
    exp_return_mid: mid.toFixed(6), p_up: pUp.toFixed(4) })])).insertId;
  for (const id of ids) await q('UPDATE analyses SET prediction_id = ? WHERE id = ?', [pred, id]);
  const review = (o = {}) => q('INSERT INTO reviews SET ?', [reviewRow(pred, 'validator', { agent_task_id: task, report_sha256: sha256, ...o })]);
  return { run, task, pred, ids, review };
}

test('predictions BU: final only with a validator pass (latest, on the current sha), >= 3 accepted analyses of distinct agents; then frozen', { skip }, async () => {
  const pack = await insertPack(q);
  const { pred, review } = await runPrediction(pack, 2, { n: 2 });
  const finalize = () => q("UPDATE predictions SET status = 'final', final_confidence = 0.300, finalized_at = UTC_TIMESTAMP(3) WHERE id = ?", [pred]);
  await blocked(finalize(), /validator pass/);
  await blocked(review({ report_sha256: sha('old report') }), /stale_review/);
  await review({ verdict: 'pass_with_issues' });
  await blocked(finalize(), /validator pass/); // pass_with_issues is not a pass
  await review();
  await blocked(finalize(), /distinct agents/); // only 2 accepted
  const p3 = await runPrediction(pack, 5, { n: 3, status: 'last_rejected' });
  await p3.review();
  await blocked(q("UPDATE predictions SET status = 'final' WHERE id = ?", [p3.pred]), /distinct agents|not accepted/);
  const ok = await runPrediction(pack, 6, { n: 3 });
  await ok.review();
  await q("UPDATE predictions SET status = 'final', final_confidence = 0.300 WHERE id = ?", [ok.pred]);
  await blocked(q("UPDATE predictions SET status = 'reviewed' WHERE id = ?", [ok.pred]), /frozen/);
  await blocked(q('UPDATE predictions SET report_sha256 = ? WHERE id = ?', [sha('report v3'), ok.pred]), /frozen/);
  await blocked(ok.review(), /stale_review/);
  await q("UPDATE predictions SET status = 'withdrawn' WHERE id = ?", [ok.pred]);
  await blocked(q("UPDATE predictions SET status = 'draft' WHERE id = ?", [ok.pred]), /withdrawn/);
});

test('predictions BU: reviewed cannot be re-hashed or go back to draft; a later validator fail supersedes the pass', { skip }, async () => {
  const pack = await insertPack(q);
  const { pred, review } = await runPrediction(pack, 4, { n: 3 });
  await review();
  await q("UPDATE predictions SET status = 'reviewed' WHERE id = ?", [pred]);
  await blocked(q('UPDATE predictions SET report_sha256 = ? WHERE id = ?', [sha('edited'), pred]), /re-hashed/);
  await blocked(q("UPDATE predictions SET status = 'draft' WHERE id = ?", [pred]), /back to draft/);
  await review({ verdict: 'fail', score: 1, issues: JSON.stringify([{ severity: 'critical', section: 'Risks', text: 'unsupported claim about litigation', evidence_source_ids: [] }]) });
  await blocked(q("UPDATE predictions SET status = 'final' WHERE id = ?", [pred]), /latest validator review/);
});

test('predictions BU: a cited source that lost verification blocks final', { skip }, async () => {
  const pack = await insertPack(q);
  const { pred, review } = await runPrediction(pack, 3, { n: 3 });
  const src = await insertSource(q);
  await q('INSERT INTO prediction_citations (prediction_id, source_id) VALUES (?, ?)', [pred, src]);
  await review();
  await q("UPDATE sources SET verification_status = 'rejected' WHERE id = ?", [src]);
  await blocked(q("UPDATE predictions SET status = 'final' WHERE id = ?", [pred]), /no longer verified/);
});

test('analyses: inserted as submitted with verified evidence; a verdict is final', { skip }, async () => {
  const run = (await q("INSERT INTO runs (target_month, tickers, status) VALUES ('2026-09', JSON_ARRAY('AAPL'), 'running')")).insertId;
  const pending = await insertSource(q, { status: 'pending' });
  const good = await insertSource(q);
  const ins = (o = {}) => q('INSERT INTO analyses SET ?', [{ run_id: run, agent: 'fundamental', ticker: 'AAPL', target_month: '2026-09', direction: 'up', exp_return_lo: '-0.02',
    exp_return_hi: '0.05', confidence: '0.4', evidence_source_ids: JSON.stringify([good]), rationale: 'r', ...o }]);
  await blocked(ins({ evidence_source_ids: JSON.stringify([good, pending]) }), /verified/);
  await blocked(ins({ status: 'accepted' }), /submitted/);
  await blocked(ins({ ticker: 'GOOGL' }), /match its run/);
  const id = (await ins()).insertId;
  await blocked(q("UPDATE analyses SET status = 'accepted' WHERE id = ?", [id]), /reviewed_at/);
  await q("UPDATE analyses SET status = 'rejected', reviewed_at = UTC_TIMESTAMP(3) WHERE id = ?", [id]);
  await blocked(q("UPDATE analyses SET status = 'accepted' WHERE id = ?", [id]), /verdict is final/);
});

test('prediction_outcomes: actual_close must equal the verified target-month close', { skip }, async () => {
  const [pred] = await q("SELECT id FROM predictions WHERE ticker = 'AAPL' AND target_month = '2026-09' ORDER BY id LIMIT 1");
  const out = (o = {}) => q('INSERT INTO prediction_outcomes SET ?', [{ prediction_id: pred.id, actual_close: '254.6300', actual_trade_date: '2026-09-30',
    base_close: '254.6300', actual_return: '0.000000', direction_hit: 0, in_range: 1, brier: '0.3249', abs_error: '0.010000', ...o }]);
  await blocked(out(), /verified close/); // 2026-09 not verified yet
  await insertVerifiedPrice(q, { month: '2026-09', trade_date: '2026-09-30' });
  await blocked(out({ actual_close: '260.0000' }), /verified close/);
  await out();
});

test('analyses: must match the run (target month, ticker listed); CHECKs on range and confidence', { skip }, async () => {
  const run = (await q("INSERT INTO runs (target_month, tickers, plan) VALUES ('2026-11', JSON_ARRAY('AAPL','SPCX'), JSON_OBJECT('analyzers', 5))")).insertId;
  const an = (o = {}) => q('INSERT INTO analyses SET ?', [{ run_id: run, agent: 'technical', ticker: 'SPCX', target_month: '2026-11', direction: 'up',
    exp_return_lo: '-0.040000', exp_return_hi: '0.080000', confidence: '0.400', evidence_source_ids: JSON.stringify([]), rationale: 'short history; momentum only', ...o }]);
  await an();
  await blocked(an({ ticker: 'GOOGL' }), /match its run/);
  await blocked(an({ target_month: '2026-12' }), /match its run/);
  await blocked(an({ exp_return_lo: '0.100000' }));
  await blocked(an({ confidence: '1.500' }));
  await assert.rejects(an({ agent: 'drawer' }), /agent/); // only analyzers write analyses
  await blocked(q("INSERT INTO runs (target_month, tickers) VALUES ('2026-11', JSON_OBJECT('t','AAPL'))")); // tickers must be an array
});

test('Validator P1 #2: trade_date must be exactly the last NYSE trading day (holidays from nyse_closures)', { skip }, async () => {
  // 2026-10-29 is a Thursday before the month-end Friday 2026-10-30; 2024-03-29 is Good Friday (month-end is 2024-03-28).
  await blocked(insertVerifiedPrice(q, { ticker: 'GOOGL', month: '2026-10', trade_date: '2026-10-29' }), /last NYSE trading day/);
  await blocked(insertVerifiedPrice(q, { ticker: 'GOOGL', month: '2024-03', trade_date: '2024-03-29' }), /last NYSE trading day/);
  await blocked(insertVerifiedPrice(q, { ticker: 'GOOGL', month: '2026-12', trade_date: '2026-12-30' }), /last NYSE trading day/);
  await blocked(insertVerifiedPrice(q, { ticker: 'GOOGL', month: '2031-01', trade_date: '2031-01-31' }), /no calendar for this year/);
  assert.ok((await insertVerifiedPrice(q, { ticker: 'GOOGL', month: '2024-03', trade_date: '2024-03-28' })).price_id > 0);
  assert.ok((await insertVerifiedPrice(q, { ticker: 'GOOGL', month: '2026-09', trade_date: '2026-09-30' })).price_id > 0);
  // the closure calendar cannot be changed by the app user (it would move a month-end)
  await blocked(q("INSERT INTO nyse_closures (closure_date, name) VALUES ('2026-11-30', 'fake')"), /db:migrate only/);
});

test('Validator P1 #5: draft -> reviewed needs at least one review on the current report', { skip }, async () => {
  const pack = await insertPack(q, { ticker: 'AMZN', as_of: '2026-07', target: '2026-08' });
  await insertVerifiedPrice(q, { ticker: 'AMZN', month: '2026-07', trade_date: '2026-07-31' }).catch(() => {});
  const pred = (await q('INSERT INTO predictions SET ?', [predictionRow(pack, { ticker: 'AMZN', as_of_month: '2026-07', target_month: '2026-08' })])).insertId;
  await blocked(q("UPDATE predictions SET status = 'reviewed' WHERE id = ?", [pred]), /at least one review/);
  await q('INSERT INTO reviews SET ?', [reviewRow(pred, 'quant')]);
  await q("UPDATE predictions SET status = 'reviewed' WHERE id = ?", [pred]);
});
