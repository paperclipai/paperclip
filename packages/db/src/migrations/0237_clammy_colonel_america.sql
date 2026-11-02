CREATE TABLE "managed_agent_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"profile_key" text NOT NULL,
	"display_name" text NOT NULL,
	"service" text DEFAULT 'anthropic_managed_agents' NOT NULL,
	"anthropic_agent_id" text NOT NULL,
	"agent_version" text NOT NULL,
	"environment_id" text NOT NULL,
	"beta_version" text DEFAULT 'managed-agents-2026-04-01' NOT NULL,
	"default_model" text DEFAULT 'claude-sonnet-5' NOT NULL,
	"default_max_list_cost_cents" integer DEFAULT 100 NOT NULL,
	"api_key_secret_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"retention_acknowledged" boolean DEFAULT false NOT NULL,
	"qualification" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"qualified_at" timestamp with time zone,
	"qualified_revision" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_agent_profiles_service_check" CHECK ("managed_agent_profiles"."service" = 'anthropic_managed_agents'),
	CONSTRAINT "managed_agent_profiles_beta_check" CHECK ("managed_agent_profiles"."beta_version" = 'managed-agents-2026-04-01'),
	CONSTRAINT "managed_agent_profiles_positive_budget_check" CHECK ("managed_agent_profiles"."default_max_list_cost_cents" > 0),
	CONSTRAINT "managed_agent_profiles_qualified_revision_check" CHECK (("managed_agent_profiles"."qualified_at" IS NULL AND "managed_agent_profiles"."qualified_revision" IS NULL) OR ("managed_agent_profiles"."qualified_at" IS NOT NULL AND "managed_agent_profiles"."qualification" <> '{}'::jsonb AND "managed_agent_profiles"."qualified_revision" ~ '^sha256:[0-9a-f]{64}$'))
);
--> statement-breakpoint
CREATE TABLE "remote_agent_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"profile_key" text NOT NULL,
	"display_name" text NOT NULL,
	"service" text NOT NULL,
	"configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"retention_acknowledged" boolean DEFAULT false NOT NULL,
	"qualification" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"qualified_at" timestamp with time zone,
	"qualified_revision" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "remote_agent_profiles_service_check" CHECK ("remote_agent_profiles"."service" = 'aws_bedrock_agentcore_harness'),
	CONSTRAINT "remote_agent_profiles_qualified_revision_check" CHECK (("remote_agent_profiles"."qualified_at" IS NULL AND "remote_agent_profiles"."qualified_revision" IS NULL) OR ("remote_agent_profiles"."qualified_at" IS NOT NULL AND "remote_agent_profiles"."qualification" <> '{}'::jsonb AND "remote_agent_profiles"."qualified_revision" ~ '^sha256:[0-9a-f]{64}$'))
);
--> statement-breakpoint
ALTER TABLE "managed_agent_profiles" ADD CONSTRAINT "managed_agent_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_agent_profiles" ADD CONSTRAINT "managed_agent_profiles_api_key_secret_id_company_secrets_id_fk" FOREIGN KEY ("api_key_secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_agent_profiles" ADD CONSTRAINT "remote_agent_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "managed_agent_profiles_company_idx" ON "managed_agent_profiles" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_agent_profiles_company_key_uq" ON "managed_agent_profiles" USING btree ("company_id","profile_key");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_agent_profiles_company_resource_uq" ON "managed_agent_profiles" USING btree ("company_id","anthropic_agent_id","agent_version","environment_id");--> statement-breakpoint
CREATE INDEX "remote_agent_profiles_company_idx" ON "remote_agent_profiles" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "remote_agent_profiles_company_key_uq" ON "remote_agent_profiles" USING btree ("company_id","profile_key");