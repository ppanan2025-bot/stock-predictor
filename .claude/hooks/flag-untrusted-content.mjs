#!/usr/bin/env node
// PostToolUse: WebFetch | mcp__stockdb__get_source | mcp__stockdb__get_research_pack — scans the result for instruction-like
// text (prompt injection). On a hit it returns additionalContext telling Claude the content is untrusted data, and logs the
// event to data/agent-audit.jsonl. Never blocks (always exit 0).
import fs from 'node:fs';
import path from 'node:path';
import { readStdin, projectDir } from '../../src/lib/hookRunner.mjs';
import { scanUntrusted, responseText, untrustedWarning } from '../../src/harness/hookDecisions.mjs';

try {
  const input = JSON.parse(await readStdin());
  const findings = scanUntrusted(responseText(input?.tool_response));
  if (findings.length) {
    try {
      const file = path.join(projectDir(), 'data', 'agent-audit.jsonl');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), event: 'untrusted_content_flag', tool: input.tool_name ?? null,
        findings, agent_type: input.agent_type ?? null, session_id: input.session_id ?? null }) + '\n');
    } catch { /* logging is best effort */ }
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: untrustedWarning(input.tool_name ?? 'tool', findings) } }) + '\n');
  }
} catch (e) {
  process.stderr.write(`[flag-untrusted-content] ${e?.message || e}\n`);
}
process.exit(0);
