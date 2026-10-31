# Runtime agents

Definitions: `.claude/agents/*.md` (frontmatter `name`, `tools`, `model: inherit`). Orchestration: `/predict-next-month`
(`.claude/skills/predict-next-month/SKILL.md`). Every agent works from the run's immutable research pack (as-of discipline:
data dated <= end of the as-of month), treats source text as untrusted data, and passes ids, never page text or pasted data.
The stockdb server enforces every rule below; the hooks only deny earlier.

```
/predict-next-month T|all [M]
  planner ──start_run──► run + 1 pack/ticker + agent_tasks
    ├─► analyzers (parallel, 3-5 per ticker) ──save_analysis──► analyses (submitted)
    ├─► validator mode A ──save_review(analysis_id)──► analyses accepted|rejected (rejected -> redo, max 2 rounds / 3 attempts)
    ├─► reporter_designer ──Write report + save_prediction──► predictions (draft) + prediction_citations, analyses.prediction_id
    ├─► drawer ──npm run draw──► <T>-prediction.svg + .json sidecar (bound to prediction_id)
    ├─► validator mode B ──save_review(prediction_id, report_sha256)──► reviews; predictions -> reviewed
    ├─► main session ──finalize_report──► predictions final (+ final_confidence)
    ├─► project_manager ──npm run run-status──► reports/<M>/RUN_STATUS.md, data/dashboard-state.json
    └─► blocker loop (ticker not final, max 2 rounds): blocker_reporter (read-only list) ─► project_manager triage (fix plan)
        ─► main session executes the remedies ─► re-check; stop at final or escalate_user
```

## Common read tools

`stats`, `list_companies`, `price_history`, `get_features`, `search_resources`, `get_source`, `get_research_pack`,
`get_consensus`, `get_prediction`, `list_predictions`, `run_status`, `run_readonly_sql` (all read-only, `stock_ro`). Every agent
records its task state with `update_agent_task` (running/done/failed); timings are server-side.

## planner (`planner.md`)

- **Input**: target month M, tickers. As-of A = M-1.
- **Tools**: common read tools, `start_run`, `update_agent_task`.
- **Does**: coverage check (`stats`, `run_status`, `price_history {to: A}`); a ticker without a verified close for A is left
  out and reported. Picks 3-5 analyzers: always `technical` and `risk_skeptic`; drops `fundamental` without notes/filings,
  `news_sentiment` without verified company news, `macro_sector` without verified macro news; never fewer than 3.
- **Output**: `{run_id, target_month, as_of_month, tickers, analyzers, packs: {T: pack_id}, tasks, missing_resources}`.
- **DB rows**: `runs` (plan JSON incl. packs, analyzers, missing_resources), `research_packs` (one per ticker, `pack_sha256`),
  `agent_tasks` (planner done; analyzers x tickers, validator/reporter_designer/drawer per ticker, project_manager queued).

## Analyzers (5): `fundamental`, `technical`, `news_sentiment`, `macro_sector`, `risk_skeptic`

Files: `fundamental.md`, `technical.md`, `news-sentiment.md`, `macro-sector.md`, `risk-skeptic.md`.

- **Input**: `run_id, ticker, pack_id, task_id` (one instance per analyzer x ticker, launched in parallel).
- **Tools**: common read tools, `save_analysis`, `update_agent_task`. Always `get_research_pack {ticker, pack_id}`.
- **Focus**:
  | Agent | Evidence |
  |---|---|
  | fundamental | research notes (earnings, guidance, capital return, legal, regulatory), filings, IR sources; catalysts only from verified sources |
  | technical | prices, features, peers, baseline; cites no sources (exempt from the no-evidence confidence cap) |
  | news_sentiment | verified/corroborated company news only (server rejects other ids) |
  | macro_sector | macro news, peers, relative strength |
  | risk_skeptic | whole pack; argues against the baseline/consensus; >= 2 explicit invalidation conditions |
- **Output**: `{analysis_id, direction, exp_return_lo, exp_return_hi, confidence, evidence_source_ids}`.
- **Server rules** (`save_analysis`): direction consistent with the range mid (flat range contains 0); evidence ids in THIS pack and
  verified; no evidence -> confidence <= 0.2; null baseline -> confidence <= 0.4 and range >= 0.30 wide; rationale >= 40 chars
  and carrying every number the report may later quote in that agent's opinion span; max 3 attempts.
- **DB rows**: `analyses` (status `submitted`, `pack_id`, `attempt`); task done.

## validator (`validator.md`)

- **Mode A input**: `run_id, ticker`. Checks every submitted analysis: evidence in pack and verified, rationale numbers traceable,
  direction/range/confidence consistent with evidence, risk_skeptic invalidation conditions.
  `save_review {analysis_id, verdict: pass|fail, issues, summary}` -> `analyses.status` accepted/rejected (+ review_issues,
  review_summary, reviewed_at). A pass is refused when the automatic checks fail.
