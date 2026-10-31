# Report template: reports/<YYYY-MM>/<TICKER>-prediction.md

The reporter_designer writes one report per ticker from `get_consensus {run_id, ticker}`. The `guard-report-write` hook and the
stockdb server (`save_prediction`, validator `save_review`, `finalize_report`) run the same guard (`src/report/reportCheck.mjs`):

- **Front matter** is copied verbatim from `get_consensus.report.front_matter` (ticker, as_of_month, target_month, run_id, pack_id,
  pack_sha256). A report for target month M uses only data dated up to the end of M-1.
- **Every section below** (`## ` headings, exact names) is required; the Disclaimer must contain the exact sentence shown.
- **Numbers**: every number outside an opinion span must come from the pack (closes, features, peers, baseline, calibration,
  verified note excerpts/claims, verified news titles), the server-computed consensus, the accepted analyses' lo/hi/mid/confidence,
  or a model constant (k, flat band, thresholds). Copy the call strings from `consensus.formatted` exactly (e.g. `+1.4%`).
  Years and whole numbers up to 10 are exempt. Labels like 12m / Q3 / 10-K are fine (digits glued to letters are labels).
- **Opinion spans**: an analyzer's own reasoning goes inside `<!-- opinion:<agent> -->` … `<!-- /opinion -->` (agent = fundamental,
  technical, news_sentiment, macro_sector, risk_skeptic). Numbers inside must appear in THAT agent's saved analysis (its range,
  confidence or a number in its saved rationale). The span is invisible when rendered; it marks the text as analyzer opinion.
- **Citations**: only `[S<id>]` ids from `get_consensus.report.reference_lines` (verified sources of this run's pack). References
  lists exactly the cited ids, one line each, copied from those lines (canonical URL + `sha256:` prefix). No other URLs.
- Forbidden: "guaranteed", "certain to", "will definitely", "price target", "risk-free", "can't lose".
- After `save_prediction`, never edit the file: the stored sha256 must match at review and finalization. To revise, withdraw the
  prediction, rewrite, save a new version and get it re-validated.

---

```markdown
---
ticker: GOOGL
as_of_month: 2026-09
target_month: 2026-10
run_id: 12
pack_id: 34
pack_sha256: <64 hex, from get_consensus>
---
# GOOGL: prediction for 2026-10

![GOOGL verified month-end closes and 2026-10 prediction](GOOGL-prediction.svg)

## Summary
Consensus call: **flat**, mid +1.4% (range -10.4% to +14.7%), p_up 0.55, confidence 0.18 (low).
One or two sentences on why, citing [S12] where a source supports a statement.

## Baseline vs Consensus
| | Direction | Low | Mid | High | p_up | Confidence |
|---|---|---|---|---|---|---|
| Baseline (deterministic) | flat | -10.4% | +1.4% | +14.7% | 0.55 | 0.18 |
| Consensus (accepted analyses) | flat | -10.4% | +1.4% | +14.7% | 0.55 | 0.18 |

Say whether the overlay was clamped (consensus.overlay_clamped). Short-history ticker: "Baseline: null (short history)".

## Analyzer Views
| Analyzer | Direction | Low | High | Confidence |
|---|---|---|---|---|
| fundamental | up | -2.0% | +6.0% | 0.40 |

- fundamental: <!-- opinion:fundamental -->paraphrase of the saved rationale, numbers only from it<!-- /opinion --> [S12]

## Bull & Bear Case
Bull: … Bear: … (sources cited; analyzer numbers inside opinion spans)

## Risks
The risk_skeptic's strongest counter-arguments and tail risks.

## What Would Change the Call
Concrete, checkable events (e.g. a close below the low end of the range, a guidance cut reported by a verified source).

## References
- [S12] <copied from get_consensus.report.reference_lines>

## Data As Of
Verified month-end close 344.08 on 2026-09-30 (as-of month 2026-09); pack_id 34, run_id 12; baseline-v1, k 1.1.
News and research notes dated after 2026-09-30 are excluded (as-of discipline).

## Disclaimer
This report is an automated statistical and research summary, not investment advice.
```
