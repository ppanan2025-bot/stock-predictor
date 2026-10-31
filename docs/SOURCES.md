# Sources: policy, feeds and crawling

Loaded by `/research-company` and `/verify-resources`. Configuration: `config/domain-policy.json` (allowlist, tiers, ownership
groups, deny and paywall lists), `config/feeds.json` (per-ticker discovery feeds), `config/companies.json` (IR domains, CIK).
Never edit these to make a source pass; a policy change is a reviewed config change.

## Domain policy (`config/domain-policy.json`, enforced in `src/verify/domainPolicy.mjs`)

- **https only**; hosts matched by suffix after lower-casing and stripping `www.`. Anything not listed is `domain_not_allowed`.
- **Tier `primary`**: `sec.gov` and each company's IR domains from `config/companies.json`
  (GOOGL: abc.xyz, blog.google; AMZN: aboutamazon.com, ir.aboutamazon.com; AAPL: apple.com, investor.apple.com; SPCX: none).
- **Tier `high`**: Reuters, AP, CNBC, FT, WSJ, MarketWatch, Barron's, Bloomberg, NYT, The Verge, TechCrunch, Federal Reserve,
  BLS, BEA, BBC, The Guardian, NPR, Al Jazeera, DW, France 24.
- **Tier `standard`**: Sky News, CBS News, ABC News, CNN, Axios, Washington Post.
- **Ownership groups** decide independence for corroboration: e.g. WSJ, MarketWatch and Barron's are all `news-corp`; CNBC and
  Sky News are both `comcast`. Two outlets of one group count as one.
- **Deny list** (`domain_denied`): URL shorteners (bit.ly, t.co, ...), user content (medium, substack, blogspot, wordpress,
  tumblr, reddit, x/twitter, facebook, instagram, tiktok, youtube, stocktwits, seekingalpha), aggregators/redirectors
  (news.google.com, news.yahoo.com, msn.com), archives (archive.org, archive.ph) and pastebin.
- **Paywall list** (WSJ, FT, Bloomberg, Barron's): pages usually fetch as thin text and end `unreachable` (`paywalled`), so they
  cannot be cited. Prefer primary sources and open outlets.
- Also refused: IP-literal and local hosts, non-standard ports, URLs with credentials, redirect hops leaving the policy
  (`redirect_denied`), more than 3 redirects, and **search/query pages** (`search_page`: paths like /search, /find, /results,
  /query, /lookup or query keys like q, s, k, text, term), because they echo arbitrary text from the URL.

## What makes a source verified (`add_source`)

Fetch with a browser User-Agent (15 s timeout, 3 MB cap, <= 3 redirects, each re-checked), extract title, publication date,
canonical URL and main text (scripts and CSS-hidden elements stripped), store `content_sha256` and text length. `verified` needs
HTTP 200, HTML and >= 300 characters of text. 403/5xx/timeouts are `unreachable` (retry with `/verify-resources`); 404/410 and
policy failures are `rejected`. Page text is never stored, only its hash and the excerpts of research notes.

## Discovery feeds (`config/feeds.json`, `npm run crawl -- --ticker T [--register]`)

Discovery only: candidates become evidence only through `add_source` / `add_research_note`.

| Ticker | Feeds | Notes |
|---|---|---|
| AAPL | Apple Newsroom RSS (apple.com/newsroom) | press releases incl. quarterly results |
| AMZN | About Amazon RSS (aboutamazon.com/news) | ir.aboutamazon.com answered 403 to automated requests (2026-10-31) |
| GOOGL | abc.xyz/investor (HTML), blog.google RSS | abc.xyz answered 403 (bot wall); earnings releases are PDFs (not citable as pages); use SEC 8-K EX-99.1 |
| SPCX | none | no CIK in config, no IR feed: research through allowlisted outlets only |

SEC: forms 10-K, 10-Q, 8-K (limit 12, last 400 days) from `data.sec.gov/submissions/CIK##########.json`; for 8-K item 2.02
the filing index is read to find the earnings press release exhibit (EX-99.1).

## SEC EDGAR User-Agent requirement (ACTION NEEDED)

SEC fair-access rules require automated requests to declare who is calling: a User-Agent containing a **contact e-mail**,
at most 10 requests per second (the crawler paces at 150 ms). The contact is the user's own choice and lives only in `.env`
as `SP_HTTP_UA`, e.g. `stock-predictor/0.1 (contact: <your e-mail>)`. It is never written into code, config or docs, and Claude
never invents one.

**Status (2026-10-31): not set yet.** While `SP_HTTP_UA` is unset or still the `.env.example` placeholder, every sec.gov request is
refused before it is sent with reason `sec_user_agent_unset` (sources end `unreachable`, the crawler prints `REFUSED sec_user_agent_unset`). Filings
are therefore not yet available as evidence. To enable: the user edits `.env` themselves and sets `SP_HTTP_UA` to a value
with their contact e-mail, then re-runs `npm run crawl -- --ticker <T>`.

## Price sources (not configurable)

- A: Nasdaq historical API `https://api.nasdaq.com/api/quote/<T>/historical?...` (canonical close, unadjusted).
- B: CNBC bars `https://ts-api.cnbc.com/harmony/app/bars/<T>/1D/...` (adjusted basis).
- The server builds both URLs itself; a submitted `source_url` is recorded but never fetched. Nasdaq rate-limits after about
  15 quick calls; requests are paced (`NASDAQ_MIN_INTERVAL_MS`, default 3 s) and the backfill uses one range fetch per ticker.

## Inbox inputs

`inbox/prices` and `inbox/news` files from the stock-collector and news-collector agents are submissions, not evidence: every
value is re-verified (see `inbox/README.md`). `inbox/leads/` is never ingested or cited.
