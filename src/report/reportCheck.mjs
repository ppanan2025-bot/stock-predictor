// Report guard (PLAN §4.5, Phase 4 template docs/REPORT_TEMPLATE.md). Shared by the guard-report-write hook, save_prediction,
// save_review (validator pass) and finalize_report. checkReport() is PURE (context injected); loadReportContext() reads the DB.
//
// A report FAILS when any of these is missing or broken:
//  1. YAML front matter {ticker, as_of_month, target_month, run_id, pack_id, pack_sha256} equal to the run's pack for the ticker
//     (as_of_month = target_month - 1; pack_sha256 = the stored snapshot's sha).
//  2. Required `## ` sections (config/verification.json report.required_sections) and the exact disclaimer sentence.
//  3. Numbers (src/report/numbers.mjs; NFKC + Unicode digits; typed tokens): outside opinion spans every pct/dollar/plain/
//     magnitude token must equal a field of the matching TYPE (percent-type fields, prices, plain fields, verified note/news
//     numbers) sign-sensitively within ±0.05pp / ±0.005. Inside `<!-- opinion:<agent> --> … <!-- /opinion -->` only that agent's
//     structured range/mid/confidence. Spelled-out quantities are refused; ISO dates must be pack dates; only `pack_id <id>` and
//     `run_id <id>` with the real values are masked; years are exempt only in a date context, plain integers <= 10 only without a unit.
//     Any other HTML comment or tag, schemeless/www links and instruction-like text (injection scan) fail the report.
//  4. Citations: every [S<id>] is a source of the run's pack AND currently verified/corroborated. The References section lists
//     exactly the cited ids, each line EXACTLY equal to referenceLine() (what get_consensus hands out). Every bare URL equals a
//     cited source's canonical URL.
//  5. The call: Summary states the consensus direction and mid; Baseline vs Consensus contains the consensus low/mid/high and the
//     baseline mid (or "null" for a short-history baseline) exactly as get_consensus formats them; Data As Of names the as-of
//     month and the as-of close's trade date.
//  6. Forbidden phrases (guaranteed, certain to, will definitely, price target, ...).
import { extractNumbers, traces, exempt, blank, normalizeNumerals, spelledQuantities, emptySets, addVals, addTextValues } from './numbers.mjs';
import { scanUntrusted } from '../harness/hookDecisions.mjs';
import { nextMonth } from '../market/calendar.mjs';

export const OPINION_RE = /<!--\s*opinion:([a-z_]+)\s*-->([\s\S]*?)<!--\s*\/opinion\s*-->/g;
const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

/** `---\nkey: value\n---` front matter (flat scalars only). */
export function parseFrontMatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(String(md));
  if (!m) return { front: null, body: String(md), offset: 0 };
  const front = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w]*)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) front[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return { front, body: String(md).slice(m[0].length), offset: m[0].length };
}

/** `## ` sections: [{title, start, end, text}] (offsets into the full markdown). */
export function sectionsOf(md) {
  const out = [];
  const re = /^##\s+(.+?)\s*$/gm;
  let m;
  while ((m = re.exec(md))) out.push({ title: m[1].trim(), start: m.index, headEnd: m.index + m[0].length });
  for (let i = 0; i < out.length; i++) { out[i].end = i + 1 < out.length ? out[i + 1].start : md.length; out[i].text = md.slice(out[i].headEnd, out[i].end); }
  return out;
}

/** Source ids of a pack (company news, macro news, research notes). */
export function packSourceIds(pack) {
  const ids = new Set();
  for (const n of [...(pack?.news ?? []), ...(pack?.macro_news ?? [])]) ids.add(Number(n.source_id));
  for (const r of pack?.research_notes ?? []) ids.add(Number(r.source_id));
  return ids;
}

/** The one accepted References line for a source (get_consensus hands out exactly these; page titles with instruction-like
 *  text are withheld). */
export function referenceLine(s) {
  const title = String(s.title_fetched ?? s.url_canonical).replace(/\s+/g, ' ').trim();
  const safe = scanUntrusted(title).length ? '[title withheld: instruction-like text]' : title;
  return `- [S${s.id}] ${safe}, ${s.outlet_key ?? s.domain}, ${String(s.published_at_fetched ?? '').slice(0, 10) || 'undated'}, ${s.url_canonical} (${s.verification_status}, sha256:${String(s.content_sha256 ?? '').slice(0, 8)})`;
}

