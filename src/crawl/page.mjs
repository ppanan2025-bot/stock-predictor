// Web page fetch + extraction for sources (PLAN §3 add_source): https, 15 s timeout, 3 MB cap, at most 3 redirects with EVERY
// hop re-checked against the domain policy, browser UA. Extracts title candidates (og:title, <title>, JSON-LD headline, <h1>),
// the published time (article:published_time / JSON-LD datePublished / <time datetime> / common meta), the canonical link and
// the main text (scripts, styles, navigation and forms stripped). Page text is DATA: it is only hashed, measured, cached and
// matched, never interpreted. Fixture mode (CRAWL_MODE=fixture, tests only) reads test/fixtures/http/index.json
// ({url: {file, status, location?, content_type?}}). sec.gov hosts are fetched with the declared SEC contact User-Agent
// (SP_HTTP_UA) and refused with sec_user_agent_unset while it is unset or a placeholder. rawBody=true returns the unparsed body
// (RSS/Atom/JSON listings for the crawlers) after the same policy/redirect/status checks.
import fs from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { crawlConfig } from '../lib/env.mjs';
import { sha256 } from '../lib/hash.mjs';
import { FIXTURE_DIR } from './http.mjs';
import { checkUrl } from '../verify/domainPolicy.mjs';
import { SOURCE_REASONS } from '../verify/reasons.mjs';
import { isSecHost, secUserAgentProblem } from './secUa.mjs';
import { detectWire } from '../verify/wire.mjs';

/** author / publisher / sourceOrganization / provider names anywhere in JSON-LD. */
function ldNames(node, depth = 0, under = false, out = []) {
  if (!node || depth > 8) return out;
  if (Array.isArray(node)) { for (const x of node) ldNames(x, depth + 1, under, out); return out; }
  if (typeof node === 'string') { if (under) out.push(node); return out; }
  if (typeof node !== 'object') return out;
  if (under && typeof node.name === 'string') out.push(node.name);
  for (const [k, v] of Object.entries(node)) {
    if (['author', 'publisher', 'sourceOrganization', 'provider', 'creator'].includes(k)) ldNames(v, depth + 1, true, out);
    else if (['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement'].includes(k)) ldNames(v, depth + 1, false, out);
  }
  return out;
}

