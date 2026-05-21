CREATE TABLE "company_tools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"source" text NOT NULL,
	"adapter" text NOT NULL,
	"server_key" text,
	"tool_name" text,
	"risk" text DEFAULT 'read' NOT NULL,
	"supported_modes" jsonb DEFAULT '["off","read"]'::jsonb NOT NULL,
	"render" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_tool_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"tool_id" uuid NOT NULL,
	"mode" text DEFAULT 'off' NOT NULL,
	"granted_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_tools" ADD CONSTRAINT "company_tools_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_tool_grants" ADD CONSTRAINT "agent_tool_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_tool_grants" ADD CONSTRAINT "agent_tool_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_tool_grants" ADD CONSTRAINT "agent_tool_grants_tool_id_company_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."company_tools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "company_tools_company_key_idx" ON "company_tools" USING btree ("company_id","key");
--> statement-breakpoint
CREATE INDEX "company_tools_company_source_idx" ON "company_tools" USING btree ("company_id","source");
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_tool_grants_agent_tool_idx" ON "agent_tool_grants" USING btree ("agent_id","tool_id");
--> statement-breakpoint
CREATE INDEX "agent_tool_grants_company_agent_idx" ON "agent_tool_grants" USING btree ("company_id","agent_id");