const RETURN_KEYS = /^(r1|r3|r6|r12|vol12|vol36|mean36|up_rate36|mdd12|dist_12m_high|rel_r\d+_peers|rel_r3_bench|mid|low|high|raw_mid|mu_adj|p_adj|mu_log|sigma|overlay_bound|exp_return_low|exp_return_mid|exp_return_high|actual_return|hit_rate|range_coverage|mean_abs_error|in_range|direction_hit)$/;
const PROB_KEYS = /^(p_up|p_base|p_mom|p_mr|baseline_p_up|up_rate36)$/;
const PRICE_KEYS = /^(close|as_of_close)$/;
const PLAIN_KEYS = /^(confidence|final_confidence|agreement|data_factor|z1|mom_z\d*|n_months|n_returns36|k|brier|mean_brier|n_scored|score)$/;

/** Typed walk over structured pack/consensus objects: each field lands only in the set(s) its meaning allows. */
function addStructured(sets, v, key = '') {
  if (v === null || v === undefined) return;
  if (Array.isArray(v)) { for (const x of v) addStructured(sets, x, key); return; }
  if (typeof v === 'object') { for (const [k, x] of Object.entries(v)) addStructured(sets, x, k); return; }
  if (RETURN_KEYS.test(key)) addVals(sets, 'P', v);
  else if (PROB_KEYS.test(key)) { addVals(sets, 'P', v); addVals(sets, 'N', v); }
  else if (PRICE_KEYS.test(key)) { addVals(sets, 'D', v); addVals(sets, 'N', v); }
  else if (PLAIN_KEYS.test(key)) addVals(sets, 'N', v);
}

/** Typed allowed values (P percents as fractions, D prices, N plain, M magnitudes) from the pack, consensus, analyses, model. */
export function allowedSets({ pack, consensus, analyses = [], model }) {
  const sets = emptySets();
  for (const x of pack?.prices?.series ?? []) addVals(sets, 'D', x.close), addVals(sets, 'N', x.close);
  if (pack?.features && !pack.features.error) { const { stored: _s, ...f } = pack.features; addStructured(sets, f); }
  // peers: never their closes (another ticker's price is not this ticker's level); their returns only in peer-labelled sentences
  for (const pr of pack?.peers ?? []) addVals(sets, 'R', pr.r1, pr.r3, pr.r6, pr.r12, pr.vol12);
  addStructured(sets, pack?.baseline);
  addStructured(sets, pack?.calibration);
  addStructured(sets, pack?.prior_predictions);
  for (const n of pack?.research_notes ?? []) addTextValues(sets, n.claim);
  for (const e of pack?.untrusted_content?.note_excerpts ?? []) addTextValues(sets, e.text);
  for (const n of [...(pack?.news ?? []), ...(pack?.macro_news ?? [])]) addTextValues(sets, n.title);
  if (consensus) {
    const { formatted: _f, price_levels: pl, analyses: _a, ...c } = consensus;
    addStructured(sets, c);
    if (pl) addVals(sets, 'D', pl.low, pl.mid, pl.high, pl.as_of_close), addVals(sets, 'N', pl.low, pl.mid, pl.high, pl.as_of_close);
  }
  for (const x of analyses) { addVals(sets, 'P', x.exp_return_lo, x.exp_return_hi, (Number(x.exp_return_lo) + Number(x.exp_return_hi)) / 2); addVals(sets, 'N', x.confidence); }
  if (model) {
    const b = model.baseline, c = model.consensus, sh = model.short_history;
    addVals(sets, 'N', b.range_k, b.up_threshold, b.down_threshold, c.overlay_max_sigma, sh.max_confidence, c.label_thresholds.low, c.label_thresholds.medium, c.min_accepted_analyses);
    addVals(sets, 'P', b.flat_band, sh.sigma_floor, sh.min_range_width, c.max_p_adj, b.up_threshold, b.down_threshold);
  }
  return sets;
}

