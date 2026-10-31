---
name: review-prediction
description: Re-validate one saved prediction (report + chart) with the validator agent and finalize it when it passes. Use for a prediction id left in draft/reviewed, e.g. after a new version.
argument-hint: "<prediction_id>"
allowed-tools: Agent, Read, Bash(npm run draw:*), Bash(npm run run-status:*), mcp__stockdb__get_prediction, mcp__stockdb__get_consensus, mcp__stockdb__finalize_report, mcp__stockdb__run_status
---

# /review-prediction <prediction_id>

1. `get_prediction {prediction_id}`: status must be draft or reviewed; note ticker, target_month, run_id, report_sha256.
2. Chart bound to this prediction? Read `reports/<target>/<TICKER>-prediction.json`; if `prediction.prediction_id` differs or the
   file is missing, run `npm run draw -- --ticker <T> --target <M>`.
3. Launch the **validator** (Agent) in mode B with the prediction id. It calls save_review on the CURRENT report sha.
4. Verdict pass -> `finalize_report {prediction_id}`. Fail -> report its issues; the fix is a new version by the
   reporter_designer (withdraw, rewrite, save_prediction), never an edit of the reviewed file.
5. `npm run run-status -- --run <run_id>` and print the final call, final_confidence and any open problems.
