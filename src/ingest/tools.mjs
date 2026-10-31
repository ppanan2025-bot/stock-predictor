// Server-side implementations of the Phase 2 write tools (PLAN §3): ingest_price, add_source, add_news_item, recheck_sources.
// These are AUTHORITATIVE: hooks do not fire for script-driven MCP calls, so every check is re-implemented here. Each function
// takes a mysql2 promise connection (`db`) inside a transaction managed by the caller (the MCP server: one transaction per
// call; ingest --dry-run: one transaction for the whole batch, rolled back) and a context from createToolContext().
import fs from 'node:fs';
import path from 'node:path';
import { root } from '../lib/env.mjs';
import { clean } from '../lib/repo.mjs';
import { createHttp } from '../crawl/http.mjs';
import { fetchPage } from '../crawl/page.mjs';
import { parsePrice, formatUnits } from '../crawl/parse.mjs';
import { loadVerification, loadPolicy } from '../verify/config.mjs';
import { verifyPrice, createPriceCache } from '../verify/priceRefetch.mjs';
import { checkUrl, irDomainsOf, normHost } from '../verify/domainPolicy.mjs';
import { canonicalUrl } from '../verify/canonicalize.mjs';
import { decideNewsItem, submittedInterval } from '../verify/newsRule.mjs';
import { evaluate, countsAsIndependent } from '../verify/corroborate.mjs';
import { isWireCopy, isWireCopyOf } from '../verify/wire.mjs';
import { SOURCE_TRANSIENT } from '../verify/reasons.mjs';

const rows = async (db, sql, args = []) => clean((await db.query(sql, args))[0]);
const one = async (db, sql, args = []) => (await rows(db, sql, args))[0] ?? null;
const asDate = (iso) => (iso ? new Date(iso) : null);
const H = 3600000;

/**
 * @param opts.http        price crawler http (defaults: live, or fixture when CRAWL_MODE=fixture)
 * @param opts.pageFetch   (url) => fetchPage result (defaults to crawl/page.mjs with config limits)
 * @param opts.dryRun      never write the page cache
 */
export function createToolContext({ projectDir = root, http = null, pageFetch = null, now = () => new Date(), dryRun = false, log = () => {} } = {}) {
  const cfg = loadVerification({ projectDir });
  const policy = loadPolicy({ projectDir });
  const ctx = {
    projectDir, cfg, policy, now, dryRun, log,
    // generated page text (get_source untrusted_content); SP_PAGE_CACHE_DIR lets tests keep it out of the project's data/
    pageCacheDir: process.env.SP_PAGE_CACHE_DIR || path.join(projectDir, 'data', 'page-cache'),
    http: http ?? createHttp({ projectDir }),
    priceCache: createPriceCache(),
    irDomains: [],
    companies: [],
    bodies: new Map(), // content_sha256 -> article text fetched in this process (dry-run never writes the page cache)
  };
  ctx.pageFetch = pageFetch ?? ((url) => fetchPage(url, { policy, irDomains: ctx.irDomains, timeoutMs: cfg.news.fetch.timeout_ms,
    maxBytes: cfg.news.fetch.max_bytes, maxRedirects: cfg.news.fetch.max_redirects, minTextLen: cfg.news.min_text_len }));
  return ctx;
}

/** Companies from the DB (the source of truth for tickers, listing dates and IR domains). */
export async function refreshCompanies(db, ctx) {
  ctx.companies = (await rows(db, 'SELECT ticker, name, listed_on, active, ir_domains FROM companies')).map((c) => ({
    ...c, ir_domains: typeof c.ir_domains === 'string' ? JSON.parse(c.ir_domains) : (c.ir_domains ?? []) }));
  ctx.irDomains = irDomainsOf(ctx.companies);
  return ctx.companies;
}

export async function audit(db, tool, args, ok, reason, actor = 'mcp') {
  const summary = JSON.stringify(args, (k, v) => (typeof v === 'string' && v.length > 300 ? `${v.slice(0, 300)}…` : v));
  await db.query('INSERT INTO audit_log (actor, tool, args_summary, ok, reason) VALUES (?,?,?,?,?)', [actor, tool, summary, ok ? 1 : 0, reason ? String(reason).slice(0, 64) : null]);
}

