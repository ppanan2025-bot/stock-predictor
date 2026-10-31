# Project Status: stock-predictor

Last updated: 2026-10-31 01:47 AEDT (Project manager). Plan: [docs/PLAN.md](docs/PLAN.md) (§5 superseded by [docs/AGENTS.md](docs/AGENTS.md)).
Dashboard: https://claude.ai/artifact/2kRtCkAy8nuM8kBdapWRJs

## Goal

Take month-end closing prices plus news and references for the tracked tickers, verify them, and store them in MySQL (`stockdb`, accessed through the `stockdb` MCP server). A multi-agent research team then works from that verified data to produce a next-month trend prediction report with a predicted line graph. A harness of skills and hooks enforces verification: prices are re-fetched and checked, sources are fetched and corroborated, and report numbers and citations must trace back to the research pack. CLAUDE.md provides the project context.

## Build team and roles

| Role | Who | Responsibility |
|---|---|---|
| Leader | Main session | Directs the build, assigns work, accepts phases |
| Planner | Sub-agent | Owns docs/PLAN.md and its revisions |
| Project manager | Sub-agent | Owns PROJECT_STATUS.md: phase tracking, inputs, risks |
| Developer | Sub-agent | Implements the phase deliverables |
| Validator | Sub-agent | Checks the acceptance criteria and signs off each phase |

## Runtime agent roster (implemented in P4; see docs/AGENTS.md)

planner; 5 analyzers (fundamental, technical, news-sentiment, macro-sector, risk-skeptic); validator; reporter-designer; drawer; project-manager.

## Phases

| Phase | Scope | Status |
|---|---|---|
| P0 | Plan | Done. Draft saved as docs/PLAN.md. The Planner's roster revision never came back; the roster was implemented directly in P4 |
| P1 | Infrastructure, DB, MCP skeleton | Done. Validator PASS WITH ISSUES (2 med, 4 low), all fixed in P2 |
| P2 | Ingest and verification hooks | Done. Validator PASS WITH ISSUES (1 high, 3 med, 2 low), all fixed in P3 |
| P3 | Research crawl and features | Built. Validator FAIL (critical), fixed in P4 and confirmed by the P4 Validator. Gap: GOOGL notes |
| P4 | Prediction, sub-agents, report guard | Built. Validator PASS WITH ISSUES (3 med, 2 low-med, 5 low). Developer is fixing them now |
| P5 | Tests, docs, audit | Built. Waiting on Validator review of P5 and the P4 fixes |

### P0: Plan
- [x] PLAN.md draft reviewed by the Leader
- [ ] PLAN.md revised to include the runtime roster. Not done: superseded by docs/AGENTS.md
- [x] Plan approved for build

### P1: Infrastructure, DB and MCP skeleton
- [x] `npm run setup` brings the DB up healthy, and `stats` works from Claude
- [x] The users' grants are verified (`stock_ro` cannot INSERT; `stock_app` cannot DELETE)
- [x] Trigger tests pass against an empty schema
- [x] The `sqlGuard` and calendar tests pass

