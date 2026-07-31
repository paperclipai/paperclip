ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "env" jsonb;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN IF NOT EXISTS "routine_revision_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routine_runs_routine_revision_id_routine_revisions_id_fk') THEN
    ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_routine_revision_id_routine_revisions_id_fk" FOREIGN KEY ("routine_revision_id") REFERENCES "public"."routine_revisions"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routine_runs_revision_idx" ON "routine_runs" USING btree ("routine_revision_id");