// ------------------------------------------------------------------ ingest_price
export async function ingestPrice(db, args, ctx) {
  await refreshCompanies(db, ctx);
  const sub = { ticker: args.ticker, month: args.month, trade_date: args.trade_date, close: String(args.close) };
  const base = { ticker: sub.ticker, month: sub.month, trade_date: sub.trade_date, submitted_close: sub.close, origin: args.origin };
  if (!ctx.companies.some((c) => c.ticker === sub.ticker))
    return { ...base, status: 'rejected', reason: 'unknown_ticker', submission_id: null, detail: { message: `${sub.ticker} is not in companies` } };
  const units = parsePrice(sub.close);
  const existing = await one(db, 'SELECT id, trade_date, close FROM month_end_prices WHERE ticker = ? AND month = ?', [sub.ticker, sub.month]);
  const insertSub = async (status, reason, detail, closeOverride = null) => (await db.query(
    'INSERT INTO price_submissions (ticker, month, trade_date, close, origin, inbox_file, submitted_source_url, status, reason, detail) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [sub.ticker, sub.month, sub.trade_date, closeOverride ?? (units != null && units > 0 ? formatUnits(units) : null), args.origin, args.inbox_file ?? null,
      args.submitted_source_url ?? null, status, reason, JSON.stringify(detail ?? {})]))[0].insertId;
  if (existing) {
    const exUnits = parsePrice(existing.close);
    if (units != null && existing.trade_date === sub.trade_date && Math.abs(exUnits - units) <= ctx.cfg.price.submittedToleranceUnits)
      return { ...base, status: 'verified', reason: 'ok', duplicate: true, price_id: Number(existing.id), close: existing.close, submission_id: null,
        detail: { message: 'already verified; nothing written' } };
    const detail = { existing_close: existing.close, existing_trade_date: existing.trade_date, message: 'a different verified close is stored; it is never overwritten' };
    return { ...base, status: 'rejected', reason: 'conflict_existing', submission_id: await insertSub('rejected', 'conflict_existing', detail), detail };
  }
  const r = await verifyPrice(sub, { companies: ctx.companies, cfg: ctx.cfg.price, http: ctx.http, now: ctx.now(), cache: ctx.priceCache });
  if (r.status !== 'verified') {
    const id = r.reason === 'unknown_ticker' ? null : await insertSub(r.status, r.reason, r.detail);
    return { ...base, status: r.status, reason: r.reason, submission_id: id, detail: r.detail };
  }
  // verified: the stored close is the canonical Nasdaq close (the submitted value is kept in detail.submitted_close)
  const v = r.verified;
  const subId = await insertSub('verified', 'ok', r.detail, v.close);
  const [res] = await db.query('INSERT INTO month_end_prices SET ?', [{ ticker: v.ticker, month: v.month, trade_date: v.trade_date, close: v.close, submission_id: subId,
    source_a_url: v.source_a_url, source_a_close: v.source_a_close, source_a_fetched_at: new Date(v.source_a_fetched_at),
    source_b_url: v.source_b_url, source_b_close: v.source_b_close, source_b_fetched_at: new Date(v.source_b_fetched_at),
    abs_diff: v.abs_diff, tolerance_abs: v.tolerance_abs }]);
  return { ...base, status: 'verified', reason: 'ok', submission_id: subId, price_id: res.insertId, close: v.close, detail: r.detail };
}

// ------------------------------------------------------------------ add_source
function writePageCache(ctx, page) {
  if (ctx.dryRun || !page?.content_sha256 || !page.text) return;
  try {
    const dir = ctx.pageCacheDir;
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `${page.content_sha256}.txt`);
    if (!fs.existsSync(f)) fs.writeFileSync(f, page.text);
  } catch (e) { ctx.log(`page cache: ${e.message}`); }
}

const publicSource = (s, extra = {}) => ({ source_id: Number(s.id), url_canonical: s.url_canonical, domain: s.domain, outlet_key: s.outlet_key,
  ownership_group: s.ownership_group, tier: s.tier, kind: s.kind, title_fetched: s.title_fetched, published_at_fetched: s.published_at_fetched,
  http_status: s.http_status, content_sha256: s.content_sha256, text_len: s.text_len, status: s.verification_status, reason: s.verification_reason, ...extra });

/**
 * Canonicalise, apply the domain policy, fetch, extract and store (idempotent on url_canonical). With refetch=false an existing
 * verified/corroborated source is reused without a network call. Returns the public source plus a non-serialised `_page`.
 */
