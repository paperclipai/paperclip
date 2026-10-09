CREATE TABLE IF NOT EXISTS "ai_connection_pools" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"plugin_key" text NOT NULL,
	"config" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_connection_pools_company_id_uq" UNIQUE("company_id","id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_connection_router_cursors" (
	"pool_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"last_member_id" text,
	"version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_connection_task_pins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"pool_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"task_key" text NOT NULL,
	"selection" jsonb NOT NULL,
	"member" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_secrets" ADD COLUMN IF NOT EXISTS "ai_session_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "ai_connection_pools" ADD CONSTRAINT "ai_connection_pools_id_tool_connections_id_fk" FOREIGN KEY ("id") REFERENCES "public"."tool_connections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "ai_connection_pools" ADD CONSTRAINT "ai_connection_pools_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "ai_connection_pools" ADD CONSTRAINT "ai_connection_pools_company_connection_fk" FOREIGN KEY ("company_id","id") REFERENCES "public"."tool_connections"("company_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "ai_connection_router_cursors" ADD CONSTRAINT "ai_connection_router_cursors_pool_id_ai_connection_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."ai_connection_pools"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "ai_connection_router_cursors" ADD CONSTRAINT "ai_connection_router_cursors_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "ai_connection_router_cursors" ADD CONSTRAINT "ai_connection_router_cursors_company_pool_fk" FOREIGN KEY ("company_id","pool_id") REFERENCES "public"."ai_connection_pools"("company_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "ai_connection_task_pins" ADD CONSTRAINT "ai_connection_task_pins_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "ai_connection_task_pins" ADD CONSTRAINT "ai_connection_task_pins_pool_id_ai_connection_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."ai_connection_pools"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "ai_connection_task_pins" ADD CONSTRAINT "ai_connection_task_pins_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "ai_connection_task_pins" ADD CONSTRAINT "ai_connection_task_pins_company_pool_fk" FOREIGN KEY ("company_id","pool_id") REFERENCES "public"."ai_connection_pools"("company_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "ai_connection_task_pins" ADD CONSTRAINT "ai_connection_task_pins_company_agent_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_connection_task_pins_affinity_uq" ON "ai_connection_task_pins" USING btree ("company_id","pool_id","agent_id","task_key");