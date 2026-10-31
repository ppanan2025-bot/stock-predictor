#!/usr/bin/env node
// PreToolUse mcp__stockdb__finalize_report: the finalize gate (report sha unchanged since review, validator pass on that sha, >= 3 accepted analyses, report guard, chart matches the DB).
// Read-only (stock_ro); fails closed. The stockdb server repeats every check.
import { runHook, projectDir } from '../../src/lib/hookRunner.mjs';
import { REPORT_TOOLS, ANALYSIS_TOOL, PREDICTION_TOOL, FINALIZE_TOOL, decideReportWrite, decideAnalysis, decidePrediction, decideFinalize } from '../../src/harness/phase4Hooks.mjs';
import { roPool, closePools } from '../../src/lib/db.mjs';
import { loadModel } from '../../src/quant/model.mjs';
import { loadVerification } from '../../src/verify/config.mjs';

await runHook('check-finalize', [FINALIZE_TOOL], async (input) => {
  const db = roPool();
  const model = loadModel({ projectDir: projectDir(), fresh: true });
  const cfg = loadVerification({ projectDir: projectDir(), fresh: true }).report;
  try { return await decideFinalize(input.tool_input, { db, model, cfg }); } finally { await closePools(); }
});
