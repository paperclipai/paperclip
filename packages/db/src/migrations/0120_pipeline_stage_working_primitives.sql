UPDATE "pipeline_stages"
SET "kind" = 'working'
WHERE "kind" = 'open';--> statement-breakpoint

ALTER TABLE "pipeline_stages" DROP CONSTRAINT IF EXISTS "pipeline_stages_kind_check";--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'pipeline_stages_kind_check'
      AND conrelid = '"pipeline_stages"'::regclass
  ) THEN
    ALTER TABLE "pipeline_stages"
      ADD CONSTRAINT "pipeline_stages_kind_check"
      CHECK ("pipeline_stages"."kind" in ('working', 'review', 'done', 'cancelled'));
  END IF;
END $$;
