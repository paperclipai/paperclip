CREATE TABLE "split_test_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"primary_run_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"model" text NOT NULL,
	"adapter_type" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"prompt" text,
	"summary" text,
	"usage_json" jsonb,
	"cost_usd" numeric(12, 6),
	"log_content" text,
	"error" text,
	"judge_analysis" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "split_test_runs" ADD CONSTRAINT "split_test_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "split_test_runs" ADD CONSTRAINT "split_test_runs_primary_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("primary_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "split_test_runs" ADD CONSTRAINT "split_test_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "split_test_runs_primary_run_idx" ON "split_test_runs" USING btree ("primary_run_id");
--> statement-breakpoint
CREATE INDEX "split_test_runs_company_agent_idx" ON "split_test_runs" USING btree ("company_id","agent_id");
