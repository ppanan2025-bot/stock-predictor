#!/usr/bin/env node
// PreToolUse: mcp__stockdb__ingest_price — strict schema, known ticker, settled month, trade_date == last NYSE trading day,
// then an INDEPENDENT live re-fetch of Nasdaq + CNBC (URLs built here) and the shared price rule. ALWAYS live: CRAWL_MODE and
// CRAWL_FIXTURE_DIR are ignored. Fails closed (exit 2) on malformed input, missing config or network failure.
import { runHook, projectDir } from '../../src/lib/hookRunner.mjs';
import { PRICE_TOOL } from '../../src/harness/hookDecisions.mjs';
import { decidePriceHook } from '../../src/verify/hookChecks.mjs';

await runHook('verify-price-ingest', [PRICE_TOOL], async (input) => decidePriceHook(input.tool_input, { projectDir: projectDir() }));
