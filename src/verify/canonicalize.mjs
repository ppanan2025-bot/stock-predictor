// Ported verbatim from news-collection-agent src/lib/canonicalize.mjs.
import crypto from 'node:crypto';

const DROP_EXACT = new Set(['maca', 'traffic_source', 'cmpid', 'cmp', 'smid', 'fbclid', 'gclid', 'ocid', 'ref', 'rss']);
const DROP_PREFIX = ['utm_', 'at_', 'ns_'];

function dropParam(name) {
  const n = name.toLowerCase();
  if (DROP_EXACT.has(n)) return true;
  return DROP_PREFIX.some((p) => n.startsWith(p));
}

export function canonicalUrl(u) {
  let url;
  try { url = new URL(String(u).trim()); } catch { throw new Error(`invalid URL: ${u}`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`unsupported scheme: ${url.protocol}`);
  url.protocol = 'https:';
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  if (url.port === '80' || url.port === '443') url.port = '';
  url.hash = '';
  url.username = '';
  url.password = '';
  const kept = [];
  for (const [k, v] of url.searchParams) if (!dropParam(k)) kept.push([k, v]);
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  url.search = kept.length ? '?' + new URLSearchParams(kept).toString() : '';
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString();
}

export function sha256(str) {
  return crypto.createHash('sha256').update(String(str), 'utf8').digest('hex');
}

export function hostOf(u) {
  try { return new URL(u).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return null; }
}
