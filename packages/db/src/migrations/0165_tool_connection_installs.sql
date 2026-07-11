CREATE TABLE "tool_connection_installs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "connection_id" uuid NOT NULL,
  "target_type" text NOT NULL,
  "target_id" text NOT NULL,
  "created_by_agent_id" uuid,
  "created_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "tool_connection_installs_target_type_check" CHECK ("target_type" in ('company', 'agent'))
);
--> statement-breakpoint
ALTER TABLE "tool_connection_installs" ADD CONSTRAINT "tool_connection_installs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tool_connection_installs" ADD CONSTRAINT "tool_connection_installs_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tool_connection_installs" ADD CONSTRAINT "tool_connection_installs_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "tool_connection_installs_company_target_idx" ON "tool_connection_installs" USING btree ("company_id","target_type","target_id");
--> statement-breakpoint
CREATE INDEX "tool_connection_installs_connection_idx" ON "tool_connection_installs" USING btree ("company_id","connection_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "tool_connection_installs_target_uq" ON "tool_connection_installs" USING btree ("company_id","connection_id","target_type","target_id");
