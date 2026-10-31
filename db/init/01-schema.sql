-- stockdb schema (PLAN §2 + run/agent tables). Runs once on first container start (docker-entrypoint-initdb.d).
-- All timestamps are UTC DATETIME(3) (server runs with --default-time-zone=+00:00). Money values are DECIMAL(14,4).
-- Months are 'YYYY-MM' CHAR(7). Integrity rules that need other tables live in 03-triggers.sql.

CREATE TABLE IF NOT EXISTS companies (
  ticker      VARCHAR(10)  PRIMARY KEY,
  name        VARCHAR(120) NOT NULL,
  exchange    VARCHAR(16)  NOT NULL DEFAULT 'NASDAQ',
  sector      VARCHAR(64)  NULL,
  industry    VARCHAR(96)  NULL,
  cik         CHAR(10)     NULL,
  ir_domains  JSON         NOT NULL,
  peers       JSON         NOT NULL,
  role        ENUM('target','benchmark') NOT NULL DEFAULT 'target',
  listed_on   DATE         NOT NULL,                 -- first trading day; months before it never have data
  active      TINYINT(1)   NOT NULL DEFAULT 1,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT ck_co_cik CHECK (cik IS NULL OR cik REGEXP '^[0-9]{10}$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Append-only log of every received price (verified, pending or rejected).
CREATE TABLE IF NOT EXISTS price_submissions (
  id                   BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ticker               VARCHAR(10)   NOT NULL,
  month                CHAR(7)       NOT NULL,
  trade_date           DATE          NULL,
  close                DECIMAL(14,4) NULL,
  origin               ENUM('inbox','ria_import','backfill','claude') NOT NULL,
  inbox_file           VARCHAR(255)  NULL,
  submitted_source_url VARCHAR(600)  NULL,
  received_at          DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  status               ENUM('verified','pending','rejected') NOT NULL,
  reason               VARCHAR(48)   NOT NULL,       -- 'ok' when verified, else a PLAN §4.2 reason code
  detail               JSON          NULL,
  CONSTRAINT fk_sub_ticker FOREIGN KEY (ticker) REFERENCES companies(ticker),
  CONSTRAINT ck_sub_month CHECK (month REGEXP '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  KEY ix_sub_tm (ticker, month, received_at), KEY ix_sub_status (status, received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- VERIFIED ONLY: one canonical (Nasdaq, unadjusted) close per ticker/month, cross-checked against CNBC.
CREATE TABLE IF NOT EXISTS month_end_prices (
  id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ticker              VARCHAR(10)   NOT NULL,
  month               CHAR(7)       NOT NULL,
  trade_date          DATE          NOT NULL,
  close               DECIMAL(14,4) NOT NULL,
  submission_id       BIGINT UNSIGNED NOT NULL,
  source_a_url        VARCHAR(600)  NOT NULL, source_a_close DECIMAL(14,4) NOT NULL, source_a_fetched_at DATETIME(3) NOT NULL,
  source_b_url        VARCHAR(600)  NOT NULL, source_b_close DECIMAL(14,4) NOT NULL, source_b_fetched_at DATETIME(3) NOT NULL,
  abs_diff            DECIMAL(14,4) NOT NULL,
  tolerance_abs       DECIMAL(14,4) NOT NULL,
  verification_status ENUM('verified') NOT NULL DEFAULT 'verified',
  verified_at         DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_price_tm (ticker, month),
  KEY ix_price_month (month),
  CONSTRAINT fk_price_ticker FOREIGN KEY (ticker) REFERENCES companies(ticker),
  CONSTRAINT fk_price_sub    FOREIGN KEY (submission_id) REFERENCES price_submissions(id),
  CONSTRAINT ck_price_month CHECK (month REGEXP '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT ck_price_in_month CHECK (DATE_FORMAT(trade_date,'%Y-%m') = month),
  CONSTRAINT ck_price_pos CHECK (close > 0 AND source_a_close > 0 AND source_b_close > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sources (
  id                   BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  url_canonical        VARCHAR(700)  NOT NULL,
  url_original         VARCHAR(2000) NOT NULL,
  domain               VARCHAR(255)  NOT NULL,
  outlet_key           VARCHAR(64)   NULL,
  ownership_group      VARCHAR(64)   NULL,
  tier                 ENUM('primary','high','standard') NOT NULL DEFAULT 'standard',
  kind                 ENUM('news','filing','ir','data','reference','research') NOT NULL,
  title_fetched        VARCHAR(500)  NULL,
  published_at_fetched DATETIME(3)   NULL,
  http_status          SMALLINT      NULL,
  fetched_at           DATETIME(3)   NULL,
  content_sha256       CHAR(64)      NULL,
  text_len             INT UNSIGNED  NULL,
  wire_agency          VARCHAR(16)   NULL,           -- ap|reuters|afp when the FETCHED page is wire-agency copy evidence (dateline/byline/copyright)
  verification_status  ENUM('pending','verified','corroborated','unreachable','rejected') NOT NULL DEFAULT 'pending',
  verification_reason  VARCHAR(64)   NULL,
  last_checked_at      DATETIME(3)   NULL,
  created_at           DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_src_url (url_canonical),
  KEY ix_src_status (verification_status), KEY ix_src_domain (domain),
  FULLTEXT KEY ft_src_title (title_fetched),
  CONSTRAINT ck_src_sha CHECK (content_sha256 IS NULL OR content_sha256 REGEXP '^[0-9a-f]{64}$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- scope 'company' needs a ticker; scope 'macro' (world/market news used as context) may have ticker NULL.
CREATE TABLE IF NOT EXISTS news_items (
  id                       BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ticker                   VARCHAR(10)  NULL,
  scope                    ENUM('company','macro') NOT NULL DEFAULT 'company',
  source_id                BIGINT UNSIGNED NOT NULL,
  title_submitted          VARCHAR(500) NOT NULL,
  published_at_submitted   DATETIME(3)  NULL,
  summary_submitted        TEXT         NULL,
  inbox_file               VARCHAR(255) NULL,
  title_similarity         DECIMAL(4,3) NULL,
  date_delta_hours         DECIMAL(8,2) NULL,
  corroboration_count      INT          NOT NULL DEFAULT 0,
  corroborating_source_ids JSON         NULL,
  status                   ENUM('pending','verified','corroborated','rejected') NOT NULL DEFAULT 'pending',
  reason                   VARCHAR(64)  NULL,
  sentiment                ENUM('pos','neg','neutral') NULL,
  created_at               DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_news_ticker FOREIGN KEY (ticker) REFERENCES companies(ticker),
  CONSTRAINT fk_news_source FOREIGN KEY (source_id) REFERENCES sources(id),
  CONSTRAINT ck_news_scope CHECK (scope = 'macro' OR ticker IS NOT NULL),
  KEY ix_news_ticker (ticker, status, published_at_submitted), KEY ix_news_scope (scope, status),
  FULLTEXT KEY ft_news (title_submitted, summary_submitted)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS news_references (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  news_item_id BIGINT UNSIGNED NOT NULL,
  source_id    BIGINT UNSIGNED NOT NULL,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_ref (news_item_id, source_id),
  CONSTRAINT fk_ref_news FOREIGN KEY (news_item_id) REFERENCES news_items(id),
  CONSTRAINT fk_ref_src  FOREIGN KEY (source_id) REFERENCES sources(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS research_notes (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ticker         VARCHAR(10)  NOT NULL,
  source_id      BIGINT UNSIGNED NOT NULL,
  category       ENUM('earnings','guidance','product','legal','regulatory','macro','management','capital_return','supply_chain','other') NOT NULL,
  claim          VARCHAR(500) NOT NULL,
  excerpt        TEXT         NOT NULL,
  excerpt_sha256 CHAR(64)     NOT NULL,
  excerpt_found  TINYINT(1)   NOT NULL DEFAULT 0,
  as_of_date     DATE         NULL,
  status         ENUM('verified','rejected') NOT NULL,
  reason         VARCHAR(64)  NULL,
  created_by     ENUM('claude','crawler') NOT NULL DEFAULT 'claude',
  page_sha256    CHAR(64)     NULL,                  -- content_sha256 of the page text the excerpt was matched in (Phase 3)
  fetched_at     DATETIME(3)  NULL,                  -- when the server re-fetched the page for this note (Phase 3)
  created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_note_ticker FOREIGN KEY (ticker) REFERENCES companies(ticker),
  CONSTRAINT fk_note_source FOREIGN KEY (source_id) REFERENCES sources(id),
  KEY ix_note_ticker (ticker, status, category),
  FULLTEXT KEY ft_note (claim, excerpt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS quant_features (
  ticker          VARCHAR(10)   NOT NULL,
  month           CHAR(7)       NOT NULL,
  close           DECIMAL(14,4) NOT NULL,
  r1 DECIMAL(12,8) NULL, r3 DECIMAL(12,8) NULL, r6 DECIMAL(12,8) NULL, r12 DECIMAL(12,8) NULL,
  vol12 DECIMAL(12,8) NULL, vol36 DECIMAL(12,8) NULL, mdd12 DECIMAL(12,8) NULL, dist_12m_high DECIMAL(12,8) NULL,
  up_rate36 DECIMAL(12,8) NULL, mean36 DECIMAL(12,8) NULL, rel_r3_bench DECIMAL(12,8) NULL,
  n_months        INT           NOT NULL,
  features_json   JSON          NULL,                -- full canonical feature object (z-scores, peers, flags); sha256 = features_sha256
  features_sha256 CHAR(64)      NOT NULL,
  computed_at     DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  code_version    VARCHAR(32)   NOT NULL,
  PRIMARY KEY (ticker, month),
  CONSTRAINT fk_feat_ticker FOREIGN KEY (ticker) REFERENCES companies(ticker)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Immutable snapshots handed to Claude (reproducible reports).
CREATE TABLE IF NOT EXISTS research_packs (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ticker       VARCHAR(10) NOT NULL,
  as_of_month  CHAR(7)     NOT NULL,
  target_month CHAR(7)     NOT NULL,
  pack_json    JSON        NOT NULL,
  pack_sha256  CHAR(64)    NOT NULL,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_pack_ticker FOREIGN KEY (ticker) REFERENCES companies(ticker),
  KEY ix_pack_tm (ticker, as_of_month)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS predictions (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ticker            VARCHAR(10)   NOT NULL,
  as_of_month       CHAR(7)       NOT NULL,
  target_month      CHAR(7)       NOT NULL,
  version           INT UNSIGNED  NOT NULL DEFAULT 1,
  pack_id           BIGINT UNSIGNED NOT NULL,
  baseline_json     JSON          NOT NULL,
  baseline_p_up     DECIMAL(6,4)  NOT NULL,
  baseline_mu       DECIMAL(10,6) NOT NULL,
  overlay_p_adj     DECIMAL(6,4)  NOT NULL DEFAULT 0,
  overlay_mu_adj    DECIMAL(10,6) NOT NULL DEFAULT 0,
  overlay_rationale JSON          NULL,
  direction         ENUM('up','down','flat') NOT NULL,
  p_up              DECIMAL(6,4)  NOT NULL,
  exp_return_low    DECIMAL(10,6) NOT NULL,
  exp_return_mid    DECIMAL(10,6) NOT NULL,
  exp_return_high   DECIMAL(10,6) NOT NULL,
  confidence        DECIMAL(4,3)  NOT NULL,
  confidence_label  ENUM('low','medium','high') NOT NULL,
  final_confidence  DECIMAL(4,3)  NULL,
  report_path       VARCHAR(255)  NULL,
  report_sha256     CHAR(64)      NULL,
  status            ENUM('draft','reviewed','final','withdrawn') NOT NULL DEFAULT 'draft',
  created_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finalized_at      DATETIME(3)   NULL,
  run_id            BIGINT UNSIGNED NULL,               -- Phase 4: the agent run whose accepted analyses form the consensus
  consensus_json    JSON          NULL,               -- Phase 4: the server-computed consensus stored with the row (trigger-checked)
  UNIQUE KEY uq_pred_version (ticker, target_month, version),
  KEY ix_pred_status (status),
  CONSTRAINT fk_pred_ticker FOREIGN KEY (ticker) REFERENCES companies(ticker),
  CONSTRAINT fk_pred_pack   FOREIGN KEY (pack_id) REFERENCES research_packs(id),
  CONSTRAINT ck_pred_conf CHECK (confidence BETWEEN 0 AND 1 AND (final_confidence IS NULL OR final_confidence BETWEEN 0 AND 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS prediction_citations (
  prediction_id BIGINT UNSIGNED NOT NULL,
  source_id     BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (prediction_id, source_id),
  CONSTRAINT fk_cit_pred FOREIGN KEY (prediction_id) REFERENCES predictions(id),
  CONSTRAINT fk_cit_src  FOREIGN KEY (source_id) REFERENCES sources(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS reviews (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  prediction_id  BIGINT UNSIGNED NOT NULL,
  perspective    ENUM('fundamental','quant','news_sentiment','macro_sector','risk','source_audit','validator') NOT NULL,
  report_sha256  CHAR(64)     NOT NULL,
  score          TINYINT      NOT NULL,
  verdict        ENUM('pass','pass_with_issues','fail') NOT NULL,
  direction_view ENUM('up','down','flat','abstain') NOT NULL,
  confidence_adj DECIMAL(4,3) NOT NULL DEFAULT 0,
  issues         JSON         NOT NULL,
  summary        TEXT         NOT NULL,
  created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  agent_task_id  BIGINT UNSIGNED NULL,               -- Phase 4: validator reviews reference the run's validator agent_task
  KEY ix_rev_pred (prediction_id, report_sha256, perspective, id),             -- several reviews per sha: the LATEST validator review decides
  CONSTRAINT fk_rev_pred FOREIGN KEY (prediction_id) REFERENCES predictions(id),
  CONSTRAINT ck_rev_score CHECK (score BETWEEN 1 AND 5),
  CONSTRAINT ck_rev_adj CHECK (confidence_adj BETWEEN -0.300 AND 0.100)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS prediction_outcomes (
  prediction_id     BIGINT UNSIGNED PRIMARY KEY,
  actual_close      DECIMAL(14,4) NOT NULL,
  actual_trade_date DATE          NOT NULL,
  base_close        DECIMAL(14,4) NOT NULL,
  actual_return     DECIMAL(10,6) NOT NULL,
  direction_hit     TINYINT(1)    NOT NULL,
  in_range          TINYINT(1)    NOT NULL,
  brier             DECIMAL(6,4)  NOT NULL,
  abs_error         DECIMAL(10,6) NOT NULL,
  scored_at         DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_out_pred FOREIGN KEY (prediction_id) REFERENCES predictions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS backtest_results (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  run_id        CHAR(36)      NOT NULL,
  ticker        VARCHAR(10)   NOT NULL,
  month         CHAR(7)       NOT NULL,
  baseline_p_up DECIMAL(6,4)  NOT NULL,
  baseline_mu   DECIMAL(10,6) NOT NULL,
  actual_return DECIMAL(10,6) NOT NULL,
  hit           TINYINT(1)    NOT NULL,
  brier         DECIMAL(6,4)  NOT NULL,
  code_version  VARCHAR(32)   NOT NULL,
  created_at    DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_bt (run_id, ticker, month)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS audit_log (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  actor        ENUM('mcp','script') NOT NULL,
  tool         VARCHAR(64)  NOT NULL,
  args_summary JSON         NULL,
  ok           TINYINT(1)   NOT NULL,
  reason       VARCHAR(64)  NULL,
  KEY ix_audit_at (at), KEY ix_audit_tool (tool, at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- runtime agent orchestration (user roster: planner, 3-5 analyzers, validator, reporter-designer, drawer, PM) ----------
CREATE TABLE IF NOT EXISTS runs (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  target_month CHAR(7)     NOT NULL,
  tickers      JSON        NOT NULL,
  status       ENUM('planned','running','done','failed','cancelled') NOT NULL DEFAULT 'planned',
  started_at   DATETIME(3) NULL,
  finished_at  DATETIME(3) NULL,
  plan         JSON        NULL,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT ck_run_month CHECK (target_month REGEXP '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT ck_run_tickers CHECK (JSON_TYPE(tickers) = 'ARRAY'),
  KEY ix_run_status (status, created_at), KEY ix_run_month (target_month)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agent_tasks (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  run_id      BIGINT UNSIGNED NOT NULL,
  agent       ENUM('planner','fundamental','technical','news_sentiment','macro_sector','risk_skeptic',
                   'validator','reporter_designer','drawer','project_manager') NOT NULL,
  ticker      VARCHAR(10)  NULL,                    -- NULL for run-wide tasks (planner, PM, macro context)
  status      ENUM('queued','running','done','failed','rejected') NOT NULL DEFAULT 'queued',
  started_at  DATETIME(3)  NULL,
  finished_at DATETIME(3)  NULL,
  output_ref  VARCHAR(500) NULL,                    -- e.g. analyses:<id>, reports/<T>/<YYYY-MM>-prediction.md
  error       TEXT         NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  token_sha256 CHAR(64)    NULL,                    -- sha256 of the per-task secret start_run hands out (update_agent_task needs it)
  ticker_key  VARCHAR(10)  AS (IFNULL(ticker, '')) STORED,
  UNIQUE KEY uq_task (run_id, agent, ticker_key),
  CONSTRAINT fk_task_run    FOREIGN KEY (run_id) REFERENCES runs(id),
  CONSTRAINT fk_task_ticker FOREIGN KEY (ticker) REFERENCES companies(ticker),
  KEY ix_task_run (run_id, agent, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS analyses (
  id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  run_id              BIGINT UNSIGNED NOT NULL,
  prediction_id       BIGINT UNSIGNED NULL,
  agent               ENUM('fundamental','technical','news_sentiment','macro_sector','risk_skeptic') NOT NULL,
  ticker              VARCHAR(10)   NOT NULL,
  target_month        CHAR(7)       NOT NULL,
  direction           ENUM('up','down','flat') NOT NULL,
  exp_return_lo       DECIMAL(10,6) NOT NULL,
  exp_return_hi       DECIMAL(10,6) NOT NULL,
  confidence          DECIMAL(4,3)  NOT NULL,
  evidence_source_ids JSON          NOT NULL,
  rationale           TEXT          NOT NULL,
  created_at          DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  pack_id             BIGINT UNSIGNED NULL,               -- Phase 4: the run's research pack the evidence ids must come from
  evidence_pack_fields JSON         NULL,               -- pack-level evidence (prices, baseline, peers, features.<key>) for technical/macro
  status              ENUM('submitted','accepted','rejected') NOT NULL DEFAULT 'submitted',  -- set by the validator (save_review)
  attempt             INT UNSIGNED  NOT NULL DEFAULT 1,
  review_issues       JSON          NULL,
  review_summary      TEXT          NULL,
  reviewed_at         DATETIME(3)   NULL,
  active_slot         TINYINT       AS (IF(status = 'rejected', NULL, 1)) STORED,  -- one non-rejected analysis per (run, ticker, agent)
  UNIQUE KEY uq_an_active (run_id, ticker, agent, active_slot),
  CONSTRAINT fk_an_run    FOREIGN KEY (run_id) REFERENCES runs(id),
  CONSTRAINT fk_an_pred   FOREIGN KEY (prediction_id) REFERENCES predictions(id),
  CONSTRAINT fk_an_ticker FOREIGN KEY (ticker) REFERENCES companies(ticker),
  CONSTRAINT ck_an_range CHECK (exp_return_lo <= exp_return_hi),
  CONSTRAINT ck_an_conf CHECK (confidence BETWEEN 0 AND 1),
  CONSTRAINT ck_an_month CHECK (target_month REGEXP '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT ck_an_evidence CHECK (JSON_TYPE(evidence_source_ids) = 'ARRAY'),
  KEY ix_an_run (run_id, ticker, agent), KEY ix_an_tm (ticker, target_month)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- NYSE full-day closures (rule holidays + one-off closures such as 2025-01-09), seeded by 06-closures.sql from
-- src/market/calendar.mjs + config/verification.json price.extra_closures. trg_price_bi uses it to require that trade_date is
-- exactly the last NYSE trading day of the month. Only root (migrations) may insert (trg_closure_bi).
CREATE TABLE IF NOT EXISTS nyse_closures (
  closure_date DATE        PRIMARY KEY,
  name         VARCHAR(64) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
