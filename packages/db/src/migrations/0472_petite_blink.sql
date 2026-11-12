CREATE TABLE "tool_mcp_app_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"invocation_id" uuid,
	"issue_id" uuid,
	"run_id" uuid,
	"agent_id" uuid,
	"responsible_user_id" text,
	"connection_id" uuid NOT NULL,
	"catalog_entry_id" uuid,
	"application_name" text NOT NULL,
	"tool_name" text NOT NULL,
	"upstream_tool_name" text NOT NULL,
	"resource_uri" text NOT NULL,
	"tool_input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tool_result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tool_catalog_entries" ADD COLUMN "ui_meta" jsonb;--> statement-breakpoint
ALTER TABLE "tool_mcp_app_views" ADD CONSTRAINT "tool_mcp_app_views_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_mcp_app_views" ADD CONSTRAINT "tool_mcp_app_views_invocation_id_tool_invocations_id_fk" FOREIGN KEY ("invocation_id") REFERENCES "public"."tool_invocations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_mcp_app_views" ADD CONSTRAINT "tool_mcp_app_views_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_mcp_app_views" ADD CONSTRAINT "tool_mcp_app_views_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_mcp_app_views" ADD CONSTRAINT "tool_mcp_app_views_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_mcp_app_views" ADD CONSTRAINT "tool_mcp_app_views_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_mcp_app_views" ADD CONSTRAINT "tool_mcp_app_views_catalog_entry_id_tool_catalog_entries_id_fk" FOREIGN KEY ("catalog_entry_id") REFERENCES "public"."tool_catalog_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tool_mcp_app_views_issue_idx" ON "tool_mcp_app_views" USING btree ("company_id","issue_id","created_at");--> statement-breakpoint
CREATE INDEX "tool_mcp_app_views_connection_idx" ON "tool_mcp_app_views" USING btree ("connection_id");