---
name: predict-next-month
description: Run the multi-agent next-month prediction for one ticker or all (GOOGL, AMZN, AAPL, SPCX) for a target month, using only data dated up to the end of the previous month. Drives planner -> analyzers -> validator -> reporter_designer + drawer -> validator -> finalize_report -> project_manager with the Agent tool.
argument-hint: "<TICKER|all> [YYYY-MM]"
allowed-tools: Agent, Read, Bash(npm run baseline:*), Bash(npm run draw:*), Bash(npm run run-status:*), mcp__stockdb__stats, mcp__stockdb__run_status, mcp__stockdb__get_consensus, mcp__stockdb__get_prediction, mcp__stockdb__list_predictions, mcp__stockdb__finalize_report
---

# /predict-next-month <TICKER|all> [YYYY-MM]

Target month M defaults to the month after the latest verified close (`stats.coverage[].latest_verified` + 1). As-of month
A = M-1: every agent uses only data dated <= the end of A (rehearsal example: M=2026-10 with data through 2026-09, scored when
the October close is verified). Pass ids (run_id, pack_id, analysis_id, prediction_id) between agents, never page text.

1. **Baseline preview** (read-only): `npm run baseline -- --target M`. SPCX shows `baseline=null (short_history)`.
2. **planner** (Agent, subagent_type planner): "target M, tickers <list>". It returns run_id, packs, analyzers, task ids, one
   secret task_token per task and missing resources. Stop if no ticker has a verified close for A. `all` dispatches all five
   analyzers; a single ticker at least four. Hand EACH agent only its OWN task_id + task_token (update_agent_task requires it);
   never paste another agent's token into a prompt.
3. **Analyzers in parallel**: one Agent call per (dispatched analyzer x ticker), all in ONE message, each with
   {run_id, ticker, pack_id, task_id, task_token}. Agent types: fundamental, technical, news_sentiment, macro_sector, risk_skeptic.
4. **validator, mode A** per ticker (parallel): accepts/rejects every submitted analysis. For each rejected one, re-launch that
   analyzer with the validator's reason, then re-validate. Max 2 redo rounds; after that continue with what is accepted. A
   ticker with fewer than 3 accepted analyses stops here (report it; no prediction).
5. **reporter_designer** per ticker (parallel across tickers): writes the report and calls save_prediction.
6. **drawer** per ticker after its save_prediction (`npm run draw -- --ticker T --target M`), then once `--all`.
7. **validator, mode B** per prediction: report + chart verdict (save_review on the current report_sha256). On fail, the
   reporter withdraws, rewrites and saves a new version, the drawer redraws, the validator re-checks (max 2 rounds).
8. **finalize_report {prediction_id}** for each validator pass (the check-finalize hook prints exactly what is missing).
8b. **Blocker loop** (only if a ticker is not final; max 2 rounds): `blocker_reporter` (Agent) with {run_id} returns the
   blocker list -> `project_manager` in triage mode with {run_id, task_id, blocker list} returns a fix plan (one remedy per
   blocker) -> the main session executes the plan in order (agents get only their own task_id + task_token) -> re-check with
   `run_status` / `get_prediction`. Stop when every ticker is final, or when the only blockers left are `escalate_user`
   (report them to the user verbatim; never edit src/, config/ or hooks).
9. **project_manager** with {run_id, task_id}: writes RUN_STATUS.md and data/dashboard-state.json.
10. Print per ticker: direction, mid [low .. high], p_up, final_confidence (label), report path, chart path, and the PM flags.
    Predictions are probabilistic and not investment advice.

Never edit config, the harness or a report after save_prediction; never type numbers that did not come from stockdb.
