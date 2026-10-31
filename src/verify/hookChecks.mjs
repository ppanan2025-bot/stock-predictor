// Decision logic of the PreToolUse hooks verify-price-ingest and verify-news-source (PLAN §4.6). The same shared rules as the
// server (priceRule, domainPolicy, page fetch, newsRule); the hooks are the EARLY, explainable layer, the server stays
// authoritative. Network: the price hook is ALWAYS live (liveHttp ignores CRAWL_MODE/CRAWL_FIXTURE_DIR). The news hook is live
// unless the test-only seam (SP_HOOK_TEST=1 + the marked test DB) is active; tests may also inject fetchers directly.
import { allow, deny, PRICE_HINT, NEWS_HINT, NOTE_HINT, zodIssues } from '../harness/hookDecisions.mjs';
import { IngestPriceSchema, AddNewsItemSchema, AddSourceSchema, AddResearchNoteSchema } from './schemas.mjs';
import { checkExcerptStatic, findExcerpt } from './excerpt.mjs';
import { loadVerification, loadPolicy, loadCompanies } from './config.mjs';
import { checkPriceStatic, decidePrice } from './priceRule.mjs';
import { refetchBoth } from './priceRefetch.mjs';
import { checkUrl, irDomainsOf } from './domainPolicy.mjs';
import { reflectedInUrl } from './reflection.mjs';
import { decideNewsItem } from './newsRule.mjs';
import { liveHttp } from '../crawl/http.mjs';
import { fetchPage } from '../crawl/page.mjs';

const fmt = (reason, detail, hint) => `${reason}: ${detail}. ${hint}`;

export async function decidePriceHook(toolInput, { projectDir, http = null, now = new Date() } = {}) {
  const cfg = loadVerification({ projectDir, fresh: true }).price; // throws -> exit 2 (fail closed)
  const companies = loadCompanies({ projectDir, fresh: true }).companies;
  const r = IngestPriceSchema.safeParse(toolInput);
  if (!r.success) return deny(fmt('bad_schema', zodIssues(r.error), PRICE_HINT));
  const sub = r.data;
  const s = checkPriceStatic(sub, { companies, cfg, now });
  if (s) return deny(fmt(s.reason, JSON.stringify(s.detail).slice(0, 300), PRICE_HINT));
  const { a, b } = await refetchBoth(sub.ticker, sub.month, cfg, { http: http ?? liveHttp({ projectDir, health: false }), now, retries: 1 });
  const d = decidePrice(sub, a, b, cfg, now);
  if (d.ok) return allow();
  if (['refetch_failed', 'rate_limited'].includes(d.reason))
    throw new Error(`${d.reason}: independent re-fetch could not reach a source (${d.detail?.source ?? ''} ${d.detail?.code ?? ''}). Retry later. ${PRICE_HINT}`);
  const det = d.detail ?? {};
  return deny(fmt(d.reason, det.message ?? `nasdaq ${det.source_a?.date ?? '-'} ${det.source_a?.close ?? '-'} / cnbc ${det.source_b?.date ?? '-'} ${det.source_b?.close ?? '-'}`, PRICE_HINT));
}

/**
 * add_source / add_news_item: schema, domain policy for the URL and every reference URL, live fetch of the main page (must be
 * reachable with enough text), and for news: title similarity, company mention and date tolerance. A page without a date is
 * allowed (the server stores it pending date_unverifiable).
 */
