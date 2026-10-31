#!/usr/bin/env node
// PreToolUse: mcp__stockdb__add_news_item | mcp__stockdb__add_source — schema, domain policy (URL and reference URLs), live
// fetch (reachable, enough text), title similarity, company mention and date tolerance. Fails closed.
// Test-only seam: with SP_HOOK_TEST=1 AND a connection to the marked test DB (127.0.0.1:3320, report_host sp-test-db) pages
// are read from the fixture index (CRAWL_FIXTURE_DIR) instead of the network. Anything else is live.
import { runHook, projectDir } from '../../src/lib/hookRunner.mjs';
import { NEWS_TOOLS } from '../../src/harness/hookDecisions.mjs';
import { decideNewsHook } from '../../src/verify/hookChecks.mjs';
import { hookTestSeamActive } from '../../src/harness/testSeam.mjs';

await runHook('verify-news-source', [...NEWS_TOOLS], async (input) => {
  let pageFetch = null;
  if (await hookTestSeamActive()) {
    const { fetchPage } = await import('../../src/crawl/page.mjs');
    const { loadPolicy, loadCompanies } = await import('../../src/verify/config.mjs');
    const { irDomainsOf } = await import('../../src/verify/domainPolicy.mjs');
    pageFetch = (u) => fetchPage(u, { policy: loadPolicy(), irDomains: irDomainsOf(loadCompanies()), mode: 'fixture' });
  }
  return decideNewsHook(input.tool_name, input.tool_input, { projectDir: projectDir(), pageFetch });
});
