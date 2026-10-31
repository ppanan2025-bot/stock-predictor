-- DB-level guards (PLAN §2 "Triggers"). The database itself refuses rows that break the verification rules, whatever
-- client inserts them. Runs once on first container start; existing databases get it from `npm run db:migrate`
-- (scripts/migrate.mjs, idempotent: DROP TRIGGER IF EXISTS + CREATE, never touches rows).
-- Statements are separated by `$$` (the migration script splits on it).
-- Timestamps are UTC; 21:00 UTC is 16:00 EST / 17:00 EDT, i.e. never before the close.
-- The price tolerance is pinned to 0.0100 = config/verification.json price.tolerance_abs; the finalization minimum (3 accepted
-- analyses) is pinned to config/model.json consensus.min_accepted_analyses. Loosening either needs a reviewed migration.
DELIMITER $$

-- 0. price_submissions: 'ok' <=> verified, and a verified submission carries a date and a close.
DROP TRIGGER IF EXISTS trg_sub_bi$$
CREATE TRIGGER trg_sub_bi BEFORE INSERT ON price_submissions FOR EACH ROW
BEGIN
  IF NEW.status = 'verified' AND (NEW.reason <> 'ok' OR NEW.trade_date IS NULL OR NEW.close IS NULL OR NEW.close <= 0
      OR DATE_FORMAT(NEW.trade_date, '%Y-%m') <> NEW.month) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'verified submission needs reason ok and a positive close on a date inside the month';
  END IF;
  IF NEW.status <> 'verified' AND NEW.reason = 'ok' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'reason ok is only valid for a verified submission';
  END IF;
END$$

