-- GLA-873 / GLA-1066: company-level shared_instructions schema.
--
-- Adds:
--   * companies.shared_instructions (nullable text) — single canonical policy
--     prepended to every agent's resolved instructions file at heartbeat time.
--   * agents.shared_instructions_opt_out (boolean, default false) — per-agent
--     escape hatch (board-only write).
--   * company_shared_instructions_history — append-only audit log of every
--     write to companies.shared_instructions, with previous + new value, actor,
--     timestamp, and optional request id.
--
-- Rollback (manual; not a drizzle automatic down):
--   ALTER TABLE "companies" DROP COLUMN IF EXISTS "shared_instructions";
--   ALTER TABLE "agents" DROP COLUMN IF EXISTS "shared_instructions_opt_out";
--   DROP TABLE IF EXISTS "company_shared_instructions_history";

ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "shared_instructions" text;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "shared_instructions_opt_out" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_shared_instructions_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"actor_user_id" text,
	"actor_kind" text NOT NULL,
	"actor_ip_or_source" text,
	"previous_value" text,
	"new_value" text,
	"diff_summary" text,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_shared_instructions_history_company_id_companies_id_fk') THEN
  ALTER TABLE "company_shared_instructions_history" ADD CONSTRAINT "company_shared_instructions_history_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_shared_instructions_history_company_created_at_idx" ON "company_shared_instructions_history" USING btree ("company_id","created_at");
