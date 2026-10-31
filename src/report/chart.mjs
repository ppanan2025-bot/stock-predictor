// Deterministic prediction charts (drawer agent: npm run draw). Reads ONLY stockdb (verified month_end_prices + the saved
// prediction and its accepted analyses, or — before save_prediction — the run's server-computed consensus) and writes
//   reports/<target>/<TICKER>-prediction.svg   line of verified month-end closes, dashed segment to the predicted mid close,
//                                               shaded lo-hi cone, per-analyzer markers, axis labels, data-as-of
//   reports/<target>/<TICKER>-prediction.json  sidecar: the exact plotted values with their DB ids and the SVG sha256
// Same DB state -> byte-identical SVG (no clock, no randomness, fixed decimals). verifyChart() re-reads the DB and re-renders
// from the sidecar so finalize_report / the validator can prove the chart shows DB values only.
import fs from 'node:fs';
import path from 'node:path';
import { sha256, stableStringify } from '../lib/hash.mjs';
import { clean } from '../lib/repo.mjs';
import { root } from '../lib/env.mjs';
import { monthRange, prevMonth } from '../market/calendar.mjs';
import { pct } from '../quant/consensus.mjs';

export const CHART_CODE_VERSION = 'chart-v1';
const rows = async (db, sql, args = []) => clean((await db.query(sql, args))[0]);

export const reportsRoot = () => (process.env.SP_REPORTS_DIR && path.isAbsolute(process.env.SP_REPORTS_DIR) ? process.env.SP_REPORTS_DIR : path.join(root, 'reports'));
/** reports/<YYYY-MM>/<TICKER>-prediction.md -> absolute path under reportsRoot(); throws on anything else. */
export function resolveReportPath(rel, base = reportsRoot()) {
  if (!/^reports\/\d{4}-(0[1-9]|1[0-2])\/[A-Z][A-Z0-9.]{0,9}-prediction\.(md|svg|json)$/.test(String(rel))) throw new Error(`bad report path ${rel}`);
  return path.join(base, String(rel).slice('reports/'.length));
}
export const chartPaths = (ticker, target, base = reportsRoot()) => ({
  rel_svg: `reports/${target}/${ticker}-prediction.svg`, rel_json: `reports/${target}/${ticker}-prediction.json`,
  svg: path.join(base, target, `${ticker}-prediction.svg`), json: path.join(base, target, `${ticker}-prediction.json`) });

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n2 = (x) => Number(x).toFixed(2);
const COLORS = { fundamental: '#1f77b4', technical: '#ff7f0e', news_sentiment: '#2ca02c', macro_sector: '#9467bd', risk_skeptic: '#d62728' };
const SHAPES = ['circle', 'square', 'diamond', 'triangle', 'cross'];

