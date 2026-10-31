#!/usr/bin/env node
// npm run audit [-- --json] [--strict]
// Read-only (stock_ro) DB invariant audit (PLAN §4.7 layer 6, §8 /audit-db). Re-checks, from the stored rows and the files on disk,
// what the server, hooks and triggers are supposed to guarantee. VIOLATIONS (exit 1) mean the guarantees were broken somewhere;
// WARNINGS are expected drift that needs a decision (e.g. a cited source was rejected after the report was finalized).
//
// Violations:
//   price_not_last_trading_day   month_end_prices.trade_date != NYSE last trading day of the month (src/market/calendar.mjs)
//   price_submission_mismatch    the backing price_submission is missing, not verified/ok, or differs in ticker/month/date/close
//   price_source_mismatch        close != Nasdaq close, abs_diff != |A-B| or > tolerance 0.01
//   news_on_unverified_source    verified/corroborated news whose source is not verified/corroborated (or has no content hash)
//   news_corroboration_count     corroborated news with corroboration_count < 2
//   note_excerpt_sha_mismatch    verified research note whose excerpt does not hash to excerpt_sha256 / excerpt_found = 0
//   pack_sha_mismatch            research_packs.pack_json does not hash to pack_sha256
//   final_without_validator_pass final prediction without a validator pass on the current report_sha256 (or with a critical fail)
//   final_without_analyses       final prediction with < 3 accepted analyses linked, or a linked analysis not accepted
//   final_citation_unverified    final prediction citing a source that is no longer verified/corroborated
//   report_missing / report_sha_mismatch   saved report file missing or changed after save_prediction (draft/reviewed/final)
//   chart_mismatch               final prediction whose chart SVG/sidecar does not match the DB (src/report/chart.mjs verifyChart)
//   outcome_close_mismatch       prediction_outcomes.actual_close != verified close of the target month
//   consensus_mismatch           run-based prediction whose consensus RECOMPUTED (computeConsensus over its linked analyses and its
//                                pack's baseline) differs from consensus_json or from the row's direction/p_up/low/mid/high/confidence
//   duplicate_live_prediction    more than one non-withdrawn prediction for one (ticker, target_month)
//   task_not_from_start_run      an agent_task without a start_run token, created > 2 min after its run, or a 2nd task per (run, agent, ticker)
// Warnings:
//   note_on_unverified_source    verified note whose source was later rejected/unreachable (packs exclude it)
//   analysis_evidence_unverified accepted analysis citing a source that is no longer verified
//   features_stale               stored quant_features sha differs from a recomputation over the current verified closes
//   chart_mismatch (draft/reviewed) chart not (yet) bound to / matching a non-final prediction
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from '../src/lib/cli.mjs';
import { clean } from '../src/lib/repo.mjs';
import { sha256, stableStringify } from '../src/lib/hash.mjs';
import { lastTradingDay } from '../src/market/calendar.mjs';
import { loadFeatureInputs, featuresFor } from '../src/quant/featureStore.mjs';
import { resolveReportPath, verifyChart, reportsRoot } from '../src/report/chart.mjs';
import { loadPack } from '../src/research/pack.mjs';
import { computeConsensus } from '../src/quant/consensus.mjs';
import { loadModel } from '../src/quant/model.mjs';

const OK = ['verified', 'corroborated'];
const js = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const str = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d ?? ''));
const num = (x) => Number(x);

