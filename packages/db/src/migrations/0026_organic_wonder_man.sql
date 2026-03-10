CREATE TABLE "agent_mcp_servers" (
	"agent_id" uuid NOT NULL,
	"mcp_server_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_mcp_servers_pk" PRIMARY KEY("agent_id","mcp_server_id")
);
--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"transport_type" text DEFAULT 'stdio' NOT NULL,
	"command" text,
	"args" jsonb DEFAULT '[]'::jsonb,
	"url" text,
	"headers" jsonb DEFAULT '{}'::jsonb,
	"env" jsonb DEFAULT '{}'::jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_mcp_servers" ADD CONSTRAINT "agent_mcp_servers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_mcp_servers" ADD CONSTRAINT "agent_mcp_servers_mcp_server_id_mcp_servers_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_mcp_servers" ADD CONSTRAINT "agent_mcp_servers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_mcp_servers_agent_idx" ON "agent_mcp_servers" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_mcp_servers_mcp_server_idx" ON "agent_mcp_servers" USING btree ("mcp_server_id");--> statement-breakpoint
CREATE INDEX "agent_mcp_servers_company_idx" ON "agent_mcp_servers" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "mcp_servers_company_idx" ON "mcp_servers" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_company_name_uq" ON "mcp_servers" USING btree ("company_id","name");