// add_research_note (PLAN §3, §4.4) — AUTHORITATIVE server-side check (hooks do not fire for script-driven calls).
//   1. static: ticker known, excerpt present and 40-1200 chars after normalisation, claim present, every claim number in the excerpt
//   2. add_source with refetch=true: domain policy, live re-fetch (redirect hops re-checked), must end verified/corroborated
//   3. the normalised excerpt must be an exact substring of the RE-FETCHED page text (main text or visible body text)
// Verified notes store the normalised excerpt, its sha256, the page content_sha256 and the fetch time. Rejections after the
// source exists are logged as status 'rejected' rows (never citable); a missing/invalid excerpt is rejected before any fetch.
import { clean } from '../lib/repo.mjs';
import { addSource, refreshCompanies } from '../ingest/tools.mjs';
import { checkExcerptStatic, findExcerpt } from '../verify/excerpt.mjs';
import { normHost } from '../verify/domainPolicy.mjs';
import { isSecHost } from '../crawl/secUa.mjs';
import { reflectedInUrl } from '../verify/reflection.mjs';

const one = async (db, sql, args = []) => clean((await db.query(sql, args))[0])[0] ?? null;

/** Source kind for a research URL: sec.gov -> filing, company IR domain -> ir, anything else allowed -> research. */
export function inferKind(url, irDomains) {
  let host;
  try { host = normHost(new URL(url).hostname); } catch { return 'research'; }
  if (isSecHost(host)) return 'filing';
  if (irDomains.some((d) => host === d.domain || host.endsWith(`.${d.domain}`))) return 'ir';
  return 'research';
}

const day = (iso) => (iso ? String(iso).slice(0, 10) : null);

export async function addResearchNote(db, args, ctx) {
  await refreshCompanies(db, ctx);
  const base = { ticker: args.ticker, url: args.url, category: args.category };
  if (!ctx.companies.some((c) => c.ticker === args.ticker)) return { ...base, status: 'rejected', reason: 'unknown_ticker', note_id: null, message: `${args.ticker} is not in companies` };
  const st = checkExcerptStatic({ excerpt: args.excerpt, claim: args.claim }, ctx.cfg.excerpt);
  if (!st.ok) return { ...base, status: 'rejected', reason: st.reason, note_id: null, message: st.message, ...(st.missing_numbers ? { missing_numbers: st.missing_numbers } : {}) };

  if (reflectedInUrl(args.url, [st.normalized, args.claim]))
    return { ...base, status: 'rejected', reason: 'excerpt_reflected_in_url', note_id: null,
      message: 'the excerpt or claim appears in the URL itself: a page can echo its URL, so this proves nothing (use the article URL)' };
  const kind = args.kind ?? inferKind(args.url, ctx.irDomains);
  const src = await addSource(db, { url: args.url, kind, refetch: true }, ctx);
  const page = src._page;
  const insert = async (status, reason, found, extra = {}) => (await db.query('INSERT INTO research_notes SET ?', [{
    ticker: args.ticker, source_id: src.source_id, category: args.category, claim: String(args.claim).trim().slice(0, 500),
    excerpt: st.normalized, excerpt_sha256: st.excerpt_sha256, excerpt_found: found ? 1 : 0,
    as_of_date: asOfDate, status, reason, created_by: args.created_by ?? 'claude',
    page_sha256: page?.content_sha256 ?? null, fetched_at: page?.fetched_at ? new Date(page.fetched_at) : null, ...extra }]))[0].insertId;
  // content date (as-of discipline): the page's own date wins; a caller date may only be LATER than it (never backdate)
  const pageDay = day(page?.published_at);
  if (args.as_of_date && pageDay && args.as_of_date < pageDay)
    return { ...base, source_id: src.source_id, status: 'rejected', reason: 'as_of_date_before_page_date', note_id: null,
      message: `as_of_date ${args.as_of_date} is earlier than the page date ${pageDay}; omit as_of_date (the page date is used)` };
  const asOfDate = pageDay ?? args.as_of_date ?? null;
  const out = { ...base, source_id: src.source_id, source_status: src.status, source_reason: src.reason, kind: src.kind ?? kind,
    excerpt_sha256: st.excerpt_sha256, page_sha256: page?.content_sha256 ?? null, fetched_at: page?.fetched_at ?? null };

  if (!['verified', 'corroborated'].includes(src.status) || !page) {
    const id = await insert('rejected', 'source_unverified', false);
    return { ...out, status: 'rejected', reason: 'source_unverified', note_id: Number(id),
      message: `source ${src.status}: ${src.reason}${src.message ? ` (${src.message})` : ''}` };
  }
  const f = findExcerpt(st.normalized, page);
  if (!f.found) {
    const id = await insert('rejected', 'excerpt_not_found', false);
    return { ...out, status: 'rejected', reason: 'excerpt_not_found', note_id: Number(id),
      message: 'the excerpt is not verbatim text of the re-fetched page (copy it exactly; do not paraphrase, join or trim words)' };
  }
  const dup = await one(db, "SELECT id FROM research_notes WHERE ticker = ? AND source_id = ? AND excerpt_sha256 = ? AND status = 'verified' ORDER BY id LIMIT 1",
    [args.ticker, src.source_id, st.excerpt_sha256]);
  if (dup) return { ...out, status: 'verified', reason: 'duplicate', duplicate: true, note_id: Number(dup.id), matched_in: f.where };
  const id = await insert('verified', 'ok', true);
  return { ...out, status: 'verified', reason: 'ok', note_id: Number(id), matched_in: f.where, as_of_date: asOfDate };
}