/** NFKC, unified quotes and dashes, collapsed whitespace (the basis of content_sha256 and excerpt matching). */
export function normalizeText(s) {
  return String(s ?? '').normalize('NFKC')
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/[  -​  　﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const BLOCK = 'p,div,br,li,h1,h2,h3,h4,h5,h6,section,article,blockquote,tr,td,th,dd,dt,figcaption,pre';
const STRIP = 'script,style,noscript,template,svg,iframe,object,embed,nav,header,footer,aside,form,button,select,input,textarea,dialog,[aria-hidden=true],[hidden]';

function findInLd(node, key, depth = 0) {
  if (!node || depth > 6) return null;
  if (Array.isArray(node)) { for (const x of node) { const v = findInLd(x, key, depth + 1); if (v) return v; } return null; }
  if (typeof node !== 'object') return null;
  if (typeof node[key] === 'string' && node[key].trim()) return node[key].trim();
  for (const k of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement']) { const v = findInLd(node[k], key, depth + 1); if (v) return v; }
  return null;
}

/** Parses an ISO-ish date/time; returns an ISO string or null. Date-only values are taken as 00:00 UTC. */
export function parseDate(s) {
  const v = String(s ?? '').trim();
  if (!v) return null;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
  if (!Number.isFinite(t)) return null;
  const y = new Date(t).getUTCFullYear();
  return y >= 1990 && y <= 2100 ? new Date(t).toISOString() : null;
}

/** Does a CSS declaration block hide its element? Comments are removed and whitespace collapsed first. */
export function hidesStyle(style) {
  const d = String(style ?? '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '').toLowerCase().replace(/!important/g, '');
  if (!d) return false;
  const decl = new Map();
  for (const part of d.split(';')) { const i = part.indexOf(':'); if (i > 0) decl.set(part.slice(0, i), part.slice(i + 1)); }
  const v = (k) => decl.get(k) ?? '';
  const zero = (x) => /^(-?0+(\.0+)?(px|em|rem|%|pt|vh|vw)?)$/.test(x);
  if (v('display') === 'none') return true;
  if (['hidden', 'collapse'].includes(v('visibility'))) return true;
  if (decl.has('opacity') && (zero(v('opacity')) || Number.parseFloat(v('opacity')) <= 0.05)) return true;
  if (decl.has('font-size')) {
    const fs = Number.parseFloat(v('font-size'));
    if (zero(v('font-size')) || (Number.isFinite(fs) && (/px$/.test(v('font-size')) ? fs < 2 : /(em|rem)$/.test(v('font-size')) ? fs < 0.2 : /%$/.test(v('font-size')) ? fs < 20 : false))) return true;
  }
  for (const k of ['left', 'top', 'right', 'bottom', 'text-indent', 'margin-left', 'margin-top']) {
    const n = Number.parseFloat(v(k));
    if (Number.isFinite(n) && n <= -999) return true;
  }
  if (/^rect\(0(px)?[, ]*0(px)?[, ]*0(px)?[, ]*0(px)?\)$/.test(v('clip')) || /^rect\(0/.test(v('clip'))) return true;
  if (/^(inset\((50|100)%\)|circle\(0)/.test(v('clip-path'))) return true;
  if (/scale\(0(\.0+)?\)|scale[xy]\(0(\.0+)?\)/.test(v('transform'))) return true;
  const ovh = ['hidden', 'clip'].includes(v('overflow')) || ['hidden', 'clip'].includes(v('overflow-y')) || ['hidden', 'clip'].includes(v('overflow-x'));
  if (ovh && ((decl.has('height') && zero(v('height'))) || (decl.has('max-height') && zero(v('max-height'))) || (decl.has('width') && zero(v('width'))))) return true;
  if ((v('width') === '1px' && v('height') === '1px' && ovh)) return true;
  return false;
}

/** Selectors of <style> rules whose declarations hide (simple class/id/tag/attribute selectors; @media blocks are flattened). */
export function hiddenSelectors(css) {
  const out = [];
  const t = String(css ?? '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{/g, '');
  for (const m of t.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!hidesStyle(m[2])) continue;
    for (const sel of m[1].split(',').map((x) => x.trim()).filter(Boolean)) {
      if (/^[\w\s.#\-\[\]="':>*~+()]+$/.test(sel) && !/^(html|body|main|article)$/i.test(sel)) out.push(sel.replace(/::?(before|after)$/, ''));
    }
  }
  return out;
}

/** Pure extraction from HTML. */
export function extractPage(html, { url = null, minTextLen = 300 } = {}) {
  const $ = cheerio.load(String(html ?? ''));
  const ld = [];
  $('script[type="application/ld+json"]').each((_, el) => { try { ld.push(JSON.parse($(el).text())); } catch { /* ignore */ } });
  const meta = (sel) => normalizeText($(sel).first().attr('content') ?? '') || null;
  const titles = [
    meta('meta[property="og:title"]'), meta('meta[name="twitter:title"]'), normalizeText($('title').first().text()) || null,
    normalizeText(findInLd(ld, 'headline') ?? '') || null, normalizeText($('h1').first().text()) || null,
  ].filter(Boolean);
  const dateCandidates = [
    ['meta:article:published_time', meta('meta[property="article:published_time"]')],
    ['jsonld:datePublished', findInLd(ld, 'datePublished')],
    ['meta:itemprop', $('[itemprop="datePublished"]').first().attr('content') ?? $('[itemprop="datePublished"]').first().attr('datetime') ?? null],
    ['meta:name', meta('meta[name="pubdate"]') ?? meta('meta[name="publishdate"]') ?? meta('meta[name="parsely-pub-date"]') ?? meta('meta[name="sailthru.date"]')
      ?? meta('meta[name="article.published"]') ?? meta('meta[name="dc.date"]') ?? meta('meta[name="date"]') ?? meta('meta[property="og:published_time"]')],
    ['time', $('time[datetime]').first().attr('datetime') ?? null],
    ['jsonld:uploadDate', findInLd(ld, 'uploadDate')],
  ];
  let published_at = null, published_from = null;
  for (const [src, v] of dateCandidates) { const d = parseDate(v); if (d) { published_at = d; published_from = src; break; } }
  const metaAuthor = meta('meta[name="author"]') ?? meta('meta[property="article:author"]') ?? null;
  const metaSite = meta('meta[name="article:source"]') ?? meta('meta[name="dc.source"]') ?? null;
  let canonical = $('link[rel="canonical"]').first().attr('href') ?? null;
  if (canonical && url) { try { canonical = new URL(canonical, url).toString(); } catch { canonical = null; } }
  const hiddenRules = hiddenSelectors($('style').map((_, el) => $(el).text()).get().join('\n'));
  $(STRIP).remove();
  // hidden text is not page content (Validator Phase 2 #5, Phase 3 #3): inline styles and <style> class/id/tag rules that hide
  // (display:none, visibility:hidden|collapse, opacity:0, font-size:0, off-screen positioning, clip rect(0), zero size with
  // overflow hidden, scale(0)), the hidden attribute and aria-hidden=true (any case) all remove the element and its subtree.
  for (const sel of hiddenRules) { try { $(sel).remove(); } catch { /* unsupported selector: ignored */ } }
  $('[hidden]').remove();
  $('*').filter((_, el) => /^\s*true\s*$/i.test($(el).attr('aria-hidden') ?? '') || hidesStyle($(el).attr('style') ?? '')).remove();
  $(BLOCK).each((_, el) => { $(el).append('\n'); });
  const textOf = (sel) => normalizeText($(sel).map((_, el) => $(el).text()).get().join('\n'));
  let text = '';
  for (const sel of ['article', '[itemprop="articleBody"]', 'main', 'body']) {
    const t = textOf(sel);
    if (t.length >= minTextLen) { text = t; break; }
    if (t.length > text.length) text = t;
  }
  // body_text: all visible body text (same stripping); research-note excerpts may sit outside the main article block
  const body_text = textOf('body') || text;
  // wire-agency copy, detected on the fetched page itself (dateline, JSON-LD/meta author or publisher, copyright line)
  const names = [...ldNames(ld), metaAuthor, metaSite].filter(Boolean);
  const wire = detectWire({ text, names });
  return { title: titles[0] ?? null, titles: [...new Set(titles)], published_at, published_from, canonical, text, text_len: text.length, body_text,
    wire_agency: wire.agency, wire_evidence: wire.evidence };
}

function fixtureIndex(dir) { try { return JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')); } catch { return {}; } }

async function readCapped(res, maxBytes) {
  const reader = res.body?.getReader?.();
  if (!reader) { const t = await res.text(); return { text: t.slice(0, maxBytes), truncated: t.length > maxBytes }; }
  const chunks = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > maxBytes) { await reader.cancel().catch(() => {}); return { text: null, truncated: true }; }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'), truncated: false };
}

const fail = (reason, extra = {}) => ({ ok: false, reason, status_class: SOURCE_REASONS[reason] ?? 'rejected', ...extra });

/**
 * Fetches `url` (already policy-checked by the caller) following at most maxRedirects redirects, each re-checked.
 * @returns {ok, reason, status_class, http_status, final_url, redirects[], fetched_at, policy, title, titles, published_at, canonical,
 *           text, text_len, content_sha256}
 */
export async function fetchPage(url, { policy, irDomains = [], mode = crawlConfig().mode, fetchImpl = globalThis.fetch, fixtureDir = FIXTURE_DIR,
  timeoutMs = 15000, maxBytes = 3 * 1024 * 1024, maxRedirects = 3, minTextLen = 300, rawBody = false, secUserAgent = crawlConfig().secUserAgent } = {}) {
  const redirects = [];
  let cur = url;
  let index = null;
  const fetched_at = new Date().toISOString();
  for (let hop = 0; ; hop++) {
    const pol = checkUrl(cur, policy, irDomains, { requireHttps: hop > 0 });
    if (!pol.allowed) return fail(hop > 0 ? 'redirect_denied' : pol.reason, { message: pol.message, final_url: cur, redirects, fetched_at });
    let status, location = null, contentType = null, text = null;
    if (mode === 'fixture') {
      index ??= fixtureIndex(fixtureDir);
      const ent = index[cur];
      if (!ent) return fail('not_found', { http_status: 404, message: `no fixture for ${cur}`, final_url: cur, redirects, fetched_at });
      status = ent.status ?? 200; location = ent.location ?? null; contentType = ent.content_type ?? 'text/html';
      if (ent.error) return fail(ent.error, { message: `fixture ${ent.error}`, final_url: cur, redirects, fetched_at });
      text = ent.file ? fs.readFileSync(path.join(fixtureDir, ent.file), 'utf8') : '';
    } else {
      // SEC EDGAR requires a declared contact User-Agent (never a browser UA); refuse while SP_HTTP_UA is unset or a placeholder
      let ua = crawlConfig().userAgent;
      if (isSecHost(pol.host)) {
        const problem = secUserAgentProblem(secUserAgent, { live: true });
        if (problem) return fail('sec_user_agent_unset', { message: problem, final_url: cur, redirects, fetched_at });
        ua = secUserAgent;
      }
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await fetchImpl(cur, { redirect: 'manual', signal: ac.signal, headers: { 'User-Agent': ua,
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'Accept-Language': 'en-US,en;q=0.9' } });
        status = res.status; location = res.headers.get('location'); contentType = res.headers.get('content-type');
        if (status >= 200 && status < 300) {
          const r = await readCapped(res, maxBytes);
          if (r.truncated) return fail('too_large', { http_status: status, message: `body larger than ${maxBytes} bytes`, final_url: cur, redirects, fetched_at });
          text = r.text;
        } else await res.body?.cancel?.().catch(() => {});
      } catch (e) {
        if (e?.name === 'AbortError') return fail('timeout', { message: `timeout after ${timeoutMs} ms`, final_url: cur, redirects, fetched_at });
        return fail('network', { message: String(e?.cause?.code || e?.message || e).slice(0, 200), final_url: cur, redirects, fetched_at });
      } finally { clearTimeout(t); }
    }
    if (status >= 300 && status < 400 && location) {
      if (hop >= maxRedirects) return fail('too_many_redirects', { http_status: status, final_url: cur, redirects, fetched_at });
      let next;
      try { next = new URL(location, cur).toString(); } catch { return fail('redirect_denied', { message: `bad Location ${location}`, final_url: cur, redirects, fetched_at }); }
      redirects.push({ from: cur, to: next, status });
      cur = next;
      continue;
    }
    const base = { http_status: status, final_url: cur, redirects, fetched_at, policy: pol };
    if (status === 404 || status === 410) return fail('not_found', base);
    if (status === 429) return fail('rate_limited', base);
    if (status >= 500) return fail('server_error', base);
    if (status >= 300) return fail('http_error', base);
    if (rawBody) return { ok: true, reason: 'ok', status_class: 'verified', ...base, content_type: contentType, body: text ?? '' };
    if (contentType && !/html|xml/i.test(contentType)) return fail('not_html', { ...base, message: `content-type ${contentType}` });
    const ex = extractPage(text, { url: cur, minTextLen });
    const out = { ...base, ...ex, content_sha256: ex.text ? sha256(ex.text) : null };
    if (ex.text_len < minTextLen) return { ...fail(pol.paywall ? 'paywalled' : 'thin_content', out), message: `${ex.text_len} chars of text (< ${minTextLen})` };
    return { ok: true, reason: 'ok', status_class: 'verified', ...out };
  }
}
