-- Migrate existing 'acknowledged' review_state to 'approved'
-- and add support for 'denied' and 'pending_review' states.
UPDATE "qsl_findings"
  SET "review_state" = 'approved'
  WHERE "review_state" = 'acknowledged';
