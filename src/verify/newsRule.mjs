// News item rule (PLAN §3 add_news_item, §4.3). Pure: compares the submitted title/date/ticker with the FETCHED page.
// Corroboration is separate (corroborate.mjs, ported from news-collection-agent).
import { tokenize } from '../lib/text.mjs';
import { normalizeText } from '../crawl/page.mjs';

const round3 = (x) => Math.round(x * 1000) / 1000;

/**
 * Title similarity of the submitted title vs one fetched title: mean of token Jaccard and containment (share of the
 * submitted title's tokens found in the fetched title). Tokens are stemmed, stop-words removed (src/lib/text.mjs).
 */
export function titleSimilarity(submitted, fetched) {
  const A = new Set(tokenize(submitted)), B = new Set(tokenize(fetched));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const jaccard = inter / (A.size + B.size - inter);
  const containment = inter / A.size;
  return round3((jaccard + containment) / 2);
}

/** Best similarity over all fetched title candidates (og:title, <title>, JSON-LD headline, <h1>). */
export function bestTitleSimilarity(submitted, titles) {
  let best = 0, matched = null;
  for (const t of titles ?? []) { const s = titleSimilarity(submitted, t); if (s > best) { best = s; matched = t; } }
  return { similarity: best, matched_title: matched };
}

/** Parses a submitted published_at: 'YYYY-MM-DD' (a whole UTC day) or an ISO date-time. Returns {from, to} ms or null. */
export function submittedInterval(v) {
  const s = String(v ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { const t = Date.parse(`${s}T00:00:00Z`); return Number.isFinite(t) ? { from: t, to: t + 86400000, dateOnly: true } : null; }
  const t = Date.parse(s);
  return Number.isFinite(t) ? { from: t, to: t, dateOnly: false } : null;
}

/**
 * Hours between the page's published time and the submitted date (0 when inside a date-only submitted day). A date-only
 * submission may be in any timezone, so its day is widened by 14 h on each side before measuring.
 */
export function dateDeltaHours(submitted, pagePublishedIso) {
  const iv = submittedInterval(submitted);
  const p = Date.parse(pagePublishedIso ?? '');
  if (!iv || !Number.isFinite(p)) return null;
  const pad = iv.dateOnly ? 14 * 3600000 : 0;
  const lo = iv.from - pad, hi = iv.to + pad;
  const d = p < lo ? lo - p : p > hi ? p - hi : 0;
  return Math.round((d / 3600000) * 100) / 100;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Names a company is mentioned by: ticker, configured aliases and the legal name without suffixes. */
export function companyNames(company, aliases = {}) {
  const base = String(company?.name ?? '').replace(/,?\s+(Inc\.?|Corp\.?|Corporation|Ltd\.?|plc|Class [A-Z])(?=\s|,|$)/gi, '').replace(/\.com\b/i, '').trim();
  return [...new Set([company?.ticker, base, ...(aliases[company?.ticker] ?? [])].filter((x) => x && x.length >= 2))];
}

/** True when the page text mentions the ticker (as a word) or one of the company names (case-insensitive, word bounded). */
export function mentionsCompany(text, company, aliases = {}) {
  const t = normalizeText(text);
  return companyNames(company, aliases).some((n) => (n === company.ticker
    ? new RegExp(`(^|[^A-Za-z0-9])${escapeRe(n)}([^A-Za-z0-9]|$)`).test(t)
    : new RegExp(`(^|[^A-Za-z0-9])${escapeRe(n)}([^A-Za-z0-9]|$)`, 'i').test(t)));
}

/**
 * Decision for a news item whose source page was fetched OK (source verified). Returns
 * {status: 'verified'|'pending'|'rejected', reason, title_similarity, matched_title, date_delta_hours}.
 * Corroboration may later upgrade 'verified' to 'corroborated'.
 */
export function decideNewsItem(item, page, newsCfg, { company = null } = {}) {
  const { similarity, matched_title } = bestTitleSimilarity(item.title, page.titles ?? [page.title].filter(Boolean));
  const out = { title_similarity: similarity, matched_title, date_delta_hours: null };
  if (similarity < newsCfg.title_similarity_min)
    return { ...out, status: 'rejected', reason: 'title_mismatch', message: `title similarity ${similarity} < ${newsCfg.title_similarity_min} (page: ${String(page.title ?? '').slice(0, 160)})` };
  if (item.scope !== 'macro' && company && !mentionsCompany(page.text, company, newsCfg.ticker_aliases))
    return { ...out, status: 'rejected', reason: 'ticker_not_mentioned', message: `the page text does not mention ${companyNames(company, newsCfg.ticker_aliases).join(' / ')}` };
  const delta = dateDeltaHours(item.published_at, page.published_at);
  out.date_delta_hours = delta;
  if (delta === null) return { ...out, status: 'pending', reason: 'date_unverifiable', message: 'the page has no machine-readable publication date' };
  if (delta > newsCfg.date_tolerance_hours)
    return { ...out, status: 'rejected', reason: 'date_mismatch', message: `submitted ${item.published_at} vs page ${page.published_at} (${delta} h > ${newsCfg.date_tolerance_hours} h)` };
  return { ...out, status: 'verified', reason: 'ok' };
}
