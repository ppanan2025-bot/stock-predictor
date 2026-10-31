// Unit (no DB): CLAUDE.md cannot drift from the harness. It must stay <= 150 lines and name every MCP tool registered in
// mcp-server/index.mjs, every hook file and every hook wired in .claude/settings.json (with its event), every skill, every
// runtime agent (frontmatter name and file), and every doc / nested CLAUDE.md it points to must exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_NAMES, READ_TOOLS, IMPLEMENTED_WRITE_TOOLS } from '../src/verify/schemas.mjs';
import { AGENT_ROLES, HELPER_AGENTS } from '../src/lib/agents.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const md = read('CLAUDE.md');
const has = (s) => md.includes(s);
const section = (title) => { const i = md.indexOf(`## ${title}`); assert.ok(i >= 0, `section ${title}`); const j = md.indexOf('\n## ', i + 3); return md.slice(i, j < 0 ? undefined : j); };

test('CLAUDE.md stays lean (<= 150 lines)', () => {
  const lines = md.split('\n').length - (md.endsWith('\n') ? 1 : 0);
  assert.ok(lines <= 150, `CLAUDE.md has ${lines} lines`);
});

test('CLAUDE.md names every MCP tool registered by the server (and classifies read vs write)', () => {
  const registered = [...read('mcp-server/index.mjs').matchAll(/^tool\('([a-z_]+)'/gm)].map((m) => m[1]);
  assert.deepEqual([...registered].sort(), [...TOOL_NAMES].sort(), 'server registrations == TOOL_NAMES');
  assert.equal(registered.length, 26);
  const tools = section('stockdb MCP tools');
  const [readPart, writePart] = tools.split(/^Write \(/m);
  assert.ok(writePart, 'tool section has a Write part');
  for (const t of READ_TOOLS) assert.match(readPart, new RegExp(`\`${t}\``), `read tool ${t} listed under Read`);
  for (const t of IMPLEMENTED_WRITE_TOOLS) assert.match(writePart, new RegExp(`\`${t}\``), `write tool ${t} listed under Write`);
});

test('CLAUDE.md names every hook file and every hook wired in settings.json with its event', () => {
  const files = fs.readdirSync(path.join(ROOT, '.claude/hooks')).filter((f) => f.endsWith('.mjs'));
  assert.ok(files.length >= 12);
  const hooks = section('Hooks');
  for (const f of files) assert.ok(hooks.includes(`\`${f}\``), `hook file ${f} in the hook table`);
  const settings = JSON.parse(read('.claude/settings.json'));
  for (const [event, groups] of Object.entries(settings.hooks)) {
    for (const g of groups) for (const h of g.hooks) {
      const file = h.command.match(/hooks\/([\w-]+\.mjs)/)?.[1];
      assert.ok(file && files.includes(file), `settings hook ${h.command} points to an existing file`);
      const row = hooks.split('\n').find((l) => l.includes(`\`${file}\``));
      assert.ok(row, `row for ${file}`);
      assert.ok(row.includes(event), `${file} row names its event ${event}`);
    }
  }
  // every MCP write tool is gated by the server; the hook-gated ones must have a PreToolUse matcher
  const matchers = settings.hooks.PreToolUse.map((g) => g.matcher).join('|');
  for (const t of ['ingest_price', 'add_news_item', 'add_source', 'add_research_note', 'save_analysis', 'save_prediction', 'finalize_report'])
    assert.ok(matchers.includes(`mcp__stockdb__${t}`), `PreToolUse matcher covers ${t}`);
});

test('CLAUDE.md names every skill (as /<name>) and every skill directory has a SKILL.md with a matching name', () => {
  const dirs = fs.readdirSync(path.join(ROOT, '.claude/skills'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  for (const want of ['ingest-inbox', 'verify-resources', 'research-company', 'company-context', 'predict-next-month', 'review-prediction', 'score-outcomes', 'audit-db'])
    assert.ok(dirs.includes(want), `skill ${want} exists`);
  for (const d of dirs) {
    const skill = read(`.claude/skills/${d}/SKILL.md`);
    assert.match(skill, new RegExp(`^name: ${d}$`, 'm'), `${d}/SKILL.md name`);
    assert.match(skill, /^allowed-tools: /m, `${d}/SKILL.md allowed-tools`);
    assert.ok(has(`/${d}`), `CLAUDE.md mentions /${d}`);
  }
});

test('CLAUDE.md names every runtime agent by name and file', () => {
  const files = fs.readdirSync(path.join(ROOT, '.claude/agents')).filter((f) => f.endsWith('.md'));
  assert.equal(files.length, AGENT_ROLES.length + HELPER_AGENTS.length);
  const roster = section('Runtime agents');
  for (const f of files) {
    const name = read(`.claude/agents/${f}`).match(/^name: ([\w-]+)$/m)?.[1];
    assert.ok(name, `${f} has a name`);
    assert.ok(roster.includes(`\`${name}\``), `agent ${name} in the roster`);
    assert.ok(roster.includes(f), `agent file ${f} in the roster`);
  }
});

test('CLAUDE.md golden rules and context-management essentials are present', () => {
  for (const s of ['Never fabricate', '.env', 'untrusted', 'inbox/leads/', 'not investment advice', 'run_readonly_sql', 'raw SQL'])
    assert.ok(has(s), `golden rules mention ${s}`);
  const ctx = section('Context management');
  for (const s of ['context/companies/<TICKER>.md', 'npm run context', 'pack_id', 'get_research_pack', 'reports/CLAUDE.md', 'Compaction', 'prediction_id', 'pack_sha256'])
    assert.ok(ctx.includes(s), `context section mentions ${s}`);
});

test('every doc and nested CLAUDE.md referenced from CLAUDE.md exists', () => {
  const refs = new Set([...md.matchAll(/`((?:docs|reports|inbox|context)\/[A-Za-z_]+\.md)`/g)].map((m) => m[1]));
  for (const r of ['docs/METHOD.md', 'docs/VERIFICATION.md', 'docs/SCHEMA.md', 'docs/SOURCES.md', 'docs/AGENTS.md', 'docs/REPORT_TEMPLATE.md',
    'reports/CLAUDE.md', 'inbox/CLAUDE.md', 'context/CLAUDE.md']) assert.ok(refs.has(r), `CLAUDE.md references ${r}`);
  for (const r of refs) assert.ok(fs.existsSync(path.join(ROOT, r)), `${r} exists`);
  for (const f of ['src/verify/reasons.mjs', 'src/report/reportCheck.mjs', 'docs/PLAN.md', 'PROJECT_STATUS.md']) assert.ok(has(f) && fs.existsSync(path.join(ROOT, f)), f);
});

test('every npm script named in CLAUDE.md exists in package.json', () => {
  const scripts = JSON.parse(read('package.json')).scripts;
  for (const s of ['setup', 'db:up', 'db:migrate', 'ingest', 'backfill', 'crawl', 'features', 'context', 'baseline', 'backtest', 'draw', 'run-status', 'audit', 'validate', 'smoke', 'test'])
    assert.ok(scripts[s], `package.json script ${s}`);
});
