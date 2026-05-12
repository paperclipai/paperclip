CREATE TABLE IF NOT EXISTS "agent_capability_drift" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" uuid,
	"drift_type" text NOT NULL,
	"tool" text NOT NULL,
	"target" text NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_coverage_gaps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"gap_type" text NOT NULL,
	"detail" text NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_flagged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_capability_drift_company_id_companies_id_fk') THEN
		ALTER TABLE "agent_capability_drift" ADD CONSTRAINT "agent_capability_drift_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_capability_drift_agent_id_agents_id_fk') THEN
		ALTER TABLE "agent_capability_drift" ADD CONSTRAINT "agent_capability_drift_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_capability_drift_run_id_heartbeat_runs_id_fk') THEN
		ALTER TABLE "agent_capability_drift" ADD CONSTRAINT "agent_capability_drift_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_coverage_gaps_company_id_companies_id_fk') THEN
		ALTER TABLE "agent_coverage_gaps" ADD CONSTRAINT "agent_coverage_gaps_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_coverage_gaps_agent_id_agents_id_fk') THEN
		ALTER TABLE "agent_coverage_gaps" ADD CONSTRAINT "agent_coverage_gaps_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_capability_drift_agent_observed_idx" ON "agent_capability_drift" USING btree ("agent_id","observed_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_capability_drift_company_observed_idx" ON "agent_capability_drift" USING btree ("company_id","observed_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_capability_drift_run_idx" ON "agent_capability_drift" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_coverage_gaps_agent_gap_idx" ON "agent_coverage_gaps" USING btree ("agent_id","gap_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_coverage_gaps_company_observed_idx" ON "agent_coverage_gaps" USING btree ("company_id","observed_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_coverage_gaps_unresolved_idx" ON "agent_coverage_gaps" USING btree ("agent_id","resolved_at");
