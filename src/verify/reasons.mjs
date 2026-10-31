// Reason codes (PLAN §4.2, §4.3). Pending reasons may resolve on a later run (the inbox file stays for retry); all others
// are final. Price codes follow RIA; news/source codes are this project's.
export const PRICE_REASONS = Object.freeze(['ok', 'not_month_end', 'month_incomplete', 'pre_listing', 'price_mismatch', 'date_mismatch',
  'source_a_missing', 'source_b_missing', 'source_stale', 'refetch_failed', 'rate_limited', 'conflict_existing', 'bad_schema', 'unknown_ticker']);

export const PRICE_PENDING = Object.freeze(new Set(['month_incomplete', 'source_stale', 'refetch_failed', 'rate_limited']));

export const priceStatusFor = (reason) => (reason === 'ok' ? 'verified' : PRICE_PENDING.has(reason) ? 'pending' : 'rejected');

/** Source (page) reason codes -> sources.verification_status. */
export const SOURCE_REASONS = Object.freeze({
  ok: 'verified',
  bad_url: 'rejected',             // unparseable URL / scheme
  not_https: 'rejected',
  domain_denied: 'rejected',       // deny list (shorteners, user content, aggregators)
  domain_not_allowed: 'rejected',  // not on the allowlist
  ip_or_local_host: 'rejected',
  redirect_denied: 'rejected',     // a redirect hop left the policy
  too_many_redirects: 'rejected',
  not_found: 'rejected',           // HTTP 404/410
  http_error: 'unreachable',       // other 4xx (403 bot walls, 401)
  server_error: 'unreachable',     // 5xx
  rate_limited: 'unreachable',
  network: 'unreachable',
  timeout: 'unreachable',
  too_large: 'unreachable',
  not_html: 'unreachable',
  thin_content: 'unreachable',     // < min_text_len characters of article text
  paywalled: 'unreachable',
  sec_user_agent_unset: 'unreachable', // sec.gov needs the user's contact User-Agent (SP_HTTP_UA); nothing is fetched until it is set
});

/** Source reasons that may succeed on a retry (news items stay pending). */
export const SOURCE_TRANSIENT = Object.freeze(new Set(['http_error', 'server_error', 'rate_limited', 'network', 'timeout', 'sec_user_agent_unset']));

/** Research-note reason codes (add_research_note, verify-research-excerpt). */
export const NOTE_REASONS = Object.freeze(['ok', 'duplicate', 'excerpt_missing', 'excerpt_too_short', 'excerpt_too_long', 'excerpt_not_found',
  'claim_missing', 'claim_number_not_in_excerpt', 'source_unverified', 'unknown_ticker', 'bad_schema']);

/** News item reason codes. */
export const NEWS_REASONS = Object.freeze(['ok', 'corroborated', 'title_mismatch', 'date_mismatch', 'date_unverifiable', 'ticker_not_mentioned',
  'source_unreachable', 'source_rejected', 'bad_schema', 'unknown_ticker']);
