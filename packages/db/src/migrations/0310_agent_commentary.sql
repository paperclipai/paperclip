-- Internal feedback only; no backfill or external delivery.
CREATE TABLE IF NOT EXISTS "agent_commentary" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"issue_id" uuid,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_commentary_kind_check" CHECK ("agent_commentary"."kind" in ('complaint', 'suggestion'))
);
--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "agent_commentary" ADD CONSTRAINT "agent_commentary_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "agent_commentary" ADD CONSTRAINT "agent_commentary_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "agent_commentary" ADD CONSTRAINT "agent_commentary_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "agent_commentary" ADD CONSTRAINT "agent_commentary_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_commentary_run_key_uq" ON "agent_commentary" USING btree ("company_id","run_id","idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_commentary_company_kind_created_idx" ON "agent_commentary" USING btree ("company_id","kind","created_at");
