// Ported verbatim from news-collection-agent src/lib/similarity.mjs.
import { tokenize, keywords, salientTokens } from '../lib/text.mjs';

const round4 = (x) => Math.round(x * 10000) / 10000;

function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

export function titleOverlap(A, B) {
  const TA = new Set(tokenize(A.title)), TB = new Set(tokenize(B.title));
  if (TA.size === 0 || TB.size === 0) return 0;
  let inter = 0;
  for (const x of TA) if (TB.has(x)) inter++;
  return round4(inter / Math.min(TA.size, TB.size));
}

export function keywordJaccard(A, B) {
  return round4(jaccard(keywords(`${A.title} ${A.summary ?? ''}`), keywords(`${B.title} ${B.summary ?? ''}`)));
}

export function score(A, B) {
  return round4(0.6 * titleOverlap(A, B) + 0.4 * keywordJaccard(A, B));
}

export function sharedSalient(A, B) {
  const SA = salientTokens(A.title), SB = salientTokens(B.title);
  let n = 0;
  for (const x of SA) if (SB.has(x)) n++;
  return n;
}

/** 5-word shingles of a text (lower-cased word tokens; capped for speed). */
export function shingles(text, k = 5, max = 4000) {
  const w = String(text ?? '').toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? [];
  const out = new Set();
  for (let i = 0; i + k <= w.length && out.size < max; i++) out.add(w.slice(i, i + k).join(' '));
  return out;
}
/** Shared shingles / the smaller set: a wire copy with extra outlet boilerplate still scores near 1 (Validator Phase 2 #3). */
export function bodyContainment(a, b) {
  const A = shingles(a), B = shingles(b);
  if (A.size < 20 || B.size < 20) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return round4(inter / Math.min(A.size, B.size));
}

export function isSyndicated(A, B, threshold = 0.85) {
  if (A.content_hash && B.content_hash && A.content_hash === B.content_hash) return true;
  if (A.body && B.body && bodyContainment(A.body, B.body) >= threshold) return true;
  const sa = tokenize(A.summary ?? ''), sb = tokenize(B.summary ?? '');
  if (sa.length && sb.length && jaccard(sa, sb) >= threshold) return true;
  if (A.is_wire_copy && B.is_wire_copy && titleOverlap(A, B) >= 0.9) return true;
  return false;
}

export function compare(A, B, threshold = 0.85) {
  const to = titleOverlap(A, B), kj = keywordJaccard(A, B);
  return {
    titleOverlap: to,
    keywordJaccard: kj,
    score: round4(0.6 * to + 0.4 * kj),
    sharedSalient: sharedSalient(A, B),
    syndicated: isSyndicated(A, B, threshold),
  };
}
