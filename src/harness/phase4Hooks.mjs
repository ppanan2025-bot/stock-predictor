// Phase 4 hook decisions (read-only, stock_ro). The stockdb server repeats every check (authoritative); these give the agent an
// early, explainable denial. All fail closed (a thrown error = exit 2 in hookRunner).
//   guard-report-write  PreToolUse Write|Edit|MultiEdit on reports/**
//   verify-analysis     PreToolUse mcp__stockdb__save_analysis
//   check-prediction    PreToolUse mcp__stockdb__save_prediction
//   check-finalize      PreToolUse mcp__stockdb__finalize_report
import fs from 'node:fs';
import path from 'node:path';
import { allow, deny, zodIssues } from './hookDecisions.mjs';
import { SaveAnalysisSchema, SavePredictionInput, FinalizeReportInput } from '../verify/schemas.mjs';
import { z } from 'zod';
import { analysisProblems, checkReportText, finalizeGate, loadRun, WorkflowError } from '../predict/workflow.mjs';
import { parseFrontMatter } from '../report/reportCheck.mjs';
import { reportsRoot } from '../report/chart.mjs';
import { clean } from '../lib/repo.mjs';

export const REPORT_TOOLS = Object.freeze(['Write', 'Edit', 'MultiEdit']);
export const ANALYSIS_TOOL = 'mcp__stockdb__save_analysis';
export const PREDICTION_TOOL = 'mcp__stockdb__save_prediction';
export const FINALIZE_TOOL = 'mcp__stockdb__finalize_report';
const REPORT_HINT = 'Hint: copy numbers and the call from get_consensus / the pack, put analyzer-only numbers inside <!-- opinion:<agent> --> … <!-- /opinion --> '
  + 'spans (they must be in that agent\'s saved analysis), cite only [S<id>] from get_consensus.report.reference_lines, and keep every section of docs/REPORT_TEMPLATE.md.';
const fmt = (code, detail, hint = '') => `${code}: ${detail}${hint ? ` ${hint}` : ''}`;

/** reports/... path relative to the reports root, or null when the file is not under it. */
export function reportRel(filePath, projectDir) {
  const abs = path.resolve(path.isAbsolute(filePath) ? filePath : path.join(projectDir, filePath));
  const base = path.resolve(process.env.SP_REPORTS_DIR && path.isAbsolute(process.env.SP_REPORTS_DIR) ? process.env.SP_REPORTS_DIR : path.join(projectDir, 'reports'));
  const r = path.relative(base, abs);
  if (r.startsWith('..') || path.isAbsolute(r)) return null;
  return `reports/${r.split(path.sep).join('/')}`;
}

/** Post-edit content for Write / Edit / MultiEdit (Edit applies old -> new to the current file; a missing old_string throws). */
export function postEditContent(toolName, ti, abs) {
  if (toolName === 'Write') return String(ti.content ?? '');
  let cur = fs.readFileSync(abs, 'utf8');
  const edits = toolName === 'MultiEdit' ? ti.edits ?? [] : [ti];
  for (const e of edits) {
    if (!cur.includes(e.old_string)) throw new Error('old_string not found in the current report');
    cur = e.replace_all ? cur.split(e.old_string).join(e.new_string) : cur.replace(e.old_string, () => e.new_string);
  }
  return cur;
}