-- 1. month_end_prices: backed by a verified submission; Nasdaq (A) + CNBC (B) URLs; |A-B| <= 0.01; month-end weekday;
--    fetched after the close and not in the future.
DROP TRIGGER IF EXISTS trg_price_bi$$
CREATE TRIGGER trg_price_bi BEFORE INSERT ON month_end_prices FOR EACH ROW
BEGIN
  DECLARE n INT DEFAULT 0;
  DECLARE d DATE;
  SELECT COUNT(*) INTO n FROM price_submissions s
   WHERE s.id = NEW.submission_id AND s.status = 'verified' AND s.reason = 'ok'
     AND s.ticker = NEW.ticker AND s.month = NEW.month AND s.trade_date = NEW.trade_date AND s.close = NEW.close;
  IF n <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'month_end_prices row must reference a verified price_submission with the same ticker, month, trade_date and close';
  END IF;
  IF NEW.close <> NEW.source_a_close
     OR NEW.abs_diff <> ABS(NEW.source_a_close - NEW.source_b_close) OR NEW.tolerance_abs <> 0.0100 OR NEW.abs_diff > 0.0100 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'price: close must equal the Nasdaq close and abs_diff = |A-B| <= tolerance 0.0100';
  END IF;
  IF NEW.source_a_url NOT LIKE CONCAT('https://api.nasdaq.com/api/quote/', NEW.ticker, '/historical?%')
     OR NEW.source_b_url NOT LIKE CONCAT('https://ts-api.cnbc.com/harmony/app/bars/', NEW.ticker, '/1D/%') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'price: source URLs must be the Nasdaq historical and CNBC bars endpoints for the ticker';
  END IF;
  -- trade_date must be exactly the last NYSE trading day of its month (weekends and nyse_closures skipped; Validator P1 #2).
  -- Fails closed when the closure calendar has no rows for that year.
  SELECT COUNT(*) INTO n FROM nyse_closures c WHERE YEAR(c.closure_date) = YEAR(NEW.trade_date);
  IF n = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'price: nyse_closures has no calendar for this year (run npm run db:migrate)';
  END IF;
  SET d = LAST_DAY(NEW.trade_date);
  WHILE DAYOFWEEK(d) IN (1, 7) OR EXISTS (SELECT 1 FROM nyse_closures c WHERE c.closure_date = d) DO
    SET d = d - INTERVAL 1 DAY;
  END WHILE;
  IF NEW.trade_date <> d THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'price: trade_date must be the last NYSE trading day of the month (not_month_end)';
  END IF;
  IF NEW.source_a_fetched_at < TIMESTAMP(NEW.trade_date, '21:00:00') OR NEW.source_b_fetched_at < TIMESTAMP(NEW.trade_date, '21:00:00')
     OR NEW.source_a_fetched_at > UTC_TIMESTAMP(3) + INTERVAL 2 MINUTE OR NEW.source_b_fetched_at > UTC_TIMESTAMP(3) + INTERVAL 2 MINUTE THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'price: both sources must be fetched after the close (21:00 UTC on trade_date) and not in the future';
  END IF;
END$$

-- 2. research_notes: a verified note has a found, hashed, 40-1200 char excerpt from a verified/corroborated source.
DROP TRIGGER IF EXISTS trg_note_bi$$
CREATE TRIGGER trg_note_bi BEFORE INSERT ON research_notes FOR EACH ROW
BEGIN
  DECLARE n INT DEFAULT 0;
  IF NEW.status = 'verified' THEN
    SELECT COUNT(*) INTO n FROM sources s WHERE s.id = NEW.source_id AND s.verification_status IN ('verified','corroborated');
    IF n <> 1 OR NEW.excerpt_found <> 1 OR CHAR_LENGTH(NEW.excerpt) NOT BETWEEN 40 AND 1200
       OR NEW.excerpt_sha256 <> SHA2(NEW.excerpt, 256) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'verified note needs excerpt_found=1, a 40-1200 char excerpt with matching sha256 and a verified source';
    END IF;
  END IF;
END$$

-- 3. news_items: verified/corroborated needs a verified/corroborated source with a content hash; corroborated needs >= 2.
DROP TRIGGER IF EXISTS trg_news_bi$$
CREATE TRIGGER trg_news_bi BEFORE INSERT ON news_items FOR EACH ROW
BEGIN
  DECLARE n INT DEFAULT 0;
  IF NEW.status IN ('verified','corroborated') THEN
    SELECT COUNT(*) INTO n FROM sources s
     WHERE s.id = NEW.source_id AND s.verification_status IN ('verified','corroborated') AND s.content_sha256 IS NOT NULL;
    IF n <> 1 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'verified news needs a verified/corroborated source with a content_sha256';
    END IF;
    IF NEW.status = 'corroborated' AND NEW.corroboration_count < 2 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'corroborated news needs corroboration_count >= 2';
    END IF;
  END IF;
END$$

DROP TRIGGER IF EXISTS trg_news_bu$$
CREATE TRIGGER trg_news_bu BEFORE UPDATE ON news_items FOR EACH ROW
BEGIN
  DECLARE n INT DEFAULT 0;
  IF NEW.status IN ('verified','corroborated') THEN
    SELECT COUNT(*) INTO n FROM sources s
     WHERE s.id = NEW.source_id AND s.verification_status IN ('verified','corroborated') AND s.content_sha256 IS NOT NULL;
    IF n <> 1 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'verified news needs a verified/corroborated source with a content_sha256';
    END IF;
    IF NEW.status = 'corroborated' AND NEW.corroboration_count < 2 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'corroborated news needs corroboration_count >= 2';
    END IF;
  END IF;
END$$

-- 4. prediction_citations: only verified/corroborated sources can be cited.
DROP TRIGGER IF EXISTS trg_cit_bi$$
CREATE TRIGGER trg_cit_bi BEFORE INSERT ON prediction_citations FOR EACH ROW
BEGIN
  DECLARE n INT DEFAULT 0;
  SELECT COUNT(*) INTO n FROM sources s WHERE s.id = NEW.source_id AND s.verification_status IN ('verified','corroborated');
  IF n <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'citation source must be verified or corroborated';
  END IF;
END$$

-- 6. predictions BI: inserted as draft; target = as_of + 1; a verified close for as_of; consistent numbers.
DROP TRIGGER IF EXISTS trg_pred_bi$$
CREATE TRIGGER trg_pred_bi BEFORE INSERT ON predictions FOR EACH ROW
BEGIN
  DECLARE n INT DEFAULT 0;
  IF NEW.status <> 'draft' OR NEW.finalized_at IS NOT NULL OR NEW.final_confidence IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a prediction is inserted as draft (reviews and finalize_report move it on)';
  END IF;
  IF NEW.as_of_month NOT REGEXP '^[0-9]{4}-(0[1-9]|1[0-2])$'
     OR NEW.target_month <> DATE_FORMAT(STR_TO_DATE(CONCAT(NEW.as_of_month, '-01'), '%Y-%m-%d') + INTERVAL 1 MONTH, '%Y-%m') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'target_month must be as_of_month + 1';
  END IF;
  SELECT COUNT(*) INTO n FROM month_end_prices p WHERE p.ticker = NEW.ticker AND p.month = NEW.as_of_month;
  IF n <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a verified close for (ticker, as_of_month) is required';
  END IF;
  IF NOT (NEW.exp_return_low <= NEW.exp_return_mid AND NEW.exp_return_mid <= NEW.exp_return_high)
     OR NEW.p_up < 0 OR NEW.p_up > 1 OR ABS(NEW.overlay_p_adj) > 0.15 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'prediction needs low <= mid <= high, p_up in [0,1] and |overlay_p_adj| <= 0.15';
  END IF;
  -- Phase 4: a run-based prediction stores the server-computed consensus and its numbers must equal it
  IF NEW.run_id IS NOT NULL THEN
    IF NEW.consensus_json IS NULL
       OR ABS(CAST(JSON_UNQUOTE(JSON_EXTRACT(NEW.consensus_json, '$.mid')) AS DECIMAL(12,6)) - NEW.exp_return_mid) > 0.0000005
       OR ABS(CAST(JSON_UNQUOTE(JSON_EXTRACT(NEW.consensus_json, '$.low')) AS DECIMAL(12,6)) - NEW.exp_return_low) > 0.0000005
       OR ABS(CAST(JSON_UNQUOTE(JSON_EXTRACT(NEW.consensus_json, '$.high')) AS DECIMAL(12,6)) - NEW.exp_return_high) > 0.0000005
       OR ABS(CAST(JSON_UNQUOTE(JSON_EXTRACT(NEW.consensus_json, '$.p_up')) AS DECIMAL(12,6)) - NEW.p_up) > 0.00005
       OR JSON_UNQUOTE(JSON_EXTRACT(NEW.consensus_json, '$.direction')) <> NEW.direction THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'prediction numbers must equal its stored consensus (consensus_json)';
    END IF;
  END IF;
END$$

-- 5. predictions BU (Phase 4 runtime roster): 'final' only with a hashed report, a VALIDATOR pass on that sha, no review on that
--    sha that failed with a critical issue, >= 3 ACCEPTED analyses linked to the prediction (and none of its linked analyses
--    rejected), every citation still verified and the as_of close present. Final rows are frozen except for withdrawal.
DROP TRIGGER IF EXISTS trg_pred_bu$$
CREATE TRIGGER trg_pred_bu BEFORE UPDATE ON predictions FOR EACH ROW
BEGIN
  DECLARE n INT DEFAULT 0;
  DECLARE sc, sm, sv, bmid, bsig, bp, cmid, cp DOUBLE DEFAULT 0;
  DECLARE bl JSON DEFAULT NULL;
  IF OLD.status = 'withdrawn' AND NEW.status <> 'withdrawn' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a withdrawn prediction cannot be revived (save a new version)';
  END IF;
  IF OLD.status = 'final' AND (NEW.status NOT IN ('final','withdrawn') OR NOT (NEW.report_sha256 <=> OLD.report_sha256)
      OR NOT (NEW.final_confidence <=> OLD.final_confidence)) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a final prediction is frozen (only withdrawal is allowed)';
  END IF;
  IF OLD.status IN ('reviewed','final') AND NOT (NEW.report_sha256 <=> OLD.report_sha256) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'the report of a reviewed prediction cannot be re-hashed (save a new version)';
  END IF;
  IF OLD.status = 'reviewed' AND NEW.status = 'draft' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a reviewed prediction cannot go back to draft (withdraw it and save a new version)';
  END IF;
  IF NOT (NEW.consensus_json <=> OLD.consensus_json) OR NOT (NEW.exp_return_mid <=> OLD.exp_return_mid) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'prediction numbers and consensus are immutable (save a new version)';
  END IF;
  -- draft -> reviewed needs at least one review on the current report (Validator P1 #5).
  IF NEW.status = 'reviewed' AND OLD.status <> 'reviewed' THEN
    SELECT COUNT(*) INTO n FROM reviews r WHERE r.prediction_id = NEW.id AND r.report_sha256 <=> NEW.report_sha256;
    IF n < 1 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'reviewed needs at least one review on the current report_sha256';
    END IF;
  END IF;
  IF NEW.status = 'final' AND OLD.status <> 'final' THEN
    IF NEW.report_sha256 IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'final needs report_sha256';
    END IF;
    -- the LATEST validator review on the current sha must be a pass (a later fail supersedes an earlier pass)
    SELECT COUNT(*) INTO n FROM reviews r
     WHERE r.prediction_id = NEW.id AND r.report_sha256 = NEW.report_sha256 AND r.perspective = 'validator' AND r.verdict = 'pass'
       AND r.id = (SELECT MAX(r2.id) FROM reviews r2 WHERE r2.prediction_id = NEW.id AND r2.report_sha256 = NEW.report_sha256 AND r2.perspective = 'validator');
    IF n < 1 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'final needs a validator pass as the latest validator review on the current report_sha256';
    END IF;
    SELECT COUNT(*) INTO n FROM reviews r
     WHERE r.prediction_id = NEW.id AND r.report_sha256 = NEW.report_sha256 AND r.verdict = 'fail' AND r.perspective <> 'validator'
       AND JSON_CONTAINS(JSON_EXTRACT(r.issues, '$[*].severity'), '"critical"');
    IF n > 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'final blocked: a review failed with a critical issue';
    END IF;
    IF NEW.run_id IS NULL OR NEW.consensus_json IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'final needs a run-based prediction with its stored consensus';
    END IF;
    -- >= 3 accepted analyses from DISTINCT agents of the SAME run, ticker and target month
    SELECT COUNT(DISTINCT a.agent) INTO n FROM analyses a
     WHERE a.prediction_id = NEW.id AND a.status = 'accepted' AND a.run_id = NEW.run_id AND a.ticker = NEW.ticker AND a.target_month = NEW.target_month;
    IF n < 3 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'final needs at least 3 accepted analyses from distinct agents of the same run, ticker and target month';
    END IF;
    SELECT COUNT(*) INTO n FROM analyses a
     WHERE a.prediction_id = NEW.id AND (a.status <> 'accepted' OR a.run_id <> NEW.run_id OR a.ticker <> NEW.ticker OR a.target_month <> NEW.target_month);
    IF n > 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'final blocked: a linked analysis is not accepted or belongs to another run/ticker/month';
    END IF;
    -- the linked analyses are exactly the ones the stored consensus was computed from
    SELECT COUNT(*) INTO n FROM analyses a WHERE a.prediction_id = NEW.id;
    IF n <> JSON_LENGTH(JSON_EXTRACT(NEW.consensus_json, '$.analyses')) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'final blocked: linked analyses differ from the stored consensus';
    END IF;
    SELECT COUNT(*) INTO n FROM JSON_TABLE(JSON_EXTRACT(NEW.consensus_json, '$.analyses'), '$[*]' COLUMNS (aid BIGINT UNSIGNED PATH '$.analysis_id')) j
      LEFT JOIN analyses a ON a.id = j.aid AND a.prediction_id = NEW.id AND a.status = 'accepted'
     WHERE a.id IS NULL;
    IF n > 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'final blocked: a consensus analysis is not linked and accepted';
    END IF;
    -- the pack is the run's pack for this ticker (runs.plan is immutable, trg_run_bu)
    SELECT COUNT(*) INTO n FROM runs r WHERE r.id = NEW.run_id
       AND CAST(JSON_UNQUOTE(JSON_EXTRACT(r.plan, CONCAT('$.packs.', NEW.ticker, '.pack_id'))) AS UNSIGNED) = NEW.pack_id;
    IF n <> 1 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'final blocked: pack_id is not the run''s pack for this ticker';
    END IF;
    -- recompute the consensus mid and p_up in SQL (src/quant/consensus.mjs; constants pinned to config/model.json: baseline_weight 1,
    -- overlay_max_sigma 1.5, max_p_adj 0.15, short_history sigma_floor 0.15) from the linked analyses and the pack baseline
    SELECT SUM(a.confidence), SUM(a.confidence * (a.exp_return_lo + a.exp_return_hi) / 2),
           SUM(a.confidence * CASE a.direction WHEN 'up' THEN 1 WHEN 'down' THEN -1 ELSE 0 END)
      INTO sc, sm, sv FROM analyses a WHERE a.prediction_id = NEW.id AND a.status = 'accepted';
    SELECT JSON_EXTRACT(rp.pack_json, '$.baseline') INTO bl FROM research_packs rp WHERE rp.id = NEW.pack_id;
    IF bl IS NULL OR JSON_TYPE(bl) = 'NULL' THEN
      SET bmid = 0, bsig = 0.15, bp = 0.5;
    ELSE
      SET bmid = CAST(JSON_UNQUOTE(JSON_EXTRACT(bl, '$.mid')) AS DECIMAL(14,8)),
          bsig = CAST(JSON_UNQUOTE(JSON_EXTRACT(bl, '$.sigma')) AS DECIMAL(14,8)),
          bp   = CAST(JSON_UNQUOTE(JSON_EXTRACT(bl, '$.p_up')) AS DECIMAL(14,8));
    END IF;
    SET cmid = LEAST(GREATEST((bmid + sm) / (1 + sc), bmid - 1.5 * bsig), bmid + 1.5 * bsig);
    SET cp = LEAST(GREATEST(bp + LEAST(GREATEST(0.15 * sv / (1 + sc), -0.15), 0.15), 0.01), 0.99);
    IF ABS(cmid - NEW.exp_return_mid) > 0.000002 OR ABS(cp - NEW.p_up) > 0.0001 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'final blocked: mid/p_up differ from the consensus recomputed from the linked analyses and the pack baseline';
    END IF;
    SELECT COUNT(*) INTO n FROM prediction_citations c JOIN sources s ON s.id = c.source_id
     WHERE c.prediction_id = NEW.id AND s.verification_status NOT IN ('verified','corroborated');
    IF n > 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'final blocked: a cited source is no longer verified';
    END IF;
    SELECT COUNT(*) INTO n FROM month_end_prices p WHERE p.ticker = NEW.ticker AND p.month = NEW.as_of_month;
    IF n < 1 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'final blocked: no verified close for (ticker, as_of_month)';
    END IF;
  END IF;
END$$

-- reviews BI: a review is for the prediction's CURRENT report (stale_review otherwise).
DROP TRIGGER IF EXISTS trg_rev_bi$$
CREATE TRIGGER trg_rev_bi BEFORE INSERT ON reviews FOR EACH ROW
BEGIN
  DECLARE n INT DEFAULT 0;
  SELECT COUNT(*) INTO n FROM predictions p
   WHERE p.id = NEW.prediction_id AND p.report_sha256 = NEW.report_sha256 AND p.status IN ('draft','reviewed');
  IF n <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'stale_review: report_sha256 must equal the draft/reviewed prediction''s current report_sha256';
  END IF;
  -- a validator review references the validator agent_task of the prediction's run and ticker
  IF NEW.perspective = 'validator' THEN
    SELECT COUNT(*) INTO n FROM predictions p JOIN agent_tasks t ON t.id = NEW.agent_task_id
     WHERE p.id = NEW.prediction_id AND t.agent = 'validator' AND t.run_id = p.run_id AND t.ticker <=> p.ticker;
    IF n <> 1 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a validator review must reference the validator agent_task of the prediction''s run and ticker';
    END IF;
  END IF;
END$$

-- 7. prediction_outcomes BI: actual_close is the verified close of the target month.
DROP TRIGGER IF EXISTS trg_out_bi$$
CREATE TRIGGER trg_out_bi BEFORE INSERT ON prediction_outcomes FOR EACH ROW
BEGIN
  DECLARE n INT DEFAULT 0;
  SELECT COUNT(*) INTO n FROM predictions pr JOIN month_end_prices p ON p.ticker = pr.ticker AND p.month = pr.target_month
   WHERE pr.id = NEW.prediction_id AND p.close = NEW.actual_close AND p.trade_date = NEW.actual_trade_date;
  IF n <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'actual_close/actual_trade_date must equal the verified close of the target month';
  END IF;
END$$

-- analyses BI: an analysis belongs to its run (same target month, ticker in the run) and every evidence id is a verified source.
DROP TRIGGER IF EXISTS trg_an_bi$$
CREATE TRIGGER trg_an_bi BEFORE INSERT ON analyses FOR EACH ROW
BEGIN
  DECLARE n INT DEFAULT 0;
  SELECT COUNT(*) INTO n FROM runs r
   WHERE r.id = NEW.run_id AND r.target_month = NEW.target_month AND JSON_CONTAINS(r.tickers, JSON_QUOTE(NEW.ticker));
  IF n <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'analysis must match its run (target_month and a ticker listed in runs.tickers)';
  END IF;
  IF NEW.status <> 'submitted' OR NEW.reviewed_at IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'an analysis is inserted as submitted (the validator accepts or rejects it)';
  END IF;
  SELECT COUNT(*) INTO n FROM JSON_TABLE(NEW.evidence_source_ids, '$[*]' COLUMNS (sid BIGINT UNSIGNED PATH '$')) j
    LEFT JOIN sources s ON s.id = j.sid AND s.verification_status IN ('verified','corroborated')
   WHERE s.id IS NULL;
  IF n > 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'analysis evidence_source_ids must all be verified/corroborated sources';
  END IF;
END$$

-- analyses BU: accepted needs a review timestamp and still-verified evidence; an accepted/rejected verdict is not re-opened
-- (a rejected analysis is redone as a NEW row).
DROP TRIGGER IF EXISTS trg_an_bu$$
CREATE TRIGGER trg_an_bu BEFORE UPDATE ON analyses FOR EACH ROW
BEGIN
  DECLARE n INT DEFAULT 0;
  IF OLD.status <> 'submitted' AND NEW.status <> OLD.status THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'an analysis verdict is final (redo a rejected analysis as a new analysis)';
  END IF;
  IF NEW.status = 'accepted' AND OLD.status <> 'accepted' THEN
    IF NEW.reviewed_at IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'accepted analysis needs reviewed_at';
    END IF;
    SELECT COUNT(*) INTO n FROM JSON_TABLE(NEW.evidence_source_ids, '$[*]' COLUMNS (sid BIGINT UNSIGNED PATH '$')) j
      LEFT JOIN sources s ON s.id = j.sid AND s.verification_status IN ('verified','corroborated')
     WHERE s.id IS NULL;
    IF n > 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'cannot accept an analysis whose evidence is not verified';
    END IF;
  END IF;
END$$

-- runs BU: the plan (packs per ticker, analyzers) is fixed by start_run and never changes afterwards.
DROP TRIGGER IF EXISTS trg_run_bu$$
CREATE TRIGGER trg_run_bu BEFORE UPDATE ON runs FOR EACH ROW
BEGIN
  IF OLD.plan IS NOT NULL AND NOT (NEW.plan <=> OLD.plan) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a run plan is immutable once start_run has set it';
  END IF;
END$$

-- agent_tasks BI: a task belongs to an existing OPEN run (planned/running) and, for a ticker task, to a ticker of that run;
-- one task per (run, agent, ticker) is enforced by uq_task. (Tasks are created by start_run; npm run audit flags late inserts.)
DROP TRIGGER IF EXISTS trg_task_bi$$
CREATE TRIGGER trg_task_bi BEFORE INSERT ON agent_tasks FOR EACH ROW
BEGIN
  DECLARE n INT DEFAULT 0;
  SELECT COUNT(*) INTO n FROM runs r WHERE r.id = NEW.run_id AND r.status IN ('planned','running')
     AND (NEW.ticker IS NULL OR JSON_CONTAINS(r.tickers, JSON_QUOTE(NEW.ticker)));
  IF n <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'agent task must belong to an open run (planned/running) and one of its tickers';
  END IF;
END$$

-- nyse_closures: only migrations (root) may add closures; stock_app's schema-wide INSERT must not move a month-end.
DROP TRIGGER IF EXISTS trg_closure_bi$$
CREATE TRIGGER trg_closure_bi BEFORE INSERT ON nyse_closures FOR EACH ROW
BEGIN
  IF SUBSTRING_INDEX(USER(), '@', 1) <> 'root' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'nyse_closures is maintained by npm run db:migrate only';
  END IF;
END$$

DELIMITER ;
