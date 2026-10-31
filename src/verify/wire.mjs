// Ported verbatim from news-collection-agent src/lib/wire.mjs.
// Wire-agency (syndicated) copy detection. Wire copy never counts as independent corroboration.
const WIRE_URL = /\/wireStory\//i;
const WIRE_DATELINE = /\((AP|Reuters|AFP)\)\s*[—–-]/;
// Byline naming a wire agency. Acronyms are matched case-sensitively to avoid false positives.
const WIRE_BYLINE_WORDS = /\b(the\s+)?associated\s+press\b|\breuters\b|\bagence\s+france[\s-]+presse\b/i;
const WIRE_BYLINE_ACRONYMS = /\b(AP|AFP)\b/;

export function isWireByline(author) {
  if (!author) return false;
  const a = String(author);
  return WIRE_BYLINE_WORDS.test(a) || WIRE_BYLINE_ACRONYMS.test(a);
}

/** @param {{url?:string, summary?:string|null, author?:string|null}} a */
export function isWireCopy({ url, summary, author } = {}) {
  return WIRE_URL.test(url || '') || WIRE_DATELINE.test(summary || '') || isWireByline(author);
}

// ---- detection on FETCHED page content (Validator Phase 2 #3) ----
// Submitted summaries/URLs are not evidence; the fetched page is. A page is wire copy when its own text or metadata names a
// wire agency as the source: a dateline "CITY (AP) —" near the start of the article, a JSON-LD/meta author or publisher that is
// the agency, or an agency copyright line. The agency's OWN site is the original, not a copy (see isWireCopyOf).
export const WIRE_AGENCIES = Object.freeze({ ap: 'associated-press', reuters: 'thomson-reuters', afp: 'afp' });
const AGENCY_NAME = [['ap', /\b(the\s+)?associated\s+press\b|^\s*AP\s*$/i], ['reuters', /\breuters\b/i], ['afp', /\bagence\s+france[\s-]+presse\b|^\s*AFP\s*$/i]];
const DATELINE = [['ap', /\((AP)\)\s*[—–-]/], ['reuters', /\((Reuters)\)\s*[—–-]/], ['afp', /\((AFP)\)\s*[—–-]/]];
const COPYRIGHT = /(?:copyright|©)\s*(?:\(c\)\s*)?(?:\d{4}\s*)?(?:,\s*)?(the\s+associated\s+press|reuters|agence\s+france[\s-]+presse|AFP)\b/i;

const agencyOfName = (name) => { for (const [k, re] of AGENCY_NAME) if (re.test(String(name ?? ''))) return k; return null; };

/**
 * @param text     article main text (normalised)
 * @param names    author/publisher/source names from JSON-LD and meta tags
 * @returns {agency: 'ap'|'reuters'|'afp'|null, evidence: string|null}
 */
export function detectWire({ text = '', names = [] } = {}) {
  const head = String(text).slice(0, 800);
  for (const [k, re] of DATELINE) if (re.test(head)) return { agency: k, evidence: 'dateline' };
  for (const n of names) { const k = agencyOfName(n); if (k) return { agency: k, evidence: `byline:${String(n).slice(0, 60)}` }; }
  const m = COPYRIGHT.exec(String(text));
  if (m) return { agency: agencyOfName(m[1]) ?? (/afp/i.test(m[1]) ? 'afp' : null), evidence: 'copyright' };
  return { agency: null, evidence: null };
}

/** Wire copy = an agency was detected AND the page is not on the agency's own outlet (ownership group). */
export const isWireCopyOf = (agency, ownershipGroup) => !!agency && WIRE_AGENCIES[agency] !== ownershipGroup;
