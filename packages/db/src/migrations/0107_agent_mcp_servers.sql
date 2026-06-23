CREATE TABLE IF NOT EXISTS "agent_mcp_servers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "transport" text NOT NULL,
  "config" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "env_bindings" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" text DEFAULT 'enabled' NOT NULL,
  "source_approval_id" uuid,
  "created_by_actor_type" text,
  "created_by_actor_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "disabled_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_mcp_servers" ADD CONSTRAINT "agent_mcp_servers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_mcp_servers" ADD CONSTRAINT "agent_mcp_servers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_mcp_servers_company_agent_status_idx" ON "agent_mcp_servers" USING btree ("company_id","agent_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_mcp_servers_agent_status_idx" ON "agent_mcp_servers" USING btree ("agent_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_mcp_servers_agent_name_unique" ON "agent_mcp_servers" USING btree ("company_id","agent_id","name");
