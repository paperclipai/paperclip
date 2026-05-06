ALTER TABLE "provider_rate_limit_blocks"
  ADD COLUMN IF NOT EXISTS "hit_count" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "provider_rate_limit_blocks"
  ADD COLUMN IF NOT EXISTS "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_rate_limit_block_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"block_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"issue_id" uuid,
	"run_id" uuid,
	"original_agent_status" text,
	"release_status" text,
	"release_reason" text,
	"wakeup_request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'provider_rate_limit_block_members_block_id_provider_rate_limit_blocks_id_fk') THEN
  ALTER TABLE "provider_rate_limit_block_members" ADD CONSTRAINT "provider_rate_limit_block_members_block_id_provider_rate_limit_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."provider_rate_limit_blocks"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'provider_rate_limit_block_members_company_id_companies_id_fk') THEN
  ALTER TABLE "provider_rate_limit_block_members" ADD CONSTRAINT "provider_rate_limit_block_members_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'provider_rate_limit_block_members_agent_id_agents_id_fk') THEN
  ALTER TABLE "provider_rate_limit_block_members" ADD CONSTRAINT "provider_rate_limit_block_members_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'provider_rate_limit_block_members_issue_id_issues_id_fk') THEN
  ALTER TABLE "provider_rate_limit_block_members" ADD CONSTRAINT "provider_rate_limit_block_members_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'provider_rate_limit_block_members_run_id_heartbeat_runs_id_fk') THEN
  ALTER TABLE "provider_rate_limit_block_members" ADD CONSTRAINT "provider_rate_limit_block_members_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "provider_rate_limit_block_members_block_agent_uq" ON "provider_rate_limit_block_members" USING btree ("block_id","agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_rate_limit_block_members_block_idx" ON "provider_rate_limit_block_members" USING btree ("block_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_rate_limit_block_members_company_agent_idx" ON "provider_rate_limit_block_members" USING btree ("company_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_wakeup_requests_idempotency_uq"
  ON "agent_wakeup_requests" USING btree ("company_id","agent_id","idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
