---
name: audit-db
description: Audit the stockdb database invariants (verified month-end closes, verified news sources, final predictions gated by a validator pass and >= 3 accepted analyses, report sha and chart sidecar matching the DB) and live re-validate a sample of stored URLs, excerpts and closes. Use weekly, after a prediction run, or when the user asks whether the stored data is still trustworthy.
argument-hint: "[--sample N] [--prices N] [--ticker T]"
allowed-tools: Bash(npm run audit:*), Bash(npm run validate:*), Read, mcp__stockdb__stats, mcp__stockdb__get_prediction, mcp__stockdb__get_source, mcp__stockdb__run_readonly_sql
---

# /audit-db [--sample N] [--prices N] [--ticker T]

Both scripts are READ-ONLY (stock_ro). You report what they find; you never fix data by hand.

1. **Invariants.** `npm run audit` (add `-- --json` for machine output). Exit 1 = at least one VIOLATION:
   - `price_not_last_trading_day`, `price_submission_mismatch`, `price_source_mismatch`: a stored close breaks the price rules.
   - `news_on_unverified_source`, `news_corroboration_count`, `note_excerpt_sha_mismatch`, `pack_sha_mismatch`: evidence integrity.
   - `final_without_validator_pass`, `final_without_analyses`, `final_citation_unverified`: a final prediction lost its gate.
   - `report_missing`, `report_sha_mismatch`, `chart_mismatch`: report/chart files changed after save_prediction/finalize.
   - `outcome_close_mismatch`: a score does not equal the verified target-month close.
   WARNINGS (`note_on_unverified_source`, `analysis_evidence_unverified`, `features_stale`, chart drift on drafts) are expected
   drift: explain them and name the fix (re-run `compute_features`, re-draw, or withdraw + re-issue the prediction).
2. **Live re-validation.** `npm run validate -- --sample 20` (default 20 sources; `--prices 4` also re-fetches 4 random closes from
   Nasdaq + CNBC; `--ticker T` restricts both). PROBLEM lines (exit 1): an excerpt no longer on its page, a page now 404/denied, or a
   close that no longer matches. Content drift and transient fetch failures (403 bot walls, timeouts) are warnings.
3. **Report**: violations and problems first (with ids), then warnings, then the counts line. For each problem name the
   remedy through the proper tool, never a manual edit: `recheck_sources {source_ids}` (cascades a rejection),
   `withdraw_prediction` + new version for a final whose citation was rejected, `npm run draw` for a stale chart. Ask before
   calling any write tool.

Rules: never read `.env`, never run SQL writes, never edit reports, data/ or config to make the audit pass.