function niceTicks(lo, hi, n = 5) {
  const span = hi - lo || 1;
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

function marker(shape, x, y, color) {
  const s = 5;
  if (shape === 'square') return `<rect x="${n2(x - s)}" y="${n2(y - s)}" width="${2 * s}" height="${2 * s}" fill="${color}"/>`;
  if (shape === 'diamond') return `<polygon points="${n2(x)},${n2(y - s - 1)} ${n2(x + s + 1)},${n2(y)} ${n2(x)},${n2(y + s + 1)} ${n2(x - s - 1)},${n2(y)}" fill="${color}"/>`;
  if (shape === 'triangle') return `<polygon points="${n2(x)},${n2(y - s - 1)} ${n2(x + s + 1)},${n2(y + s)} ${n2(x - s - 1)},${n2(y + s)}" fill="${color}"/>`;
  if (shape === 'cross') return `<path d="M${n2(x - s)},${n2(y - s)} L${n2(x + s)},${n2(y + s)} M${n2(x - s)},${n2(y + s)} L${n2(x + s)},${n2(y - s)}" stroke="${color}" stroke-width="2"/>`;
  return `<circle cx="${n2(x)}" cy="${n2(y)}" r="${s}" fill="${color}"/>`;
}

/**
 * Pure SVG renderer. data = {ticker, as_of_month, target_month, data_as_of, points:[{month, close}],
 *   call:{direction, mid, low, high, p_up, confidence_label} (simple returns), analyses:[{agent, mid}], label}
 */
export function renderPredictionSvg(data) {
  const W = 960, H = 520, L = 80, R = 210, T = 70, B = 70;
  const pts = data.points.filter((p) => p.close !== null && p.close !== undefined).map((p) => ({ month: p.month, close: Number(p.close) }));
  const last = pts[pts.length - 1];
  const months = monthRange(pts[0].month, data.target_month);
  const base = last.close;
  const lv = (r) => base * (1 + Number(r));
  const levels = { low: lv(data.call.low), mid: lv(data.call.mid), high: lv(data.call.high) };
  const am = (data.analyses ?? []).map((a) => ({ ...a, level: lv(a.mid) }));
  const all = [...pts.map((p) => p.close), levels.low, levels.high, ...am.map((a) => a.level)];
  let lo = Math.min(...all), hi = Math.max(...all);
  const pad = (hi - lo) * 0.06 || 1; lo -= pad; hi += pad;
  const X = (m) => L + (months.indexOf(m) / Math.max(1, months.length - 1)) * (W - L - R);
  const Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const o = [];
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif" font-size="12">`);
  o.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`);
  o.push(`<text x="${L}" y="28" font-size="18" font-weight="bold">${esc(data.ticker)}: verified month-end closes and ${esc(data.target_month)} prediction</text>`);
  o.push(`<text x="${L}" y="48" fill="#444">${esc(data.label)}</text>`);
  // grid + y axis
  for (const t of niceTicks(lo, hi)) {
    o.push(`<line x1="${L}" y1="${n2(Y(t))}" x2="${W - R}" y2="${n2(Y(t))}" stroke="#e5e5e5"/>`);
    o.push(`<text x="${L - 8}" y="${n2(Y(t) + 4)}" text-anchor="end" fill="#333">$${n2(t)}</text>`);
  }
  o.push(`<line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" stroke="#333"/><line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" stroke="#333"/>`);
  o.push(`<text x="18" y="${n2((T + H - B) / 2)}" transform="rotate(-90 18 ${n2((T + H - B) / 2)})" text-anchor="middle" fill="#333">Month-end close (USD, unadjusted)</text>`);
  // x axis ticks: every 6th month, the as-of month and the target month
  months.forEach((m, i) => {
    if (i % 6 === 0 || m === last.month || m === data.target_month) {
      o.push(`<line x1="${n2(X(m))}" y1="${H - B}" x2="${n2(X(m))}" y2="${H - B + 5}" stroke="#333"/>`);
      o.push(`<text x="${n2(X(m))}" y="${H - B + 20}" text-anchor="middle" fill="#333">${m}</text>`);
    }
  });
  o.push(`<text x="${n2((L + W - R) / 2)}" y="${H - 22}" text-anchor="middle" fill="#333">Month</text>`);
  // band (cone from the last close to lo..hi at the target month), dashed mid segment
  o.push(`<polygon points="${n2(X(last.month))},${n2(Y(base))} ${n2(X(data.target_month))},${n2(Y(levels.high))} ${n2(X(data.target_month))},${n2(Y(levels.low))}" fill="#1f77b4" fill-opacity="0.15" stroke="none"/>`);
  o.push(`<line x1="${n2(X(data.target_month))}" y1="${n2(Y(levels.high))}" x2="${n2(X(data.target_month))}" y2="${n2(Y(levels.low))}" stroke="#1f77b4" stroke-width="2"/>`);
  o.push(`<line x1="${n2(X(last.month))}" y1="${n2(Y(base))}" x2="${n2(X(data.target_month))}" y2="${n2(Y(levels.mid))}" stroke="#1f77b4" stroke-width="2" stroke-dasharray="6 4"/>`);
  // verified closes (gaps break the line; never interpolated)
  const segs = []; let cur = [];
  for (const m of monthRange(pts[0].month, last.month)) { const p = pts.find((x) => x.month === m); if (p) cur.push(p); else if (cur.length) { segs.push(cur); cur = []; } }
  if (cur.length) segs.push(cur);
  for (const s of segs) o.push(`<polyline points="${s.map((p) => `${n2(X(p.month))},${n2(Y(p.close))}`).join(' ')}" fill="none" stroke="#222" stroke-width="2"/>`);
  for (const p of pts) o.push(`<circle cx="${n2(X(p.month))}" cy="${n2(Y(p.close))}" r="2.5" fill="#222"/>`);
  o.push(`<circle cx="${n2(X(data.target_month))}" cy="${n2(Y(levels.mid))}" r="5" fill="#ffffff" stroke="#1f77b4" stroke-width="2"/>`);
  const tx = X(data.target_month) + 10;
  o.push(`<text x="${n2(tx)}" y="${n2(Y(levels.high) + 4)}" fill="#1f77b4">hi $${n2(levels.high)} (${pct(data.call.high)})</text>`);
  o.push(`<text x="${n2(tx)}" y="${n2(Y(levels.mid) + 4)}" fill="#1f77b4" font-weight="bold">mid $${n2(levels.mid)} (${pct(data.call.mid)})</text>`);
  o.push(`<text x="${n2(tx)}" y="${n2(Y(levels.low) + 4)}" fill="#1f77b4">lo $${n2(levels.low)} (${pct(data.call.low)})</text>`);
  o.push(`<text x="${n2(X(last.month))}" y="${n2(Y(base) - 10)}" text-anchor="end" fill="#222">$${n2(base)} (${esc(last.month)})</text>`);
  // analyzer markers (offset left of the target month so they do not hide the band)
  am.forEach((a, i) => {
    const x = X(data.target_month) - 14 - 9 * i;
    o.push(marker(SHAPES[i % SHAPES.length], x, Y(a.level), COLORS[a.agent] ?? '#555'));
  });
  // legend
  let ly = T + 6;
  const lx = W - R + 70;
  o.push(`<text x="${lx}" y="${ly}" font-weight="bold">Legend</text>`); ly += 18;
  o.push(`<line x1="${lx}" y1="${ly - 4}" x2="${lx + 22}" y2="${ly - 4}" stroke="#222" stroke-width="2"/><text x="${lx + 28}" y="${ly}">verified close</text>`); ly += 18;
  o.push(`<line x1="${lx}" y1="${ly - 4}" x2="${lx + 22}" y2="${ly - 4}" stroke="#1f77b4" stroke-width="2" stroke-dasharray="6 4"/><text x="${lx + 28}" y="${ly}">predicted mid</text>`); ly += 18;
  o.push(`<rect x="${lx}" y="${ly - 10}" width="22" height="10" fill="#1f77b4" fill-opacity="0.15"/><text x="${lx + 28}" y="${ly}">lo-hi range</text>`); ly += 22;
  am.forEach((a, i) => { o.push(marker(SHAPES[i % SHAPES.length], lx + 11, ly - 4, COLORS[a.agent] ?? '#555')); o.push(`<text x="${lx + 28}" y="${ly}">${esc(a.agent)} ${pct(a.mid)}</text>`); ly += 18; });
  o.push(`<text x="${L}" y="${H - 6}" fill="#666" font-size="11">Data as of ${esc(data.data_as_of)} (stockdb verified closes: Nasdaq, cross-checked with CNBC). Not investment advice.</text>`);
  o.push('</svg>');
  return o.join('\n') + '\n';
}

/** Combined chart: every ticker's closes indexed to 100 at its first plotted month, plus the predicted mid (dashed). */
export function renderIndexedSvg({ target_month, series, data_as_of }) {
  const W = 960, H = 520, L = 70, R = 170, T = 60, B = 60;
  const palette = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b'];
  const first = series.map((s) => s.points[0]?.month).filter(Boolean).sort()[0];
  const months = monthRange(first, target_month);
  const idx = series.map((s) => {
    const b = Number(s.points[0].close);
    const pts = s.points.map((p) => ({ month: p.month, v: 100 * Number(p.close) / b }));
    const lastC = Number(s.points[s.points.length - 1].close);
    return { ...s, pts, pred: s.mid === null || s.mid === undefined ? null : 100 * lastC * (1 + Number(s.mid)) / b };
  });
  const all = idx.flatMap((s) => [...s.pts.map((p) => p.v), ...(s.pred === null ? [] : [s.pred])]);
  let lo = Math.min(...all), hi = Math.max(...all);
  const pad = (hi - lo) * 0.06 || 1; lo -= pad; hi += pad;
  const X = (m) => L + (months.indexOf(m) / Math.max(1, months.length - 1)) * (W - L - R);
  const Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const o = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif" font-size="12">`,
    `<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`,
    `<text x="${L}" y="30" font-size="18" font-weight="bold">Verified month-end closes, indexed (first month = 100), and ${esc(target_month)} predicted mids</text>`];
  for (const t of niceTicks(lo, hi)) {
    o.push(`<line x1="${L}" y1="${n2(Y(t))}" x2="${W - R}" y2="${n2(Y(t))}" stroke="#e5e5e5"/>`);
    o.push(`<text x="${L - 8}" y="${n2(Y(t) + 4)}" text-anchor="end">${n2(t)}</text>`);
  }
  o.push(`<line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" stroke="#333"/><line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" stroke="#333"/>`);
  months.forEach((m, i) => { if (i % 6 === 0 || m === target_month) o.push(`<text x="${n2(X(m))}" y="${H - B + 20}" text-anchor="middle">${m}</text>`); });
  o.push(`<text x="18" y="${n2((T + H - B) / 2)}" transform="rotate(-90 18 ${n2((T + H - B) / 2)})" text-anchor="middle">Index (first verified month = 100)</text>`);
  idx.forEach((s, i) => {
    const c = palette[i % palette.length];
    o.push(`<polyline points="${s.pts.map((p) => `${n2(X(p.month))},${n2(Y(p.v))}`).join(' ')}" fill="none" stroke="${c}" stroke-width="2"/>`);
    const lp = s.pts[s.pts.length - 1];
    if (s.pred !== null) o.push(`<line x1="${n2(X(lp.month))}" y1="${n2(Y(lp.v))}" x2="${n2(X(target_month))}" y2="${n2(Y(s.pred))}" stroke="${c}" stroke-width="2" stroke-dasharray="6 4"/>`);
    o.push(`<rect x="${W - R + 20}" y="${T + 20 * i}" width="14" height="4" fill="${c}"/><text x="${W - R + 40}" y="${T + 20 * i + 6}">${esc(s.ticker)}${s.pred === null ? ' (no prediction)' : ` ${pct(s.mid)}`}</text>`);
  });
  o.push(`<text x="${L}" y="${H - 8}" fill="#666" font-size="11">Data as of ${esc(data_as_of)} (stockdb verified closes). Not investment advice.</text>`, '</svg>');
  return o.join('\n') + '\n';
}

