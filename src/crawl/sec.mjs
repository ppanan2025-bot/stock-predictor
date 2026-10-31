// SEC EDGAR crawler (PLAN §8 /research-company): the company submissions JSON (data.sec.gov/submissions/CIK##########.json)
// gives recent filings; 10-K / 10-Q / 8-K are listed with their primary document URL, and for 8-Ks that report results
// (item 2.02) the filing index page is read to find the earnings press release exhibit (EX-99.1).
// The crawler only DISCOVERS candidate URLs. Nothing it finds is evidence until it goes through the stockdb server
// (add_source / add_research_note re-fetch and verify it).
// SEC fair-access: a declared User-Agent with the user's contact address (SP_HTTP_UA, set by the user in .env), <= 10 req/s.
// While SP_HTTP_UA is unset or still the placeholder the crawler refuses BEFORE any request: error code sec_user_agent_unset.
import * as cheerio from 'cheerio';
import { createHttp, SourceError } from './http.mjs';
import { crawlConfig } from '../lib/env.mjs';
import { requireSecUserAgent } from './secUa.mjs';

export const SEC_FORMS = Object.freeze(['10-K', '10-Q', '8-K']);
export const SEC_MIN_INTERVAL_MS = 150; // < 10 requests per second
export const cik10 = (cik) => String(cik ?? '').replace(/\D/g, '').padStart(10, '0');
export const submissionsUrl = (cik) => `https://data.sec.gov/submissions/CIK${cik10(cik)}.json`;
export const archiveBase = (cik, accession) => `https://www.sec.gov/Archives/edgar/data/${Number(cik10(cik))}/${String(accession).replace(/-/g, '')}`;
export const filingIndexUrl = (cik, accession) => `${archiveBase(cik, accession)}/${accession}-index.htm`;

/**
 * Recent filings from a submissions JSON (filings.recent is column-oriented: parallel arrays).
 * @returns [{form, accession, filing_date, report_date, items[], primary_document, description, url, index_url}] newest first
 */
export function parseSubmissions(json, { cik = null, forms = SEC_FORMS, since = null, limit = 20 } = {}) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const rec = data?.filings?.recent;
  if (!rec || !Array.isArray(rec.accessionNumber)) throw new Error('submissions JSON has no filings.recent.accessionNumber');
  const c = cik ?? data.cik;
  const out = [];
  for (let i = 0; i < rec.accessionNumber.length; i++) {
    const form = rec.form?.[i];
    if (!forms.includes(form)) continue;
    const filing_date = rec.filingDate?.[i] ?? null;
    if (since && filing_date && filing_date < since) continue;
    const accession = rec.accessionNumber[i];
    const primary = rec.primaryDocument?.[i] ?? null;
    out.push({ form, accession, filing_date, report_date: rec.reportDate?.[i] || null,
      items: String(rec.items?.[i] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      primary_document: primary, description: rec.primaryDocDescription?.[i] || null,
      url: primary ? `${archiveBase(c, accession)}/${primary}` : null, index_url: filingIndexUrl(c, accession) });
  }
  out.sort((a, b) => (a.filing_date < b.filing_date ? 1 : a.filing_date > b.filing_date ? -1 : a.accession < b.accession ? 1 : -1));
  return out.slice(0, limit);
}

/** Documents of a filing index page (-index.htm): [{seq, description, type, url, size}]. Inline-XBRL viewer links are unwrapped. */
export function parseFilingIndex(html, baseUrl = 'https://www.sec.gov/') {
  const $ = cheerio.load(String(html ?? ''));
  const docs = [];
  $('table.tableFile tr').each((_, tr) => {
    const td = $(tr).find('td');
    if (td.length < 4) return;
    let href = $(td[2]).find('a').attr('href');
    if (!href) return;
    href = href.replace(/^\/ix\?doc=/, '');
    let url;
    try { url = new URL(href, baseUrl).toString(); } catch { return; }
    docs.push({ seq: $(td[0]).text().trim() || null, description: $(td[1]).text().trim() || null, type: $(td[3]).text().trim() || null,
      url, size: td[4] ? $(td[4]).text().trim() || null : null });
  });
  return docs;
}

/** 8-K reporting results of operations (item 2.02) -> look for the EX-99.1 press release. */
export const isEarnings8K = (f) => f.form === '8-K' && f.items.includes('2.02');

/**
 * Candidate filing documents for one company.
 * @param opts.ua     SEC User-Agent (default SP_HTTP_UA); refused (sec_user_agent_unset) while unset/placeholder
 * @param opts.http   createHttp() instance (fixture mode in tests)
 * @returns {ticker, cik, filings:[...{exhibit_99_1?: {url, description}}], requests}
 */
export async function secFilings({ ticker, cik, ua = crawlConfig().secUserAgent, http = null, since = null, forms = SEC_FORMS, limit = 12,
  exhibits = true, log = () => {} } = {}) {
  const h = http ?? createHttp();
  const agent = requireSecUserAgent(ua, { live: h.mode !== 'fixture' }); // throws BEFORE any request
  if (!cik) throw new Error(`${ticker}: no CIK in companies (SEC filings unavailable)`);
  const headers = { 'User-Agent': agent, Accept: 'application/json, text/html;q=0.9, */*;q=0.5', 'Accept-Encoding': 'identity' };
  const get = (url, accept) => h.get(url, { source: 'sec', headers: { ...headers, ...(accept ? { Accept: accept } : {}) }, minIntervalMs: SEC_MIN_INTERVAL_MS,
    retries: 2, timeoutMs: 20000 });
  let requests = 0;
  const sub = await get(submissionsUrl(cik), 'application/json'); requests++;
  let json;
  try { json = JSON.parse(sub.text); } catch { throw new SourceError('sec', 'non_json', submissionsUrl(cik), 'submissions response is not JSON'); }
  const filings = parseSubmissions(json, { cik, forms, since, limit });
  if (exhibits) {
    for (const f of filings.filter(isEarnings8K)) {
      try {
        const idx = await get(f.index_url, 'text/html'); requests++;
        const ex = parseFilingIndex(idx.text, f.index_url).find((d) => /^EX-99\.1$/i.test(d.type ?? ''));
        if (ex) f.exhibit_99_1 = { url: ex.url, description: ex.description };
      } catch (e) { f.exhibit_error = `${e.code ?? 'error'}: ${e.message}`; log(`index ${f.index_url}: ${e.message}`); }
    }
  }
  return { ticker, cik: cik10(cik), name: json.name ?? null, filings, requests };
}

/** The URLs to register as sources (kind 'filing'): earnings exhibits first, then primary documents. */
export function secSourceUrls(result) {
  const out = [];
  for (const f of result.filings) {
    if (f.exhibit_99_1?.url) out.push({ url: f.exhibit_99_1.url, kind: 'filing', label: `${f.form} ${f.filing_date} EX-99.1`, form: f.form, filing_date: f.filing_date });
    if (f.url) out.push({ url: f.url, kind: 'filing', label: `${f.form} ${f.filing_date} ${f.primary_document}`, form: f.form, filing_date: f.filing_date });
  }
  return out;
}
