# reports/: prediction report rules (loaded when working in reports/)

Layout: `reports/<YYYY-MM>/<TICKER>-prediction.md` (written by the reporter_designer), `<TICKER>-prediction.svg` + `.json`
(drawer, `npm run draw`), `<TICKER>-reviews.md` and `RUN_STATUS.md` (generated). `<YYYY-MM>` is the TARGET month; the report
uses only data dated up to the end of the as-of month (target - 1).

## Writing a report
- Template and full rules: `docs/REPORT_TEMPLATE.md`. Start from `get_consensus {run_id, ticker}`; copy
  `report.front_matter` verbatim (ticker, as_of_month, target_month, run_id, pack_id, pack_sha256).
- Required `## ` sections, exact names: Summary, Baseline vs Consensus, Analyzer Views, Bull & Bear Case, Risks,
  What Would Change the Call, References, Data As Of, Disclaimer (with the exact disclaimer sentence).
- **Numbers** are typed and sign-sensitive: a percent must equal a percent field within ±0.05 pp, a dollar amount a price
  within ±$0.005, a plain number a plain field exactly; units glued to digits count (`US$400`, `$1.2k`, `400-dollar`, `3x`).
  Copy call strings from `consensus.formatted`. Years (in a date context) and whole numbers up to 10 without a unit are exempt;
  labels like 12m, Q3, 10-K are not numbers. No spelled-out quantities, no HTML, no peer closes.
- **Forward-looking sentences** (next month, the target month, expect/could/likely/will, probability, upside …) use ONLY the
  call: the mid as the point estimate, low/high only as range bounds, p_up only as the probability of a rise.
- **Opinion spans**: `<!-- opinion:<agent> -->...<!-- /opinion -->`; numbers inside must equal THAT agent's saved range, mid or
  confidence (never its free rationale text).
- **Citations**: only `[S<id>]` from `get_consensus.report.reference_lines`; References lists exactly the cited ids with those
  lines (canonical URL + `sha256:` prefix). No other URLs. Inbox leads are never citable.
- Forbidden phrases (word-bounded, spaces/hyphens normalised): guaranteed, certain to, will definitely, price target, risk-free,
  can't lose, buy, sell, strong buy, upside of, analysts expect.
- Short-history tickers (SPCX): baseline is `null (short history)`; say confidence is low and why.

## Guard behaviour
- `guard-report-write` (PreToolUse Write/Edit/MultiEdit on reports/**) runs `src/report/reportCheck.mjs` on the post-edit text
  and denies with codes such as `untraced_number:<token>@<line>`, `forward_number_not_in_call`, `bound_as_point`,
  `probability_misdescribed`, `untraced_date`, `spelled_number`, `injection_text`, `html_forbidden`, `citation_unverified`, `citation_not_in_pack`, `stray_url`, `missing_section`, `opinion_untraced`, `forbidden_phrase`.
  Fix the text; never weaken the template, the config or the guard. Only `reports/<YYYY-MM>/<TICKER>-prediction.md` is writable.
- `save_prediction` stores the report's sha256. After it, the file is FROZEN: any edit makes `finalize_report` fail with
  `report_sha_mismatch` and `npm run audit` report it. To revise: `withdraw_prediction`, rewrite, `save_prediction` (new
  version), redraw, re-validate.
- Reviewed/final reports are locked by the hook; `*-reviews.md`, `RUN_STATUS.md`, SVG and JSON sidecars are never hand-edited.
- Finalization needs a validator pass on the current sha, >= 3 accepted analyses and a chart sidecar that matches the DB.
