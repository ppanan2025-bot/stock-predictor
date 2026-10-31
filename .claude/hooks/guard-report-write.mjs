#!/usr/bin/env node
// PreToolUse Write|Edit|MultiEdit on reports/**: only reports/<YYYY-MM>/<TICKER>-prediction.md is writable; the post-edit report must pass the report guard (numbers traced to the pack/DB or inside an opinion span, citations verified and in the pack, sections, disclaimer); reviewed/final reports are locked.
// Read-only (stock_ro); fails closed. The stockdb server repeats every check.
import { runHook, projectDir } from '../../src/lib/hookRunner.mjs';
import { REPORT_TOOLS, ANALYSIS_TOOL, PREDICTION_TOOL, FINALIZE_TOOL, decideReportWrite, decideAnalysis, decidePrediction, decideFinalize } from '../../src/harness/phase4Hooks.mjs';
import { roPool, closePools } from '../../src/lib/db.mjs';
import { loadModel } from '../../src/quant/model.mjs';
import { loadVerification } from '../../src/verify/config.mjs';

await runHook('guard-report-write', REPORT_TOOLS, async (input) => {
  const db = roPool();
  const model = loadModel({ projectDir: projectDir(), fresh: true });
  const cfg = loadVerification({ projectDir: projectDir(), fresh: true }).report;
  try { return await decideReportWrite(input.tool_name, input.tool_input, { db, projectDir: projectDir(), model, cfg }); } finally { await closePools(); }
});
