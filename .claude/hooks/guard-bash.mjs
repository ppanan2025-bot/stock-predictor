#!/usr/bin/env node
// PreToolUse: Bash — command allowlist; no raw SQL writes, no ad-hoc node/interpreters, no volume wipes, no .env reads,
// no shell writes to protected paths (PLAN §4.6). Deny = exit 2 with "[guard-bash] reason. Hint: ..." on stderr.
import { runHook, projectDir } from '../../src/lib/hookRunner.mjs';
import { decideBashCommand } from '../../src/harness/hookDecisions.mjs';

await runHook('guard-bash', ['Bash'], async (input) => decideBashCommand(input.tool_input?.command, { cwd: input.cwd || projectDir(), projectDir: projectDir() }));
