CREATE TABLE IF NOT EXISTS "tool_stdio_command_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "template_key" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "status" text DEFAULT 'active' NOT NULL,
  "command" text NOT NULL,
  "args" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "env_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_by_agent_id" uuid,
  "created_by_user_id" text,
  "disabled_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_stdio_command_templates_company_id_companies_id_fk') THEN
    ALTER TABLE "tool_stdio_command_templates" ADD CONSTRAINT "tool_stdio_command_templates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_stdio_command_templates_created_by_agent_id_agents_id_fk') THEN
    ALTER TABLE "tool_stdio_command_templates" ADD CONSTRAINT "tool_stdio_command_templates_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_stdio_command_templates_company_idx" ON "tool_stdio_command_templates" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_stdio_command_templates_company_status_idx" ON "tool_stdio_command_templates" USING btree ("company_id", "status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tool_stdio_command_templates_company_key_uq" ON "tool_stdio_command_templates" USING btree ("company_id", "template_key");
