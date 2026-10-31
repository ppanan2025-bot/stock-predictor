---
name: company-context
description: Regenerate and read the per-company context file context/companies/<TICKER>.md (profile, latest deterministic features from verified closes, top verified research notes with ids, recent verified news, last predictions). Use before researching or predicting a ticker, or when the user asks for a company summary.
argument-hint: "<TICKER>"
allowed-tools: Bash(npm run context:*), Read, mcp__stockdb__get_features, mcp__stockdb__search_resources
---

# /company-context <TICKER>

1. Run `npm run context -- --ticker <T>` (several tickers: `--ticker GOOGL,AMZN`). It reads the database as `stock_ro`
   and REWRITES `context/companies/<T>.md`; the file is generated, never edit it (the protected-files hook blocks edits).
2. Read `context/companies/<T>.md` and work from it. Quote ids (`[S<source_id>]`, `N<note_id>`), not page text.
3. If it says the stored features are `STALE` or `not stored yet`, the numbers shown are still the deterministic values
   recomputed from verified closes; `compute_features` stores them (it is a write tool; ask before running it).

Notes
- Null feature values mean insufficient verified history (e.g. SPCX, listed 2026-06-12: `short_history`); never fill them in.
- Inbox leads are unverified and never appear in this file.
