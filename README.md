# stock-predictor

Next-month direction and range predictions for **GOOGL, AMZN, AAPL and SPCX**, built only from verified data:

- month-end closes re-fetched live from Nasdaq and cross-checked against CNBC,
- news and research notes whose pages were fetched, policy-checked, matched and (for news) corroborated,
- stored in MySQL through the `stockdb` MCP server, the only write path, guarded by hooks, server checks and DB triggers.

A team of Claude agents (planner, 5 analyzers, validator, reporter-designer, drawer, project manager) turns that data into a
report and a chart per ticker. Every number and citation in a report must trace back to the database.

Dashboard: https://claude.ai/artifact/2kRtCkAy8nuM8kBdapWRJs

> **Disclaimer.** This report is an automated statistical and research summary, not investment advice. The baseline model
> has shown no skill beyond the base rate of up months in its backtest (`docs/METHOD.md`). Do not trade on it.

## Setup

Requirements: Node >= 22, Docker, Claude Code.

```bash
npm install && npm run setup     # generates .env (random DB passwords), starts MySQL 8.4 on 127.0.0.1:3310
npm run db:migrate               # only needed for an existing database after an upgrade (idempotent)
npm test                         # unit tests; integration tests run when the test DB is up (npm run db:test:up, port 3320)
npm run smoke                    # end-to-end smoke on the throwaway test DB
```

Optional, for SEC filings: edit `.env` yourself and set `SP_HTTP_UA` to an app name plus **your contact e-mail** (SEC
fair-access rule). Until then SEC requests are refused with `sec_user_agent_unset` and research uses IR pages and outlets.
See `docs/SOURCES.md`. Claude never reads `.env`.

## Daily operation

1. Drop new files into `inbox/` (see below), then in Claude Code run `/ingest-inbox`.
2. `/verify-resources` re-checks pending/old sources and looks for independent coverage of single-outlet news.
3. Optionally `/research-company <TICKER>` to add verified research notes (SEC/IR/outlets, verbatim excerpts).

## Monthly operation

1. After the last NYSE trading day of the month (closes settle 90 minutes after the 16:00 ET close), ingest that month's closes
   (`/ingest-inbox`, or `npm run backfill`), so the new month is verified.
2. Run the prediction for the next month (below).
3. Once the following month-end close is verified, `/score-outcomes` scores the predictions and compares them with the baseline.
4. Weekly or after a run: `/audit-db` (`npm run audit` invariants + `npm run validate` live re-check).

## Dropping inbox files

| Path | Format |
|---|---|
| `inbox/prices/*.csv` | header `ticker,month,trade_date,close[,source_url]`; `trade_date` = last NYSE trading day of `month` |
| `inbox/prices/*.json` | array of `{ticker, month, trade_date, close, source_url?}` |
| `inbox/news/*.json` | `{ticker, scope?, title, url, published_at, outlet?, summary?, references?}` or an array; `scope: "macro"` allows `ticker: null` |
| `inbox/news/*.md` | YAML front-matter with the same fields; the body is the summary |
| `inbox/leads/` | unverified hints from collectors: never ingested, never cited |

`npm run ingest -- --dry-run` shows what would happen; `npm run ingest` stores what verifies, moves decided files to
`inbox/processed/` and keeps files with pending items (e.g. `month_incomplete`, `refetch_failed`) for a retry. Details:
`inbox/README.md`.

## Running a prediction

```bash
cd stock-predictor
claude
> /predict-next-month all 2026-11
```

The target month 2026-11 uses data up to the end of 2026-10 only, so the 2026-10 closes must be verified first. The run:
planner (coverage, immutable research pack per ticker) -> analyzers in parallel -> validator accepts/rejects each analysis ->
reporter-designer writes `reports/2026-11/<TICKER>-prediction.md` -> drawer draws `<TICKER>-prediction.svg` -> validator
checks report and chart -> `finalize_report` -> project manager writes `reports/2026-11/RUN_STATUS.md`. One ticker:
`/predict-next-month AAPL 2026-11`. Re-check one prediction: `/review-prediction <id>`.

Preview the deterministic baseline without writing anything: `npm run baseline -- --target 2026-11`.

## Commands

| Command | What it does |
|---|---|
| `npm run setup` / `db:up` / `db:down` / `db:migrate` | env + DB lifecycle (never `docker compose down -v`) |
| `npm run ingest [-- --dry-run] [--file f]` | ingest inbox files through the MCP server |
| `npm run backfill -- --from 2023-01` | verified month-end closes from Nasdaq + CNBC |
| `npm run crawl -- --ticker T [--register]` | SEC / IR discovery |
| `npm run features` / `context -- --ticker T` | deterministic features / regenerate `context/companies/<T>.md` |
| `npm run baseline -- --target M` / `backtest [-- --calibrate]` | read-only baseline preview / walk-forward backtest |
| `npm run draw -- --ticker T --target M` / `run-status` | charts / run status report |
| `npm run audit` | DB invariants (exit 1 on any violation) |
| `npm run validate [-- --sample 20 --prices 4]` | live re-fetch of a sample of stored URLs, excerpts and closes (read-only) |
| `npm test` / `npm run smoke` | tests / end-to-end smoke on the test DB (3320) |

## Documentation

- `CLAUDE.md`: rules, tools, hooks and context policy for Claude (nested: `reports/`, `inbox/`, `context/`).
- `docs/PLAN.md` (design), `docs/METHOD.md` (model and backtest), `docs/VERIFICATION.md` (defense layers, residual risk),
  `docs/SCHEMA.md`, `docs/SOURCES.md`, `docs/AGENTS.md`, `docs/REPORT_TEMPLATE.md`. Status: `PROJECT_STATUS.md`.

This project produces automated statistical and research summaries. It is not investment advice.
