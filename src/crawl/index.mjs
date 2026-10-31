// Price crawler registry (ported from RIA src/crawl/index.mjs; the Yahoo tiebreaker is not used here).
import * as nasdaq from './nasdaq.mjs';
import * as cnbc from './cnbc.mjs';

export const SOURCES = { nasdaq, cnbc };
export { nasdaq, cnbc };

export function isValidHost(source, url) { return SOURCES[source]?.isValidHost(url) ?? false; }
export function parseSourceUrl(source, url) { return SOURCES[source]?.parseUrl(url) ?? null; }
