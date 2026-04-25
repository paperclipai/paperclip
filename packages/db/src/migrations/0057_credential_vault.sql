ALTER TABLE "company_secrets" ADD COLUMN IF NOT EXISTS "allowed_agent_roles" text[] NOT NULL DEFAULT '{}';
ALTER TABLE "company_secrets" ADD COLUMN IF NOT EXISTS "allowed_agent_ids" uuid[] NOT NULL DEFAULT '{}';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_secrets_allowed_roles_idx" ON "company_secrets" USING gin ("allowed_agent_roles");
CREATE INDEX IF NOT EXISTS "company_secrets_allowed_agent_ids_idx" ON "company_secrets" USING gin ("allowed_agent_ids");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "secret_access_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "secret_id" uuid NOT NULL REFERENCES "company_secrets"("id") ON DELETE CASCADE,
  "secret_name" text NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "actor_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "actor_role" text,
  "access_granted" boolean NOT NULL DEFAULT false,
  "denial_reason" text,
  "created_at" timestamptz NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "secret_access_log_secret_id_idx" ON "secret_access_log" USING btree ("secret_id");
CREATE INDEX IF NOT EXISTS "secret_access_log_company_id_idx" ON "secret_access_log" USING btree ("company_id");
CREATE INDEX IF NOT EXISTS "secret_access_log_created_at_idx" ON "secret_access_log" USING btree ("created_at" DESC);
CREATE INDEX IF NOT EXISTS "secret_access_log_pending_flush_idx" ON "secret_access_log" USING btree ("created_at" ASC) WHERE "access_granted" = true;