### P2: Ingest and verification hooks
- [x] A fixture inbox ingests: correct prices verified, wrong close gives `price_mismatch`, mid-month date gives `not_month_end`
- [x] Fake news (title mismatch, denied domain) is rejected
- [x] 3 outlets give `corroborated` (live: #37 iPhone Duo)
- [x] Hook tests pass
- [x] Live backfill from 2023-01 yields ≥36 verified months per ticker: 45 for GOOGL/AMZN/AAPL. SPCX has 4 (listed 2026-06, see R5)

### P3: Research crawl and features
- [x] A missing excerpt is blocked by both the hook and the server (fabricated-excerpt bypass fixed in P4)
- [x] Features are byte-identical across runs (sha stable) and match golden fixtures
- [x] The pack contains no unverified rows and returns `excluded_counts`
- [ ] Live `/research-company GOOGL` produces ≥5 verified notes. Open: 0 GOOGL notes so far (AMZN has 4). Needs the SEC contact email or a blog.google run

### P4: Prediction, sub-agents and report guard
- [x] End-to-end on fixtures reaches `final` only with a validator pass and the required reviews (per the P4 Validator)
- [x] Editing a report after review blocks finalization
- [ ] Untraced numbers and unverified citations are blocked. Open: the Validator found number-tracing bypasses/tolerance issues and a DB-trigger gate bypass via direct SQL. Fix in progress
- [x] Backtest prints calibration: k=1.10, coverage 67.7% (inside 60–76%). Sign hit 58.3% equals the base rate, so there is no skill beyond the base rate
- [ ] Live: GOOGL, AMZN and AAPL predictions for 2026-11 finalized after the 2026-10 close is verified. Waiting on the 2026-10 closes

### P5: Tests, docs and audit
- [x] `npm test` is green: 141/141 pass, 0 fail (checked 2026-10-31 01:47; the Developer is mid-fix on P4, so the count may change)
- [x] `npm run smoke` is green (Developer report; not yet validated)
- [x] `claude-md.test` is green (included in the 141)
- [x] Audit reports 0 violations: dev DB 3310 has 0 violations and 0 warnings (139 prices, 4 verified notes, 2 research packs, 0 predictions)
- [ ] With `SP_DEV_MODE` unset, writing to `src/` is denied. Waiting on the P5 Validator

## Build summary (P4 and P5)

- P4: 10 runtime agents, 26 MCP tools, 4 new hooks, baseline and backtest.
- P5: CLAUDE.md (117 lines), plus nested CLAUDE.md files in reports/, inbox/ and context/. Docs: METHOD, VERIFICATION, SCHEMA, SOURCES and AGENTS. README; audit, validate and smoke scripts.

## Data in stockdb (dev, 2026-10-31 01:47)

- Prices: 139 verified month-end closes. That is 103 inbox closes verified live plus 36 backfilled for 2023, giving 45 months each for GOOGL, AMZN and AAPL and 4 for SPCX.
- News: 16 items. 1 is corroborated (#37 iPhone Duo), 11 are verified, and 4 are pending because their sources returned HTTP 403.
- Research notes: 4 verified (all AMZN); 0 for GOOGL.

## Inputs received

| File | From | Contents |
|---|---|---|
| inbox/prices/ria-month-end-2024-01_2026-09.csv | stock-collector | 103 month-end closes (33 each for GOOGL/AMZN/AAPL; 4 for SPCX, from 2026-06). All ingested |
| inbox/news/world-2026-10-27.json | news-collector | 12 macro items |
| inbox/news/company-AAPL-2026-10.json | news-collector | 4 AAPL items |
| inbox/leads/2026-10-news-collector-leads.md | news-collector | UNVERIFIED leads. Do not cite these |

**Next milestone:** stock-collector delivers the 2026-10 closes on Sat 2026-10-31 at about 13:07 AEDT. Then: ingest and verify them, run `/predict-next-month all 2026-11` live, and have the Validator review the run.

## Open decisions for the user

1. **SEC contact email:** the SEC crawler needs it in its User-Agent. It blocks GOOGL research notes (P3 gap).
2. **Confirm blog.google** as a GOOGL source. It has already been added to the sources.

## Risks and blockers

| # | Risk or blocker | Impact | Mitigation |
|---|---|---|---|
| R1 | No GOOGL research notes; company news is thin for GOOGL and SPCX | GOOGL analysis rests on prices and macro only | User supplies the SEC email, or run blog.google |
| R2 | The 2026-10 close is not yet received or verified | Blocks the live 2026-11 prediction | Ingest it at about 13:07 AEDT on 2026-10-31 |
| R3 | No Chrome available for dashboard screenshots | The dashboard can't be checked visually | Check it manually |
| R4 | ~~Roster differs from PLAN.md §5~~ | Closed: the roster was implemented in P4, and docs/AGENTS.md supersedes §5 | None needed |
| R5 | SPCX has only 4 months of history | Weak baseline features | Flag SPCX as low-confidence in reports |
| R6 | The P4 report guard can be bypassed (number tracing; direct-SQL DB trigger) | Untraced numbers could reach a final report | Developer fixing; Validator re-check before the live run |
| R7 | Backtest shows no directional skill beyond the base rate (58.3%) | Predictions could be over-trusted | Reports must state calibration and the base rate |
| R8 | 4 news items are pending (HTTP 403) | Fewer usable sources | Recheck them with `recheck_sources`, or leave them excluded |

## Change log

- **2026-10-30**: PLAN.md draft received (P0 in progress). User specified the runtime agent roster. Inputs received from stock-collector and news-collector.
- **2026-10-30**: PROJECT_STATUS.md created by the Project manager.
- **2026-10-30 23:55**: Developer started P1.
- **2026-10-30/31**: P1 done (Validator PASS WITH ISSUES; fixed in P2). P2 done: 103 closes verified live plus 36 backfilled, and 16 news items (Validator PASS WITH ISSUES, including the high-severity curl file:// .env issue; fixed in P3).
- **2026-10-30/31**: P3 built; Validator FAIL because a fabricated excerpt got through via a search-page echo. Fixed in P4 and confirmed by the P4 Validator.
- **2026-10-30/31**: P4 built; Validator PASS WITH ISSUES (3 med). Developer fixing. P0 closed: the roster was implemented directly and docs/AGENTS.md supersedes PLAN.md §5.
- **2026-10-31 (before 01:47)**: P5 built: CLAUDE.md and its nested files, docs, README, and the audit, validate and smoke scripts.
- **2026-10-31 01:47**: PM check: `npm test` 141/141 pass; `npm run audit` gives 0 violations and 0 warnings (139 prices, 4 notes). Status file updated.