/** Verified closes <= as-of with their DB ids. */
async function pricePoints(db, ticker, asOf) {
  return (await rows(db, 'SELECT id, month, trade_date, close, submission_id FROM month_end_prices WHERE ticker = ? AND month <= ? ORDER BY month', [ticker, asOf]))
    .map((r) => ({ month: r.month, trade_date: r.trade_date, close: r.close, price_id: Number(r.id), submission_id: Number(r.submission_id) }));
}

/**
 * Chart data for (ticker, target) from the DB: the latest non-withdrawn prediction (+ its linked analyses) or, when none is saved
 * yet, the run's consensus via `consensusFor(run_id, ticker)` (injected to avoid a module cycle).
 */
export async function loadChartData(db, { ticker, target_month, run_id = null, consensusFor = null }) {
  const asOf = prevMonth(target_month);
  const points = await pricePoints(db, ticker, asOf);
  if (!points.length || points[points.length - 1].month !== asOf) throw new Error(`${ticker}: no verified close for ${asOf}`);
  const [pred] = await rows(db, "SELECT * FROM predictions WHERE ticker = ? AND target_month = ? AND status <> 'withdrawn' ORDER BY version DESC LIMIT 1", [ticker, target_month]);
  let call, analyses, prediction = null, source, runId = run_id;
  if (pred && (!run_id || Number(pred.run_id) === Number(run_id))) {
    const an = await rows(db, 'SELECT id, agent, exp_return_lo, exp_return_hi, confidence FROM analyses WHERE prediction_id = ? ORDER BY agent, id', [pred.id]);
    call = { direction: pred.direction, p_up: pred.p_up, low: pred.exp_return_low, mid: pred.exp_return_mid, high: pred.exp_return_high, confidence_label: pred.confidence_label };
    analyses = an.map((a) => ({ analysis_id: Number(a.id), agent: a.agent, lo: a.exp_return_lo, hi: a.exp_return_hi, mid: ((Number(a.exp_return_lo) + Number(a.exp_return_hi)) / 2).toFixed(6), confidence: a.confidence }));
    prediction = { prediction_id: Number(pred.id), version: Number(pred.version), pack_id: Number(pred.pack_id), report_sha256: pred.report_sha256 };
    source = 'prediction'; runId = pred.run_id === null ? null : Number(pred.run_id);
  } else {
    if (!runId) {
      const [r] = await rows(db, 'SELECT id FROM runs WHERE target_month = ? AND JSON_CONTAINS(tickers, JSON_QUOTE(?)) ORDER BY id DESC LIMIT 1', [target_month, ticker]);
      if (!r) throw new Error(`${ticker} ${target_month}: no saved prediction and no run`);
      runId = Number(r.id);
    }
    if (!consensusFor) throw new Error('no consensus loader');
    const c = await consensusFor(db, runId, ticker);
    call = { direction: c.consensus.direction, p_up: c.consensus.p_up, low: c.consensus.low, mid: c.consensus.mid, high: c.consensus.high, confidence_label: c.consensus.confidence_label };
    analyses = c.consensus.analyses.map((a) => ({ analysis_id: a.analysis_id, agent: a.agent, lo: a.lo, hi: a.hi, mid: a.mid, confidence: a.confidence }));
    source = 'run_consensus';
  }
  const lastP = points[points.length - 1];
  const svgData = { ticker, as_of_month: asOf, target_month, data_as_of: lastP.trade_date, points: points.map((p) => ({ month: p.month, close: p.close })),
    call, analyses: analyses.map((a) => ({ agent: a.agent, mid: a.mid })),
    label: `Consensus ${call.direction}: mid ${pct(call.mid)} [${pct(call.low)} .. ${pct(call.high)}], p_up ${Number(call.p_up).toFixed(2)}, confidence ${call.confidence_label}${prediction ? ` (prediction ${prediction.prediction_id} v${prediction.version})` : ' (run consensus, not yet saved)'}` };
  const sidecar = { chart_code_version: CHART_CODE_VERSION, generated_from: 'stockdb', ticker, as_of_month: asOf, target_month, run_id: runId,
    values_source: source, prediction, call, analyses, points, data_as_of: lastP.trade_date };
  return { svgData, sidecar };
}