export async function addSource(db, { url, kind = 'news', refetch = false }, ctx) {
  if (!ctx.irDomains.length) await refreshCompanies(db, ctx);
  const pol = checkUrl(url, ctx.policy, ctx.irDomains);
  let canon;
  try { canon = pol.url_canonical ?? canonicalUrl(url); } catch { canon = String(url).trim(); }
  canon = canon.slice(0, 700);
  const existing = await one(db, 'SELECT * FROM sources WHERE url_canonical = ?', [canon]);
  if (existing && !refetch && pol.allowed && ['verified', 'corroborated'].includes(existing.verification_status))
    return publicSource(existing, { reused: true, _page: null });
  if (!pol.allowed) {
    if (existing) {
      await db.query('UPDATE sources SET verification_status = ?, verification_reason = ?, last_checked_at = UTC_TIMESTAMP(3) WHERE id = ?', ['rejected', pol.reason, existing.id]);
      return publicSource({ ...existing, verification_status: 'rejected', verification_reason: pol.reason }, { message: pol.message, _page: null });
    }
    const domain = (pol.host ?? (() => { try { return normHost(new URL(url).hostname); } catch { return 'invalid'; } })()).slice(0, 255) || 'invalid';
    const [res] = await db.query('INSERT INTO sources (url_canonical, url_original, domain, kind, verification_status, verification_reason, last_checked_at) VALUES (?,?,?,?,?,?,UTC_TIMESTAMP(3))',
      [canon, String(url).slice(0, 2000), domain, kind, 'rejected', pol.reason]);
    return publicSource({ id: res.insertId, url_canonical: canon, domain, kind, verification_status: 'rejected', verification_reason: pol.reason }, { message: pol.message, _page: null });
  }
  const page = await ctx.pageFetch(canon);
  const status = page.ok ? 'verified' : page.status_class;
  const fields = { title_fetched: page.title ? page.title.slice(0, 500) : null, published_at_fetched: asDate(page.published_at), http_status: page.http_status ?? null,
    fetched_at: asDate(page.fetched_at), content_sha256: page.content_sha256 ?? null, text_len: page.text_len ?? null, wire_agency: page.ok ? (page.wire_agency ?? null) : null };
  let id, drift = null, stale = false;
  if (existing) {
    // a corroborated source stays corroborated while it keeps verifying; content drift is recorded, not rejected.
    // As in recheck_sources, a transient failure never demotes a verified/corroborated source (only a policy/404-class rejection does).
    stale = !page.ok && status !== 'rejected' && ['verified', 'corroborated'].includes(existing.verification_status);
    const newStatus = stale ? existing.verification_status
      : status === 'verified' && existing.verification_status === 'corroborated' ? 'corroborated' : status;
    const newReason = stale ? existing.verification_reason : page.reason;
    drift = existing.content_sha256 && fields.content_sha256 && existing.content_sha256 !== fields.content_sha256 ? { old_sha256: existing.content_sha256 } : null;
    const keep = page.ok ? fields : {}; // a failed re-fetch keeps the last good evidence
    await db.query('UPDATE sources SET ?, verification_status = ?, verification_reason = ?, last_checked_at = UTC_TIMESTAMP(3) WHERE id = ?',
      [{ ...keep, http_status: page.http_status ?? null }, newStatus, newReason, existing.id]);
    id = existing.id;
    Object.assign(existing, keep, { verification_status: newStatus, verification_reason: newReason, http_status: page.http_status ?? null });
  } else {
    const [res] = await db.query('INSERT INTO sources SET ?, last_checked_at = UTC_TIMESTAMP(3)', [{ url_canonical: canon, url_original: String(url).slice(0, 2000),
      domain: pol.host, outlet_key: pol.outlet_key, ownership_group: pol.ownership_group, tier: pol.tier, kind, ...fields,
      verification_status: status, verification_reason: page.reason }]);
    id = res.insertId;
  }
  if (page.ok) { writePageCache(ctx, page); if (page.content_sha256 && page.text && ctx.bodies.size < 500) ctx.bodies.set(page.content_sha256, page.text); }
  const row = existing ?? { id, url_canonical: canon, domain: pol.host, outlet_key: pol.outlet_key, ownership_group: pol.ownership_group, tier: pol.tier, kind,
    ...fields, verification_status: status, verification_reason: page.reason };
  return publicSource(clean({ ...row, id }), { final_url: page.final_url ?? null, redirects: page.redirects?.length ?? 0, ...(page.message ? { message: page.message } : {}),
    ...(drift ? { content_drift: drift } : {}), ...(stale ? { refetch_failed: page.reason } : {}), _page: page });
}

