CREATE TABLE "agent_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"category" text DEFAULT 'general' NOT NULL,
	"key" text NOT NULL,
	"content" text NOT NULL,
	"importance" integer DEFAULT 5 NOT NULL,
	"source_run_id" uuid,
	"source_issue_id" uuid,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_source_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_memories_company_agent_updated_idx" ON "agent_memories" USING btree ("company_id","agent_id","updated_at");--> statement-breakpoint
CREATE INDEX "agent_memories_company_agent_category_idx" ON "agent_memories" USING btree ("company_id","agent_id","category");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_memories_company_agent_category_key_uniq" ON "agent_memories" USING btree ("company_id","agent_id","category","key");