/** Renders and writes the SVG + sidecar; returns {svg_path, json_path, svg_sha256}. */
export async function drawPrediction(db, { ticker, target_month, run_id = null, consensusFor, base = reportsRoot() }) {
  const { svgData, sidecar } = await loadChartData(db, { ticker, target_month, run_id, consensusFor });
  const svg = renderPredictionSvg(svgData);
  const p = chartPaths(ticker, target_month, base);
  fs.mkdirSync(path.dirname(p.svg), { recursive: true });
  fs.writeFileSync(p.svg, svg);
  const side = { ...sidecar, svg_file: path.basename(p.svg), svg_sha256: sha256(svg), render_input_sha256: sha256(stableStringify(svgData)) };
  fs.writeFileSync(p.json, JSON.stringify(side, null, 2) + '\n');
  return { svg_path: p.rel_svg, json_path: p.rel_json, svg_sha256: side.svg_sha256, values_source: side.values_source, prediction_id: side.prediction?.prediction_id ?? null };
}

export async function drawAll(db, { target_month, base = reportsRoot() }) {
  const asOf = prevMonth(target_month);
  const tickers = (await rows(db, "SELECT ticker FROM companies WHERE active = 1 AND role = 'target' ORDER BY FIELD(ticker,'GOOGL','AMZN','AAPL','SPCX'), ticker")).map((r) => r.ticker);
  const series = [];
  for (const t of tickers) {
    const points = await pricePoints(db, t, asOf);
    if (!points.length) continue;
    const [pred] = await rows(db, "SELECT id, version, exp_return_mid FROM predictions WHERE ticker = ? AND target_month = ? AND status <> 'withdrawn' ORDER BY version DESC LIMIT 1", [t, target_month]);
    series.push({ ticker: t, points, mid: pred ? pred.exp_return_mid : null, prediction_id: pred ? Number(pred.id) : null });
  }
  const data_as_of = series.map((s) => s.points[s.points.length - 1].trade_date).sort().pop();
  const svg = renderIndexedSvg({ target_month, series: series.map((s) => ({ ticker: s.ticker, points: s.points, mid: s.mid })), data_as_of });
  const dir = path.join(base, target_month);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ALL-indexed.svg'), svg);
  const side = { chart_code_version: CHART_CODE_VERSION, generated_from: 'stockdb', target_month, as_of_month: asOf, data_as_of, series, svg_file: 'ALL-indexed.svg', svg_sha256: sha256(svg) };
  fs.writeFileSync(path.join(dir, 'ALL-indexed.json'), JSON.stringify(side, null, 2) + '\n');
  return { svg_path: `reports/${target_month}/ALL-indexed.svg`, svg_sha256: side.svg_sha256, tickers: series.map((s) => s.ticker) };
}