// ------------------------------------------------------------------ corroboration
const groupKey = (s) => s.ownership_group ?? s.outlet_key ?? s.domain;

/** Fetched article text for syndication checks: the in-memory page, else the generated page cache (by content sha). */
function bodyOf(ctx, sha, page = null) {
  if (page?.text && (!sha || page.content_sha256 === sha)) return page.text;
  if (!sha) return null;
  if (ctx.bodies?.has(sha)) return ctx.bodies.get(sha);
  try { return fs.readFileSync(path.join(ctx.pageCacheDir, `${sha}.txt`), 'utf8'); } catch { return null; }
}
/** Wire copy from the submitted URL/summary OR (Validator Phase 2 #3) from the fetched page's wire_agency. */
const wireCopy = (s, summary) => isWireCopy({ url: s.url_canonical, summary }) || isWireCopyOf(s.wire_agency, s.ownership_group);

/**
 * Candidate sources around `atMs` (+-window): verified/corroborated, titled, with a FETCHED publication date (a submitted date
 * is not evidence), plus their linked news summary if any.
 */
async function candidates(db, atMs, windowH, excludeId, ctx) {
  const lo = new Date(atMs - windowH * H), hi = new Date(atMs + windowH * H);
  const list = await rows(db, `SELECT s.id, s.url_canonical, s.domain, s.outlet_key, s.ownership_group, s.title_fetched, s.content_sha256, s.wire_agency,
      s.published_at_fetched AS published_at,
      (SELECT n.summary_submitted FROM news_items n WHERE n.source_id = s.id AND n.summary_submitted IS NOT NULL ORDER BY n.id LIMIT 1) AS summary
    FROM sources s WHERE s.verification_status IN ('verified','corroborated') AND s.title_fetched IS NOT NULL AND s.id <> ?
      AND s.published_at_fetched BETWEEN ? AND ? ORDER BY s.id LIMIT 500`, [excludeId, lo, hi]);
  return list.map((c) => ({ id: Number(c.id), title: c.title_fetched, summary: c.summary, content_hash: c.content_sha256, published_at: c.published_at,
    outlet_key: c.outlet_key, group: groupKey(c), is_wire_copy: wireCopy(c, c.summary), body: bodyOf(ctx, c.content_sha256) }));
}

/** Corroboration of one article (NCA rule): independent ownership groups among matching candidates within the window. */
export async function corroborateArticle(db, article, ctx) {
  const c = ctx.cfg.news.corroboration;
  const at = Date.parse(article.published_at);
  if (!Number.isFinite(at)) return { meetsRule: false, independentGroups: [], matches: [], independent_source_ids: [] };
  const r = evaluate(article, await candidates(db, at, c.window_hours, article.id, ctx), c);
  const independent = r.matches.filter(countsAsIndependent);
  const ids = [...new Set(independent.map((m) => Number(m.id)))].sort((a, b) => a - b);
  return { ...r, independent_source_ids: ids,
    rejected_wire_or_syndicated: r.matches.filter((m) => !countsAsIndependent(m)).map((m) => ({ id: m.id, wire: m.wireCopy, syndicated: m.syndicated })) };
}

async function articleOf(db, newsRow, ctx, page = null) {
  const s = await one(db, 'SELECT * FROM sources WHERE id = ?', [newsRow.source_id]);
  return { id: Number(s.id), title: s.title_fetched ?? newsRow.title_submitted, summary: newsRow.summary_submitted, content_hash: s.content_sha256,
    published_at: s.published_at_fetched ?? newsRow.published_at_submitted, outlet_key: s.outlet_key, group: groupKey(s),
    is_wire_copy: wireCopy(s, newsRow.summary_submitted), body: bodyOf(ctx, s.content_sha256, page) };
}

