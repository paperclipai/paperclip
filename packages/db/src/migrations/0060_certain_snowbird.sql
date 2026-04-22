CREATE TABLE "mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"transport" text NOT NULL,
	"command" text,
	"args" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cwd" text,
	"url" text,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"env" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_health_status" text DEFAULT 'unknown' NOT NULL,
	"last_healthcheck_at" timestamp with time zone,
	"last_discovery_at" timestamp with time zone,
	"last_error" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_servers_company_idx" ON "mcp_servers" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "mcp_servers_company_enabled_idx" ON "mcp_servers" USING btree ("company_id","enabled");--> statement-breakpoint
CREATE INDEX "mcp_servers_company_transport_idx" ON "mcp_servers" USING btree ("company_id","transport");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_company_slug_uq" ON "mcp_servers" USING btree ("company_id","slug");
