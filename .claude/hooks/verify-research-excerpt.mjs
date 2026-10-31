#!/usr/bin/env node
// PreToolUse: mcp__stockdb__add_research_note (PLAN §4.4) — strict schema, excerpt present (excerpt_missing otherwise), 40-1200
// chars, claim numbers inside the excerpt, domain policy, LIVE re-fetch of the page and the normalised excerpt must be an exact
// substring of the page text. Fails closed. The stockdb server repeats every check (authoritative).
// Test-only seam: with SP_HOOK_TEST=1 AND a connection to the marked test DB (127.0.0.1:3320, report_host sp-test-db) pages
// are read from the fixture index (CRAWL_FIXTURE_DIR) instead of the network. Anything else is live.
import { runHook, projectDir } from '../../src/lib/hookRunner.mjs';
import { NOTE_TOOL } from '../../src/harness/hookDecisions.mjs';
import { decideResearchNoteHook } from '../../src/verify/hookChecks.mjs';
import { hookTestSeamActive } from '../../src/harness/testSeam.mjs';

await runHook('verify-research-excerpt', [NOTE_TOOL], async (input) => {
  let pageFetch = null;
  if (await hookTestSeamActive()) {
    const { fetchPage } = await import('../../src/crawl/page.mjs');
    const { loadPolicy, loadCompanies } = await import('../../src/verify/config.mjs');
    const { irDomainsOf } = await import('../../src/verify/domainPolicy.mjs');
    pageFetch = (u) => fetchPage(u, { policy: loadPolicy(), irDomains: irDomainsOf(loadCompanies()), mode: 'fixture' });
  }
  return decideResearchNoteHook(input.tool_input, { projectDir: projectDir(), pageFetch });
});
