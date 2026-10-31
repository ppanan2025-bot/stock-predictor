// Shared I/O wrapper for PreToolUse hook scripts (PLAN §4.6 semantics):
//   allow -> exit 0, no stdout; deny -> exit 2 with "[hook] reason_code: detail. Hint: ..." on stderr;
//   malformed input / missing config / thrown error -> exit 2 (fail closed).
// Ported from RIA src/lib/hookRunner.mjs.
import { parseHookInput, isPreToolUse } from '../harness/hookDecisions.mjs';
import { fileURLToPath } from 'node:url';

export async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * @param name   hook name (for messages)
 * @param tools  tool names (string[]) or predicate this hook applies to
 * @param decide async (input) => {decision, reason}
 */
export async function runHook(name, tools, decide) {
  let code = 0;
  try {
    const input = parseHookInput(await readStdin());
    const applies = typeof tools === 'function' ? tools(input.tool_name) : tools.includes(input.tool_name);
    if (isPreToolUse(input) && applies) {
      const d = await decide(input);
      if (d?.decision === 'deny') { process.stderr.write(`[${name}] ${d.reason}\n`); code = 2; }
      else if (d?.decision !== 'allow') throw new Error('hook produced no decision');
    }
  } catch (e) {
    process.stderr.write(`[${name}] blocked (fail closed): ${e?.message || e}\n`);
    code = 2;
  }
  process.exit(code);
}

export const projectDir = () => process.env.CLAUDE_PROJECT_DIR || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
