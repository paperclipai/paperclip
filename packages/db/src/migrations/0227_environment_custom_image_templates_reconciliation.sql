CREATE TABLE IF NOT EXISTS "environment_custom_image_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "environment_id" uuid NOT NULL,
  "provider" text NOT NULL,
  "template_kind" text DEFAULT 'unknown' NOT NULL,
  "template_ref" text NOT NULL,
  "source_template_ref" text,
  "source_environment_config_fingerprint" text,
  "status" text DEFAULT 'active' NOT NULL,
  "created_by_user_id" text,
  "created_by_agent_id" uuid,
  "captured_at" timestamp with time zone,
  "last_used_at" timestamp with time zone,
  "superseded_by_template_id" uuid,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "environment_custom_image_setup_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "environment_id" uuid NOT NULL,
  "template_id" uuid,
  "promoted_template_id" uuid,
  "provider" text NOT NULL,
  "provider_lease_id" text,
  "environment_lease_id" uuid,
  "status" text DEFAULT 'starting' NOT NULL,
  "started_by_user_id" text,
  "started_by_agent_id" uuid,
  "base_template_ref" text,
  "expires_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "failure_reason" text,
  "connection_summary" jsonb,
  "connection_secret_ref" text,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'environment_custom_image_templates'
      AND column_name = 'company_id'
  ) THEN
    EXECUTE $update$
      UPDATE "environment_custom_image_templates"
      SET
        "metadata" = jsonb_set(
          COALESCE("metadata", '{}'::jsonb),
          '{setupRpcCompanyId}',
          to_jsonb("company_id"::text),
          true
        ),
        "updated_at" = now()
      WHERE "company_id" IS NOT NULL
        AND COALESCE("metadata" ->> 'setupRpcCompanyId', '') = ''
    $update$;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'environment_custom_image_setup_sessions'
      AND column_name = 'company_id'
  ) THEN
    EXECUTE $update$
      UPDATE "environment_custom_image_setup_sessions"
      SET
        "metadata" = jsonb_set(
          COALESCE("metadata", '{}'::jsonb),
          '{setupRpcCompanyId}',
          to_jsonb("company_id"::text),
          true
        ),
        "updated_at" = now()
      WHERE "company_id" IS NOT NULL
        AND COALESCE("metadata" ->> 'setupRpcCompanyId', '') = ''
    $update$;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "environment_custom_image_templates"
    WHERE "status" = 'active'
    GROUP BY "environment_id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot reconcile environment custom image templates to environment scope while multiple active templates exist for the same environment. Revoke or supersede the extra active templates before retrying.';
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "environment_custom_image_setup_sessions"
    WHERE "status" IN ('starting', 'waiting_for_user', 'capturing')
    GROUP BY "environment_id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot reconcile environment custom image setup sessions to environment scope while multiple active sessions exist for the same environment. Finish or cancel the extra sessions before retrying.';
  END IF;
END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS "environment_custom_image_templates_company_environment_status_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "environment_custom_image_templates_company_provider_status_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "environment_custom_image_templates_company_environment_active_uq";
--> statement-breakpoint
DROP INDEX IF EXISTS "environment_custom_image_templates_company_last_used_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "environment_custom_image_setup_sessions_company_environment_status_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "environment_custom_image_setup_sessions_company_environment_active_uq";
--> statement-breakpoint
DROP INDEX IF EXISTS "environment_custom_image_setup_sessions_company_template_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "environment_custom_image_setup_sessions_company_promoted_template_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "environment_custom_image_setup_sessions_company_expires_idx";
--> statement-breakpoint
ALTER TABLE "environment_custom_image_templates"
  DROP CONSTRAINT IF EXISTS "environment_custom_image_templates_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "environment_custom_image_setup_sessions"
  DROP CONSTRAINT IF EXISTS "environment_custom_image_setup_sessions_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "environment_custom_image_templates" DROP COLUMN IF EXISTS "company_id";
