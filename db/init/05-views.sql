-- Read-side views (PLAN §2 "Views"; numbered 05 because 04 is the seed). Idempotent (CREATE OR REPLACE).
CREATE OR REPLACE SQL SECURITY INVOKER VIEW v_usable_sources AS
  SELECT s.* FROM sources s WHERE s.verification_status IN ('verified','corroborated') AND s.content_sha256 IS NOT NULL;

CREATE OR REPLACE SQL SECURITY INVOKER VIEW v_latest_prediction AS
  SELECT p.* FROM predictions p
   WHERE p.status <> 'withdrawn'
     AND p.version = (SELECT MAX(p2.version) FROM predictions p2
                       WHERE p2.ticker = p.ticker AND p2.target_month = p.target_month AND p2.status <> 'withdrawn');

CREATE OR REPLACE SQL SECURITY INVOKER VIEW v_calibration AS
  SELECT IF(GROUPING(p.ticker), 'ALL', p.ticker) AS ticker, COUNT(*) AS n_scored,
         AVG(o.direction_hit) AS hit_rate, AVG(o.brier) AS mean_brier, AVG(o.in_range) AS range_coverage,
         AVG(o.abs_error) AS mean_abs_error
    FROM prediction_outcomes o JOIN predictions p ON p.id = o.prediction_id
   WHERE p.status = 'final'
   GROUP BY p.ticker WITH ROLLUP;
