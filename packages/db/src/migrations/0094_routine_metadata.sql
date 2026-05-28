ALTER TABLE "routines" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;