/** Sets a verified/corroborated news item's corroboration state; also marks its source corroborated when it qualifies. */
async function applyCorroboration(db, newsId, sourceId, corr, ctx, { allowDowngrade = false, current = 'verified' } = {}) {
  const min = ctx.cfg.news.corroboration.min_independent_outlets;
  const count = corr.independentGroups.length;
  const status = count >= min ? 'corroborated' : 'verified';
  if (status === 'verified' && current === 'corroborated' && !allowDowngrade) return current; // upgrades only, unless a source was rejected
  await db.query('UPDATE news_items SET status = ?, reason = ?, corroboration_count = ?, corroborating_source_ids = ? WHERE id = ?',
    [status, status === 'corroborated' ? 'corroborated' : 'ok', count, JSON.stringify(corr.independent_source_ids), newsId]);
  if (status === 'corroborated') await db.query("UPDATE sources SET verification_status = 'corroborated' WHERE id = ? AND verification_status = 'verified'", [sourceId]);
  return status;
}

/** Re-evaluates verified (and, with allowDowngrade, corroborated) news items around atMs. Returns changed ids. */
export async function recorroborate(db, ctx, { atMs, ids = null, allowDowngrade = false } = {}) {
  const w = ctx.cfg.news.corroboration.window_hours;
  // only items whose source is still usable: re-deciding an item on an unreachable/rejected source would trip trg_news_bu
  // (and such an item is not evidence anyway; get_research_pack excludes it)
  const usable = "s.verification_status IN ('verified','corroborated') AND s.content_sha256 IS NOT NULL";
  const list = ids?.length
    ? await rows(db, `SELECT n.* FROM news_items n JOIN sources s ON s.id = n.source_id WHERE n.id IN (?) AND n.status IN ('verified','corroborated') AND ${usable}`, [ids])
    : await rows(db, `SELECT n.* FROM news_items n JOIN sources s ON s.id = n.source_id WHERE n.status IN ('verified','corroborated') AND ${usable}
        AND COALESCE(s.published_at_fetched, n.published_at_submitted) BETWEEN ? AND ?`, [new Date(atMs - w * H), new Date(atMs + w * H)]);
  const changed = [];
  for (const n of list) {
    const corr = await corroborateArticle(db, await articleOf(db, n, ctx), ctx);
    const st = await applyCorroboration(db, n.id, n.source_id, corr, ctx, { allowDowngrade, current: n.status });
    if (st !== n.status) changed.push({ news_item_id: Number(n.id), from: n.status, to: st });
  }
  return changed;
}

// ------------------------------------------------------------------ add_news_item
function sourceToNewsOutcome(src) {
  if (['verified', 'corroborated'].includes(src.status)) return null;
  if (src.status === 'unreachable' && SOURCE_TRANSIENT.has(src.reason))
    return { status: 'pending', reason: 'source_unreachable', message: `source fetch failed (${src.reason}${src.http_status ? ` HTTP ${src.http_status}` : ''}); retry later` };
  return { status: 'rejected', reason: 'source_rejected', message: `source ${src.status}: ${src.reason}${src.message ? ` (${src.message})` : ''}` };
}

const toDbTime = (v) => { const iv = submittedInterval(v); return iv ? new Date(iv.from) : null; };

/** A rejected source: its news items are rejected; items it corroborated are re-evaluated (may lose corroboration). */
async function cascadeSourceRejection(db, ctx, sourceId) {
  const out = [];
  for (const n of await rows(db, "SELECT id, status FROM news_items WHERE source_id = ? AND status <> 'rejected'", [sourceId])) {
    await db.query("UPDATE news_items SET status = 'rejected', reason = 'source_rejected' WHERE id = ?", [n.id]);
    out.push({ news_item_id: Number(n.id), from: n.status, to: 'rejected' });
  }
  const dependents = await rows(db, "SELECT id FROM news_items WHERE status = 'corroborated' AND JSON_CONTAINS(corroborating_source_ids, CAST(? AS JSON))", [String(sourceId)]);
  out.push(...await recorroborate(db, ctx, { ids: dependents.map((d) => d.id), allowDowngrade: true }));
  return out;
}

