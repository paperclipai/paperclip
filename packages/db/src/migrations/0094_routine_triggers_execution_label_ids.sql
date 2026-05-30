ALTER TABLE "routine_triggers" ADD COLUMN IF NOT EXISTS "execution_label_ids" jsonb NOT NULL DEFAULT '[]';
