CREATE TABLE IF NOT EXISTS "company_secret_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"secret_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"config_path" text NOT NULL,
	"version_selector" text DEFAULT 'latest' NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "secret_access_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"secret_id" uuid NOT NULL,
	"version" integer,
	"provider" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"consumer_type" text NOT NULL,
	"consumer_id" text NOT NULL,
	"config_path" text,
	"issue_id" uuid,
	"heartbeat_run_id" uuid,
	"plugin_id" uuid,
	"outcome" text NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_secrets" ADD COLUMN IF NOT EXISTS "key" text;--> statement-breakpoint
UPDATE "company_secrets"
SET "key" = left(
	regexp_replace(
		regexp_replace(lower(trim(coalesce("name", "id"::text))), '[^a-z0-9_.-]+', '-', 'g'),
		'^-+|-+$',
		'',
		'g'
	),
	120
)
WHERE "key" IS NULL;--> statement-breakpoint
UPDATE "company_secrets"
SET "key" = "id"::text
WHERE "key" IS NULL OR "key" = '';--> statement-breakpoint
ALTER TABLE "company_secrets" ALTER COLUMN "key" SET NOT NULL;--> statement-breakpoint
WITH ranked AS (
	SELECT
		"id",
		"key",
		row_number() OVER (PARTITION BY "company_id", "key" ORDER BY "created_at", "id") AS rn
	FROM "company_secrets"
)
UPDATE "company_secrets"
SET "key" = left(ranked."key", 100) || '-' || ranked.rn::text
FROM ranked
WHERE "company_secrets"."id" = ranked."id"
	AND ranked.rn > 1;--> statement-breakpoint
ALTER TABLE "company_secrets" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "company_secrets" ADD COLUMN IF NOT EXISTS "managed_mode" text DEFAULT 'paperclip_managed' NOT NULL;--> statement-breakpoint
ALTER TABLE "company_secrets" ADD COLUMN IF NOT EXISTS "provider_config_id" text;--> statement-breakpoint
ALTER TABLE "company_secrets" ADD COLUMN IF NOT EXISTS "provider_metadata" jsonb;--> statement-breakpoint
ALTER TABLE "company_secrets" ADD COLUMN IF NOT EXISTS "last_resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "company_secrets" ADD COLUMN IF NOT EXISTS "last_rotated_at" timestamp with time zone;--> statement-breakpoint
UPDATE "company_secrets"
SET "last_rotated_at" = "updated_at"
WHERE "last_rotated_at" IS NULL;--> statement-breakpoint
ALTER TABLE "company_secrets" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "company_secret_versions" ADD COLUMN IF NOT EXISTS "provider_version_ref" text;--> statement-breakpoint
ALTER TABLE "company_secret_versions" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'current' NOT NULL;--> statement-breakpoint
ALTER TABLE "company_secret_versions" ADD COLUMN IF NOT EXISTS "fingerprint_sha256" text;--> statement-breakpoint
UPDATE "company_secret_versions"
SET "fingerprint_sha256" = "value_sha256"
WHERE "fingerprint_sha256" IS NULL;--> statement-breakpoint
ALTER TABLE "company_secret_versions" ALTER COLUMN "fingerprint_sha256" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "company_secret_versions" ADD COLUMN IF NOT EXISTS "rotation_job_id" text;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_secret_bindings_company_id_companies_id_fk') THEN
		ALTER TABLE "company_secret_bindings" ADD CONSTRAINT "company_secret_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_secret_bindings_secret_id_company_secrets_id_fk') THEN
		ALTER TABLE "company_secret_bindings" ADD CONSTRAINT "company_secret_bindings_secret_id_company_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'secret_access_events_company_id_companies_id_fk') THEN
		ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'secret_access_events_secret_id_company_secrets_id_fk') THEN
		ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_secret_id_company_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'secret_access_events_issue_id_issues_id_fk') THEN
		ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'secret_access_events_heartbeat_run_id_heartbeat_runs_id_fk') THEN
		ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'secret_access_events_plugin_id_plugins_id_fk') THEN
		ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_secret_bindings_company_idx" ON "company_secret_bindings" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_secret_bindings_secret_idx" ON "company_secret_bindings" USING btree ("secret_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_secret_bindings_target_idx" ON "company_secret_bindings" USING btree ("company_id","target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_secret_bindings_target_path_uq" ON "company_secret_bindings" USING btree ("company_id","target_type","target_id","config_path");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "secret_access_events_company_created_idx" ON "secret_access_events" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "secret_access_events_secret_created_idx" ON "secret_access_events" USING btree ("secret_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "secret_access_events_consumer_idx" ON "secret_access_events" USING btree ("company_id","consumer_type","consumer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "secret_access_events_run_idx" ON "secret_access_events" USING btree ("heartbeat_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_secret_versions_fingerprint_idx" ON "company_secret_versions" USING btree ("fingerprint_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_secrets_company_key_uq" ON "company_secrets" USING btree ("company_id","key");
