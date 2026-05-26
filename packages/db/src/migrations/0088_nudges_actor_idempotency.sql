DROP INDEX IF EXISTS "nudges_company_idempotency_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "nudges_company_actor_idempotency_uq" ON "nudges" USING btree ("company_id","actor_agent_id","idempotency_key");
