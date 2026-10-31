#!/usr/bin/env node
// npm run run-status -- [--run N] [--stall-minutes M] [--json]
// Project-manager report (read-only, stock_ro): the run's agent_tasks with states and timings, stalls (running longer than
// model.project_manager.stall_minutes), failures/rejections, the predictions per ticker (mid/lo/hi, status, report sha), validator
// verdicts and the finalize-gate check results. Writes
//   reports/<target>/RUN_STATUS.md     human-readable
//   data/dashboard-state.json          machine-readable state for the leader's dashboard
// Default run: the latest one.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from '../src/lib/cli.mjs';
import { roPool, closePools } from '../src/lib/db.mjs';
import { root } from '../src/lib/env.mjs';
import { clean } from '../src/lib/repo.mjs';
import { loadModel } from '../src/quant/model.mjs';
import { loadVerification } from '../src/verify/config.mjs';
import { finalizeGate } from '../src/predict/workflow.mjs';
import { reportsRoot } from '../src/report/chart.mjs';
import { pct } from '../src/quant/consensus.mjs';

const args = parseArgs();
const model = loadModel();
const cfg = loadVerification().report;
const stallMin = args.stallMinutes ? Number(args.stallMinutes) : model.project_manager.stall_minutes;
const dataDir = process.env.SP_DATA_DIR && path.isAbsolute(process.env.SP_DATA_DIR) ? process.env.SP_DATA_DIR : path.join(root, 'data');
const db = roPool();
const q = async (sql, a = []) => clean((await db.query(sql, a))[0]);
const mins = (a, b) => (a ? Math.round(((b ? new Date(b) : new Date()) - new Date(a)) / 6000) / 10 : null);
try {
  const [run] = args.run ? await q('SELECT * FROM runs WHERE id = ?', [Number(args.run)]) : await q('SELECT * FROM runs ORDER BY id DESC LIMIT 1');
  if (!run) throw new Error(args.run ? `run ${args.run} not found` : 'no runs yet');
  const tickers = typeof run.tickers === 'string' ? JSON.parse(run.tickers) : run.tickers;
  const plan = typeof run.plan === 'string' ? JSON.parse(run.plan) : (run.plan ?? {});
  const now = new Date();
  const tasks = (await q('SELECT * FROM agent_tasks WHERE run_id = ? ORDER BY id', [run.id])).map((t) => ({
    task_id: Number(t.id), agent: t.agent, ticker: t.ticker, status: t.status, started_at: t.started_at, finished_at: t.finished_at,
    duration_min: mins(t.started_at, t.finished_at), output_ref: t.output_ref, error: t.error,
    stalled: t.status === 'running' && mins(t.started_at, null) > stallMin }));
  const analyses = await q('SELECT id, agent, ticker, status, direction, exp_return_lo, exp_return_hi, confidence, attempt, review_summary FROM analyses WHERE run_id = ? ORDER BY ticker, agent, id', [run.id]);
  const predictions = [];
  for (const t of tickers) {
    const [p] = await q("SELECT * FROM predictions WHERE run_id = ? AND ticker = ? ORDER BY version DESC LIMIT 1", [run.id, t]);
    if (!p) { predictions.push({ ticker: t, status: 'none' }); continue; }
    const reviews = await q('SELECT id, verdict, report_sha256, summary, created_at FROM reviews WHERE prediction_id = ? ORDER BY id', [p.id]);
    const gate = ['draft', 'reviewed'].includes(p.status) ? await finalizeGate(db, p, { model, cfg }) : [];
    predictions.push({ ticker: t, prediction_id: Number(p.id), version: Number(p.version), status: p.status, direction: p.direction, p_up: p.p_up,
      mid: p.exp_return_mid, lo: p.exp_return_low, hi: p.exp_return_high, confidence: p.confidence, final_confidence: p.final_confidence,
      confidence_label: p.confidence_label, report_path: p.report_path, report_sha256: p.report_sha256, chart: `reports/${run.target_month}/${t}-prediction.svg`,
      validator: reviews.map((r) => ({ review_id: Number(r.id), verdict: r.verdict, on_current_sha: r.report_sha256 === p.report_sha256 })),
      checks: { finalizable: p.status === 'final' ? true : gate.length === 0, problems: gate } });
  }
  const flags = [...tasks.filter((t) => t.stalled).map((t) => `STALL: ${t.agent}${t.ticker ? `/${t.ticker}` : ''} running ${t.duration_min ?? mins(t.started_at, null)} min (> ${stallMin})`),
    ...tasks.filter((t) => ['failed', 'rejected'].includes(t.status)).map((t) => `${t.status.toUpperCase()}: ${t.agent}${t.ticker ? `/${t.ticker}` : ''}${t.error ? ` - ${t.error}` : ''}`)];
  const state = { generated_at: now.toISOString(), run_id: Number(run.id), target_month: run.target_month, as_of_month: plan.as_of_month ?? null, run_status: run.status,
    tickers, analyzers: plan.analyzers ?? [], stall_minutes: stallMin,
    agents: tasks, analyses: analyses.map((a) => ({ ...a, id: Number(a.id) })), predictions, flags,
    missing_resources: plan.missing_resources ?? [], packs: plan.packs ?? {} };
  const md = [`# Run ${run.id}: predictions for ${run.target_month} (as of ${plan.as_of_month ?? '?'})`, '',
    `Status: **${run.status}**; started ${run.started_at ?? '-'}; finished ${run.finished_at ?? '-'}. Generated ${now.toISOString()} by npm run run-status (project_manager).`, '',
    '## Flags', '', ...(flags.length ? flags.map((f) => `- ${f}`) : ['- none']), '',
    '## Predictions', '', '| Ticker | Status | Direction | Mid | Low | High | p_up | Confidence | Finalizable | Problems |', '|---|---|---|---|---|---|---|---|---|---|',
    ...predictions.map((p) => (p.status === 'none' ? `| ${p.ticker} | none | | | | | | | | |`
      : `| ${p.ticker} | ${p.status} v${p.version} | ${p.direction} | ${pct(p.mid)} | ${pct(p.lo)} | ${pct(p.hi)} | ${p.p_up} | ${p.final_confidence ?? p.confidence} (${p.confidence_label}) | ${p.checks.finalizable ? 'yes' : 'no'} | ${p.checks.problems.slice(0, 3).join('; ').replace(/\|/g, '/')} |`)), '',
    '## Agent tasks', '', '| Task | Agent | Ticker | Status | Started | Finished | Minutes | Output / error |', '|---|---|---|---|---|---|---|---|',
    ...tasks.map((t) => `| ${t.task_id} | ${t.agent} | ${t.ticker ?? '-'} | ${t.status}${t.stalled ? ' (STALLED)' : ''} | ${t.started_at ?? '-'} | ${t.finished_at ?? '-'} | ${t.duration_min ?? '-'} | ${String(t.error ?? t.output_ref ?? '').replace(/\|/g, '/').slice(0, 120)} |`), '',
    '## Analyses', '', '| Id | Ticker | Agent | Attempt | Status | Direction | Lo | Hi | Confidence |', '|---|---|---|---|---|---|---|---|---|',
    ...analyses.map((a) => `| ${a.id} | ${a.ticker} | ${a.agent} | ${a.attempt} | ${a.status} | ${a.direction} | ${pct(a.exp_return_lo)} | ${pct(a.exp_return_hi)} | ${a.confidence} |`), '',
    '## Missing resources (planner)', '', ...((plan.missing_resources ?? []).length ? plan.missing_resources.map((m) => `- ${m.ticker ?? 'all'}: ${m.kind}: ${m.detail}`) : ['- none recorded']), ''].join('\n');
  const mdPath = path.join(reportsRoot(), run.target_month, 'RUN_STATUS.md');
  fs.mkdirSync(path.dirname(mdPath), { recursive: true });
  fs.writeFileSync(mdPath, md);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'dashboard-state.json'), JSON.stringify(state, null, 2) + '\n');
  if (args.json) console.log(JSON.stringify(state, null, 2));
  else console.log(`[run-status] run ${run.id} ${run.status}: ${tasks.length} tasks, ${flags.length} flag(s); wrote ${path.relative(root, mdPath)} and ${path.relative(root, path.join(dataDir, 'dashboard-state.json'))}`);
} catch (e) { console.error(`[run-status] ${e.message}`); process.exitCode = 1; }
finally { await closePools(); }
