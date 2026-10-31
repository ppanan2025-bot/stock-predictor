#!/bin/bash
# Runs once on first container start (docker-entrypoint-initdb.d), after 01-schema.sql (column grants need the tables).
# stock_app: SELECT + INSERT everywhere, UPDATE only on listed columns, DELETE only on quant_features (REPLACE).
# stock_ro: SELECT only. Existing databases: npm run db:migrate re-applies these grants (idempotent).
set -euo pipefail
DB="${SP_DB_DATABASE:-stockdb}"
APP="${SP_APP_USER:-stock_app}"
RO="${SP_RO_USER:-stock_ro}"
mysql --protocol=socket -uroot -p"${MYSQL_ROOT_PASSWORD}" <<SQL
CREATE USER IF NOT EXISTS '${APP}'@'%' IDENTIFIED BY '${SP_APP_PASSWORD}';
CREATE USER IF NOT EXISTS '${RO}'@'%'  IDENTIFIED BY '${SP_RO_PASSWORD}';
GRANT SELECT, INSERT ON \`${DB}\`.* TO '${APP}'@'%';
GRANT UPDATE (verification_status, verification_reason, last_checked_at, title_fetched, published_at_fetched, http_status, fetched_at, content_sha256, text_len, wire_agency) ON \`${DB}\`.sources TO '${APP}'@'%';
GRANT UPDATE (status, reason, corroboration_count, corroborating_source_ids, sentiment) ON \`${DB}\`.news_items TO '${APP}'@'%';
GRANT UPDATE (status, final_confidence, finalized_at, report_sha256) ON \`${DB}\`.predictions TO '${APP}'@'%';
GRANT DELETE ON \`${DB}\`.quant_features TO '${APP}'@'%';
GRANT UPDATE (status, started_at, finished_at, plan) ON \`${DB}\`.runs TO '${APP}'@'%';
GRANT UPDATE (status, started_at, finished_at, output_ref, error) ON \`${DB}\`.agent_tasks TO '${APP}'@'%';
GRANT UPDATE (prediction_id, status, review_issues, review_summary, reviewed_at) ON \`${DB}\`.analyses TO '${APP}'@'%';
GRANT SELECT ON \`${DB}\`.* TO '${RO}'@'%';
FLUSH PRIVILEGES;
SQL
