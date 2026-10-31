#!/usr/bin/env node
// PreToolUse: Write|Edit|MultiEdit|NotebookEdit — .env*, data/**, context/companies/**, *-reviews.md always blocked; outside
// SP_DEV_MODE=1 (real process env only) only reports/<T>/*-prediction.md, inbox/prices|news/*, docs/**, README.md,
// PROJECT_STATUS.md and dashboard/** are writable (PLAN §4.6).
import { runHook, projectDir } from '../../src/lib/hookRunner.mjs';
import { decideProtectedFile } from '../../src/harness/hookDecisions.mjs';

await runHook('guard-protected-files', ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
  async (input) => decideProtectedFile(input.tool_name, input.tool_input, projectDir()));
