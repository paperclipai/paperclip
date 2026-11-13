ALTER TABLE "decision_training_examples"
  ADD COLUMN IF NOT EXISTS "retention_policy" text DEFAULT 'scrub_deleted_comments_v1' NOT NULL;
