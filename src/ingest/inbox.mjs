// Inbox parsing (PLAN §7). inbox/prices/*.csv|json and inbox/news/*.json|md; inbox/leads/ (UNVERIFIED crawler leads),
// inbox/processed/ and inbox/rejected/ are never ingested. Parsing only: every row is validated with the shared zod schemas
// and then verified server-side (ingest_price / add_news_item).
import fs from 'node:fs';
import path from 'node:path';
import { InboxPriceRow, InboxNewsItem } from '../verify/schemas.mjs';

export const INGEST_DIRS = Object.freeze({ prices: ['.csv', '.json'], news: ['.json', '.md'] });
export const IGNORED_DIRS = Object.freeze(['leads', 'processed', 'rejected']);

const issues = (err) => err.issues.slice(0, 6).map((i) => `${i.path.join('.') || 'row'}: ${i.message}`).join('; ');

/** Files to ingest, sorted (prices first). `only` restricts to one file (path relative to cwd or the inbox). */
export function listInboxFiles(inboxDir, { only = null } = {}) {
  const out = [];
  for (const [kind, exts] of Object.entries(INGEST_DIRS)) {
    const dir = path.join(inboxDir, kind);
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name); } catch { continue; }
    for (const n of names.sort()) if (exts.includes(path.extname(n).toLowerCase()) && !n.startsWith('.') && !/^readme/i.test(n)) out.push({ kind, file: path.join(dir, n) });
  }
  if (!only) return out;
  const want = path.resolve(only);
  const rel = path.resolve(inboxDir, only);
  const hit = out.filter((f) => path.resolve(f.file) === want || path.resolve(f.file) === rel);
  if (!hit.length) {
    const r = path.relative(path.resolve(inboxDir), want);
    if (r.split(path.sep)[0] && IGNORED_DIRS.includes(r.split(path.sep)[0])) throw new Error(`${only}: files under inbox/${r.split(path.sep)[0]}/ are never ingested`);
    throw new Error(`${only}: not an ingestable inbox file (inbox/prices/*.csv|json, inbox/news/*.json|md)`);
  }
  return hit;
}

/** Minimal RFC-4180 line splitter (quotes, doubled quotes). */
export function splitCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** @returns {items:[{index, line, data}], errors:[{index, line, message, raw}], fatal: string|null} */
export function parsePriceText(text, ext) {
  const items = [], errors = [];
  if (ext === '.json') {
    let arr;
    try { arr = JSON.parse(text); } catch (e) { return { items, errors, fatal: `invalid JSON: ${e.message}` }; }
    if (!Array.isArray(arr)) arr = [arr];
    arr.forEach((o, i) => { const r = InboxPriceRow.safeParse(o); if (r.success) items.push({ index: i, line: null, data: r.data }); else errors.push({ index: i, line: null, message: issues(r.error), raw: o }); });
    return { items, errors, fatal: null };
  }
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  const hIdx = lines.findIndex((l) => l.trim() && !l.trim().startsWith('#'));
  if (hIdx === -1) return { items, errors, fatal: 'empty file' };
  const header = splitCsvLine(lines[hIdx]).map((h) => h.toLowerCase());
  for (const need of ['ticker', 'month', 'trade_date', 'close']) if (!header.includes(need)) return { items, errors, fatal: `header must contain ticker,month,trade_date,close[,source_url] (missing ${need})` };
  let n = 0;
  for (let i = hIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || l.trim().startsWith('#')) continue;
    const cells = splitCsvLine(l);
    const o = Object.fromEntries(header.map((h, k) => [h, cells[k] ?? '']));
    if (o.source_url === '') delete o.source_url;
    const r = InboxPriceRow.safeParse(o);
    if (r.success) items.push({ index: n, line: i + 1, data: r.data }); else errors.push({ index: n, line: i + 1, message: issues(r.error), raw: l });
    n++;
  }
  return { items, errors, fatal: null };
}

/** Tiny YAML subset for news front-matter: `key: value` scalars and a `references:` list of `- url: ... / title: ...` maps. */
export function parseFrontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(text).replace(/^﻿/, ''));
  if (!m) throw new Error('missing YAML front-matter (--- ... ---)');
  const scalar = (v) => {
    const t = v.trim();
    if (t === '' || t === '~' || t === 'null') return null;
    if (/^".*"$/.test(t)) return JSON.parse(t);
    if (/^'.*'$/.test(t)) return t.slice(1, -1).replaceAll("''", "'");
    return t;
  };
  const out = {}; let list = null, cur = null;
  for (const raw of m[1].split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const item = /^\s+-\s+(\w+):\s*(.*)$/.exec(raw);
    const cont = /^\s{2,}(\w+):\s*(.*)$/.exec(raw);
    const top = /^(\w+):\s*(.*)$/.exec(raw);
    if (top) { list = null; if (top[2].trim() === '') { out[top[1]] = []; list = out[top[1]]; } else out[top[1]] = scalar(top[2]); continue; }
    if (item && list) { cur = { [item[1]]: scalar(item[2]) }; list.push(cur); continue; }
    if (cont && cur) { cur[cont[1]] = scalar(cont[2]); continue; }
    throw new Error(`unsupported front-matter line: ${raw.slice(0, 80)}`);
  }
  return { data: out, body: m[2].trim() };
}

export function parseNewsText(text, ext) {
  const items = [], errors = [];
  let arr;
  if (ext === '.md') {
    try { const fm = parseFrontMatter(text); arr = [{ ...fm.data, ...(fm.body && !fm.data.summary ? { summary: fm.body } : {}) }]; }
    catch (e) { return { items, errors, fatal: e.message }; }
  } else {
    try { arr = JSON.parse(text); } catch (e) { return { items, errors, fatal: `invalid JSON: ${e.message}` }; }
    if (!Array.isArray(arr)) arr = [arr];
  }
  arr.forEach((o, i) => {
    const r = InboxNewsItem.safeParse(o);
    if (r.success) items.push({ index: i, line: null, data: r.data });
    else errors.push({ index: i, line: null, message: issues(r.error), raw: { title: o?.title ?? null, url: o?.url ?? null } });
  });
  return { items, errors, fatal: null };
}

export function parseInboxFile({ kind, file }) {
  const text = fs.readFileSync(file, 'utf8');
  const ext = path.extname(file).toLowerCase();
  return kind === 'prices' ? parsePriceText(text, ext) : parseNewsText(text, ext);
}
