CREATE TABLE "mcp_server_catalog_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"mcp_server_id" uuid NOT NULL,
	"status" text DEFAULT 'succeeded' NOT NULL,
	"protocol_version" text,
	"server_name" text,
	"server_version" text,
	"summary" text,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"prompts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"server_info" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_server_catalog_snapshots" ADD CONSTRAINT "mcp_server_catalog_snapshots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server_catalog_snapshots" ADD CONSTRAINT "mcp_server_catalog_snapshots_mcp_server_id_mcp_servers_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server_catalog_snapshots" ADD CONSTRAINT "mcp_server_catalog_snapshots_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_server_catalog_snapshots_company_idx" ON "mcp_server_catalog_snapshots" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "mcp_server_catalog_snapshots_server_idx" ON "mcp_server_catalog_snapshots" USING btree ("mcp_server_id");--> statement-breakpoint
CREATE INDEX "mcp_server_catalog_snapshots_status_idx" ON "mcp_server_catalog_snapshots" USING btree ("status");--> statement-breakpoint
CREATE INDEX "mcp_server_catalog_snapshots_server_created_idx" ON "mcp_server_catalog_snapshots" USING btree ("mcp_server_id","created_at");