/**
 * Proves a chart shows DB values for this prediction: sidecar exists, is bound to the prediction (id, version, report sha not
 * required), its points equal month_end_prices (id, month, close, trade_date), its call equals the prediction row, its analyses
 * equal the linked analyses, and re-rendering the sidecar's values reproduces the SVG file byte-for-byte (sha).
 */
export async function verifyChart(db, prediction, { base = reportsRoot() } = {}) {
  const problems = [];
  const p = chartPaths(prediction.ticker, prediction.target_month, base);
  let side, svg;
  try { side = JSON.parse(fs.readFileSync(p.json, 'utf8')); } catch { return { ok: false, problems: [`chart_missing: ${p.rel_json} (run npm run draw -- --ticker ${prediction.ticker} --target ${prediction.target_month})`] }; }
  try { svg = fs.readFileSync(p.svg, 'utf8'); } catch { return { ok: false, problems: [`chart_missing: ${p.rel_svg}`] }; }
  if (sha256(svg) !== side.svg_sha256) problems.push('chart_svg_sha_mismatch: the SVG file was changed after drawing');
  if (side.prediction?.prediction_id !== Number(prediction.id)) problems.push(`chart_not_bound: sidecar prediction ${side.prediction?.prediction_id ?? 'none'} != ${prediction.id} (re-run npm run draw after save_prediction)`);
  let fresh;
  try { fresh = await loadChartData(db, { ticker: prediction.ticker, target_month: prediction.target_month }); }
  catch (e) { return { ok: false, problems: [...problems, `chart_db_error: ${e.message}`] }; }
  const cmp = (k, a, b) => { if (stableStringify(a) !== stableStringify(b)) problems.push(`chart_value_mismatch:${k}`); };
  cmp('points', side.points, fresh.sidecar.points);
  cmp('call', side.call, fresh.sidecar.call);
  cmp('analyses', side.analyses, fresh.sidecar.analyses);
  cmp('prediction', side.prediction, fresh.sidecar.prediction);
  if (sha256(renderPredictionSvg(fresh.svgData)) !== side.svg_sha256) problems.push('chart_render_mismatch: re-rendering the DB values does not reproduce the SVG');
  return { ok: problems.length === 0, problems, svg_sha256: side.svg_sha256 };
}
