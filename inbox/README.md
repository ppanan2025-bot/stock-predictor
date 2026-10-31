# inbox/

Drop files here, then run `/ingest-inbox` (or `npm run ingest -- --dry-run`, then `npm run ingest`). Every row is verified
by the stockdb server before anything is stored; nothing in this folder is trusted as-is.

| Folder | Format | Notes |
|---|---|---|
| `prices/*.csv` | header `ticker,month,trade_date,close[,source_url]` | `trade_date` must be the last NYSE trading day of `month`; the close is re-fetched live from Nasdaq and CNBC (tolerance 0.01). |
| `prices/*.json` | array of `{ticker, month, trade_date, close, source_url?}` | same rules |
| `news/*.json` | one object or an array of `{ticker, scope?, title, url, published_at, outlet?, author?, summary?, references?: [{url?, title?}]}` | `scope: "macro"` allows `ticker: null` (world/market news). `published_at` is `YYYY-MM-DD` or an ISO date-time with offset. References without a `url` are recorded only and never count toward corroboration. Unknown extra fields are ignored. |
| `news/*.md` | YAML front-matter with the same fields; the body becomes the summary | |
| `leads/` | anything | UNVERIFIED crawler leads. Never ingested, never cited. |
| `processed/`, `rejected/` | generated | results (`<file>.result.json`) and moved files; written by `npm run ingest` only. |

Files whose items are all decided move to `processed/`; files with pending items (e.g. `refetch_failed`, `source_unreachable`,
`date_unverifiable`, `month_incomplete`) stay here for a retry; unparseable files move to `rejected/` with a `.reason.json`.
