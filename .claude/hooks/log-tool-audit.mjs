#!/usr/bin/env node
// PostToolUse: mcp__stockdb__.* | WebFetch | WebSearch — appends {at, tool, input_summary, ok, reason, agent_type} to
// data/agent-audit.jsonl (a mirror of the server-side audit_log). Never blocks; failures are non-fatal.
import fs from 'node:fs';
import path from 'node:path';
import { readStdin, projectDir } from '../../src/lib/hookRunner.mjs';
import { summarizeToolInput, toolResponseOk, toolResponseReason } from '../../src/harness/hookDecisions.mjs';

try {
  const input = JSON.parse(await readStdin());
  const t = input?.tool_name;
  if (typeof t === 'string' && (t.startsWith('mcp__stockdb__') || t === 'WebFetch' || t === 'WebSearch')) {
    const file = path.join(projectDir(), 'data', 'agent-audit.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), tool: t, input_summary: summarizeToolInput(input.tool_input),
      ok: toolResponseOk(input.tool_response), reason: toolResponseReason(input.tool_response), agent_type: input.agent_type ?? null,
      session_id: input.session_id ?? null }) + '\n');
  }
} catch (e) {
  process.stderr.write(`[log-tool-audit] ${e?.message || e}\n`);
}
process.exit(0);