export async function addNewsItem(db, args, ctx) {
  await refreshCompanies(db, ctx);
  const scope = args.scope ?? (args.ticker ? 'company' : null);
  const ticker = args.ticker ?? null;
  const base = { ticker, scope, url: args.url, title: args.title, published_at: args.published_at };
  if (!scope) return { ...base, status: 'rejected', reason: 'bad_schema', news_item_id: null, message: 'company news needs a ticker; world/market news needs scope "macro"' };
  const company = ticker ? ctx.companies.find((c) => c.ticker === ticker) : null;
  if (ticker && !company) return { ...base, status: 'rejected', reason: 'unknown_ticker', news_item_id: null, message: `${ticker} is not in companies` };
  if (!submittedInterval(args.published_at)) return { ...base, status: 'rejected', reason: 'bad_schema', news_item_id: null, message: `published_at ${args.published_at} is not a date` };

  const src = await addSource(db, { url: args.url, kind: 'news', refetch: true }, ctx);
  const page = src._page;
  // references: each one is a source verified the same way; references without a URL are recorded in the result only
  const refs = [];
  let refsWithoutUrl = 0;
  for (const ref of args.references ?? []) {
    if (!ref?.url) { refsWithoutUrl++; continue; }
    const r = await addSource(db, { url: ref.url, kind: 'news' }, ctx);
    refs.push({ url: ref.url, source_id: r.source_id, status: r.status, reason: r.reason, outlet_key: r.outlet_key });
  }

  const dup = await one(db, 'SELECT * FROM news_items WHERE source_id = ? AND scope = ? AND ticker <=> ? ORDER BY id LIMIT 1', [src.source_id, scope, ticker]);
  let decision = sourceToNewsOutcome(src);
  if (!decision && src.refetch_failed) // source kept its status but this fetch failed: nothing fresh to decide on
    decision = { status: 'pending', reason: 'source_unreachable', message: `source re-fetch failed (${src.refetch_failed}${src.http_status ? ` HTTP ${src.http_status}` : ''}); stored status kept, retry later` };
  if (!decision) {
    if (!page) throw new Error('internal: verified source without a fetched page');
    decision = decideNewsItem({ title: args.title, published_at: args.published_at, scope }, page, ctx.cfg.news, { company });
  }
  let newsId, status = decision.status, reason = decision.reason, corr = null, cascaded = [];
  if (dup) {
    newsId = Number(dup.id);
    // a pending item may now verify; a final (verified/corroborated/rejected) item is never re-decided here,
    // except that a source rejected on this re-fetch cascades exactly as in recheck_sources
    if (src.status === 'rejected' && dup.status !== 'rejected') {
      cascaded = await cascadeSourceRejection(db, ctx, src.source_id);
    } else if (dup.status === 'pending' && decision.status !== 'pending') {
      await db.query('UPDATE news_items SET status = ?, reason = ? WHERE id = ?', [decision.status, decision.reason, newsId]);
    } else { status = dup.status; reason = dup.reason; }
  } else {
    const [res] = await db.query('INSERT INTO news_items SET ?', [{ ticker, scope, source_id: src.source_id, title_submitted: String(args.title).slice(0, 500),
      published_at_submitted: toDbTime(args.published_at), summary_submitted: args.summary ?? null, inbox_file: args.inbox_file ?? null,
      title_similarity: decision.title_similarity ?? null, date_delta_hours: decision.date_delta_hours ?? null, status: decision.status, reason: decision.reason }]);
    newsId = res.insertId;
  }
  for (const r of refs) await db.query('INSERT IGNORE INTO news_references (news_item_id, source_id) VALUES (?,?)', [newsId, r.source_id]);
  if (['verified', 'corroborated'].includes(status) && !src.refetch_failed) {
    const row = await one(db, 'SELECT * FROM news_items WHERE id = ?', [newsId]);
    const article = await articleOf(db, row, ctx, page);
    corr = await corroborateArticle(db, article, ctx);
    status = await applyCorroboration(db, newsId, src.source_id, corr, ctx, { current: row.status });
    if (status === 'corroborated') reason = 'corroborated';
  }
  // a newly verified source can complete the corroboration of earlier items in its window (upgrades only)
  const at = Date.parse(page?.published_at ?? '') || submittedInterval(args.published_at).from;
  const upgraded = ['verified', 'corroborated'].includes(src.status) ? await recorroborate(db, ctx, { atMs: at }) : [];
  return {
    ...base, news_item_id: newsId, duplicate: !!dup, source_id: src.source_id, source_status: src.status, source_reason: src.reason,
    status, reason, message: decision.message ?? null, title_similarity: decision.title_similarity ?? null, matched_title: decision.matched_title ?? null,
    date_delta_hours: decision.date_delta_hours ?? null, page_published_at: page?.published_at ?? null,
    wire_copy: isWireCopy({ url: src.url_canonical, summary: args.summary, author: args.author }) || isWireCopyOf(page?.wire_agency, src.ownership_group),
    wire_agency: page?.wire_agency ?? null,
    corroboration: corr ? { count: corr.independentGroups.length, independent_groups: corr.independentGroups, source_ids: corr.independent_source_ids,
      not_independent: corr.rejected_wire_or_syndicated } : null,
    references: refs, references_without_url: refsWithoutUrl,
    ...(refsWithoutUrl ? { references_note: 'references without a URL are recorded only; they never count toward corroboration' } : {}),
    upgraded_items: upgraded.filter((u) => u.news_item_id !== newsId),
    ...(cascaded.length ? { cascade: cascaded } : {}),
  };
}

