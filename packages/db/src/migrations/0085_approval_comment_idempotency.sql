ALTER TABLE "approval_comments" ADD COLUMN IF NOT EXISTS "created_by_run_id" uuid;
--> statement-breakpoint
ALTER TABLE "approval_comments" ADD COLUMN IF NOT EXISTS "idempotency_key" text;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "approval_comments" ADD CONSTRAINT "approval_comments_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "approval_comments_idempotency_key_uq"
  ON "approval_comments" USING btree ("idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
