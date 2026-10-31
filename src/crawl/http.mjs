// HTTP layer for the crawlers: browser User-Agent, timeout, retry with backoff, per-host pacing, fixture mode and
// data/source-health.json bookkeeping. Ported from RIA src/crawl/http.mjs. Fixture mode reads test/fixtures/http/index.json (url -> file).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { root, crawlConfig } from '../lib/env.mjs';

export class SourceError extends Error {
  constructor(source, code, url, message, { retryable = false, status = null } = {}) {
    super(`${source} ${code}: ${message || code}`);
    this.name = 'SourceError';
    this.source = source; this.code = code; this.url = url; this.retryable = retryable; this.status = status;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const FIXTURE_DIR = process.env.CRAWL_FIXTURE_DIR || path.join(root, 'test', 'fixtures', 'http');

function fixtureIndex(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')); } catch { return {}; }
}

export function fixtureFileFor(source, url) {
  return `${source}/${crypto.createHash('sha1').update(url).digest('hex').slice(0, 12)}.json`;
}

/** Saves one recorded response (live -> fixture). */
export function recordFixture(dir, source, url, { status, text, name }) {
  const index = fixtureIndex(dir);
  const file = name ? `${source}/${name}` : fixtureFileFor(source, url);
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
  index[url] = { file, status };
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(Object.fromEntries(Object.entries(index).sort()), null, 2) + '\n');
  return file;
}

// ---- source health (data/source-health.json) ----
export function healthPath(projectDir = root) { return path.join(projectDir, 'data', 'source-health.json'); }
export function readHealth(projectDir = root) {
  try { return JSON.parse(fs.readFileSync(healthPath(projectDir), 'utf8')); } catch { return {}; }
}
export function updateHealth(patchFn, projectDir = root) {
  const file = healthPath(projectDir);
  const cur = readHealth(projectDir);
  const next = patchFn(cur) ?? cur;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return next;
}
function noteHealth(source, ok, info, projectDir) {
  try {
    updateHealth((h) => {
      const s = h[source] ?? {};
      if (ok) { s.last_ok_at = new Date().toISOString(); s.consecutive_errors = 0; }
      else { s.last_error = info; s.last_error_at = new Date().toISOString(); s.consecutive_errors = (s.consecutive_errors ?? 0) + 1; }
      h[source] = s;
      return h;
    }, projectDir);
  } catch { /* health is advisory */ }
}

/**
 * createHttp({mode, fetchImpl, sleepImpl, fixtureDir, recordDir, health, projectDir})
 * .get(url, {source, headers, timeoutMs, retries, backoffMs[], minIntervalMs, check(status, text) -> throws SourceError})
 *   -> {status, text, fetchedAt, attempts}
 */
export function createHttp({ mode = crawlConfig().mode, fetchImpl = globalThis.fetch, sleepImpl = sleep, fixtureDir = FIXTURE_DIR,
  recordDir = process.env.RECORD_FIXTURES ? FIXTURE_DIR : null, health = mode === 'live' && !process.env.NO_SOURCE_HEALTH,
  projectDir = root, jitter = true, log = () => {} } = {}) {
  const lastCall = new Map();
  let index = null;

  // Pacing is per process (lastCall) and across processes (mtime of data/pace/<host>, live mode only), so the collector
  // and the MCP server's re-fetch never hit Nasdaq closer together than minIntervalMs.
  const paceFile = (host) => path.join(projectDir, 'data', 'pace', host);
  async function pace(host, minIntervalMs) {
    if (!minIntervalMs) return;
    let last = lastCall.get(host) ?? 0;
    if (mode === 'live') { try { last = Math.max(last, fs.statSync(paceFile(host)).mtimeMs); } catch { /* first call */ } }
    const wait = last + minIntervalMs - Date.now();
    if (wait > 0) await sleepImpl(Math.min(wait, minIntervalMs));
    markCall(host, minIntervalMs);
  }
  function markCall(host, minIntervalMs) {
    lastCall.set(host, Date.now());
    if (mode !== 'live' || !minIntervalMs) return;
    try { fs.mkdirSync(path.dirname(paceFile(host)), { recursive: true }); const t = new Date(); fs.writeFileSync(paceFile(host), ''); fs.utimesSync(paceFile(host), t, t); } catch { /* advisory */ }
  }

  async function once(url, { source, headers, timeoutMs }) {
    if (mode === 'fixture') {
      index ??= fixtureIndex(fixtureDir);
      const ent = index[url];
      if (!ent) throw new SourceError(source, 'http_4xx', url, `no fixture for ${url}`, { status: 404 });
      return { status: ent.status ?? 200, text: fs.readFileSync(path.join(fixtureDir, ent.file), 'utf8') };
    }
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { headers, signal: ac.signal, redirect: 'follow' });
      const text = await res.text();
      return { status: res.status, text };
    } catch (e) {
      if (e?.name === 'AbortError') throw new SourceError(source, 'timeout', url, `timeout after ${timeoutMs} ms`, { retryable: true });
      throw new SourceError(source, 'network', url, e?.cause?.code || e?.message || String(e), { retryable: true });
    } finally { clearTimeout(t); }
  }

  async function get(url, { source, headers = {}, timeoutMs = 15000, retries = 3, backoffMs = [1000, 2000, 4000], minIntervalMs = 0, check } = {}) {
    const host = new URL(url).host;
    const ua = crawlConfig().userAgent;
    const hdrs = { 'User-Agent': ua, Accept: 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9', ...headers };
    let lastErr;
    if (mode === 'fixture') retries = 0; // recorded responses never change; retrying would only sleep
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        const base = backoffMs[Math.min(attempt - 1, backoffMs.length - 1)];
        const wait = base + (jitter && mode === 'live' ? Math.floor(Math.random() * base * 0.25) : 0);
        log(`${source} retry ${attempt}/${retries} in ${wait} ms (${lastErr?.code})`);
        await sleepImpl(wait);
      }
      await pace(host, mode === 'live' ? minIntervalMs : 0);
      const fetchedAt = new Date().toISOString();
      try {
        const r = await once(url, { source, headers: hdrs, timeoutMs });
        markCall(host, mode === 'live' ? minIntervalMs : 0);
        if (r.status === 429) throw new SourceError(source, 'rate_limited', url, 'HTTP 429', { retryable: true, status: 429 });
        if (r.status >= 500) throw new SourceError(source, 'http_5xx', url, `HTTP ${r.status}`, { retryable: true, status: r.status });
        if (r.status >= 400) throw new SourceError(source, 'http_4xx', url, `HTTP ${r.status}`, { status: r.status });
        if (check) check(r.status, r.text);
        if (recordDir && mode === 'live') recordFixture(recordDir, source, url, r);
        if (health) noteHealth(source, true, null, projectDir);
        return { ...r, fetchedAt, attempts: attempt + 1 };
      } catch (e) {
        markCall(host, mode === 'live' ? minIntervalMs : 0);
        lastErr = e instanceof SourceError ? e : new SourceError(source, 'schema', url, e?.message || String(e));
        if (!lastErr.retryable) break;
      }
    }
    // A retryable failure that survived every retry on an empty/non-JSON body is the rate limiter.
    if (lastErr.retryable && ['empty', 'non_json'].includes(lastErr.code) && retries > 0)
      lastErr = new SourceError(lastErr.source, 'rate_limited', url, `${lastErr.code} after ${retries + 1} attempts`, { retryable: true });
    if (health) noteHealth(source, false, `${lastErr.code}: ${lastErr.message}`.slice(0, 250), projectDir);
    throw lastErr;
  }

  return { get, mode };
}

/**
 * HTTP client for the safety-critical independent re-fetch (PreToolUse hook): ALWAYS live. CRAWL_MODE, CRAWL_FIXTURE_DIR and
 * RECORD_FIXTURES are ignored (BUG-004), and TLS verification cannot be switched off through the environment.
 */
export function liveHttp(opts = {}) {
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  return createHttp({ ...opts, mode: 'live', fixtureDir: null, recordDir: null });
}

let shared = null;
export const defaultHttp = () => (shared ??= createHttp());
