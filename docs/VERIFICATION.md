# Verification: defense layers and residual risk

Goal: nothing reaches a final prediction report unless it traces back to data the system itself fetched and verified. Each
layer below assumes the ones before it can fail. Reason codes: `src/verify/reasons.mjs`; report guard codes:
`src/report/reportCheck.mjs`; DB triggers: `docs/SCHEMA.md`.

## Defense layers

| # | Layer | Where | What it stops |
|---|---|---|---|
| 1 | Protected files | `guard-protected-files` hook | `.env*` never read or written; `data/**`, `context/companies/**`, `*-reviews.md`, `inbox/processed|rejected` always blocked; without `SP_DEV_MODE=1` (real process env, never `.env`) only reports/<M>/<T>-prediction.md, inbox/prices|news, docs/**, README.md, PROJECT_STATUS.md, dashboard/** are writable. Claude settings/hooks and shell rc files outside the project are blocked |
| 2 | Bash allowlist | `guard-bash` hook | only `npm run`/`npm test`, `node` on project scripts, read-only git, docker ps/logs/compose up/down (no `-v`), curl GET. Denies mysql clients, `docker exec`, SQL writes with a DB context, `.env` reads (globs, recursive search, dynamic paths, `@file`), interpreters, eval, xargs, `find -exec`, `npx` |
| 3 | Hook pre-checks | PreToolUse hooks on MCP write tools and reports | early, explainable denials: price re-fetch (A+B), news page fetch + title/date match, verbatim excerpt re-fetch, analysis evidence in pack, report guard on every write, finalize gate |
| 4 | Server re-verification | `mcp-server/index.mjs` -> `src/ingest/tools.mjs`, `src/research/notes.mjs`, `src/predict/workflow.mjs` | AUTHORITATIVE: every check is repeated server-side because hooks do not fire for script-driven calls (`npm run ingest/backfill`). One transaction + `audit_log` row per call |
| 5 | DB triggers + column grants | `db/init/02-users.sh`, `03-triggers.sql` | `stock_app` has SELECT/INSERT and UPDATE only on listed status columns, DELETE only on `quant_features`; `stock_ro` SELECT only. Triggers refuse unverified prices, notes without a hashed found excerpt, verified news on unverified sources, citations of unverified sources, finals without a validator pass and >= 3 accepted analyses, outcomes not equal to the verified close |
| 6 | Audit + live re-validation | `npm run audit`, `npm run validate`, `/audit-db` | invariants re-checked from rows + files (report sha, chart sidecar, pack sha, last trading day, gates); a random sample of stored URLs re-fetched (excerpts still verbatim, 404s) and closes re-fetched from Nasdaq + CNBC |

Additional controls:
- **Prices**: Nasdaq (A) and CNBC (B) are re-fetched live by the server for every submission (URLs built by the server, never
  taken from input); |A-B| <= 0.01 and |submitted-A| <= 0.01; trade date must be the last NYSE trading day (holiday calendar
  in code and in `nyse_closures`); a month is only accepted 90 minutes after the 16:00 ET close.
- **Sources**: https allowlist with ownership groups (`config/domain-policy.json`), deny list (shorteners, user content,
  aggregators), IP/local hosts refused, every redirect hop re-checked, search/query pages refused (`search_page`), CSS-hidden
  text stripped, 3 MB / 15 s / 3 redirect caps. Text is stored only as a sha256 plus excerpts. On a re-fetch (`recheck_sources`
  or a re-ingested `add_news_item`) a transient failure (403/5xx/timeout/thin page) never demotes a verified source or its items;
  a rejection (404-class, policy) rejects the source's items and re-evaluates the items it corroborated.
- **Corroboration**: >= 2 other ownership groups within 72 h with similar titles; wire copies (AP/Reuters/AFP datelines and
  bylines) and syndicated text (>= 0.85 similarity) do not count as independent.
- **Research notes**: excerpt 40-1200 chars, exact substring of the re-fetched main text, every number in the claim present in
  the excerpt, excerpt not reflected from the URL.
- **Prompt injection**: `flag-untrusted-content` scans WebFetch / `get_source` / `get_research_pack` output for instruction-like
  text (incl. homoglyphs) and adds a warning; source text is always delivered inside `untrusted_content` fields.
- **Reports**: numbers traced to the pack/DB, citations verified and in the run's pack, exact reference lines, required
  sections, disclaimer, forbidden phrases; the file's sha256 is frozen at `save_prediction` and re-checked at review and
  finalize; the chart sidecar is re-rendered from the DB and compared byte-for-byte.
- **As-of discipline**: packs contain only data dated <= end of the as-of month; a run's agents must use its `pack_id`.

## Residual risks (known, accepted for now)

1. **Number tracing is typed, not fully semantic.** Text is NFKC/Unicode-digit normalised and every number is typed by what is
   glued to it (percent, dollar incl. `US$`/`USD`/"dollars", magnitude k/m/bn, other unit). A percent must equal a percent-type
   field within ±0.05 percentage points, a dollar amount a price within ±$0.005, a plain number a plain field exactly to its last
   decimal, all **sign-sensitive**. Spelled-out quantities, HTML, unknown dates and instruction-like text fail. Peer closes are
   never allowed; peer returns only in sentences that name a peer. **Forward-looking sentences** (next month, the target month,
   expect/could/likely/will, probability, upside, close at …) may only use the call (consensus/baseline mid, range bounds, p_up,
   confidence, accepted analyzer ranges); a range bound described as the expected value (`bound_as_point`) or p_up described as a
   decline probability (`probability_misdescribed`) fails. Residual: in a backward-looking sentence a number is checked against
   every field of its type, so a real value can still be quoted with the wrong label ("revenue grew 6.1%" where 6.1% is vol12).
   Years in a date context and plain integers <= 10 without a unit are exempt. The validator (mode B) checks field meaning; it is
   an LLM and can miss this.
2. **Search-page rule false positives.** `search_page` refuses any URL whose path contains a segment like `search`, `find`,
   `results`, `query` or `lookup`, or that has a query key such as `q`, `s`, `k`, `text`, `term`. Legitimate articles with such
   paths or parameters (e.g. `/results/` earnings pages, `?s=` share links) are rejected and cannot be cited. Use the canonical
   article URL without tracking parameters.
3. **Corroboration misses.** The rule is conservative: on the labelled dev pairs (`test/fixtures/corroboration-pairs.json`),
   news items 39 (BBC) and 40 (CBS) describe the same event but score below the threshold, so that pair does not corroborate
   (known false negative). Real independent coverage can therefore stay `verified` (single outlet) instead of `corroborated`.
   The opposite error (two outlets sharing one wire story) is mitigated by wire detection but not eliminated for rewrites that
   strip datelines.
4. **Hooks only load in project sessions.** `.claude/settings.json` hooks run only when Claude Code is started in this
   project directory. Sessions started elsewhere (e.g. a parent folder, a sub-agent of another project), scripts and other MCP
   clients bypass layers 1-3 entirely. Layers 4-6 still apply to everything that goes through stockdb, but file edits (reports,
   config, harness) are only guarded by hooks. `npm run audit` detects edited reports/charts after the fact.
5. **Agent identity is only partly authenticated.** `start_run` issues one random secret per agent_task (only its sha256 is
   stored) and `update_agent_task` requires it, so an agent holding only its own token cannot move another agent's task — but the
   orchestrating session sees every token, and `save_analysis` / `save_review` still trust the `agent` / perspective in the
   payload: one session could write analyses under several agent names. Controls: tokens, one task and one live analysis per
   (run, agent, ticker) (unique keys), validator reviews must reference the run's validator task, the validator gate, the
   `audit_log`, `npm run audit` (consensus recomputation, tasks not issued by start_run, duplicate live predictions) and
   `data/agent-audit.jsonl` (records `agent_type` when the hook input carries it).
   At the DB level the finalize trigger recomputes the consensus mid and p_up in SQL from the linked accepted analyses and the run
   pack's baseline, and run plans are immutable, so a forged consensus re-using real analyses cannot be finalized. Residual: a
   holder of the `stock_app` credentials can still INSERT a whole fake chain (pack, run, tasks with token hashes, analyses, review);
   the stockdb server is the only intended writer and `npm run audit` re-derives what it can.
6. **Page drift and soft paywalls.** A page verified once can later change (`npm run validate` reports content drift) or serve
   different text to different clients. Paywalled outlets (WSJ, FT, Bloomberg, Barron's) usually end `unreachable` and cannot be
   cited. Excerpt checks prove the text was on the page when fetched, not that the claim is true.
7. **Source truth vs. fetch truth.** Both price sources could be wrong in the same way (shared upstream feed); CNBC is read on an
   adjusted basis, so a later split/dividend adjustment can make `validate --prices` report a mismatch for an old month.
8. **Model risk.** The baseline has no demonstrated skill beyond the base rate (`docs/METHOD.md`); verification guarantees
   provenance, not accuracy.
9. **SEC fetches are disabled** until the user sets a real contact `SP_HTTP_UA` (see `docs/SOURCES.md`); filings are then
   unavailable as evidence and research relies on IR pages and outlets.
10. **Dev mode.** `SP_DEV_MODE=1` in the real environment unlocks harness edits; it must be unset for normal operation.
