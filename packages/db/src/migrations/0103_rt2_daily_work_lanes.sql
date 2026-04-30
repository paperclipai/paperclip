ALTER TABLE "rt2_v33_daily_report_cards"
  DROP CONSTRAINT IF EXISTS "rt2_v33_daily_report_cards_lane_check";

UPDATE "rt2_v33_daily_report_cards"
SET "lane" = CASE "lane"
  WHEN 'today' THEN 'todo'
  WHEN 'support_1' THEN 'doing'
  WHEN 'support_2' THEN 'done'
  ELSE "lane"
END
WHERE "lane" IN ('today', 'support_1', 'support_2');

ALTER TABLE "rt2_v33_daily_report_cards"
  ADD CONSTRAINT "rt2_v33_daily_report_cards_lane_check"
  CHECK ("lane" IN ('todo', 'doing', 'done'));