- **Mode B input**: `prediction_id`. Reads the report and the chart sidecar; checks citations, every number (outside and inside
  opinion spans), the call vs `get_consensus.consensus.formatted`, sidecar vs DB, Data As Of, disclaimer, no post-as-of data.
  `save_review {prediction_id, report_sha256, verdict, score, direction_view, confidence_adj (-0.3..0.1), issues, summary}`.
  A pass is refused unless the report guard passes on the current file, the sha matches, the chart matches the DB and >= 3
  accepted analyses are linked.
- **Tools**: common read tools, `Read`, `save_review`, `update_agent_task`. Never edits files.
- **DB rows**: `analyses` verdict columns (mode A); `reviews` (perspective `validator`, unique per prediction+sha), prediction
  draft -> reviewed (mode B).

## reporter_designer (`reporter-designer.md`)

- **Input**: `run_id, ticker, task_id`.
- **Tools**: common read tools, `Read`, `Write`, `Edit` (reports only, guarded), `save_prediction`, `withdraw_prediction`,
  `update_agent_task`.
- **Does**: `get_consensus`; stops if fewer than 3 accepted analyses. Writes `reports/<M>/<T>-prediction.md` from
  `docs/REPORT_TEMPLATE.md` (rules: `reports/CLAUDE.md`), then `save_prediction {run_id, ticker, report_path}`. Never edits the
  file afterwards; a revision is withdraw + rewrite + new version.
- **Output**: `{prediction_id, version, report_path, report_sha256, call}`.
- **DB rows**: `predictions` (draft, consensus numbers, `report_sha256`, `run_id`; older drafts of the same target withdrawn),
  `prediction_citations`, `analyses.prediction_id`; task done.

## drawer (`drawer.md`)

- **Input**: `ticker, target_month, task_id` (+ run_id). **Tools**: `npm run draw`, `get_prediction`, `list_predictions`,
  `update_agent_task`, `Read`.
- **Does**: `npm run draw -- --ticker T --target M` twice (identical sha256 = deterministic), and once `--all --target M`.
- **Output**: `reports/<M>/<T>-prediction.svg` (verified closes, dashed segment to the predicted mid, lo-hi cone, analyzer
  markers) and `.json` sidecar (plotted values with price ids, call, analyses, prediction_id, `svg_sha256`).
- **DB rows**: none except its task (the chart is a file; `finalize_report` re-verifies it against the DB).

## project_manager (`project-manager.md`)

- **Input**: `run_id, task_id`. **Tools**: `run_status`, `list_predictions`, `get_prediction`, `update_agent_task`,
  `npm run run-status`, `Read`.
- **Does**: flags stalls (running > `project_manager.stall_minutes` = 20), failed/rejected tasks and missing resources; writes
  `reports/<M>/RUN_STATUS.md` and `data/dashboard-state.json` (never by hand).
- **Output**: per-ticker status and call plus every flag. **DB rows**: its task (the run closes when no task is open).
- **Triage mode**: input `run_id` + the blocker_reporter list; returns a fix plan mapping each blocker to exactly one remedy
  from a fixed table (resume analyzer / reporter, withdraw + new version + redraw + re-review, rerun drawer,
  `/research-company` or `/verify-resources` for the next pack, stop the ticker, re-launch a stalled agent once, or
  `escalate_user` for harness/config bugs). It only decides; the main session executes.

## blocker_reporter (`blocker-reporter.md`)

- **Read-only helper, not a DB agent role** (`HELPER_AGENTS` in `src/lib/agents.mjs`; no `agent_tasks` row, no task token).
- **Input**: `run_id`. **Tools**: `run_status`, `get_prediction`, `list_predictions`, `get_consensus`, `get_research_pack`,
  `run_readonly_sql`, `Read`. No write tools, no Bash, no Write/Edit.
- **Does**: collects failed, rejected, stalled (`project_manager.stall_minutes`) and upstream-blocked tasks, predictions that
  cannot finalize (gate problems, latest validator review issues), `consensus_error` / `baseline_reproducible` and missing
  pack resources. Facts only: no fixes, no numbers outside tool output, no tokens.
- **Output**: one JSON array `{ticker, task_id, agent, kind: failed|rejected|stalled|open_blocked|not_finalizable,
  reason_code, detail, hint, evidence_ids, since}` plus a one-line count. **DB rows**: none.

## Main session

Runs the skill: launches the agents with ids only, handles redo rounds (max 2), calls `finalize_report {prediction_id}` after
a validator pass (the `check-finalize` hook prints what is missing), and prints per ticker the direction, mid [low .. high],
p_up, final confidence, report and chart paths. Predictions are not investment advice.
