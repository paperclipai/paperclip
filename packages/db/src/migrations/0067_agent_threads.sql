CREATE TABLE "agent_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"archived_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_thread_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"role" text NOT NULL,
	"author_user_id" text,
	"author_agent_id" uuid,
	"producing_heartbeat_run_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_thread_reads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"last_read_message_id" uuid,
	"last_read_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "origin_thread_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "origin_thread_message_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_threads" ADD CONSTRAINT "agent_threads_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_threads" ADD CONSTRAINT "agent_threads_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_thread_messages" ADD CONSTRAINT "agent_thread_messages_thread_id_agent_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."agent_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_thread_messages" ADD CONSTRAINT "agent_thread_messages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_thread_messages" ADD CONSTRAINT "agent_thread_messages_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_thread_messages" ADD CONSTRAINT "agent_thread_messages_producing_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("producing_heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_thread_reads" ADD CONSTRAINT "agent_thread_reads_thread_id_agent_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."agent_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_thread_reads" ADD CONSTRAINT "agent_thread_reads_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_thread_reads" ADD CONSTRAINT "agent_thread_reads_last_read_message_id_agent_thread_messages_id_fk" FOREIGN KEY ("last_read_message_id") REFERENCES "public"."agent_thread_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_origin_thread_id_agent_threads_id_fk" FOREIGN KEY ("origin_thread_id") REFERENCES "public"."agent_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_origin_thread_message_id_agent_thread_messages_id_fk" FOREIGN KEY ("origin_thread_message_id") REFERENCES "public"."agent_thread_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_threads_company_agent_idx" ON "agent_threads" USING btree ("company_id","agent_id");--> statement-breakpoint
CREATE INDEX "agent_threads_company_status_last_activity_idx" ON "agent_threads" USING btree ("company_id","status","last_activity_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_threads_company_agent_active_uq" ON "agent_threads" USING btree ("company_id","agent_id") WHERE "agent_threads"."status" = 'active';--> statement-breakpoint
CREATE INDEX "agent_thread_messages_company_thread_created_at_idx" ON "agent_thread_messages" USING btree ("company_id","thread_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_thread_messages_company_run_idx" ON "agent_thread_messages" USING btree ("company_id","producing_heartbeat_run_id");--> statement-breakpoint
CREATE INDEX "agent_thread_reads_company_thread_idx" ON "agent_thread_reads" USING btree ("company_id","thread_id");--> statement-breakpoint
CREATE INDEX "agent_thread_reads_company_user_idx" ON "agent_thread_reads" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_thread_reads_company_thread_user_uq" ON "agent_thread_reads" USING btree ("company_id","thread_id","user_id");--> statement-breakpoint
CREATE INDEX "issues_company_origin_thread_idx" ON "issues" USING btree ("company_id","origin_thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_thread_messages_thread_run_uq" ON "agent_thread_messages" USING btree ("thread_id","producing_heartbeat_run_id") WHERE "agent_thread_messages"."producing_heartbeat_run_id" IS NOT NULL;
