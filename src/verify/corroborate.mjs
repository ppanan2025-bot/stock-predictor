// Ported verbatim from news-collection-agent src/lib/corroborate.mjs.
// Pure, deterministic corroboration decision.
import { compare } from './similarity.mjs';
import { keywords } from '../lib/text.mjs';

const jaccard = (a, b) => { const A = new Set(a), B = new Set(b); let i = 0; for (const x of A) if (B.has(x)) i++; const u = A.size + B.size - i; return u ? i / u : 0; };

/** Jaccard of the top-N body keywords of two fetched article texts, or null when either body is unavailable. */
export function bodyKeywordJaccard(a, b, n = 25) {
  if (!a || !b) return null;
  return Math.round(jaccard(keywords(a, n), keywords(b, n)) * 1000) / 1000;
}

/**
 * Score rule (Validator Phase 3 #10, labelled dev pairs in test/fixtures/corroboration-pairs.json): a candidate matches when
 * score >= min_score, OR when score >= relaxed_min_score AND the top-N body keyword Jaccard >= body_keyword_jaccard_min.
 */
export function scoreMatches(score, bodyJ, cfg) {
  if (score >= cfg.min_score) return { ok: true, via: 'score' };
  if (cfg.relaxed_min_score !== undefined && score >= cfg.relaxed_min_score && bodyJ !== null && bodyJ >= (cfg.body_keyword_jaccard_min ?? 1))
    return { ok: true, via: 'score+body' };
  return { ok: false, via: null };
}

export const countsAsIndependent = (m) => !m.syndicated && !m.wireCopy;

export const groupOf = (x) => x.group ?? x.ownership_group ?? x.outlet_key ?? x.outletKey ?? null;

function toMs(d) {
  const t = d instanceof Date ? d.getTime() : Date.parse(d);
  return Number.isFinite(t) ? t : NaN;
}

/**
 * @param article    {id,title,summary,content_hash,is_wire_copy,published_at,outlet_key,group|ownership_group}
 * @param candidates same shape
 * @param cfg        verification config
 */
export function evaluate(article, candidates, cfg) {
  const aGroup = groupOf(article);
  const aT = toMs(article.published_at);
  const matches = [], rejectedCandidates = [];
  const sorted = [...candidates].sort((x, y) => Number(x.id) - Number(y.id));
  for (const c of sorted) {
    const cGroup = groupOf(c);
    const outletKey = c.outlet_key ?? c.outletKey ?? null;
    if (Number(c.id) === Number(article.id)) { rejectedCandidates.push({ id: c.id, reason: 'same article' }); continue; }
    if (cGroup === aGroup) { rejectedCandidates.push({ id: c.id, reason: 'same outlet or ownership group' }); continue; }
    const deltaHours = Math.round(((toMs(c.published_at) - aT) / 3600000) * 100) / 100;
    if (!Number.isFinite(deltaHours) || Math.abs(deltaHours) > cfg.window_hours) {
      rejectedCandidates.push({ id: c.id, reason: `outside ${cfg.window_hours}h window` }); continue;
    }
    const s = compare(article, c, cfg.syndication_threshold);
    const bodyJ = bodyKeywordJaccard(article.body, c.body, cfg.body_keyword_top ?? 25);
    const sm = scoreMatches(s.score, bodyJ, cfg);
    if (!sm.ok) { rejectedCandidates.push({ id: c.id, reason: `score ${s.score} < ${cfg.min_score} (body keyword jaccard ${bodyJ ?? 'n/a'})` }); continue; }
    if (s.sharedSalient < cfg.min_shared_salient_tokens) {
      rejectedCandidates.push({ id: c.id, reason: `shared salient tokens ${s.sharedSalient} < ${cfg.min_shared_salient_tokens}` }); continue;
    }
    matches.push({ id: c.id, outletKey, group: cGroup, score: s.score, titleOverlap: s.titleOverlap,
      keywordJaccard: s.keywordJaccard, bodyKeywordJaccard: bodyJ, matchedVia: sm.via, sharedSalient: s.sharedSalient, syndicated: s.syndicated, wireCopy: !!c.is_wire_copy, deltaHours });
  }
  // A candidate counts only if it is neither syndicated with the article nor itself wire-agency copy.
  const independentGroups = [...new Set(matches.filter(countsAsIndependent).map((m) => m.group))].sort();
  return { matches, rejectedCandidates, independentGroups, meetsRule: independentGroups.length >= cfg.min_independent_outlets };
}
