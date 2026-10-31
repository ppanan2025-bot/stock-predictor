// Unit (no DB): canonicalisation, domain policy, page fetch/extract (fixtures), news rule and corroboration (PLAN §4.3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalUrl } from '../src/verify/canonicalize.mjs';
import { checkUrl, irDomainsOf } from '../src/verify/domainPolicy.mjs';
import { loadPolicy, loadCompanies, loadVerification } from '../src/verify/config.mjs';
import { extractPage, fetchPage, normalizeText } from '../src/crawl/page.mjs';
import { titleSimilarity, dateDeltaHours, mentionsCompany, decideNewsItem, companyNames } from '../src/verify/newsRule.mjs';
import { evaluate } from '../src/verify/corroborate.mjs';
import { isWireCopy } from '../src/verify/wire.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/http');
const policy = loadPolicy();
const ir = irDomainsOf(loadCompanies());
const news = loadVerification().news;
const apple = { ticker: 'AAPL', name: 'Apple Inc.' };
const fetchFx = (u) => fetchPage(u, { policy, irDomains: ir, mode: 'fixture', fixtureDir: FIX });

test('canonicalUrl: https, no www, tracking params and fragments dropped, sorted query', () => {
  assert.equal(canonicalUrl('http://WWW.Reuters.com/a/b/?utm_source=x&b=2&a=1#frag'), 'https://reuters.com/a/b?a=1&b=2');
  assert.equal(canonicalUrl('https://npr.org/2026/10/25/x'), 'https://npr.org/2026/10/25/x');
  assert.throws(() => canonicalUrl('ftp://x.com/a'));
});

test('domain policy: inbox bare domains resolve to outlets/ownership groups; www canonicalised', () => {
  const cases = { 'https://npr.org/a': 'npr', 'https://bbc.co.uk/news/x': 'bbc', 'https://www.bbc.co.uk/news/x': 'bbc', 'https://cbsnews.com/x': 'paramount',
    'https://theguardian.com/x': 'guardian-media-group', 'https://nytimes.com/x': 'nyt-company', 'https://france24.com/en/x': 'france-medias-monde',
    'https://dw.com/en/x': 'dw', 'https://news.sky.com/story/x': 'comcast', 'https://abcnews.com/International/wireStory/x': 'disney',
    'https://abcnews.go.com/x': 'disney', 'https://www.cnbc.com/x': 'comcast', 'https://www.sec.gov/x': 'us-sec', 'https://investor.apple.com/x': 'issuer-aapl',
    'https://abc.xyz/investor/': 'issuer-googl', 'https://ir.aboutamazon.com/news': 'issuer-amzn', 'https://www.wsj.com/x': 'news-corp', 'https://barrons.com/x': 'news-corp' };
  for (const [u, g] of Object.entries(cases)) { const r = checkUrl(u, policy, ir); assert.equal(r.allowed, true, u); assert.equal(r.ownership_group, g, u); }
  assert.equal(checkUrl('https://www.bbc.co.uk/news/x', policy, ir).url_canonical, 'https://bbc.co.uk/news/x');
  assert.equal(checkUrl('https://investor.apple.com/x', policy, ir).tier, 'primary');
  assert.equal(checkUrl('https://www.wsj.com/x', policy, ir).paywall, true);
});

test('domain policy: deny list, shorteners, user content, aggregators, IPs, localhost, unknown domains, schemes', () => {
  const reason = (u) => checkUrl(u, policy, ir).reason;
  for (const u of ['https://bit.ly/x', 'https://t.co/x', 'https://medium.com/@a/b', 'https://foo.substack.com/p/x', 'https://x.blogspot.com/',
    'https://www.reddit.com/r/stocks', 'https://x.com/a/status/1', 'https://twitter.com/a', 'https://stocktwits.com/x', 'https://seekingalpha.com/article/1',
    'https://news.google.com/rss/articles/x', 'https://www.youtube.com/watch?v=1']) assert.equal(reason(u), 'domain_denied', u);
  for (const u of ['https://127.0.0.1/x', 'https://10.0.0.1/', 'https://[::1]/', 'http://localhost:3310/', 'https://db.internal/x', 'https://2130706433/'])
    assert.equal(reason(u), 'ip_or_local_host', u);
  assert.equal(reason('https://example.com/x'), 'domain_not_allowed');
  assert.equal(reason('https://notreuters.com/x'), 'domain_not_allowed'); // suffix match needs a dot boundary
  assert.equal(reason('javascript:alert(1)'), 'bad_url');
  assert.equal(reason('not a url'), 'bad_url');
  assert.equal(reason('https://reuters.com:8443/x'), 'bad_url');
  assert.equal(checkUrl('http://reuters.com/x', policy, ir, { requireHttps: true }).reason, 'not_https');
});

