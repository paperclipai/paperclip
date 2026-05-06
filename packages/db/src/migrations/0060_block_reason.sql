ALTER TABLE "issues" ADD COLUMN "block_reason" text;
--> statement-breakpoint
UPDATE "issues" i
SET block_reason = CASE
  WHEN EXISTS (
    SELECT 1 FROM issue_relations ir
    WHERE ir.related_issue_id = i.id
    AND ir.type = 'blocks'
  ) THEN 'upstream'
  ELSE 'manual'
END
WHERE i.status = 'blocked';
