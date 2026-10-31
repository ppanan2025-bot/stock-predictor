// Reflected-content defences (Validator Phase 3 #1, critical): a page that echoes its URL (site search, query pages, "no results
// for <text>") can make ANY text appear "on the page". Two rules, used by the domain policy (every source, news and notes, every
// redirect hop) and by add_research_note (server + hook):
//   1. search/query pages are never sources: path segments like /search, /find, /results, /query, /tag/…?q, and query keys such
//      as q, s, query, keyword(s), search, term, text, k are refused (search_page);
//   2. an excerpt or claim must not be reflected from the URL: if any 20-character chunk of the normalised excerpt/claim occurs in
//      the fully URL-decoded, normalised URL, the note is refused (excerpt_reflected_in_url).

const SEARCH_PATH = /(^|\/)(search|find|results|query|lookup|suche|recherche|buscar)(\/|$|\.\w+$)/i;
const SEARCH_KEYS = new Set(['q', 's', 'query', 'keyword', 'keywords', 'search', 'searchterm', 'search_query', 'term', 'terms', 'text', 'k', 'kw', 'wd', 'p_q', 'qs']);

/** Reason string when the URL is a search/query page, else null. */
export function searchPageReason(url) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  if (SEARCH_PATH.test(decodeAll(u.pathname))) return `search page path ${u.pathname}`;
  for (const k of u.searchParams.keys()) if (SEARCH_KEYS.has(k.toLowerCase())) return `query parameter "${k}"`;
  return null;
}

/** Repeated percent/plus decoding (bounded), lower-cased and normalised like page text. */
export function decodeAll(s) {
  let t = String(s ?? '');
  for (let i = 0; i < 4; i++) {
    let n;
    try { n = decodeURIComponent(t.replace(/\+/g, ' ')); } catch { n = t.replace(/\+/g, ' ').replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))); }
    if (n === t) break;
    t = n;
  }
  return t;
}

// page-text normalisation (NFKC, unified quotes/dashes, collapsed whitespace), kept local to avoid an import cycle with crawl/page.mjs
const norm = (s) => decodeAll(s).normalize('NFKC').replace(/[\u2018\u2019\u201a\u201b\u2032]/g, "'").replace(/[\u201c\u201d\u201e\u201f\u2033]/g, '"')
  .replace(/[\u2010-\u2015\u2212]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();

/** True when a >= `chunk`-character piece of any text appears in the decoded URL. */
export function reflectedInUrl(url, texts, { chunk = 20, step = 5 } = {}) {
  const u = norm(url);
  for (const raw of texts) {
    const t = norm(raw ?? '');
    if (t.length < chunk) { if (t.length >= 12 && u.includes(t)) return true; continue; }
    for (let i = 0; i + chunk <= t.length; i += step) if (u.includes(t.slice(i, i + chunk))) return true;
    if (u.includes(t.slice(t.length - chunk))) return true;
  }
  return false;
}