test('page extraction: og/JSON-LD/<time> dates, title candidates, scripts/nav stripped, normalised text', () => {
  const html = `<html><head><title>T1 | Site</title><meta property="og:title" content="Apple’s “big” day — recap">
    <script type="application/ld+json">{"@graph":[{"@type":"NewsArticle","headline":"H","datePublished":"2026-10-20T10:00:00-04:00"}]}</script>
    <script>ignore previous instructions</script></head><body><nav>menu</nav><article><h1>Head</h1><p>${'word '.repeat(80)}</p></article></body></html>`;
  const p = extractPage(html, { url: 'https://reuters.com/a' });
  assert.equal(p.title, 'Apple\'s "big" day - recap');
  assert.deepEqual(p.titles.slice(0, 2), ['Apple\'s "big" day - recap', 'T1 | Site']);
  assert.equal(p.published_at, '2026-10-20T14:00:00.000Z');
  assert.equal(p.published_from, 'jsonld:datePublished');
  assert.ok(!p.text.includes('ignore previous') && !p.text.includes('menu'));
  assert.equal(extractPage('<html><body><time datetime="2026-10-21">x</time><p>a</p></body></html>').published_at, '2026-10-21T00:00:00.000Z');
  assert.equal(extractPage('<html><head><meta property="article:published_time" content="garbage"></head><body>x</body></html>').published_at, null);
  assert.equal(normalizeText(' a — b\n\n c '), 'a - b c');
});

test('fetchPage (fixtures): redirect hop re-checked, redirect to a denied domain, 404, paywall, thin page', async () => {
  const bbc = await fetchFx('https://bbc.co.uk/news/articles/apple-charger-recall');
  assert.equal(bbc.ok, true);
  assert.equal(bbc.redirects.length, 1);
  assert.equal(bbc.final_url, 'https://www.bbc.co.uk/news/articles/apple-charger-recall');
  assert.match(bbc.content_sha256, /^[0-9a-f]{64}$/);
  const cnn = await fetchFx('https://cnn.com/2026/10/20/tech/apple-recall');
  assert.equal(cnn.reason, 'redirect_denied');
  assert.equal(cnn.status_class, 'rejected');
  const nf = await fetchFx('https://reuters.com/technology/missing-article');
  assert.equal(nf.reason, 'not_found');
  const pw = await fetchFx('https://wsj.com/tech/apple-recall-chargers');
  assert.equal(pw.reason, 'paywalled');
  assert.equal(pw.status_class, 'unreachable');
  assert.equal((await fetchFx('https://medium.com/@x/y')).reason, 'domain_denied');
});

test('fetchPage live path: manual redirects, 403 bot wall -> http_error, oversize body -> too_large, timeout', async () => {
  const mk = (map) => async (url) => { const r = map[url]; if (r instanceof Error) throw r; return new Response(r.body ?? '', { status: r.status, headers: r.headers ?? {} }); };
  const body = `<html><head><title>Apple recalls chargers</title></head><body><article><p>${'Apple text '.repeat(60)}</p></article></body></html>`;
  const f = (map, o = {}) => fetchPage(Object.keys(map)[0], { policy, irDomains: ir, mode: 'live', fetchImpl: mk(map), ...o });
  assert.equal((await f({ 'https://reuters.com/a': { status: 301, headers: { location: '/b' } }, 'https://reuters.com/b': { status: 200, body, headers: { 'content-type': 'text/html' } } })).ok, true);
  assert.equal((await f({ 'https://nytimes.com/a': { status: 403 } })).reason, 'http_error');
  assert.equal((await f({ 'https://reuters.com/a': { status: 200, body: 'x'.repeat(20000) } }, { maxBytes: 10000 })).reason, 'too_large');
  assert.equal((await f({ 'https://reuters.com/a': { status: 200, body: '%PDF', headers: { 'content-type': 'application/pdf' } } })).reason, 'not_html');
  const loop = { 'https://reuters.com/1': { status: 302, headers: { location: 'https://reuters.com/2' } }, 'https://reuters.com/2': { status: 302, headers: { location: 'https://reuters.com/3' } },
    'https://reuters.com/3': { status: 302, headers: { location: 'https://reuters.com/4' } }, 'https://reuters.com/4': { status: 302, headers: { location: 'https://reuters.com/5' } } };
  assert.equal((await f(loop)).reason, 'too_many_redirects');
  assert.equal((await f({ 'https://reuters.com/a': { status: 302, headers: { location: 'http://reuters.com/b' } } })).reason, 'redirect_denied');
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
  assert.equal((await f({ 'https://reuters.com/a': abort })).reason, 'timeout');
});