export async function decideReportWrite(toolName, ti, { db, projectDir, model, cfg }) {
  const p = ti?.file_path;
  if (typeof p !== 'string' || !p) return deny(fmt('bad_input', `${toolName} needs a file_path`));
  const rel = reportRel(p, projectDir);
  if (!rel) return allow();
  const m = /^reports\/(\d{4}-(?:0[1-9]|1[0-2]))\/([A-Z][A-Z0-9.]{0,9})-prediction\.md$/.exec(rel);
  if (!m) return deny(fmt('report_generated', `${rel} is not writable by hand: only reports/<YYYY-MM>/<TICKER>-prediction.md is; charts/sidecars come from npm run draw and RUN_STATUS.md from npm run run-status`));
  const [, target, ticker] = m;
  const abs = path.resolve(path.isAbsolute(p) ? p : path.join(projectDir, p));
  const locked = clean((await db.query("SELECT id, status FROM predictions WHERE report_path = ? AND status IN ('reviewed','final') ORDER BY id DESC LIMIT 1", [rel]))[0])[0];
  if (locked) return deny(fmt('report_locked', `prediction ${locked.id} for ${rel} is ${locked.status}; an edited report would no longer match the reviewed sha256`,
    'Hint: withdraw_prediction first (reason), then rewrite and save_prediction a new version for re-validation.'));
  let content;
  try { content = postEditContent(toolName, ti, abs); } catch (e) { return deny(fmt('bad_edit', e.message)); }
  const { front } = parseFrontMatter(content);
  const runId = Number(front?.run_id);
  if (!Number.isInteger(runId) || runId <= 0) return deny(fmt('front_matter_missing', 'the report needs front matter with run_id (copy get_consensus.report.front_matter)', REPORT_HINT));
  if (front.ticker !== ticker || front.target_month !== target) return deny(fmt('front_matter_mismatch', `file is ${ticker} ${target} but front matter says ${front.ticker} ${front.target_month}`, REPORT_HINT));
  try {
    const r = await checkReportText(db, content, { run_id: runId, ticker, model, cfg });
    if (!r.ok) return deny(fmt('report_check_failed', r.problems.slice(0, 12).join('; ') + (r.problems.length > 12 ? ` (+${r.problems.length - 12} more)` : ''), REPORT_HINT));
  } catch (e) {
    if (e instanceof WorkflowError) return deny(fmt(e.reason, e.message, REPORT_HINT));
    throw e;
  }
  return allow();
}

export async function decideAnalysis(ti, { db, model }) {
  const r = SaveAnalysisSchema.safeParse(ti ?? {});
  if (!r.success) return deny(fmt('bad_schema', zodIssues(r.error)));
  try {
    const { run, problems } = await analysisProblems(db, r.data, { model });
    if (!(run.plan.analyzers ?? []).includes(r.data.agent)) return deny(fmt('agent_not_dispatched', `${r.data.agent} is not an analyzer of run ${run.id}`));
    if (problems.length) return deny(fmt('analysis_check_failed', problems.join('; '),
      'Hint: cite only source ids from this run\'s pack (get_research_pack {pack_id}) that are verified; keep the range consistent with the direction.'));
  } catch (e) { if (e instanceof WorkflowError) return deny(fmt(e.reason, e.message)); throw e; }
  return allow();
}

export async function decidePrediction(ti, { db, model, cfg }) {
  const r = z.object(SavePredictionInput).strict().safeParse(ti ?? {});
  if (!r.success) return deny(fmt('bad_schema', zodIssues(r.error)));
  try {
    const run = await loadRun(db, r.data.run_id);
    if (r.data.report_path !== `reports/${run.target_month}/${r.data.ticker}-prediction.md`) return deny(fmt('bad_report_path', `expected reports/${run.target_month}/${r.data.ticker}-prediction.md`));
    let text;
    try { text = fs.readFileSync(path.join(reportsRoot(), r.data.report_path.slice('reports/'.length)), 'utf8'); } catch { return deny(fmt('report_missing', r.data.report_path)); }
    const c = await checkReportText(db, text, { run_id: run.id, ticker: r.data.ticker, model, cfg });
    if (!c.rc.consensus) return deny(fmt(c.rc.consensus_error.reason, c.rc.consensus_error.message));
    if (!c.ok) return deny(fmt('report_check_failed', c.problems.slice(0, 12).join('; '), REPORT_HINT));
  } catch (e) { if (e instanceof WorkflowError) return deny(fmt(e.reason, e.message)); throw e; }
  return allow();
}

export async function decideFinalize(ti, { db, model, cfg }) {
  const r = z.object(FinalizeReportInput).strict().safeParse(ti ?? {});
  if (!r.success) return deny(fmt('bad_schema', zodIssues(r.error)));
  const pred = clean((await db.query('SELECT * FROM predictions WHERE id = ?', [r.data.prediction_id]))[0])[0];
  if (!pred) return deny(fmt('not_found', `prediction ${r.data.prediction_id}`));
  const problems = await finalizeGate(db, pred, { model, cfg });
  if (problems.length) return deny(fmt('not_finalizable', problems.join('; '),
    'Hint: a validator pass on the CURRENT report sha (no edits after review), >= 3 accepted analyses and a chart drawn after save_prediction are required.'));
  return allow();
}
