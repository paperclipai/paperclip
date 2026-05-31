ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "idempotency_key" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "routines_company_assignee_idempotency_key_uq" ON "routines" USING btree ("company_id","assignee_agent_id","idempotency_key") WHERE "idempotency_key" IS NOT NULL;
