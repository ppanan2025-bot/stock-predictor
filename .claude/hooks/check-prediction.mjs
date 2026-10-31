#!/usr/bin/env node
// PreToolUse mcp__stockdb__save_prediction: the report file passes the report guard and a consensus (>= 3 accepted analyses) exists.
// Read-only (stock_ro); fails closed. The stockdb server repeats every check.
import { runHook, projectDir } from '../../src/lib/hookRunner.mjs';
import { REPORT_TOOLS, ANALYSIS_TOOL, PREDICTION_TOOL, FINALIZE_TOOL, decideReportWrite, decideAnalysis, decidePrediction, decideFinalize } from '../../src/harness/phase4Hooks.mjs';
import { roPool, closePools } from '../../src/lib/db.mjs';
import { loadModel } from '../../src/quant/model.mjs';
import { loadVerification } from '../../src/verify/config.mjs';

await runHook('check-prediction', [PREDICTION_TOOL], async (input) => {
  const db = roPool();
  const model = loadModel({ projectDir: projectDir(), fresh: true });
  const cfg = loadVerification({ projectDir: projectDir(), fresh: true }).report;
  try { return await decidePrediction(input.tool_input, { db, model, cfg }); } finally { await closePools(); }
});