export async function decideNewsHook(toolName, toolInput, { projectDir, pageFetch = null } = {}) {
  const cfg = loadVerification({ projectDir, fresh: true }).news;
  const policy = loadPolicy({ projectDir, fresh: true });
  const companiesCfg = loadCompanies({ projectDir, fresh: true });
  const irDomains = irDomainsOf(companiesCfg);
  const isNews = toolName.endsWith('add_news_item');
  const r = (isNews ? AddNewsItemSchema : AddSourceSchema).safeParse(toolInput);
  if (!r.success) return deny(fmt('bad_schema', zodIssues(r.error), NEWS_HINT));
  const p = r.data;
  const company = isNews && p.ticker ? companiesCfg.companies.find((c) => c.ticker === p.ticker) : null;
  if (isNews && p.ticker && !company) return deny(fmt('unknown_ticker', `${p.ticker} is not a tracked company`, NEWS_HINT));
  const pol = checkUrl(p.url, policy, irDomains);
  if (!pol.allowed) return deny(fmt(pol.reason, pol.message, NEWS_HINT));
  for (const ref of (isNews ? p.references ?? [] : [])) {
    if (!ref?.url) continue;
    const rp = checkUrl(ref.url, policy, irDomains);
    if (!rp.allowed) return deny(fmt(rp.reason, `reference ${ref.url}: ${rp.message}`, NEWS_HINT));
  }
  const fetcher = pageFetch ?? ((u) => fetchPage(u, { policy, irDomains, mode: 'live', timeoutMs: cfg.fetch.timeout_ms, maxBytes: cfg.fetch.max_bytes,
    maxRedirects: cfg.fetch.max_redirects, minTextLen: cfg.min_text_len }));
  const page = await fetcher(pol.url_canonical);
  if (!page.ok) return deny(fmt(`source_${page.reason}`, `${pol.url_canonical} could not be verified (${page.reason}${page.http_status ? ` HTTP ${page.http_status}` : ''}${page.message ? `: ${page.message}` : ''})`, NEWS_HINT));
  if (!isNews) return allow();
  const scope = p.scope ?? (p.ticker ? 'company' : 'macro');
  const d = decideNewsItem({ title: p.title, published_at: p.published_at, scope }, page, cfg, { company });
  if (d.status === 'rejected') return deny(fmt(d.reason, d.message, NEWS_HINT));
  return allow();
}

/**
 * add_research_note (PLAN §4.4): strict schema, known ticker, excerpt present / 40-1200 chars / claim numbers inside it, domain
 * policy, LIVE fetch of the page (must verify) and the normalised excerpt must be an exact substring of the page text.
 * Fails closed: anything unexpected throws (runner exits 2).
 */
export async function decideResearchNoteHook(toolInput, { projectDir, pageFetch = null } = {}) {
  const vcfg = loadVerification({ projectDir, fresh: true });
  const policy = loadPolicy({ projectDir, fresh: true });
  const companiesCfg = loadCompanies({ projectDir, fresh: true });
  const irDomains = irDomainsOf(companiesCfg);
  const ti = toolInput ?? {};
  // the explicit reason for the most important rule comes first, even when other fields are also malformed
  if (typeof ti.excerpt !== 'string' || !ti.excerpt.trim()) return deny(fmt('excerpt_missing', 'a research note needs a verbatim excerpt copied from the page', NOTE_HINT));
  const r = AddResearchNoteSchema.safeParse(ti);
  if (!r.success) return deny(fmt('bad_schema', zodIssues(r.error), NOTE_HINT));
  const p = r.data;
  if (!companiesCfg.companies.some((c) => c.ticker === p.ticker)) return deny(fmt('unknown_ticker', `${p.ticker} is not a tracked company`, NOTE_HINT));
  const st = checkExcerptStatic({ excerpt: p.excerpt, claim: p.claim }, vcfg.excerpt);
  if (!st.ok) return deny(fmt(st.reason, st.message, NOTE_HINT));
  if (reflectedInUrl(p.url, [st.normalized, p.claim])) return deny(fmt('excerpt_reflected_in_url', 'the excerpt or claim appears in the URL itself (a page can echo its URL)', NOTE_HINT));
  const pol = checkUrl(p.url, policy, irDomains);
  if (!pol.allowed) return deny(fmt(pol.reason, pol.message, NOTE_HINT));
  const cfg = vcfg.news;
  const fetcher = pageFetch ?? ((u) => fetchPage(u, { policy, irDomains, mode: 'live', timeoutMs: cfg.fetch.timeout_ms, maxBytes: cfg.fetch.max_bytes,
    maxRedirects: cfg.fetch.max_redirects, minTextLen: cfg.min_text_len }));
  const page = await fetcher(pol.url_canonical);
  if (!page.ok) return deny(fmt(`source_${page.reason}`, `${pol.url_canonical} could not be verified (${page.reason}${page.http_status ? ` HTTP ${page.http_status}` : ''}${page.message ? `: ${page.message}` : ''})`, NOTE_HINT));
  if (!findExcerpt(st.normalized, page).found) return deny(fmt('excerpt_not_found', 'the excerpt is not verbatim text of the live page', NOTE_HINT));
  return allow();
}
