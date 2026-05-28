-- Migration: 0090_agent_delegate_grants
-- Creates the agent_delegate_grants table for the multi-company agent delegate model.
-- PRO-5933 | Design: https://outline.production.city/doc/design-multi-company-agent-delegate-model-option-3-KaqMgMU07n
--
-- Data Retention Policy (GC Condition 3, PRO-5927):
--   Revoked rows are retained for 90 days after revoked_at, then eligible for purge.
--   cleanup_eligible_at is a generated column equal to (revoked_at + INTERVAL '90 days').
--   Purge query (for a scheduled maintenance job):
--     DELETE FROM agent_delegate_grants
--     WHERE revoked_at IS NOT NULL
--       AND cleanup_eligible_at < NOW();

CREATE TABLE IF NOT EXISTS "agent_delegate_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "host_company_id" uuid NOT NULL,
  "delegate_agent_id" uuid NOT NULL,
  "delegate_company_id" uuid NOT NULL,
  "scopes" text[] NOT NULL DEFAULT ARRAY['read'::text, 'write'::text],
  "granted_by_user_id" text NOT NULL,
  "expires_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "revoked_by_user_id" text,
  "cleanup_eligible_at" timestamp with time zone GENERATED ALWAYS AS (revoked_at + INTERVAL '90 days') STORED,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_delegate_grants_host_company_id_companies_id_fk') THEN
    ALTER TABLE "agent_delegate_grants" ADD CONSTRAINT "agent_delegate_grants_host_company_id_companies_id_fk" FOREIGN KEY ("host_company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_delegate_grants_delegate_agent_id_agents_id_fk') THEN
    ALTER TABLE "agent_delegate_grants" ADD CONSTRAINT "agent_delegate_grants_delegate_agent_id_agents_id_fk" FOREIGN KEY ("delegate_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_delegate_grants_active_host_delegate_uq" ON "agent_delegate_grants" USING btree ("host_company_id","delegate_agent_id") WHERE "agent_delegate_grants"."revoked_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_delegate_grants_delegate_agent_idx" ON "agent_delegate_grants" USING btree ("delegate_agent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_delegate_grants_host_created_idx" ON "agent_delegate_grants" USING btree ("host_company_id","created_at");
