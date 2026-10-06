CREATE TABLE "tool_mcp_connectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"enrollment_token_hash" text,
	"enrollment_expires_at" timestamp with time zone,
	"enrollment_used_at" timestamp with time zone,
	"credential_hash" text,
	"credential_rotated_at" timestamp with time zone,
	"version" text,
	"upstreams" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_seen_at" timestamp with time zone,
	"last_connected_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_mcp_connectors_status_check" CHECK ("tool_mcp_connectors"."status" in ('pending', 'active', 'revoked'))
);
--> statement-breakpoint
ALTER TABLE "tool_connections" DROP CONSTRAINT IF EXISTS "tool_connections_transport_check";--> statement-breakpoint
ALTER TABLE "tool_mcp_connectors" ADD CONSTRAINT "tool_mcp_connectors_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tool_mcp_connectors_company_idx" ON "tool_mcp_connectors" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_mcp_connectors_company_name_uq" ON "tool_mcp_connectors" USING btree ("company_id","name");--> statement-breakpoint
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_transport_check" CHECK ("tool_connections"."transport" in ('mcp_remote', 'connector', 'rest_api', 'local_stdio', 'chat_sdk', 'runtime_auth'));