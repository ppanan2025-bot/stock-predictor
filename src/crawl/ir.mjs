// Company investor-relations / newsroom crawler (PLAN §8). Reads the per-ticker listings in config/feeds.json (Atom/RSS feeds
// or HTML listing pages) and returns candidate press-release URLs. Domain-policy controlled: the listing URL, every redirect
// hop (crawl/page.mjs) and every candidate link must pass checkUrl (company IR domains are tier primary; anything not on the
// allowlist is dropped), and a candidate must match the feed's link_pattern. Discovery only: a candidate becomes evidence only
// through add_source / add_research_note on the stockdb server. Works without SP_HTTP_UA (no SEC requests).
import fs from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { z } from 'zod';
import { root } from '../lib/env.mjs';
import { fetchPage, normalizeText, parseDate } from './page.mjs';
import { checkUrl } from '../verify/domainPolicy.mjs';

const Feed = z.object({ type: z.enum(['atom', 'rss', 'html']), url: z.string().url(), link_pattern: z.string().min(1), note: z.string().optional() });
const FeedsSchema = z.object({
  sec: z.object({ forms: z.array(z.string()).min(1), limit: z.number().int().min(1).max(50), since_days: z.number().int().min(1).max(3650) }),
  ir: z.object({ since_days: z.number().int().min(1).max(3650), limit: z.number().int().min(1).max(100),
    tickers: z.record(z.array(Feed)) }),
}).passthrough();

export function loadFeeds({ projectDir = root } = {}) {
  return FeedsSchema.parse(JSON.parse(fs.readFileSync(path.join(projectDir, 'config/feeds.json'), 'utf8')));
}

/** Atom <entry> / RSS <item> -> [{url, title, published_at}]. */
export function parseFeed(body, baseUrl) {
  const $ = cheerio.load(String(body ?? ''), { xmlMode: true });
  const out = [];
  $('entry').each((_, e) => {
    const el = $(e);
    const link = el.find('link').filter((_, l) => !$(l).attr('rel') || $(l).attr('rel') === 'alternate').first().attr('href') ?? el.find('id').first().text();
    out.push({ url: link?.trim(), title: normalizeText(el.find('title').first().text()), published_at: parseDate(el.find('published').first().text() || el.find('updated').first().text()) });
  });
  $('item').each((_, e) => {
    const el = $(e);
    out.push({ url: el.find('link').first().text().trim() || el.find('guid').first().text().trim(), title: normalizeText(el.find('title').first().text()),
      published_at: parseDate(el.find('pubDate').first().text() || el.find('dc\\:date').first().text()) });
  });
  return out.filter((x) => x.url).map((x) => { try { return { ...x, url: new URL(x.url, baseUrl).toString() }; } catch { return null; } }).filter(Boolean);
}

/** <a href> links of an HTML listing page -> [{url, title, published_at:null}]. */
export function parseLinks(html, baseUrl) {
  const $ = cheerio.load(String(html ?? ''));
  const out = [];
  $('a[href]').each((_, a) => {
    try { out.push({ url: new URL($(a).attr('href'), baseUrl).toString(), title: normalizeText($(a).text()) || null, published_at: null }); } catch { /* bad href */ }
  });
  return out;
}

/**
 * @param feeds     the ticker's feed list (config/feeds.json ir.tickers[T])
 * @param pageFetch (url) => fetchPage(url, {rawBody: true, ...}) (policy + redirect checks)
 * @returns {ticker, candidates:[{url, url_canonical, title, published_at, feed, outlet_key, tier}], feeds:[{url, ok, reason, items, kept}], dropped}
 */
export async function irCandidates({ ticker, feeds, policy, irDomains, pageFetch = null, mode, since = null, limit = 20 }) {
  const fetcher = pageFetch ?? ((u) => fetchPage(u, { policy, irDomains, rawBody: true, ...(mode ? { mode } : {}) }));
  const seen = new Set();
  const candidates = [];
  const report = [];
  const dropped = { policy: 0, pattern: 0, old: 0, duplicate: 0 };
  for (const feed of feeds ?? []) {
    const pol = checkUrl(feed.url, policy, irDomains);
    if (!pol.allowed) { report.push({ url: feed.url, ok: false, reason: pol.reason, items: 0, kept: 0 }); continue; }
    const res = await fetcher(pol.url_canonical);
    if (!res.ok) { report.push({ url: feed.url, ok: false, reason: res.reason, http_status: res.http_status ?? null, items: 0, kept: 0 }); continue; }
    const base = res.final_url ?? pol.url_canonical;
    const items = feed.type === 'html' ? parseLinks(res.body, base) : parseFeed(res.body, base);
    const re = new RegExp(feed.link_pattern);
    let kept = 0;
    for (const it of items) {
      const p = checkUrl(it.url, policy, irDomains);
      if (!p.allowed) { dropped.policy++; continue; }
      if (!re.test(p.url_canonical)) { dropped.pattern++; continue; } // patterns apply to the canonical URL (no www, no tracking params)
      if (since && it.published_at && it.published_at.slice(0, 10) < since) { dropped.old++; continue; }
      if (seen.has(p.url_canonical)) { dropped.duplicate++; continue; }
      seen.add(p.url_canonical);
      candidates.push({ url: it.url, url_canonical: p.url_canonical, title: it.title || null, published_at: it.published_at, feed: feed.url, outlet_key: p.outlet_key, tier: p.tier });
      kept++;
    }
    report.push({ url: feed.url, ok: true, reason: 'ok', items: items.length, kept });
  }
  candidates.sort((a, b) => String(b.published_at ?? '').localeCompare(String(a.published_at ?? '')) || a.url_canonical.localeCompare(b.url_canonical));
  return { ticker, candidates: candidates.slice(0, limit), feeds: report, dropped };
}