/** @returns {{violations: {code, ref, detail}[], warnings: {code, ref, detail}[], counts: object}} */
export async function auditInvariants(db, { base = reportsRoot(), minAccepted = 3, tolerance = 0.01, model = loadModel() } = {}) {
  const q = async (sql, a = []) => clean((await db.query(sql, a))[0]);
  const violations = []; const warnings = [];
  const V = (code, ref, detail) => violations.push({ code, ref, detail });
  const W = (code, ref, detail) => warnings.push({ code, ref, detail });

  // ---- prices
  const prices = await q(`SELECT p.*, s.id AS s_id, s.status AS s_status, s.reason AS s_reason, s.ticker AS s_ticker, s.month AS s_month,
      s.trade_date AS s_trade_date, s.close AS s_close FROM month_end_prices p LEFT JOIN price_submissions s ON s.id = p.submission_id ORDER BY p.ticker, p.month`);
  for (const p of prices) {
    const ref = `price ${p.ticker} ${p.month} (id ${p.id})`;
    const ltd = lastTradingDay(p.month);
    if (str(p.trade_date) !== ltd) V('price_not_last_trading_day', ref, `trade_date ${str(p.trade_date)} != ${ltd}`);
    if (!p.s_id || p.s_status !== 'verified' || p.s_reason !== 'ok' || p.s_ticker !== p.ticker || p.s_month !== p.month
      || str(p.s_trade_date) !== str(p.trade_date) || num(p.s_close) !== num(p.close))
      V('price_submission_mismatch', ref, `submission ${p.submission_id}: ${p.s_status ?? 'missing'}/${p.s_reason ?? '-'} ${p.s_ticker} ${p.s_month} ${str(p.s_trade_date)} ${p.s_close}`);
    const diff = Math.abs(num(p.source_a_close) - num(p.source_b_close));
    if (num(p.close) !== num(p.source_a_close) || Math.abs(diff - num(p.abs_diff)) > 1e-9 || num(p.abs_diff) > tolerance + 1e-9)
      V('price_source_mismatch', ref, `close ${p.close}, A ${p.source_a_close}, B ${p.source_b_close}, abs_diff ${p.abs_diff}`);
  }

  // ---- news, notes, packs
  for (const n of await q(`SELECT n.id, n.status, n.corroboration_count, s.id AS sid, s.verification_status AS ss, s.content_sha256 AS sha
      FROM news_items n JOIN sources s ON s.id = n.source_id WHERE n.status IN ('verified','corroborated')`)) {
    if (!OK.includes(n.ss) || !n.sha) V('news_on_unverified_source', `news ${n.id}`, `status ${n.status} but source ${n.sid} is ${n.ss}${n.sha ? '' : ' (no content hash)'}`);
    if (n.status === 'corroborated' && num(n.corroboration_count) < 2) V('news_corroboration_count', `news ${n.id}`, `corroborated with count ${n.corroboration_count}`);
  }
  const notes = await q(`SELECT r.id, r.excerpt, r.excerpt_sha256, r.excerpt_found, s.id AS sid, s.verification_status AS ss
      FROM research_notes r JOIN sources s ON s.id = r.source_id WHERE r.status = 'verified'`);
  for (const r of notes) {
    if (sha256(String(r.excerpt)) !== r.excerpt_sha256 || num(r.excerpt_found) !== 1) V('note_excerpt_sha_mismatch', `note ${r.id}`, 'excerpt does not hash to excerpt_sha256 or excerpt_found = 0');
    if (!OK.includes(r.ss)) W('note_on_unverified_source', `note ${r.id}`, `source ${r.sid} is now ${r.ss} (excluded from packs)`);
  }
  const packs = await q('SELECT id, pack_json, pack_sha256 FROM research_packs ORDER BY id');
  for (const p of packs) if (sha256(stableStringify(js(p.pack_json))) !== p.pack_sha256) V('pack_sha_mismatch', `pack ${p.id}`, 'pack_json does not hash to pack_sha256');

  // ---- predictions
  const preds = await q("SELECT * FROM predictions WHERE status <> 'withdrawn' ORDER BY id");
  for (const p of preds) {
    const ref = `prediction ${p.id} ${p.ticker} ${p.target_month} v${p.version} (${p.status})`;
    if (p.status === 'final') {
      const [pass] = await q("SELECT COUNT(*) AS n FROM reviews WHERE prediction_id = ? AND report_sha256 = ? AND perspective = 'validator' AND verdict = 'pass'", [p.id, p.report_sha256]);
      const fails = await q("SELECT issues FROM reviews WHERE prediction_id = ? AND report_sha256 = ? AND verdict = 'fail'", [p.id, p.report_sha256]);
      const critical = fails.some((r) => (js(r.issues) ?? []).some((i) => i.severity === 'critical'));
      if (num(pass.n) < 1 || critical) V('final_without_validator_pass', ref, num(pass.n) < 1 ? 'no validator pass on the current report_sha256' : 'a review on the current sha failed with a critical issue');
      const an = await q('SELECT status FROM analyses WHERE prediction_id = ?', [p.id]);
      const acc = an.filter((a) => a.status === 'accepted').length;
      if (acc < minAccepted || acc !== an.length) V('final_without_analyses', ref, `${acc} accepted of ${an.length} linked analyses (need >= ${minAccepted}, all accepted)`);
      for (const c of await q('SELECT c.source_id, s.verification_status AS ss FROM prediction_citations c JOIN sources s ON s.id = c.source_id WHERE c.prediction_id = ?', [p.id]))
        if (!OK.includes(c.ss)) V('final_citation_unverified', ref, `cited source ${c.source_id} is now ${c.ss} (withdraw and re-issue the prediction)`);
      if (p.final_confidence === null) V('final_without_validator_pass', ref, 'final_confidence is null');
    }
    if (p.report_path) {
      let text = null;
      try { text = fs.readFileSync(resolveReportPath(p.report_path, base), 'utf8'); } catch { V('report_missing', ref, `${p.report_path} not found`); }
      if (text !== null && sha256(text) !== p.report_sha256) V('report_sha_mismatch', ref, `${p.report_path} sha256 ${sha256(text).slice(0, 12)} != stored ${String(p.report_sha256).slice(0, 12)}`);
    } else if (p.status === 'final') V('report_missing', ref, 'final prediction without report_path');
    const chart = await verifyChart(db, p, { base });
    if (!chart.ok) (p.status === 'final' ? V : W)('chart_mismatch', ref, chart.problems.join('; '));
    if (p.run_id !== null && p.run_id !== undefined) {
      // recompute the consensus from the linked analyses and the pack baseline (Validator final review #2)
      try {
        const pack = await loadPack(db, p.pack_id);
        const linked = await q('SELECT * FROM analyses WHERE prediction_id = ? ORDER BY agent, id', [p.id]);
        const close = (pack.prices?.series ?? []).filter((x) => x.close !== null).pop()?.close ?? null;
        const c = computeConsensus({ baseline: pack.baseline, analyses: linked, model, close });
        const stored = js(p.consensus_json);
        if (stableStringify(stored) !== stableStringify(c)) V('consensus_mismatch', ref, 'consensus_json differs from a recomputation over the linked analyses and the pack baseline');
        const same = (a, b, d) => Math.abs(num(a) - num(b)) <= d;
        if (c.direction !== p.direction || !same(c.p_up, p.p_up, 5e-5) || !same(c.low, p.exp_return_low, 1e-6) || !same(c.mid, p.exp_return_mid, 1e-6)
          || !same(c.high, p.exp_return_high, 1e-6) || !same(c.confidence, p.confidence, 5e-4))
          V('consensus_mismatch', ref, `row ${p.direction} ${p.exp_return_mid} vs recomputed ${c.direction} ${c.mid}`);
      } catch (e) { V('consensus_mismatch', ref, `cannot recompute: ${e.message}`); }
    }
  }
  for (const d of await q("SELECT ticker, target_month, COUNT(*) AS n, GROUP_CONCAT(id ORDER BY id) AS ids FROM predictions WHERE status <> 'withdrawn' GROUP BY ticker, target_month HAVING n > 1"))
    V('duplicate_live_prediction', `${d.ticker} ${d.target_month}`, `${d.n} non-withdrawn predictions: ${d.ids}`);

  // ---- agent tasks: only start_run creates them (with a token), all within the run's creation
  for (const t of await q(`SELECT t.id, t.run_id, t.agent, t.ticker, t.token_sha256, TIMESTAMPDIFF(SECOND, r.created_at, t.created_at) AS lag_s
      FROM agent_tasks t JOIN runs r ON r.id = t.run_id ORDER BY t.id`)) {
    if (!t.token_sha256 || num(t.lag_s) > 120) V('task_not_from_start_run', `task ${t.id} run ${t.run_id} ${t.agent}${t.ticker ? `/${t.ticker}` : ''}`,
      !t.token_sha256 ? 'no start_run token' : `created ${t.lag_s} s after its run`);
  }
  for (const d of await q("SELECT run_id, agent, ticker, COUNT(*) AS n FROM agent_tasks GROUP BY run_id, agent, ticker HAVING n > 1"))
    V('task_not_from_start_run', `run ${d.run_id} ${d.agent}${d.ticker ? `/${d.ticker}` : ''}`, `${d.n} tasks for one (run, agent, ticker)`);

  // ---- outcomes
  for (const o of await q(`SELECT o.prediction_id, o.actual_close, o.actual_trade_date, m.close, m.trade_date FROM prediction_outcomes o
      JOIN predictions p ON p.id = o.prediction_id LEFT JOIN month_end_prices m ON m.ticker = p.ticker AND m.month = p.target_month`)) {
    if (o.close === null || num(o.close) !== num(o.actual_close) || str(o.trade_date) !== str(o.actual_trade_date))
      V('outcome_close_mismatch', `outcome ${o.prediction_id}`, `actual ${o.actual_close} @ ${str(o.actual_trade_date)} vs verified ${o.close ?? 'none'} @ ${str(o.trade_date)}`);
  }

  // ---- warnings: accepted analyses' evidence, stored features
  for (const a of await q("SELECT id, evidence_source_ids FROM analyses WHERE status = 'accepted'")) {
    const ids = (js(a.evidence_source_ids) ?? []).map(Number);
    if (!ids.length) continue;
    const bad = await q("SELECT id, verification_status AS ss FROM sources WHERE id IN (?) AND verification_status NOT IN ('verified','corroborated')", [ids]);
    for (const b of bad) W('analysis_evidence_unverified', `analysis ${a.id}`, `evidence source ${b.id} is now ${b.ss}`);
  }
  const inputs = await loadFeatureInputs(db);
  const feats = await q('SELECT ticker, month, features_sha256 FROM quant_features ORDER BY ticker, month');
  for (const f of feats) {
    const r = featuresFor(inputs, f.ticker, f.month);
    if (r.error || r.features_sha256 !== f.features_sha256) W('features_stale', `features ${f.ticker} ${f.month}`, r.error ?? 'recomputed sha differs (re-run compute_features)');
  }

  const counts = { month_end_prices: prices.length, verified_notes: notes.length, research_packs: packs.length, predictions_checked: preds.length,
    quant_features: feats.length };
  return { violations, warnings, counts };
}

async function main() {
  const args = parseArgs();
  const { roPool, closePools } = await import('../src/lib/db.mjs');
  const { dbConfig } = await import('../src/lib/env.mjs');
  try {
    const r = await auditInvariants(roPool());
    const d = dbConfig();
    if (args.json) console.log(JSON.stringify({ db: `${d.host}:${d.port}/${d.database}`, ...r }, null, 2));
    else {
      console.log(`[audit] ${d.host}:${d.port}/${d.database} checked: ${Object.entries(r.counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
      for (const v of r.violations) console.log(`VIOLATION ${v.code}: ${v.ref}: ${v.detail}`);
      for (const w of r.warnings) console.log(`warning   ${w.code}: ${w.ref}: ${w.detail}`);
      console.log(`[audit] ${r.violations.length} violation(s), ${r.warnings.length} warning(s)`);
    }
    if (r.violations.length || (args.strict && r.warnings.length)) process.exitCode = 1;
  } catch (e) {
    console.error(`[audit] failed: ${e.code ?? ''} ${e.message}`);
    process.exitCode = 2;
  } finally { await closePools(); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
