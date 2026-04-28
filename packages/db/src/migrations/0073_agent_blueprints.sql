CREATE TABLE "agent_blueprints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"role" text DEFAULT 'general' NOT NULL,
	"title" text,
	"icon" text,
	"capabilities" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"adapter_type" text DEFAULT 'process' NOT NULL,
	"adapter_config" jsonb DEFAULT '{}' NOT NULL,
	"runtime_config" jsonb DEFAULT '{}' NOT NULL,
	"budget_monthly_cents" integer DEFAULT 0 NOT NULL,
	"permissions" jsonb DEFAULT '{}' NOT NULL,
	"instructions_content" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "agent_blueprints_role_idx" ON "agent_blueprints" USING btree ("role");
--> statement-breakpoint
CREATE INDEX "agent_blueprints_name_idx" ON "agent_blueprints" USING btree ("name");
