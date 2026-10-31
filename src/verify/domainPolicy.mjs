// Domain policy (PLAN §3 add_source, §4.1). Adapted from news-collection-agent src/lib/domainPolicy.mjs: allowlist of outlets
// with tiers and ownership groups (config/domain-policy.json) plus company IR domains (config/companies.json, tier primary);
// deny list (shorteners, user content, aggregators); no IP-literal/local hosts; https only. Hosts are compared lower-cased
// without a leading "www." so bare domains (npr.org, bbc.co.uk) and www hosts resolve to the same outlet.
import net from 'node:net';
import { canonicalUrl } from './canonicalize.mjs';
import { searchPageReason } from './reflection.mjs';

const suffixMatch = (host, d) => host === d || host.endsWith(`.${d}`);
export const normHost = (h) => String(h ?? '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '').replace(/^www\./, '');

/** IR domains from companies.json -> [{domain, ticker}] (tier primary, ownership group issuer-<ticker>). */
export const irDomainsOf = (companies) => (companies?.companies ?? companies ?? [])
  .flatMap((c) => (c.ir_domains ?? []).map((d) => ({ domain: normHost(d), ticker: c.ticker })));

const deny = (reason, message, host = null) => ({ allowed: false, reason, message, host });

/**
 * @param url        absolute URL (any case/www/tracking params)
 * @param policy     normalized config/domain-policy.json
 * @param irDomains  [{domain, ticker}]
 * @param requireHttps  true for redirect hops (submitted http:// URLs are upgraded by canonicalisation instead)
 * @returns {allowed, reason, message, host, url_canonical?, outlet_key?, outlet_name?, ownership_group?, tier?, paywall?}
 */
export function checkUrl(url, policy, irDomains = [], { requireHttps = false } = {}) {
  let u;
  try { u = new URL(String(url).trim()); } catch { return deny('bad_url', `Invalid URL: ${String(url).slice(0, 200)}`); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return deny('bad_url', `Scheme ${u.protocol} is not allowed`);
  if (u.protocol === 'http:' && requireHttps && policy.https_only !== false) return deny('not_https', 'Redirects to plain http are not allowed');
  if (u.username || u.password) return deny('bad_url', 'URLs with credentials are not allowed');
  const raw = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!raw) return deny('bad_url', 'URL has no host');
  if (net.isIP(raw) || /^\d+$/.test(raw) || /^0x[0-9a-f]+$/i.test(raw) || /^[\d.]+$/.test(raw)) return deny('ip_or_local_host', `IP-literal host ${raw} is not allowed`, raw);
  if (raw === 'localhost' || /\.(localhost|local|internal|lan|home|corp)$/.test(raw) || !raw.includes('.'))
    return deny('ip_or_local_host', `Local/internal host ${raw} is not allowed`, raw);
  if (u.port && !['443', '80'].includes(u.port)) return deny('bad_url', `Non-standard port ${u.port} is not allowed`, raw);
  const host = normHost(raw);
  for (const d of policy.deny ?? []) {
    if (suffixMatch(host, normHost(d))) return deny('domain_denied', `Domain ${host} is on the deny list (shorteners, user-content and aggregator sites are not sources)`, host);
  }
  let url_canonical;
  try { url_canonical = canonicalUrl(u.toString()); } catch (e) { return deny('bad_url', e.message, host); }
  // search/query pages reflect their URL into the page and are never sources (Validator Phase 3 #1)
  const sp = searchPageReason(u.toString());
  if (sp) return deny('search_page', `Search/query pages are not sources (${sp}): they can echo arbitrary text from the URL`, host);
  const paywall = (policy.paywall ?? []).some((d) => suffixMatch(host, normHost(d)));
  const allow = [
    ...irDomains.map((r) => ({ domain: r.domain, outlet_key: `ir-${r.ticker.toLowerCase()}`, outlet_name: `${r.ticker} investor relations`, ownership_group: `issuer-${r.ticker.toLowerCase()}`, tier: 'primary' })),
    ...(policy.outlets ?? []).flatMap((o) => o.domains.map((d) => ({ domain: normHost(d), outlet_key: o.key, outlet_name: o.name, ownership_group: o.ownership_group, tier: o.tier }))),
  ].sort((a, b) => b.domain.length - a.domain.length); // longest (most specific) match wins
  const m = allow.find((a) => suffixMatch(host, a.domain));
  if (!m) return deny('domain_not_allowed', `Domain ${host} is not on the allowlist (config/domain-policy.json outlets or company IR domains)`, host);
  return { allowed: true, reason: 'ok', message: `Domain ${host} matches ${m.domain}`, host, url_canonical, outlet_key: m.outlet_key, outlet_name: m.outlet_name,
    ownership_group: m.ownership_group, tier: m.tier, paywall };
}
