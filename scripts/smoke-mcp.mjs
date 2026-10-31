#!/usr/bin/env node
// Smoke helper (scripts/smoke.sh): starts the stockdb MCP server over stdio against the CURRENT env's database (smoke.sh points it
// at the throwaway test DB 127.0.0.1:3320 via SP_ENV_FILE), lists the tools and calls `stats`. Exit 1 on any drift from
// src/verify/schemas.mjs TOOL_NAMES or on a non-read-only read tool. Read-only.
import { createStockdbClient } from '../src/lib/mcpClient.mjs';
import { root } from '../src/lib/env.mjs';
import { TOOL_NAMES, READ_TOOLS } from '../src/verify/schemas.mjs';

const mcp = createStockdbClient({ projectDir: root, name: 'smoke' });
try {
  const tools = (await mcp.listTools()).tools;
  const names = tools.map((t) => t.name).sort();
  const want = [...TOOL_NAMES].sort();
  const ro = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort();
  const problems = [];
  if (JSON.stringify(names) !== JSON.stringify(want)) problems.push(`tool list drift: got ${names.join(',')}`);
  if (JSON.stringify(ro) !== JSON.stringify([...READ_TOOLS].sort())) problems.push(`read-only set drift: ${ro.join(',')}`);
  const s = await mcp.call('stats');
  console.log(`[smoke-mcp] ${tools.length} tools (${ro.length} read, ${tools.length - ro.length} write); stats coverage: ${(s.coverage ?? []).map((c) => `${c.ticker}=${c.verified_months}`).join(' ')}`);
  for (const p of problems) console.error(`[smoke-mcp] ${p}`);
  if (problems.length) process.exitCode = 1;
} catch (e) { console.error(`[smoke-mcp] ${e.message}`); process.exitCode = 1; }
finally { await mcp.close(); }