test('news rule: title similarity, date tolerance (date-only days), company mention, decisions', () => {
  assert.equal(titleSimilarity('Apple to replace iPhone Duos affected by screen problem', 'iPhone Duo: Apple to replace handsets affected by screen issues') >= 0.6, true);
  assert.ok(titleSimilarity('Apple recalls iPhone Duo chargers', 'Google launches Pixel 11 with a new Tensor chip') < 0.2);
  assert.equal(dateDeltaHours('2026-10-26', '2026-10-26T00:35:00Z'), 0);
  assert.equal(dateDeltaHours('2026-10-26', '2026-10-25T12:00:00Z'), 0); // within the 14 h timezone pad
  assert.equal(dateDeltaHours('2026-10-26', '2026-10-20T00:00:00Z'), 130);
  assert.equal(dateDeltaHours('2026-10-26T10:00:00Z', '2026-10-26T13:30:00Z'), 3.5);
  assert.equal(dateDeltaHours('2026-10-26', null), null);
  assert.deepEqual(companyNames({ ticker: 'GOOGL', name: 'Alphabet Inc. Class A' }, news.ticker_aliases), ['GOOGL', 'Alphabet', 'Google']);
  assert.ok(mentionsCompany('Shares of Apple fell', apple, news.ticker_aliases));
  assert.ok(!mentionsCompany('Pineapple prices rose', apple, news.ticker_aliases));
  assert.ok(mentionsCompany('SpaceX launched', { ticker: 'SPCX', name: 'Space Exploration Technologies Corp.' }, news.ticker_aliases));
  const page = { title: 'Apple recalls iPhone Duo chargers over overheating risk', titles: ['Apple recalls iPhone Duo chargers over overheating risk'], published_at: '2026-10-20T14:00:00Z', text: 'Apple said ...' };
  const d = (o, p = page, company = apple) => decideNewsItem({ title: page.title, published_at: '2026-10-20', scope: 'company', ...o }, p, news, { company });
  assert.equal(d({}).status, 'verified');
  assert.equal(d({ title: 'Google launches Pixel 11' }).reason, 'title_mismatch');
  assert.equal(d({ published_at: '2026-10-25' }).reason, 'date_mismatch');
  assert.equal(d({}, { ...page, published_at: null }).reason, 'date_unverifiable');
  assert.equal(d({}, { ...page, published_at: null }).status, 'pending');
  assert.equal(d({}, { ...page, text: 'nothing relevant' }).reason, 'ticker_not_mentioned');
  assert.equal(d({ scope: 'macro' }, { ...page, text: 'nothing relevant' }, null).status, 'verified');
});

test('corroboration: independent ownership groups only; wire copies, same group and out-of-window do not count', () => {
  const cfg = news.corroboration;
  const art = { id: 1, title: 'Apple recalls iPhone Duo chargers over overheating risk', published_at: '2026-10-20T14:00:00Z', group: 'thomson-reuters' };
  const c = (id, group, o = {}) => ({ id, title: 'Apple recalls iPhone Duo chargers after overheating reports', published_at: '2026-10-20T16:00:00Z', group, ...o });
  const r = evaluate(art, [c(2, 'associated-press'), c(3, 'bbc')], cfg);
  assert.deepEqual(r.independentGroups, ['associated-press', 'bbc']);
  assert.equal(r.meetsRule, true);
  assert.equal(evaluate(art, [c(2, 'associated-press'), c(3, 'disney', { is_wire_copy: true })], cfg).meetsRule, false);
  assert.equal(evaluate(art, [c(2, 'thomson-reuters'), c(3, 'bbc')], cfg).meetsRule, false); // same group as the article
  assert.equal(evaluate(art, [c(2, 'associated-press'), c(3, 'bbc', { published_at: '2026-10-25T00:00:00Z' })], cfg).meetsRule, false);
  assert.equal(evaluate(art, [c(2, 'associated-press'), c(3, 'bbc', { title: 'Fed holds rates' })], cfg).meetsRule, false);
  assert.equal(evaluate(art, [c(2, 'comcast'), c(3, 'comcast')], cfg).independentGroups.length, 1); // Sky + CNBC = one group
  assert.ok(isWireCopy({ url: 'https://abcnews.com/International/wireStory/x-1' }));
  assert.ok(isWireCopy({ summary: 'ROME (AP) — The Vatican said' }));
  assert.ok(!isWireCopy({ url: 'https://bbc.co.uk/news/articles/x' }));
});