// ------------------------------------------------------------------ recheck_sources
/**
 * Re-applies the CURRENT corroboration rule to verified/corroborated news items (optionally only a ticker's), downgrades
 * included: used after the rule is tightened (Validator Phase 2 #4). A source stays 'corroborated' only while one of its news
 * items is corroborated.
 */
export async function reevaluateCorroboration(db, ctx, { ticker = null } = {}) {
  const list = await rows(db, `SELECT id FROM news_items WHERE status IN ('verified','corroborated') ${ticker ? 'AND (ticker = ? OR scope = \'macro\')' : ''} ORDER BY id`, ticker ? [ticker] : []);
  const changes = list.length ? await recorroborate(db, ctx, { ids: list.map((x) => x.id), allowDowngrade: true }) : [];
  const stale = await rows(db, `SELECT s.id FROM sources s WHERE s.verification_status = 'corroborated'
    AND NOT EXISTS (SELECT 1 FROM news_items n WHERE n.source_id = s.id AND n.status = 'corroborated')`);
  for (const x of stale) await db.query("UPDATE sources SET verification_status = 'verified', verification_reason = 'ok' WHERE id = ? AND verification_status = 'corroborated'", [x.id]);
  return { evaluated: list.length, changes, sources_downgraded: stale.map((x) => Number(x.id)) };
}

