CREATE TABLE IF NOT EXISTS "agent_memories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "type" text DEFAULT 'semantic' NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "confidence" integer DEFAULT 0 NOT NULL,
  "tags" text[] NOT NULL DEFAULT '{}',
  "source_run_id" uuid,
  "source_issue_id" uuid,
  "source_comment_id" uuid,
  "recall_count" integer DEFAULT 0 NOT NULL,
  "last_recalled_at" timestamp with time zone,
  "supersedes_memory_id" uuid,
  "superseded_by_memory_id" uuid,
  "created_by_actor_type" text,
  "created_by_actor_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "forgotten_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_memory_consolidation_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "status" text DEFAULT 'running' NOT NULL,
  "ingested" integer DEFAULT 0 NOT NULL,
  "staged" integer DEFAULT 0 NOT NULL,
  "promoted" integer DEFAULT 0 NOT NULL,
  "forgotten" integer DEFAULT 0 NOT NULL,
  "cost_cents" integer DEFAULT 0 NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_supersedes_memory_id_agent_memories_id_fk" FOREIGN KEY ("supersedes_memory_id") REFERENCES "public"."agent_memories"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_superseded_by_memory_id_agent_memories_id_fk" FOREIGN KEY ("superseded_by_memory_id") REFERENCES "public"."agent_memories"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_memory_consolidation_runs" ADD CONSTRAINT "agent_memory_consolidation_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_memory_consolidation_runs" ADD CONSTRAINT "agent_memory_consolidation_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_memories_company_agent_status_idx" ON "agent_memories" USING btree ("company_id","agent_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_memories_agent_type_status_idx" ON "agent_memories" USING btree ("agent_id","type","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_memories_agent_updated_idx" ON "agent_memories" USING btree ("agent_id","updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_memories_tags_idx" ON "agent_memories" USING gin ("tags");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_memory_consolidation_company_agent_started_idx" ON "agent_memory_consolidation_runs" USING btree ("company_id","agent_id","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_memory_consolidation_agent_started_idx" ON "agent_memory_consolidation_runs" USING btree ("agent_id","started_at");
