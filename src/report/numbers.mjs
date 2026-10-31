// Numeric-token extraction and tracing for the report guard (PLAN §4.5; hardened after the Validator's Phase 4 review). Pure.
//
// Normalisation: NFKC (full-width digits/letters) and every Unicode decimal digit mapped to ASCII, so "４００" and "٤٠٠" are 400.
// Tokens are TYPED by what is glued to them:
//   pct        "1.4%", "12 percent", "3 pct", "50 bps"/"2 pp" (points)          -> traced against percent-type fields (fractions x100)
//   dollar     "$344.08", "US$400", "USD400", "400 dollars", "400-dollar"     -> traced against price fields, to the cent
//   magnitude  "$1.2k", "$400bn", "3 million", "12m" (except window labels)   -> scaled, traced only against verified note/news numbers
//   unit       any other letters glued after the digits ("3x", "5G")          -> traced like plain, never exempt
//   plain      bare numbers                                                    -> traced against plain fields (exact to the last decimal)
// Labels (not quantities): letters BEFORE the digits ("Q3", "FY2026", "M6"), "10-K"/"10-Q", window labels 1m/3m/6m/12m/24m/36m,
// ordinals up to 31st. Dates: ISO YYYY-MM-DD / YYYY-MM tokens are checked against the allowed date set by the caller.
// Exempt: plain integers <= 10 (no unit), and plain 4-digit years only in a date context ("in 2026", "September 2026", "fiscal 2027").
// Tracing is SIGN-SENSITIVE with tight tolerances: percents ±0.05 percentage points (or half the last printed decimal if smaller),
// dollars and plain numbers ±0.005 (or half the last printed decimal if smaller).
import { toAsciiDigits } from '../verify/excerpt.mjs';

export const blank = (s) => String(s).replace(/[^\n]/g, ' ');
/** NFKC + ASCII digits, length-preserving per code unit where possible (offsets are recomputed by the caller on this text). */
export const normalizeNumerals = (s) => toAsciiDigits(String(s ?? '').normalize('NFKC'));

const MAG = { k: 1e3, thousand: 1e3, m: 1e6, mn: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9, tn: 1e12, trillion: 1e12 };
const WINDOW_LABELS = new Set([1, 3, 6, 12, 24, 36]);
const NUM = /(?:(US\$|USD|EUR|GBP|\$|€|£)\s?)?([+\-−]?)(?:(US\$|\$|€|£)\s?)?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)/g;
const DATE_CTX = /(?:\b(?:in|of|since|by|from|to|until|through|year|years|fiscal|calendar|during|early|late|mid|end|start|before|after)\s+|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(?:\d{1,2},?\s+)?)$/i;

/**
 * Typed numeric tokens of `text` (already masked by the caller; masks must preserve length).
 * @returns [{raw, value, kind, decimals, index, unit}]
 */
