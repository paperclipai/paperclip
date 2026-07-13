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
	"credential_secret_ref" text,
	"enabled" boolean DEFAULT false NOT NULL,
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
--> statement-breakpoint
CREATE TABLE "agent_mcp_servers" (
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"mcp_server_id" uuid NOT NULL,
	"binding_mode" text DEFAULT 'allowed' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"allowed_tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_mcp_servers_pk" PRIMARY KEY("agent_id","mcp_server_id")
);
--> statement-breakpoint
ALTER TABLE "agent_mcp_servers" ADD CONSTRAINT "agent_mcp_servers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_mcp_servers" ADD CONSTRAINT "agent_mcp_servers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_mcp_servers" ADD CONSTRAINT "agent_mcp_servers_mcp_server_id_mcp_servers_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_mcp_servers" ADD CONSTRAINT "agent_mcp_servers_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_mcp_servers_company_idx" ON "agent_mcp_servers" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "agent_mcp_servers_agent_idx" ON "agent_mcp_servers" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_mcp_servers_mcp_server_idx" ON "agent_mcp_servers" USING btree ("mcp_server_id");--> statement-breakpoint
CREATE INDEX "agent_mcp_servers_company_enabled_idx" ON "agent_mcp_servers" USING btree ("company_id","enabled");--> statement-breakpoint
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