export async function recheckSources(db, { source_ids, ticker, older_than_days, limit = 25, reevaluate_corroboration = false } = {}, ctx) {
  await refreshCompanies(db, ctx);
  if (reevaluate_corroboration && !source_ids?.length && older_than_days === undefined) {
    const r = await reevaluateCorroboration(db, ctx, { ticker: ticker ?? null });
    return { checked: 0, results: [], corroboration_changes: r.changes, sources_downgraded: r.sources_downgraded, evaluated: r.evaluated,
      summary: r.changes.reduce((acc, c) => { const k = `${c.from}->${c.to}`; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {}) };
  }
  const w = []; const a = [];
  if (source_ids?.length) { w.push('s.id IN (?)'); a.push(source_ids); }
  if (ticker) {
    w.push(`(EXISTS (SELECT 1 FROM news_items n WHERE n.source_id = s.id AND n.ticker = ?) OR EXISTS (SELECT 1 FROM news_references r JOIN news_items n ON n.id = r.news_item_id
      WHERE r.source_id = s.id AND n.ticker = ?) OR EXISTS (SELECT 1 FROM research_notes x WHERE x.source_id = s.id AND x.ticker = ?))`);
    a.push(ticker, ticker, ticker);
  }
  if (older_than_days !== undefined) { w.push('(s.last_checked_at IS NULL OR s.last_checked_at < UTC_TIMESTAMP(3) - INTERVAL ? DAY)'); a.push(older_than_days); }
  if (!w.length) w.push("(s.verification_status IN ('pending','unreachable') OR s.last_checked_at IS NULL OR s.last_checked_at < UTC_TIMESTAMP(3) - INTERVAL 14 DAY)");
  const list = await rows(db, `SELECT s.* FROM sources s WHERE ${w.join(' AND ')} AND s.verification_status <> 'rejected' ORDER BY s.id LIMIT ?`, [...a, limit]);
  const out = [];
  const touched = new Set();
  for (const s of list) {
    const before = s.verification_status;
    const pol = checkUrl(s.url_canonical, ctx.policy, ctx.irDomains);
    let after, reason, drift = null, page = null;
    if (!pol.allowed) {
      after = 'rejected'; reason = pol.reason;
      await db.query("UPDATE sources SET verification_status = 'rejected', verification_reason = ?, last_checked_at = UTC_TIMESTAMP(3) WHERE id = ?", [reason, s.id]);
    } else {
      page = await ctx.pageFetch(s.url_canonical);
      reason = page.reason;
      if (page.ok) {
        after = before === 'corroborated' ? 'corroborated' : 'verified';
        if (s.content_sha256 && page.content_sha256 !== s.content_sha256) drift = { old_sha256: s.content_sha256, new_sha256: page.content_sha256 };
        await db.query('UPDATE sources SET ?, verification_status = ?, verification_reason = ?, last_checked_at = UTC_TIMESTAMP(3) WHERE id = ?', [{
          title_fetched: page.title ? page.title.slice(0, 500) : null, published_at_fetched: asDate(page.published_at), http_status: page.http_status,
          fetched_at: asDate(page.fetched_at), content_sha256: page.content_sha256, text_len: page.text_len, wire_agency: page.wire_agency ?? null }, after, 'ok', s.id]);
        writePageCache(ctx, page);
      } else if (page.status_class === 'rejected') {
        after = 'rejected';
        await db.query("UPDATE sources SET verification_status = 'rejected', verification_reason = ?, http_status = ?, last_checked_at = UTC_TIMESTAMP(3) WHERE id = ?", [reason, page.http_status ?? null, s.id]);
      } else if (['pending', 'unreachable'].includes(before)) {
        after = page.status_class;
        await db.query('UPDATE sources SET verification_status = ?, verification_reason = ?, http_status = ?, last_checked_at = UTC_TIMESTAMP(3) WHERE id = ?', [after, reason, page.http_status ?? null, s.id]);
      } else {
        after = before; // a transient failure never demotes a verified source
        await db.query('UPDATE sources SET last_checked_at = UTC_TIMESTAMP(3) WHERE id = ?', [s.id]);
      }
    }
    const cascade = [];
    if (after === 'rejected') {
      cascade.push(...await cascadeSourceRejection(db, ctx, s.id));
    } else if (page?.ok) {
      // pending items of this source (fetch failed or no date before) are decided now
      for (const n of await rows(db, "SELECT * FROM news_items WHERE source_id = ? AND status = 'pending'", [s.id])) {
        const company = n.ticker ? ctx.companies.find((c) => c.ticker === n.ticker) : null;
        const d = decideNewsItem({ title: n.title_submitted, published_at: n.published_at_submitted, scope: n.scope }, page, ctx.cfg.news, { company });
        if (d.status !== 'pending') {
          await db.query('UPDATE news_items SET status = ?, reason = ? WHERE id = ?', [d.status, d.reason, n.id]);
          cascade.push({ news_item_id: Number(n.id), from: 'pending', to: d.status, reason: d.reason });
        }
      }
      const at = Date.parse(page.published_at ?? '') || Date.parse(s.published_at_fetched ?? '');
      if (Number.isFinite(at)) touched.add(at);
    }
    out.push({ source_id: Number(s.id), url: s.url_canonical, before, after, reason, http_status: page?.http_status ?? null, content_drift: drift, news: cascade });
  }
  const corroboration = [];
  for (const at of touched) corroboration.push(...await recorroborate(db, ctx, { atMs: at }));
  return { checked: out.length, results: out, corroboration_changes: corroboration,
    summary: out.reduce((acc, r) => { const k = `${r.before}->${r.after}`; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {}) };
}

/** Runs fn in a transaction on a pooled connection with an audit_log row; rolls back on error. */
export async function inTransaction(pool, tool, args, fn, { actor = 'mcp' } = {}) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    const ok = !['rejected'].includes(out?.status);
    await audit(conn, tool, args, ok, out?.reason ?? out?.status ?? null, actor);
    await conn.commit();
    return out;
  } catch (e) {
    await conn.rollback().catch(() => {});
    try { await audit(conn, tool, args, false, e?.code ?? 'error', actor); } catch { /* audit is best effort after a failure */ }
    throw e;
  } finally { conn.release(); }
}

/** Strips internal (non-serialisable) fields from a tool result. */
export const publicResult = (o) => JSON.parse(JSON.stringify(o, (k, v) => (k === '_page' ? undefined : v)));
