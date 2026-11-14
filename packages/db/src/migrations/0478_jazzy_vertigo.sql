CREATE TABLE "tool_mcp_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"invocation_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"agent_id" uuid,
	"issue_id" uuid,
	"run_id" uuid,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"responsible_user_id" text,
	"identity_context_id" uuid,
	"catalog_tool_name" text NOT NULL,
	"request_hash" text NOT NULL,
	"endpoint_hash" text NOT NULL,
	"sealed_caller_headers" text,
	"protocol_version" text NOT NULL,
	"sealed_provider_task_id" text NOT NULL,
	"provider_task_id_hash" text NOT NULL,
	"status" text NOT NULL,
	"poll_interval_ms" integer,
	"ttl_ms" integer,
	"expires_at" timestamp with time zone NOT NULL,
	"next_poll_at" timestamp with time zone,
	"last_polled_at" timestamp with time zone,
	"poll_failures" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"lease_owner" text,
	"arguments_identity" text NOT NULL,
	"answered_input_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"surfaced_input_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input_wake_count" integer DEFAULT 0 NOT NULL,
	"input_wake_at" timestamp with time zone,
	"error_code" text,
	"wake_requested_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"last_invocation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tool_mcp_tasks" ADD CONSTRAINT "tool_mcp_tasks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_mcp_tasks" ADD CONSTRAINT "tool_mcp_tasks_invocation_id_tool_invocations_id_fk" FOREIGN KEY ("invocation_id") REFERENCES "public"."tool_invocations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_mcp_tasks" ADD CONSTRAINT "tool_mcp_tasks_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tool_mcp_tasks_provider_task_uq" ON "tool_mcp_tasks" USING btree ("company_id","connection_id","provider_task_id_hash");--> statement-breakpoint
CREATE INDEX "tool_mcp_tasks_attach_idx" ON "tool_mcp_tasks" USING btree ("company_id","connection_id","request_hash");--> statement-breakpoint
CREATE INDEX "tool_mcp_tasks_invocation_idx" ON "tool_mcp_tasks" USING btree ("company_id","invocation_id");--> statement-breakpoint
CREATE INDEX "tool_mcp_tasks_next_poll_idx" ON "tool_mcp_tasks" USING btree ("next_poll_at") WHERE "tool_mcp_tasks"."next_poll_at" is not null;