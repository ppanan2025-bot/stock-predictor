// Automatic checks on one analyzer output (save_analysis; the verify-analysis hook runs the same function read-only). Pure.
// The validator agent judges the reasoning; these rules are the part a machine can prove:
//   - every evidence id is a source of the run's pack for that ticker AND currently verified/corroborated (no duplicates);
//     news_sentiment may only cite news (company or macro) from the pack
//   - lo <= hi inside model.analysis.return_bounds; direction consistent with the range (up: mid > 0, down: mid < 0, flat: lo <= 0 <= hi)
//   - no evidence -> confidence <= no_evidence_max_confidence. Pack-level evidence (evidence_pack_fields: prices, baseline, peers,
//     features.<key>) counts only for model.analysis.pack_field_evidence_agents (technical, macro_sector) and must exist (non-null)
//     in THIS pack
//   - short history (pack baseline null, e.g. SPCX): confidence <= short_history.max_confidence and hi - lo >= min_range_width
//   - rationale >= min_rationale_chars
import { packSourceIds } from '../report/reportCheck.mjs';

export function newsSourceIds(pack) {
  return new Set([...(pack?.news ?? []), ...(pack?.macro_news ?? [])].map((n) => Number(n.source_id)));
}

/**
 * @param a       {agent, ticker, direction, exp_return_lo, exp_return_hi, confidence, evidence_source_ids, rationale}
 * @param pack    the run's stored pack for a.ticker
 * @param sources Map(id -> {verification_status})
 * @returns string[] problems (empty = passes)
 */
export function checkAnalysis(a, { pack, sources, model }) {
  const p = [];
  const m = model.analysis;
  const lo = Number(a.exp_return_lo), hi = Number(a.exp_return_hi), conf = Number(a.confidence);
  if (pack && pack.ticker !== a.ticker) p.push(`pack_mismatch: pack is for ${pack.ticker}`);
  if (!(lo <= hi)) p.push('range_inverted: exp_return_lo must be <= exp_return_hi');
  if (lo < m.return_bounds[0] || hi > m.return_bounds[1]) p.push(`range_out_of_bounds: returns must lie in [${m.return_bounds.join(', ')}]`);
  const mid = (lo + hi) / 2;
  if (a.direction === 'up' && !(mid > 0)) p.push('direction_inconsistent: up needs a positive mid of the range');
  if (a.direction === 'down' && !(mid < 0)) p.push('direction_inconsistent: down needs a negative mid of the range');
  if (a.direction === 'flat' && !(lo <= 0 && hi >= 0)) p.push('direction_inconsistent: flat needs a range containing 0');
  if (!(conf >= 0 && conf <= 1)) p.push('confidence_out_of_range');
  if (String(a.rationale ?? '').trim().length < m.min_rationale_chars) p.push(`rationale_too_short: >= ${m.min_rationale_chars} characters`);
  const ids = (a.evidence_source_ids ?? []).map(Number);
  if (new Set(ids).size !== ids.length) p.push('evidence_duplicate');
  const inPack = packSourceIds(pack);
  const news = newsSourceIds(pack);
  for (const id of ids) {
    if (!inPack.has(id)) p.push(`evidence_not_in_pack:S${id}`);
    const s = sources?.get(id);
    if (!s || !['verified', 'corroborated'].includes(s.verification_status)) p.push(`evidence_unverified:S${id}`);
    if (a.agent === 'news_sentiment' && !news.has(id)) p.push(`evidence_not_news:S${id} (news_sentiment cites verified news only)`);
  }
  const fields = a.evidence_pack_fields ?? [];
  if (new Set(fields).size !== fields.length) p.push('evidence_pack_field_duplicate');
  for (const f of fields) {
    const ok = f === 'prices' ? (pack?.prices?.series ?? []).some((x) => x.close !== null)
      : f === 'baseline' ? !!pack?.baseline
      : f === 'peers' ? (pack?.peers ?? []).some((x) => !x.error)
      : f.startsWith('features.') ? pack?.features && !pack.features.error && pack.features[f.slice(9)] !== null && pack.features[f.slice(9)] !== undefined
      : false;
    if (!ok) p.push(`evidence_pack_field_missing:${f} (not present / null in this pack)`);
    if (!m.pack_field_evidence_agents.includes(a.agent)) p.push(`evidence_pack_field_not_allowed:${f} (${a.agent} must cite verified sources)`);
  }
  const hasEvidence = ids.length > 0 || (fields.length > 0 && m.pack_field_evidence_agents.includes(a.agent));
  if (!hasEvidence && conf > m.no_evidence_max_confidence)
    p.push(`no_evidence_overconfident: without evidence_source_ids confidence must be <= ${m.no_evidence_max_confidence}`);
  if (!pack?.baseline) {
    const sh = model.short_history;
    if (conf > sh.max_confidence) p.push(`short_history_overconfident: baseline is null (short history); confidence must be <= ${sh.max_confidence}`);
    if (hi - lo < sh.min_range_width) p.push(`short_history_range_too_narrow: baseline is null; hi - lo must be >= ${sh.min_range_width}`);
  }
  return p;
}