export function extractNumbers(text) {
  const t = normalizeNumerals(text);
  const out = [];
  for (const m of t.matchAll(NUM)) {
    const [whole, cur1, sign, cur2, digits] = m;
    const start = m.index;
    const prev = t[start - 1] ?? '';
    if (/[A-Za-z_.\d]/.test(prev) && !cur1) continue; // label (Q3, FY2026, M6) or inside another token
    const end = start + whole.length;
    const rest = t.slice(end, end + 24);
    let value = Number(digits.replace(/,/g, '')) * (sign === '-' || sign === '−' ? -1 : 1);
    const decimals = digits.includes('.') ? digits.split('.')[1].length : 0;
    const currency = cur1 || cur2 || null;
    let kind = currency ? 'dollar' : 'plain', unit = null, raw = whole, len = whole.length;
    let mm;
    if (/^-[KQ]\b/.test(rest)) continue; // 10-K, 10-Q (filing labels)
    if ((mm = /^\s?(%|percent\b|per\s?cent\b|pct\b|percentage points?\b|pp\b|bps\b|basis points\b)/i.exec(rest))) {
      kind = 'pct'; unit = mm[1].toLowerCase();
      if (/^(bps|basis points)$/.test(unit)) value /= 100; // 50 bps = 0.5 percentage points
    } else if ((mm = /^-?\s?(k|thousand|mn|m|million|bn|b|billion|tn|trillion)\b/i.exec(rest))) {
      const u = mm[1];
      if (!currency && u === 'm' && !mm[0].startsWith(' ') && !mm[0].startsWith('-') && decimals === 0 && WINDOW_LABELS.has(Math.abs(value))) continue; // 12m window label
      kind = 'magnitude'; unit = u.toLowerCase(); value *= MAG[unit] ?? 1;
    } else if ((mm = /^-?\s?(dollars?|usd|bucks)\b/i.exec(rest))) {
      kind = 'dollar'; unit = 'dollar';
    } else if ((mm = /^(st|nd|rd|th)\b/.exec(rest)) && decimals === 0 && Math.abs(value) <= 31) continue; // ordinal
    else if ((mm = /^[A-Za-z]+/.exec(rest))) { kind = currency ? 'dollar' : 'unit'; unit = mm[0]; }
    if (mm) { raw = t.slice(start, end + mm[0].length); len = raw.length; }
    out.push({ raw: raw.trim(), value, kind, decimals, index: start, length: len, unit, currency });
  }
  return out;
}

const WORD = '(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|dozen|half|a quarter)';
const SPELLED = new RegExp(`\\b${WORD}(?:[\\s-]+(?:and\\s+)?${WORD})*\\s*(?:-|\\s)?(?:percent|per\\s?cent|percentage points?|basis points|bps|pp|dollars?|bucks|usd)\\b`, 'gi');
/** Spelled-out quantities ("twelve percent", "four hundred dollars"): they cannot be traced and are refused. */
export function spelledQuantities(text) { return [...normalizeNumerals(text).matchAll(SPELLED)].map((m) => ({ raw: m[0], index: m.index })); }

/** Years in a date context and small plain integers are not quantities that need tracing. */
export function exempt(n, text = '', { smallIntMax = 10 } = {}) {
  if (n.kind !== 'plain' || n.decimals > 0) return false;
  const a = Math.abs(n.value);
  if (n.value >= 1990 && n.value <= 2100 && /^\d{4}$/.test(n.raw) && DATE_CTX.test(String(text).slice(Math.max(0, n.index - 30), n.index))) return true;
  return a <= smallIntMax && !/^[+\-−]/.test(n.raw);
}

/** Typed allowed values: P = fractions shown as percents, D = prices, N = plain numbers, M = magnitudes (scaled). */
export const emptySets = () => ({ P: [], D: [], N: [], M: [], R: [] }); // R: peer returns (percents, peer-labelled sentences only)
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
export function addVals(set, key, ...vals) { for (const v of vals.flat()) { const x = num(v); if (x !== null && Number.isFinite(x)) set[key].push(x); } }

/** Values a free text (verified excerpt, claim, news title) contributes, typed like report tokens. */
export function addTextValues(sets, text) {
  for (const n of extractNumbers(text)) {
    if (n.kind === 'pct') sets.P.push(n.value / 100);
    else if (n.kind === 'dollar') { sets.D.push(n.value); sets.N.push(n.value); }
    else if (n.kind === 'magnitude') sets.M.push(n.value);
    else sets.N.push(n.value);
  }
}

const tolFor = (n, cap) => Math.min(cap, 0.5 * 10 ** -n.decimals) + 1e-9;
/** Sign-sensitive typed match. */
export function traces(n, sets) {
  if (n.kind === 'pct') { const t = tolFor(n, 0.05); return sets.P.some((a) => Math.abs(a * 100 - n.value) <= t); }
  if (n.kind === 'dollar') { const t = tolFor(n, 0.005); return sets.D.some((a) => Math.abs(a - n.value) <= t); }
  if (n.kind === 'magnitude') return sets.M.some((a) => Math.abs(a - n.value) <= Math.abs(a) * 1e-6 + 1e-9);
  const t = tolFor(n, 0.005);
  return sets.N.some((a) => Math.abs(a - n.value) <= t);
}
