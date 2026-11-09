-- Replay-safe after renumbering: preserve existing imports, provenance and scheduling.
CREATE TABLE IF NOT EXISTS "project_skill_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"workspace_id" uuid,
	"source_id" uuid,
	"repository_url" text NOT NULL,
	"tracking_ref" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"refresh_user_id" text,
	"refresh_agent_id" uuid,
	"refresh_local_trusted" boolean DEFAULT false NOT NULL,
	"connection_id" uuid,
	"refresh_grant_id" uuid,
	"next_sync_at" timestamp with time zone DEFAULT now() NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_skill_sources" DROP CONSTRAINT IF EXISTS "company_skill_sources_connection_id_tool_connections_id_fk";
--> statement-breakpoint
ALTER TABLE "company_skill_sources" ADD COLUMN IF NOT EXISTS "automatic_updates" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "company_skill_sources" ADD COLUMN IF NOT EXISTS "import_new_skills" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "company_skill_sources" ADD COLUMN IF NOT EXISTS "access_scope" text DEFAULT 'company' NOT NULL;--> statement-breakpoint
ALTER TABLE "company_skill_sources" ADD COLUMN IF NOT EXISTS "refresh_user_id" text;--> statement-breakpoint
ALTER TABLE "company_skill_sources" ADD COLUMN IF NOT EXISTS "refresh_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "company_skill_sources" ADD COLUMN IF NOT EXISTS "refresh_local_trusted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "company_skill_sources" ADD COLUMN IF NOT EXISTS "refresh_grant_id" uuid;--> statement-breakpoint
ALTER TABLE "company_skill_sources" ADD COLUMN IF NOT EXISTS "next_sync_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "company_skill_sources" ADD COLUMN IF NOT EXISTS "failure_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "access_source_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_skill_sources_company_id_companies_id_fk' AND conrelid = 'public.project_skill_sources'::regclass) THEN
    ALTER TABLE "project_skill_sources" ADD CONSTRAINT "project_skill_sources_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_skill_sources_project_id_projects_id_fk' AND conrelid = 'public.project_skill_sources'::regclass) THEN
    ALTER TABLE "project_skill_sources" ADD CONSTRAINT "project_skill_sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_skill_sources_workspace_id_project_workspaces_id_fk' AND conrelid = 'public.project_skill_sources'::regclass) THEN
    ALTER TABLE "project_skill_sources" ADD CONSTRAINT "project_skill_sources_workspace_id_project_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."project_workspaces"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_skill_sources_source_id_company_skill_sources_id_fk' AND conrelid = 'public.project_skill_sources'::regclass) THEN
    ALTER TABLE "project_skill_sources" ADD CONSTRAINT "project_skill_sources_source_id_company_skill_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."company_skill_sources"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_skill_sources_workspace_repo_ref_idx" ON "project_skill_sources" USING btree ("workspace_id","repository_url","tracking_ref");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_skill_sources_source_project_idx" ON "project_skill_sources" USING btree ("company_id","source_id","project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_skill_sources_sync_idx" ON "project_skill_sources" USING btree ("active","status","next_sync_at");
--> statement-breakpoint
-- Retain setup identity if a connection or agent is deleted, including preview schemas.
ALTER TABLE "company_skill_sources" DROP CONSTRAINT IF EXISTS "company_skill_sources_refresh_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "project_skill_sources" DROP CONSTRAINT IF EXISTS "project_skill_sources_refresh_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "project_skill_sources" DROP CONSTRAINT IF EXISTS "project_skill_sources_connection_id_tool_connections_id_fk";

--> statement-breakpoint
ALTER TABLE "company_skill_sources" ADD COLUMN IF NOT EXISTS "removed_at" timestamp with time zone;
--> statement-breakpoint
DROP INDEX IF EXISTS "company_skill_sources_repository_ref_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "company_skill_sources_identity_ref_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "company_skill_sources_repository_ref_idx" ON "company_skill_sources" USING btree ("company_id","repository_url","tracking_ref") WHERE "company_skill_sources"."removed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "company_skill_sources_identity_ref_idx" ON "company_skill_sources" USING btree ("company_id","repository_id","tracking_ref") WHERE "company_skill_sources"."removed_at" is null;
--> statement-breakpoint
ALTER TABLE "company_skill_sources" ADD COLUMN IF NOT EXISTS "last_scan_tree_sha" text;--> statement-breakpoint
ALTER TABLE "company_skill_sources" ADD COLUMN IF NOT EXISTS "automatic_budget_bytes" integer DEFAULT 536870912 NOT NULL;--> statement-breakpoint
ALTER TABLE "company_skill_sources" ADD COLUMN IF NOT EXISTS "automatic_budget_at" timestamp with time zone DEFAULT now() NOT NULL;