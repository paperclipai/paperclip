ALTER TABLE issues
ADD COLUMN IF NOT EXISTS productivity_review_snoozed_until timestamp with time zone;

CREATE INDEX IF NOT EXISTS issues_productivity_review_snooze_idx
ON issues (productivity_review_snoozed_until)
WHERE productivity_review_snoozed_until IS NOT NULL;
