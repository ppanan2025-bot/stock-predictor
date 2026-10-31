// MCP client for the stockdb server: spawns `node mcp-server/index.mjs` over stdio, reconnects lazily with backoff.
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { root as defaultRoot, readDotEnv } from './env.mjs';

/** The tool answered with isError (rejection, not found, db_error, ...). */
export class McpToolError extends Error {
  constructor(tool, payload) {
    super(`${tool}: ${payload?.message || payload?.reason || 'tool error'}`);
    this.name = 'McpToolError';
    this.tool = tool;
    this.reason = payload?.reason ?? 'tool_error';
    this.payload = payload ?? {};
  }
}

/** MCP transport not available (spawn failure, crash, timeout, backoff window). */
export class McpUnavailableError extends Error {
  constructor(message, cause) { super(message); this.name = 'McpUnavailableError'; this.code = 'mcp_down'; this.cause = cause; }
}

/**
 * Keys never passed to the MCP child: no password of any kind (Validator Phase 2 #2: a child's exec environment is visible to
 * `ps eww`). The server loads its credentials itself (src/lib/env.mjs reads .env; tests select test/db/test.env with SP_ENV_FILE).
 */
const NEVER_PASS = /PASSWORD|^MYSQL_PWD$/i;

/**
 * Environment for the MCP server child (Validator P1 #6, Phase 2 #2): only SP_* keys are taken from .env; the real process env
 * and explicit overrides follow; every *PASSWORD* key is dropped (the child reads its own credentials file).
 */
export function childEnv(projectDir, overrides = {}, { dotEnv = readDotEnv(path.join(projectDir, '.env')), processEnv = process.env } = {}) {
  const fromDot = Object.fromEntries(Object.entries(dotEnv).filter(([k]) => k.startsWith('SP_')));
  const out = { ...fromDot, ...processEnv, ...overrides };
  for (const k of Object.keys(out)) if (NEVER_PASS.test(k) || out[k] === undefined) delete out[k];
  return out;
}

function payloadOf(res) {
  if (res?.structuredContent && typeof res.structuredContent === 'object') return res.structuredContent;
  const text = (res?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  try { return JSON.parse(text); } catch {
    return /input validation error/i.test(text) ? { reason: 'invalid_input', message: text } : { message: text };
  }
}

export function createStockdbClient({ projectDir = defaultRoot, env = {}, serverPath, timeoutMs = 30000, name = 'stockdb-client',
  minBackoffMs = 1000, maxBackoffMs = 30000, log = (...a) => console.error('[mcp-client]', ...a) } = {}) {
  let client = null;
  let connecting = null;
  let isConnected = false;
  let backoff = minBackoffMs;
  let nextAttemptAt = 0;
  let closed = false;
  const script = serverPath || path.join(projectDir, 'mcp-server/index.mjs');

  async function connect() {
    if (isConnected && client) return client;
    if (connecting) return connecting;
    if (closed) throw new McpUnavailableError('client closed');
    if (Date.now() < nextAttemptAt) throw new McpUnavailableError(`MCP server unavailable; retry in ${nextAttemptAt - Date.now()} ms`);
    connecting = (async () => {
      const transport = new StdioClientTransport({
        command: process.execPath, args: [script], cwd: projectDir, stderr: 'inherit',
        env: childEnv(projectDir, env),
      });
      const c = new Client({ name, version: '1.0.0' });
      transport.onclose = () => {
        if (client === c) { isConnected = false; client = null; if (!closed) log('MCP server connection closed'); }
      };
      try {
        await c.connect(transport, { timeout: 15000 });
      } catch (e) {
        nextAttemptAt = Date.now() + backoff;
        backoff = Math.min(maxBackoffMs, backoff * 2);
        await c.close().catch(() => {});
        throw new McpUnavailableError(`cannot start MCP server: ${e?.message || e}`, e);
      }
      client = c;
      isConnected = true;
      backoff = minBackoffMs;
      nextAttemptAt = 0;
      return c;
    })();
    try { return await connecting; } finally { connecting = null; }
  }

  async function call(toolName, args = {}, { timeout = timeoutMs } = {}) {
    const c = await connect();
    let res;
    try {
      res = await c.callTool({ name: toolName, arguments: args }, undefined, { timeout, resetTimeoutOnProgress: false });
    } catch (e) {
      // Protocol-level invalid params (e.g. zod input validation) are tool errors, not transport failures.
      if (e?.code === -32602 || e?.code === -32601) throw new McpToolError(toolName, { reason: 'invalid_input', message: e.message });
      // Timeout / transport failure: drop the child so the next call respawns it.
      isConnected = false;
      const old = client; client = null;
      await old?.close().catch(() => {});
      throw new McpUnavailableError(`${toolName}: ${e?.message || e}`, e);
    }
    const payload = payloadOf(res);
    if (res?.isError) throw new McpToolError(toolName, payload);
    return payload;
  }

  return {
    connect,
    call,
    callTool: call,
    listTools: async () => (await connect()).listTools(),
    connected: () => isConnected,
    async close() { closed = true; isConnected = false; const c = client; client = null; await c?.close().catch(() => {}); },
  };
}
