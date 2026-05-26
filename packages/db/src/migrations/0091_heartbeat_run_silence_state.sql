CREATE TABLE IF NOT EXISTS "heartbeat_run_silence_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"consecutive_false_positives" integer DEFAULT 0 NOT NULL,
	"backoff_multiplier" integer DEFAULT 1 NOT NULL,
	"last_evaluation_issue_id" uuid,
	"last_closed_at" timestamp with time zone,
	"next_eligible_scan_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'heartbeat_run_silence_state_company_id_companies_id_fk') THEN
		ALTER TABLE "heartbeat_run_silence_state" ADD CONSTRAINT "heartbeat_run_silence_state_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'heartbeat_run_silence_state_run_id_heartbeat_runs_id_fk') THEN
		ALTER TABLE "heartbeat_run_silence_state" ADD CONSTRAINT "heartbeat_run_silence_state_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'heartbeat_run_silence_state_last_evaluation_issue_id_issues_id_fk') THEN
		ALTER TABLE "heartbeat_run_silence_state" ADD CONSTRAINT "heartbeat_run_silence_state_last_evaluation_issue_id_issues_id_fk" FOREIGN KEY ("last_evaluation_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "heartbeat_run_silence_state_company_run_uq" ON "heartbeat_run_silence_state" USING btree ("company_id","run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_run_silence_state_next_eligible_idx" ON "heartbeat_run_silence_state" USING btree ("company_id","next_eligible_scan_at");