--> statement-breakpoint
ALTER TABLE "environment_custom_image_setup_sessions" DROP COLUMN IF EXISTS "company_id";
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'environment_custom_image_templates_environment_id_environments_id_fk'
      AND conrelid = 'public.environment_custom_image_templates'::regclass
  ) THEN
    ALTER TABLE "environment_custom_image_templates"
      ADD CONSTRAINT "environment_custom_image_templates_environment_id_environments_id_fk"
      FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'environment_custom_image_templates_created_by_agent_id_agents_id_fk'
      AND conrelid = 'public.environment_custom_image_templates'::regclass
  ) THEN
    ALTER TABLE "environment_custom_image_templates"
      ADD CONSTRAINT "environment_custom_image_templates_created_by_agent_id_agents_id_fk"
      FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id")
      ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'environment_custom_image_templates_superseded_by_template_id_fk'
      AND conrelid = 'public.environment_custom_image_templates'::regclass
  ) THEN
    ALTER TABLE "environment_custom_image_templates"
      ADD CONSTRAINT "environment_custom_image_templates_superseded_by_template_id_fk"
      FOREIGN KEY ("superseded_by_template_id") REFERENCES "public"."environment_custom_image_templates"("id")
      ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'environment_custom_image_setup_sessions_environment_id_environments_id_fk'
      AND conrelid = 'public.environment_custom_image_setup_sessions'::regclass
  ) THEN
    ALTER TABLE "environment_custom_image_setup_sessions"
      ADD CONSTRAINT "environment_custom_image_setup_sessions_environment_id_environments_id_fk"
      FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'environment_custom_image_setup_sessions_template_id_fk'
      AND conrelid = 'public.environment_custom_image_setup_sessions'::regclass
  ) THEN
    ALTER TABLE "environment_custom_image_setup_sessions"
      ADD CONSTRAINT "environment_custom_image_setup_sessions_template_id_fk"
      FOREIGN KEY ("template_id") REFERENCES "public"."environment_custom_image_templates"("id")
      ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'environment_custom_image_setup_sessions_promoted_template_id_fk'
      AND conrelid = 'public.environment_custom_image_setup_sessions'::regclass
  ) THEN
    ALTER TABLE "environment_custom_image_setup_sessions"
      ADD CONSTRAINT "environment_custom_image_setup_sessions_promoted_template_id_fk"
      FOREIGN KEY ("promoted_template_id") REFERENCES "public"."environment_custom_image_templates"("id")
      ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'environment_custom_image_setup_sessions_environment_lease_id_environment_leases_id_fk'
      AND conrelid = 'public.environment_custom_image_setup_sessions'::regclass
  ) THEN
    ALTER TABLE "environment_custom_image_setup_sessions"
      ADD CONSTRAINT "environment_custom_image_setup_sessions_environment_lease_id_environment_leases_id_fk"
      FOREIGN KEY ("environment_lease_id") REFERENCES "public"."environment_leases"("id")
      ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'environment_custom_image_setup_sessions_started_by_agent_id_agents_id_fk'
      AND conrelid = 'public.environment_custom_image_setup_sessions'::regclass
  ) THEN
    ALTER TABLE "environment_custom_image_setup_sessions"
      ADD CONSTRAINT "environment_custom_image_setup_sessions_started_by_agent_id_agents_id_fk"
      FOREIGN KEY ("started_by_agent_id") REFERENCES "public"."agents"("id")
      ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "environment_custom_image_templates_environment_status_idx"
  ON "environment_custom_image_templates" USING btree ("environment_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "environment_custom_image_templates_environment_provider_status_idx"
  ON "environment_custom_image_templates" USING btree ("environment_id", "provider", "status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "environment_custom_image_templates_environment_active_uq"
  ON "environment_custom_image_templates" USING btree ("environment_id")
  WHERE "status" = 'active';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "environment_custom_image_templates_superseded_by_idx"
  ON "environment_custom_image_templates" USING btree ("superseded_by_template_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "environment_custom_image_templates_last_used_idx"
  ON "environment_custom_image_templates" USING btree ("last_used_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "environment_custom_image_setup_sessions_environment_status_idx"
  ON "environment_custom_image_setup_sessions" USING btree ("environment_id", "status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "environment_custom_image_setup_sessions_environment_active_uq"
  ON "environment_custom_image_setup_sessions" USING btree ("environment_id")
  WHERE "status" IN ('starting', 'waiting_for_user', 'capturing');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "environment_custom_image_setup_sessions_template_idx"
  ON "environment_custom_image_setup_sessions" USING btree ("template_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "environment_custom_image_setup_sessions_promoted_template_idx"
  ON "environment_custom_image_setup_sessions" USING btree ("promoted_template_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "environment_custom_image_setup_sessions_expires_idx"
  ON "environment_custom_image_setup_sessions" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "environment_custom_image_setup_sessions_provider_lease_idx"
  ON "environment_custom_image_setup_sessions" USING btree ("provider", "provider_lease_id");
