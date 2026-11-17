CREATE TABLE IF NOT EXISTS "chat_completion_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"status_version" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"target_run_id" uuid,
	"response_comment_id" uuid,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_task_handoffs" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"session_generation" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "chat_completion_deliveries" ADD CONSTRAINT "chat_completion_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "chat_completion_deliveries" ADD CONSTRAINT "chat_completion_deliveries_task_id_chat_task_handoffs_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."chat_task_handoffs"("task_id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "chat_completion_deliveries" ADD CONSTRAINT "chat_completion_deliveries_target_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("target_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "chat_completion_deliveries" ADD CONSTRAINT "chat_completion_deliveries_response_comment_id_issue_comments_id_fk" FOREIGN KEY ("response_comment_id") REFERENCES "public"."issue_comments"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "chat_task_handoffs" ADD CONSTRAINT "chat_task_handoffs_task_id_issues_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "chat_task_handoffs" ADD CONSTRAINT "chat_task_handoffs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "chat_task_handoffs" ADD CONSTRAINT "chat_task_handoffs_conversation_id_issues_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "chat_task_handoffs" ADD CONSTRAINT "chat_task_handoffs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_completion_deliveries_transition_uq" ON "chat_completion_deliveries" USING btree ("task_id","status_version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_completion_deliveries_pending_idx" ON "chat_completion_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_task_handoffs_source_idx" ON "chat_task_handoffs" USING btree ("company_id","conversation_id");--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations are transactional, so CONCURRENTLY is unavailable. This new key namespace has no existing matches; the partial unique index is required for atomic completion wake deduplication. The one-time table scan takes a write lock.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_wakeup_requests_chat_completion_uq" ON "agent_wakeup_requests" USING btree ("company_id","idempotency_key") WHERE "agent_wakeup_requests"."idempotency_key" LIKE 'chat-completion:%';