CREATE TABLE IF NOT EXISTS "user_secret_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"provider" text DEFAULT 'local_encrypted' NOT NULL,
	"managed_mode" text DEFAULT 'paperclip_managed' NOT NULL,
	"provider_config_id" uuid,
	"provider_metadata" jsonb,
	"usage_guidance" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"updated_by_agent_id" uuid,
	"updated_by_user_id" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_secret_declarations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_secret_definition_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"config_path" text NOT NULL,
	"env_key" text NOT NULL,
	"version_selector" text DEFAULT 'latest' NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"allow_missing_override" boolean DEFAULT false NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_secrets" ADD COLUMN IF NOT EXISTS "scope" text DEFAULT 'company' NOT NULL;
--> statement-breakpoint
ALTER TABLE "company_secrets" ADD COLUMN IF NOT EXISTS "owner_user_id" text;
--> statement-breakpoint
ALTER TABLE "company_secrets" ADD COLUMN IF NOT EXISTS "user_secret_definition_id" uuid;
--> statement-breakpoint
UPDATE "company_secrets"
SET "scope" = 'company'
WHERE "scope" IS NULL;
--> statement-breakpoint
ALTER TABLE "secret_access_events" ALTER COLUMN "secret_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "secret_access_events" ADD COLUMN IF NOT EXISTS "user_secret_definition_id" uuid;
--> statement-breakpoint
ALTER TABLE "secret_access_events" ADD COLUMN IF NOT EXISTS "secret_scope" text DEFAULT 'company' NOT NULL;
--> statement-breakpoint
ALTER TABLE "secret_access_events" ADD COLUMN IF NOT EXISTS "responsible_user_id" text;
--> statement-breakpoint
ALTER TABLE "secret_access_events" ADD COLUMN IF NOT EXISTS "credential_owner_user_id" text;
--> statement-breakpoint
ALTER TABLE "secret_access_events" ADD COLUMN IF NOT EXISTS "credential_subject_type" text;
--> statement-breakpoint
ALTER TABLE "secret_access_events" ADD COLUMN IF NOT EXISTS "credential_subject_id" text;
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "responsible_user_id" text;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "responsible_user_id" text;
--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "responsible_user_id" text;
--> statement-breakpoint
ALTER TABLE "routine_revisions" ADD COLUMN IF NOT EXISTS "responsible_user_id" text;
--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN IF NOT EXISTS "responsible_user_id" text;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_secret_definitions_company_id_companies_id_fk') THEN
		ALTER TABLE "user_secret_definitions" ADD CONSTRAINT "user_secret_definitions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_secret_definitions_provider_config_id_company_secret_provider_configs_id_fk') THEN
		ALTER TABLE "user_secret_definitions" ADD CONSTRAINT "user_secret_definitions_provider_config_id_company_secret_provider_configs_id_fk" FOREIGN KEY ("provider_config_id") REFERENCES "public"."company_secret_provider_configs"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_secret_definitions_created_by_agent_id_agents_id_fk') THEN
		ALTER TABLE "user_secret_definitions" ADD CONSTRAINT "user_secret_definitions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_secret_definitions_updated_by_agent_id_agents_id_fk') THEN
		ALTER TABLE "user_secret_definitions" ADD CONSTRAINT "user_secret_definitions_updated_by_agent_id_agents_id_fk" FOREIGN KEY ("updated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_secret_declarations_company_id_companies_id_fk') THEN
		ALTER TABLE "user_secret_declarations" ADD CONSTRAINT "user_secret_declarations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_secret_declarations_user_secret_definition_id_user_secret_definitions_id_fk') THEN
		ALTER TABLE "user_secret_declarations" ADD CONSTRAINT "user_secret_declarations_user_secret_definition_id_user_secret_definitions_id_fk" FOREIGN KEY ("user_secret_definition_id") REFERENCES "public"."user_secret_definitions"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_secrets_user_secret_definition_id_user_secret_definitions_id_fk') THEN
		ALTER TABLE "company_secrets" ADD CONSTRAINT "company_secrets_user_secret_definition_id_user_secret_definitions_id_fk" FOREIGN KEY ("user_secret_definition_id") REFERENCES "public"."user_secret_definitions"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'secret_access_events_user_secret_definition_id_user_secret_definitions_id_fk') THEN
		ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_user_secret_definition_id_user_secret_definitions_id_fk" FOREIGN KEY ("user_secret_definition_id") REFERENCES "public"."user_secret_definitions"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_secrets_scope_shape_check') THEN
		ALTER TABLE "company_secrets" ADD CONSTRAINT "company_secrets_scope_shape_check" CHECK (
			("scope" = 'company' AND "owner_user_id" IS NULL AND "user_secret_definition_id" IS NULL)
			OR
			("scope" = 'user' AND "owner_user_id" IS NOT NULL AND "user_secret_definition_id" IS NOT NULL)
		);
	END IF;
