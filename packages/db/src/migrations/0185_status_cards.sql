CREATE TABLE "status_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_by_user_id" text,
	"created_by_agent_id" uuid,
	"title" text,
	"title_pinned" boolean DEFAULT false NOT NULL,
	"interest_prompt" text NOT NULL,
	"queries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"query_version" integer DEFAULT 0 NOT NULL,
	"query_compiled_at" timestamp with time zone,
	"query_compiled_by_agent_id" uuid,
	"instructions_mode" text DEFAULT 'none' NOT NULL,
	"instructions" text,
	"refresh_policy" jsonb NOT NULL,
	"state" text DEFAULT 'compiling' NOT NULL,
	"pending_change_count" integer DEFAULT 0 NOT NULL,
	"last_change_at" timestamp with time zone,
	"fingerprint" jsonb,
	"fingerprint_at" timestamp with time zone,
	"document_id" uuid,
	"last_update_run_kind" text,
	"last_generated_at" timestamp with time zone,
	"last_model" text,
	"generating_issue_id" uuid,
	"failure_reason" text,
	"next_eval_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"archived_by_user_id" text,
	"archived_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "status_card_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"trigger" text NOT NULL,
	"generation_issue_id" uuid,
	"run_id" uuid,
	"changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"model" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text NOT NULL,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "status_cards" ADD CONSTRAINT "status_cards_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "status_cards" ADD CONSTRAINT "status_cards_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "status_cards" ADD CONSTRAINT "status_cards_query_compiled_by_agent_id_agents_id_fk" FOREIGN KEY ("query_compiled_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "status_cards" ADD CONSTRAINT "status_cards_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "status_cards" ADD CONSTRAINT "status_cards_generating_issue_id_issues_id_fk" FOREIGN KEY ("generating_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "status_cards" ADD CONSTRAINT "status_cards_archived_by_agent_id_agents_id_fk" FOREIGN KEY ("archived_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "status_card_updates" ADD CONSTRAINT "status_card_updates_card_id_status_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."status_cards"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "status_card_updates" ADD CONSTRAINT "status_card_updates_generation_issue_id_issues_id_fk" FOREIGN KEY ("generation_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "status_card_updates" ADD CONSTRAINT "status_card_updates_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "status_cards_company_archived_idx" ON "status_cards" USING btree ("company_id","archived_at");
--> statement-breakpoint
CREATE INDEX "status_cards_company_next_eval_idx" ON "status_cards" USING btree ("company_id","next_eval_at");
--> statement-breakpoint
CREATE INDEX "status_card_updates_card_started_idx" ON "status_card_updates" USING btree ("card_id","started_at");
