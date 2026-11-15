CREATE TABLE "tool_mcp_elicitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"agent_id" uuid,
	"run_id" uuid,
	"invocation_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"catalog_tool_name" text NOT NULL,
	"call_identity" text NOT NULL,
	"era" text NOT NULL,
	"sealed_request_state" text,
	"questions" jsonb NOT NULL,
	"arguments_identity" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" text NOT NULL,
	"claimed_until" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tool_mcp_elicitations" ADD CONSTRAINT "tool_mcp_elicitations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_mcp_elicitations" ADD CONSTRAINT "tool_mcp_elicitations_invocation_id_tool_invocations_id_fk" FOREIGN KEY ("invocation_id") REFERENCES "public"."tool_invocations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_mcp_elicitations" ADD CONSTRAINT "tool_mcp_elicitations_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tool_mcp_elicitations_call_idx" ON "tool_mcp_elicitations" USING btree ("company_id","issue_id","connection_id","call_identity","status");--> statement-breakpoint
CREATE INDEX "tool_mcp_elicitations_invocation_idx" ON "tool_mcp_elicitations" USING btree ("company_id","invocation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_mcp_elicitations_waiting_uq" ON "tool_mcp_elicitations" USING btree ("company_id","issue_id","dedupe_key") WHERE "tool_mcp_elicitations"."status" = 'waiting';