---
name: score-outcomes
description: Score final/reviewed predictions whose target month now has a verified month-end close (direction hit, in range, Brier, error vs mid) and compare with the baseline backtest. Use after a month-end close has been ingested and verified.
allowed-tools: Bash(npm run backtest:*), mcp__stockdb__score_outcomes, mcp__stockdb__run_readonly_sql, mcp__stockdb__list_predictions, mcp__stockdb__stats
---

# /score-outcomes

1. `stats`: which target months now have verified closes.
2. `score_outcomes {}` (or `{ticker}`): one prediction_outcomes row per newly scorable prediction (the DB trigger requires the
   actual close to equal the verified close).
3. `run_readonly_sql`: `SELECT * FROM v_calibration` for hit rate, mean Brier, range coverage and mean absolute error.
4. `npm run backtest` for the baseline-only reference (frozen k; coverage target 60-76%).
5. Summarise per ticker and overall: live vs baseline hit rate, coverage and Brier. Suggest (never apply) model changes, e.g.
   re-calibrating k when live coverage leaves 60-76% over at least 6 scored months.