/** Dates a report may mention: pack months/trade dates, as-of/target, news/note dates. */
export function allowedDates(pack, ctx) {
  const d = new Set([pack?.as_of_month, ctx?.target_month, pack?.prices?.from, pack?.prices?.to].filter(Boolean));
  for (const x of pack?.prices?.series ?? []) { d.add(x.month); if (x.trade_date) d.add(x.trade_date); }
  for (const n of [...(pack?.news ?? []), ...(pack?.macro_news ?? [])]) if (n.published_at) { d.add(String(n.published_at).slice(0, 10)); d.add(String(n.published_at).slice(0, 7)); }
  for (const r of pack?.research_notes ?? []) if (r.as_of_date) { d.add(String(r.as_of_date).slice(0, 10)); d.add(String(r.as_of_date).slice(0, 7)); }
  if (pack?.window) for (const v of Object.values(pack.window)) if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) d.add(v.slice(0, 10));
  return d;
}

const normPhrase = (s) => String(s).toLowerCase().normalize('NFKC').replace(/[\s\-_‐-―]+/g, ' ');
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---- field binding (Validator final review #1) ----
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
/** Forward-looking sentence: talks about the target month / the future outcome. */
export function forwardRe(targetMonth) {
  const extra = [];
  if (/^\d{4}-\d{2}$/.test(String(targetMonth ?? ''))) { const m = MONTHS[Number(targetMonth.slice(5)) - 1]; extra.push(m, m.slice(0, 3), escRe(targetMonth)); }
  return new RegExp(`\\b(next month|target month|expect\\w*|could|likely|will|would|forecast\\w*|close at|closes at|closing at|(?:rise|rises|fall|falls|climb|drop|gain|jump|trade|trades)\\s+(?:to|at|by)|reach\\w*|upside|downside|probabilit\\w*|odds|chance|outcome|set to|project\\w*|predict\\w*|anticipat\\w*|should${extra.length ? `|${extra.join('|')}` : ''})\\b`, 'i');
}
const POINT_RE = /\b(most likely|likeliest|expected|expect|expects|central|base case|median|close at|closes at|closing at|target|reach\w*|trade at|set to|will be|point estimate)\b/i;
const RANGE_RE = /\b(range|ranges|between|band|bound|bounds|upper|lower|low end|high end|worst|best|below|above|interval|as low as|as high as|lo|hi|low|high|from)\b/i;
const DECLINE_RE = /\b(decline|declines|fall|falls|drop|drops|down|lower|loss|losses|negative|decrease)\b/i;
const RISE_RE = /\b(rise|rises|gain|gains|up|higher|increase|positive|p_up)\b/i;
const PEER_RE = (tickers) => new RegExp(`\\b(peers?|${tickers.map(escRe).join('|') || 'NONE'})\\b`, 'i');

/** The call's numbers with their ROLE (mid, bound, prob, conf, close): the only numbers a forward-looking sentence may use. */
export function callEntries(consensus, analyses = []) {
  const e = [];
  const add = (set, v, role) => { const x = Number(v); if (v !== null && v !== undefined && Number.isFinite(x)) e.push({ set, v: x, role }); };
  if (consensus) {
    const c = consensus;
    add('P', c.mid, 'mid'); add('P', c.low, 'bound'); add('P', c.high, 'bound');
    add('P', c.anchor?.mid, 'mid'); add('P', c.anchor?.low, 'bound'); add('P', c.anchor?.high, 'bound');
    for (const pv of [c.p_up, c.anchor?.p_up]) { add('P', pv, 'prob'); add('N', pv, 'prob'); }
    add('N', c.confidence, 'conf'); add('N', c.anchor?.confidence, 'conf');
    const pl = c.price_levels;
    if (pl) { for (const k of ['D', 'N']) { add(k, pl.mid, 'mid'); add(k, pl.low, 'bound'); add(k, pl.high, 'bound'); add(k, pl.as_of_close, 'close'); } }
  }
  for (const a of analyses) {
    add('P', a.exp_return_lo, 'bound'); add('P', a.exp_return_hi, 'bound'); add('P', (Number(a.exp_return_lo) + Number(a.exp_return_hi)) / 2, 'mid'); add('N', a.confidence, 'conf');
  }
  return e;
}
function matchingEntries(n, entries) {
  return entries.filter((en) => { const s = emptySets(); s[en.set].push(en.v); return traces(n, s); });
}
/** Sentence (from `text`) containing offset i: split on . ! ? followed by space/end, and on newlines. */
function sentenceAt(text, i) {
  let a = i, b = i;
  while (a > 0 && !(text[a - 1] === '\n' || (/[.!?]/.test(text[a - 1]) && /\s/.test(text[a] ?? ' ')))) a--;
  while (b < text.length && !(text[b] === '\n' || (/[.!?]/.test(text[b]) && (b + 1 >= text.length || /\s/.test(text[b + 1]))))) b++;
  return text.slice(a, b);
}

/**
 * @param md   report markdown
 * @param ctx  {cfg: verification.report, model, pack (incl. pack_id, pack_sha256), run_id, ticker, target_month, consensus,
 *              analyses: accepted [{agent, exp_return_lo, exp_return_hi, confidence, rationale}], sources: Map(id -> source row)}
 * @returns {ok, problems: string[], citations: number[], front}
 */
export function checkReport(md, ctx) {
  const problems = [];
  const text = String(md ?? '');
  const { cfg, pack } = ctx;
  const { front, offset } = parseFrontMatter(text);

  // 1. front matter
  if (!front) problems.push('front_matter_missing: the report must start with --- front matter (ticker, as_of_month, target_month, run_id, pack_id, pack_sha256) ---');
  else {
    const want = { ticker: ctx.ticker, target_month: ctx.target_month, as_of_month: pack?.as_of_month, run_id: String(ctx.run_id), pack_id: String(pack?.pack_id), pack_sha256: pack?.pack_sha256 };
    for (const [k, v] of Object.entries(want)) if (String(front[k] ?? '') !== String(v ?? '')) problems.push(`front_matter_mismatch:${k} (report ${front[k] ?? 'missing'}, expected ${v})`);
    if (front.target_month && front.as_of_month && nextMonth(front.as_of_month) !== front.target_month) problems.push('front_matter_mismatch:target_month must be as_of_month + 1');
  }

  // 2. sections + disclaimer + forbidden phrases
  const secs = sectionsOf(text);
  const sec = (name) => secs.find((s) => s.title.toLowerCase() === name.toLowerCase());
  for (const name of cfg.required_sections) if (!sec(name)) problems.push(`missing_section:${name}`);
  const disc = sec('Disclaimer');
  if (!disc || !disc.text.includes(cfg.disclaimer)) problems.push(`disclaimer_missing: the Disclaimer section must contain exactly "${cfg.disclaimer}"`);
  const lower = normPhrase(text.replace(cfg.disclaimer, ''));
  for (const p of cfg.forbidden_phrases ?? []) if (new RegExp(`(^|[^a-z0-9])${escRe(normPhrase(p))}($|[^a-z0-9])`).test(lower)) problems.push(`forbidden_phrase:${p}`);
  const inj = scanUntrusted(text.replace(cfg.disclaimer, ''));
  if (inj.length) problems.push(`injection_text: instruction-like text in the report (${inj.map((f) => f.id).join(', ')})`);

  // HTML: only the opinion markers are allowed; any other comment or tag could hide or inject content
  for (const m of text.matchAll(/<!--([\s\S]*?)-->/g)) if (!/^\s*(opinion:[a-z_]+|\/opinion)\s*$/.test(m[1])) problems.push(`html_comment_forbidden@${lineOf(text, m.index)}`);
  for (const m of text.matchAll(/<\s*\/?\s*[a-zA-Z][\w-]*[^>]*>/g)) problems.push(`html_forbidden:${m[0].slice(0, 30)}@${lineOf(text, m.index)}`);

  // 3. numbers. Text is NFKC + ASCII-digit normalised; the References section is checked line-by-line below (exact lines).
  const norm = normalizeNumerals(text);
  const secsN = sectionsOf(norm);
  const refsN = secsN.find((s) => s.title.toLowerCase() === 'references');
  let work = blank(norm.slice(0, offset)) + norm.slice(offset);
  if (refsN) work = work.slice(0, refsN.headEnd) + blank(work.slice(refsN.headEnd, refsN.end)) + work.slice(refsN.end);
  const di = work.indexOf(cfg.disclaimer);
  if (di >= 0) work = work.slice(0, di) + blank(cfg.disclaimer) + work.slice(di + cfg.disclaimer.length);
  work = work.replace(/\[S\d+\]/g, blank).replace(/https?:\/\/[^\s)>\]]+/g, blank).replace(/\]\([^)\s]*\)/g, blank).replace(/sha256:[0-9a-f]{4,64}/gi, blank);
  const idMask = (k, v) => new RegExp(`\\b${k}[ :=]+${v}\\b`, 'g');
  if (pack?.pack_id) work = work.replace(idMask('pack_id', pack.pack_id), blank);
  if (ctx.run_id) work = work.replace(idMask('run_id', ctx.run_id), blank);
  const dates = allowedDates(pack, ctx);
  work = work.replace(/\b\d{4}-\d{2}(?:-\d{2})?\b/g, (m, idx) => { if (!dates.has(m)) problems.push(`untraced_date:${m}@${lineOf(norm, idx)}`); return blank(m); });
  const smallIntMax = cfg.exempt_small_integers_max ?? 10;
  const analysesByAgent = new Map((ctx.analyses ?? []).map((a) => [a.agent, a]));
  for (const m of work.matchAll(OPINION_RE)) {
    const [whole, agent, inner] = m;
    const a = analysesByAgent.get(agent);
    if (!a) problems.push(`opinion_unknown_agent:${agent}@${lineOf(norm, m.index)} (no accepted ${agent} analysis for this run/ticker)`);
    // only the analyzer's STRUCTURED fields (range, mid, confidence), never free rationale text
    const own = emptySets();
    if (a) { addVals(own, 'P', a.exp_return_lo, a.exp_return_hi, (Number(a.exp_return_lo) + Number(a.exp_return_hi)) / 2); addVals(own, 'N', a.confidence); }
    const innerStart = m.index + whole.indexOf(inner);
    for (const n of extractNumbers(inner)) {
      if (exempt(n, inner, { smallIntMax })) continue;
      if (!traces(n, own)) problems.push(`opinion_untraced:${agent}:${n.raw}@${lineOf(norm, innerStart + n.index)} (not a structured field of the ${agent} analysis)`);
    }
    work = work.slice(0, m.index) + blank(whole) + work.slice(m.index + whole.length);
  }
  for (const q of spelledQuantities(work)) problems.push(`spelled_number:${q.raw}@${lineOf(norm, q.index)} (write numbers as digits copied from the pack)`);
  const allowed = allowedSets({ pack, consensus: ctx.consensus, analyses: ctx.analyses, model: ctx.model });
  const withPeers = { ...allowed, P: [...allowed.P, ...allowed.R] };
  const call = callEntries(ctx.consensus, ctx.analyses);
  const fwd = forwardRe(ctx.target_month);
  const peerRe = PEER_RE((pack?.peers ?? []).map((x) => x.ticker));
  for (const n of extractNumbers(work)) {
    if (exempt(n, work, { smallIntMax })) continue;
    const sent = sentenceAt(norm, n.index);
    const at = `${n.raw}@${lineOf(norm, n.index)}`;
    if (fwd.test(sent)) {
      // forward-looking: only the call's numbers, each used per its role
      const m = matchingEntries(n, call);
      if (!m.length) { problems.push(`forward_number_not_in_call:${at} (a statement about the target month may only use the call: consensus/baseline mid, range bounds, p_up, confidence, analyzer ranges)`); continue; }
      const roles = new Set(m.map((x) => x.role));
      if (!roles.has('mid') && roles.has('bound') && POINT_RE.test(sent) && !RANGE_RE.test(sent))
        problems.push(`bound_as_point:${at} (a range bound is described as the expected/most likely value; only the mid is the point estimate)`);
      if ([...roles].every((r) => r === 'prob') && DECLINE_RE.test(sent) && !RISE_RE.test(sent))
        problems.push(`probability_misdescribed:${at} (p_up is the probability of a RISE)`);
      continue;
    }
    if (!traces(n, peerRe.test(sent) ? withPeers : allowed)) problems.push(`untraced_number:${at}`);
  }

  // 4. citations
  const inPack = packSourceIds(pack);
  const refs = sec('References');
  const bodyNoRefs = refs ? text.slice(0, refs.start) + blank(text.slice(refs.start, refs.end)) + text.slice(refs.end) : text;
  const cited = new Set([...bodyNoRefs.matchAll(/\[S(\d+)\]/g)].map((m) => Number(m[1])));
  const listed = refs ? [...refs.text.matchAll(/\[S(\d+)\]/g)].map((m) => Number(m[1])) : [];
  for (const id of new Set([...cited, ...listed])) {
    const s = ctx.sources?.get(id);
    if (!inPack.has(id)) problems.push(`citation_not_in_pack:S${id}`);
    if (!s || !['verified', 'corroborated'].includes(s.verification_status)) problems.push(`citation_unverified:S${id}`);
  }
  const listedSet = new Set(listed);
  if (listed.length !== listedSet.size) problems.push('references_mismatch: a source is listed twice');
  const missing = [...cited].filter((id) => !listedSet.has(id)), extra = [...listedSet].filter((id) => !cited.has(id));
  if (missing.length || extra.length) problems.push(`references_mismatch: cited but not listed [${missing.map((x) => `S${x}`).join(',')}], listed but not cited [${extra.map((x) => `S${x}`).join(',')}]`);
  if (refs) {
    for (const line of refs.text.split('\n').map((l) => l.trim()).filter(Boolean)) {
      const ids = [...line.matchAll(/\[S(\d+)\]/g)].map((m) => Number(m[1]));
      if (ids.length !== 1) { problems.push(`reference_line_bad: "${line.slice(0, 60)}" (one [S<id>] line per source, copied from get_consensus)`); continue; }
      const s = ctx.sources?.get(ids[0]);
      if (s && line !== referenceLine({ ...s, id: ids[0] })) problems.push(`reference_line_bad:S${ids[0]} (must equal exactly: ${referenceLine({ ...s, id: ids[0] })})`);
    }
  }
  const okUrls = new Set([...cited, ...listed].map((id) => ctx.sources?.get(id)?.url_canonical).filter(Boolean));
  for (const m of text.matchAll(/https?:\/\/[^\s)>\]]+/g)) {
    const u = m[0].replace(/[.,;:]+$/, '');
    if (!okUrls.has(u)) problems.push(`stray_url:${u}@${lineOf(text, m.index)} (only canonical URLs of cited sources)`);
  }
  for (const m of bodyNoRefs.matchAll(/(?:^|[\s(<"'\[])(\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s)]*|www\.[a-z0-9-]+\.[a-z]{2,}[^\s)]*)/gi)) problems.push(`stray_url:${m[1]}@${lineOf(text, m.index)} (no schemeless/www links)`);

  // 5. the call
  const f = ctx.consensus?.formatted;
  if (!f) problems.push('consensus_unavailable: the run/ticker has no consensus (needs >= 3 accepted analyses)');
  else {
    const summary = sec('Summary')?.text ?? '';
    if (!new RegExp(`\\b${f.direction}\\b`, 'i').test(summary)) problems.push(`call_missing: Summary must state the consensus direction "${f.direction}"`);
    if (!summary.includes(f.mid)) problems.push(`call_missing: Summary must state the consensus mid ${f.mid}`);
    const bvc = sec('Baseline vs Consensus')?.text ?? '';
    for (const k of ['low', 'mid', 'high']) if (!bvc.includes(f[k])) problems.push(`call_missing: Baseline vs Consensus must contain consensus ${k} ${f[k]}`);
    if (ctx.consensus.baseline_status === 'ok') { if (!bvc.includes(f.anchor_mid)) problems.push(`call_missing: Baseline vs Consensus must contain the baseline mid ${f.anchor_mid}`); }
    else if (!/\bnull\b/i.test(bvc)) problems.push('call_missing: Baseline vs Consensus must say the baseline is null (short history)');
  }
  const asOf = sec('Data As Of')?.text ?? '';
  const last = (pack?.prices?.series ?? []).filter((s) => s.close !== null).pop();
  if (pack?.as_of_month && !asOf.includes(pack.as_of_month)) problems.push(`as_of_missing: Data As Of must name the as-of month ${pack.as_of_month}`);
  if (last?.trade_date && !asOf.includes(last.trade_date)) problems.push(`as_of_missing: Data As Of must name the as-of close date ${last.trade_date}`);

  return { ok: problems.length === 0, problems, citations: [...cited].sort((a, b) => a - b), front };
}

