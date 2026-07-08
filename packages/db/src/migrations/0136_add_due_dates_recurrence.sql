ALTER TABLE "issues" ADD COLUMN "due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "recurrence" jsonb;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "recurring_task_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issues" ADD CONSTRAINT "issues_recurring_task_id_issues_id_fk" FOREIGN KEY ("recurring_task_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_company_due_at_idx" ON "issues" USING btree ("company_id","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issues_company_recurring_due_at_uq" ON "issues" USING btree ("company_id","recurring_task_id","due_at") WHERE "recurring_task_id" IS NOT NULL AND "due_at" IS NOT NULL;
