DO $$ BEGIN
	ALTER TABLE "budget_policies" ADD COLUMN "thresholds" jsonb;
EXCEPTION
	WHEN duplicate_column THEN NULL;
END $$;
