// Research-note excerpt rules (PLAN §4.4, config/verification.json "excerpt"), shared by the verify-research-excerpt hook and
// the add_research_note server tool. An excerpt is VERBATIM page text: after the same normalisation as content_sha256 (NFKC,
// unified quotes and dashes, collapsed whitespace; crawl/page.mjs normalizeText) it must be an exact substring of the re-fetched
// page text. Every number in Claude's paraphrase (`claim`) must also appear in the excerpt, so a claim cannot add figures the
// source does not contain. Pure functions; no network, no DB.
import { normalizeText } from '../crawl/page.mjs';
import { sha256 } from '../lib/hash.mjs';

export const EXCERPT_REASONS = Object.freeze(['ok', 'excerpt_missing', 'excerpt_too_short', 'excerpt_too_long', 'excerpt_not_found',
  'claim_missing', 'claim_number_not_in_excerpt', 'source_unverified', 'unknown_ticker', 'bad_schema']);

export const normalizeExcerpt = (s) => normalizeText(s);
export const excerptSha256 = (normalized) => sha256(normalized);

/** Maps every Unicode decimal digit to its ASCII value (each \p{Nd} block is 10 consecutive code points starting at zero). */
export function toAsciiDigits(s) {
  // Unicode guarantees Nd digits come in contiguous runs of ten starting at zero: value = (Nd code points before it in the run) % 10
  return String(s).replace(/\p{Nd}/gu, (d) => {
    const c = d.codePointAt(0);
    let k = 0;
    while (k < 100 && /\p{Nd}/u.test(String.fromCodePoint(c - k - 1))) k++;
    return String(k % 10);
  });
}

/**
 * Numeric tokens of a text as canonical strings: thousands separators dropped, trailing decimal zeros dropped
 * ("1,200.50" -> "1200.5", "12%" -> "12", "$3.0" -> "3", "Q3" -> "3", "2026" -> "2026").
 */
export function numberTokens(text) {
  const out = [];
  // \p{Nd}: any script's decimal digits (Arabic-Indic, Devanagari, ...) are numbers too, mapped to ASCII (Validator Phase 3 #6)
  for (const m of normalizeText(text).matchAll(/\p{Nd}[\p{Nd},]*(?:\.\p{Nd}+)?/gu)) {
    let t = toAsciiDigits(m[0]).replace(/,(?=\d{3}(\D|$))/g, '').replace(/,+$/, '');
    if (t.includes(',')) t = t.replace(/,/g, ''); // odd grouping: compare digits only
    if (t.includes('.')) t = t.replace(/0+$/, '').replace(/\.$/, '');
    t = t.replace(/^0+(?=\d)/, '');
    out.push(t);
  }
  return out;
}

/** Numbers in `claim` that do not occur in `excerpt` (after canonicalisation). */
export function claimNumbersMissing(claim, excerpt) {
  const have = new Set(numberTokens(excerpt));
  return [...new Set(numberTokens(claim))].filter((n) => !have.has(n));
}

/**
 * Static checks (no page needed). cfg = verification.excerpt {min_len, max_len, numbers_in_claim_must_be_in_excerpt}.
 * @returns {ok, reason, message?, normalized?, excerpt_sha256?, missing_numbers?}
 */
export function checkExcerptStatic({ excerpt, claim }, cfg) {
  if (typeof excerpt !== 'string' || !excerpt.trim())
    return { ok: false, reason: 'excerpt_missing', message: 'a research note needs a verbatim excerpt copied from the page' };
  const normalized = normalizeExcerpt(excerpt);
  if (normalized.length < cfg.min_len) return { ok: false, reason: 'excerpt_too_short', normalized, message: `excerpt has ${normalized.length} chars (< ${cfg.min_len})` };
  if (normalized.length > cfg.max_len) return { ok: false, reason: 'excerpt_too_long', normalized, message: `excerpt has ${normalized.length} chars (> ${cfg.max_len})` };
  if (typeof claim !== 'string' || !claim.trim()) return { ok: false, reason: 'claim_missing', normalized, message: 'a research note needs a claim (your one-sentence paraphrase)' };
  if (cfg.numbers_in_claim_must_be_in_excerpt) {
    const missing = claimNumbersMissing(claim, normalized);
    if (missing.length) return { ok: false, reason: 'claim_number_not_in_excerpt', normalized, missing_numbers: missing,
      message: `claim numbers not in the excerpt: ${missing.slice(0, 8).join(', ')}` };
  }
  return { ok: true, reason: 'ok', normalized, excerpt_sha256: excerptSha256(normalized) };
}

/**
 * Is the normalised excerpt an exact substring of the page's main visible text?
 * @returns {found, where: 'text'|'body_text'|null}
 */
export function findExcerpt(normalized, page) {
  // main article text only (article / articleBody / main, else body), after hidden-element stripping (Validator Phase 3 #3)
  for (const where of ['text']) {
    const t = page?.[where];
    if (t && normalizeText(t).includes(normalized)) return { found: true, where };
  }
  return { found: false, where: null };
}

/** Full decision for a fetched page: static rules + substring. */
export function decideExcerpt({ excerpt, claim }, page, cfg) {
  const s = checkExcerptStatic({ excerpt, claim }, cfg);
  if (!s.ok) return s;
  const f = findExcerpt(s.normalized, page);
  if (!f.found) return { ok: false, reason: 'excerpt_not_found', normalized: s.normalized, excerpt_sha256: s.excerpt_sha256,
    message: 'the excerpt is not verbatim text of the re-fetched page (copy it exactly; do not paraphrase, join or trim words)' };
  return { ...s, matched_in: f.where };
}