END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS "company_secrets_company_name_uq";
--> statement-breakpoint
DROP INDEX IF EXISTS "company_secrets_company_key_uq";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_secret_definitions_company_status_idx" ON "user_secret_definitions" USING btree ("company_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_secret_definitions_company_provider_idx" ON "user_secret_definitions" USING btree ("company_id","provider");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_secret_definitions_provider_config_idx" ON "user_secret_definitions" USING btree ("provider_config_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_secret_definitions_company_key_uq" ON "user_secret_definitions" USING btree ("company_id","key") WHERE "user_secret_definitions"."deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_secret_declarations_company_idx" ON "user_secret_declarations" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_secret_declarations_definition_idx" ON "user_secret_declarations" USING btree ("user_secret_definition_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_secret_declarations_target_idx" ON "user_secret_declarations" USING btree ("company_id","target_type","target_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_secret_declarations_company_required_idx" ON "user_secret_declarations" USING btree ("company_id","required");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_secret_declarations_target_path_uq" ON "user_secret_declarations" USING btree ("company_id","target_type","target_id","config_path");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_secret_declarations_required_override_idx" ON "user_secret_declarations" USING btree ("company_id","allow_missing_override") WHERE "user_secret_declarations"."allow_missing_override" = true;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_secrets_company_scope_idx" ON "company_secrets" USING btree ("company_id","scope");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_secrets_company_owner_idx" ON "company_secrets" USING btree ("company_id","owner_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_secrets_user_definition_owner_idx" ON "company_secrets" USING btree ("company_id","user_secret_definition_id","owner_user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_secrets_company_name_uq" ON "company_secrets" USING btree ("company_id","name") WHERE "company_secrets"."scope" = 'company' AND "company_secrets"."deleted_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_secrets_company_key_uq" ON "company_secrets" USING btree ("company_id","key") WHERE "company_secrets"."scope" = 'company' AND "company_secrets"."deleted_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_secrets_user_definition_owner_uq" ON "company_secrets" USING btree ("company_id","user_secret_definition_id","owner_user_id") WHERE "company_secrets"."scope" = 'user' AND "company_secrets"."deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "secret_access_events_user_definition_created_idx" ON "secret_access_events" USING btree ("user_secret_definition_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "secret_access_events_company_credential_owner_idx" ON "secret_access_events" USING btree ("company_id","credential_owner_user_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_company_responsible_user_idx" ON "issues" USING btree ("company_id","responsible_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_responsible_user_idx" ON "heartbeat_runs" USING btree ("company_id","responsible_user_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routines_company_responsible_user_idx" ON "routines" USING btree ("company_id","responsible_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routine_revisions_company_responsible_user_idx" ON "routine_revisions" USING btree ("company_id","responsible_user_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routine_runs_company_responsible_user_idx" ON "routine_runs" USING btree ("company_id","responsible_user_id","created_at");
