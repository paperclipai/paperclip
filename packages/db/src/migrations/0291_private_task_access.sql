CREATE TABLE IF NOT EXISTS "issue_access_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"source" text NOT NULL,
	"granted_by_user_id" text,
	"granted_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "issue_access_grants_subject_type_check" CHECK ("issue_access_grants"."subject_type" in ('user', 'agent')),
	CONSTRAINT "issue_access_grants_source_check" CHECK ("issue_access_grants"."source" in ('explicit', 'assignment', 'project'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_access_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_access_members_subject_type_check" CHECK ("project_access_members"."subject_type" in ('user', 'agent'))
);
--> statement-breakpoint
ALTER TABLE "workspace_operations" DROP CONSTRAINT IF EXISTS "workspace_operations_heartbeat_run_id_heartbeat_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "workspace_operations" DROP CONSTRAINT IF EXISTS "workspace_operations_issue_id_issues_id_fk";
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "scope_kind" text DEFAULT 'company' NOT NULL;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "issue_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "visibility" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "privacy_root_issue_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "privacy_parent_issue_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "visibility" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "personal_owner_user_id" text;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_access_grants_issue_id_issues_id_fk' AND conrelid = 'public.issue_access_grants'::regclass) THEN
    ALTER TABLE "issue_access_grants" ADD CONSTRAINT "issue_access_grants_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_access_grants_granted_by_agent_id_agents_id_fk' AND conrelid = 'public.issue_access_grants'::regclass) THEN
    ALTER TABLE "issue_access_grants" ADD CONSTRAINT "issue_access_grants_granted_by_agent_id_agents_id_fk" FOREIGN KEY ("granted_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_access_members_company_id_companies_id_fk' AND conrelid = 'public.project_access_members'::regclass) THEN
    ALTER TABLE "project_access_members" ADD CONSTRAINT "project_access_members_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_access_members_project_id_projects_id_fk' AND conrelid = 'public.project_access_members'::regclass) THEN
    ALTER TABLE "project_access_members" ADD CONSTRAINT "project_access_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_access_grants_subject_active_issue_idx" ON "issue_access_grants" USING btree ("subject_type","subject_id","revoked_at","issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_access_grants_issue_idx" ON "issue_access_grants" USING btree ("issue_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_access_members_project_subject_uq" ON "project_access_members" USING btree ("project_id","subject_type","subject_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_access_members_subject_lookup_idx" ON "project_access_members" USING btree ("company_id","subject_type","subject_id","project_id");--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'heartbeat_runs_issue_id_issues_id_fk' AND conrelid = 'public.heartbeat_runs'::regclass) THEN
    ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issues_privacy_root_issue_id_issues_id_fk' AND conrelid = 'public.issues'::regclass) THEN
    ALTER TABLE "issues" ADD CONSTRAINT "issues_privacy_root_issue_id_issues_id_fk" FOREIGN KEY ("privacy_root_issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issues_privacy_parent_issue_id_issues_id_fk' AND conrelid = 'public.issues'::regclass) THEN
    ALTER TABLE "issues" ADD CONSTRAINT "issues_privacy_parent_issue_id_issues_id_fk" FOREIGN KEY ("privacy_parent_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_operations_heartbeat_run_id_heartbeat_runs_id_fk' AND conrelid = 'public.workspace_operations'::regclass) THEN
    ALTER TABLE "workspace_operations" ADD CONSTRAINT "workspace_operations_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_operations_issue_id_issues_id_fk' AND conrelid = 'public.workspace_operations'::regclass) THEN
    ALTER TABLE "workspace_operations" ADD CONSTRAINT "workspace_operations_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_issue_created_idx" ON "heartbeat_runs" USING btree ("company_id","issue_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_company_privacy_parent_idx" ON "issues" USING btree ("company_id","privacy_parent_issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_company_privacy_root_idx" ON "issues" USING btree ("company_id","privacy_root_issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "projects_company_personal_owner_uq" ON "projects" USING btree ("company_id","personal_owner_user_id") WHERE "projects"."personal_owner_user_id" is not null;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'heartbeat_runs_scope_binding_check' AND conrelid = 'public.heartbeat_runs'::regclass) THEN
    ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_scope_binding_check" CHECK (("heartbeat_runs"."scope_kind" = 'company' AND "heartbeat_runs"."issue_id" IS NULL)
        OR "heartbeat_runs"."scope_kind" = 'issue');
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issues_visibility_check' AND conrelid = 'public.issues'::regclass) THEN
    ALTER TABLE "issues" ADD CONSTRAINT "issues_visibility_check" CHECK ("issues"."visibility" in ('open', 'private'));
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_visibility_check' AND conrelid = 'public.projects'::regclass) THEN
    ALTER TABLE "projects" ADD CONSTRAINT "projects_visibility_check" CHECK ("projects"."visibility" in ('open', 'private'));
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION set_heartbeat_run_scope_kind() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE candidate uuid;
BEGIN
  -- A private run never becomes a company run through context edits or deletion.
  IF TG_OP = 'UPDATE' AND OLD.scope_kind = 'issue' THEN
    IF OLD.issue_id IS NOT NULL AND NEW.issue_id IS NOT NULL AND OLD.issue_id <> NEW.issue_id THEN
      RAISE EXCEPTION 'run task binding is immutable';
    END IF;
    IF OLD.issue_id IS NOT NULL AND NEW.native_issue_id IS NOT NULL AND OLD.issue_id <> NEW.native_issue_id THEN
      RAISE EXCEPTION 'native run task binding disagrees with privacy binding';
    END IF;
    NEW.scope_kind := 'issue';
    RETURN NEW;
  END IF;
  candidate := coalesce(NEW.native_issue_id, NEW.issue_id);
  IF candidate IS NULL AND NEW.context_snapshot->>'issueId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    candidate := (NEW.context_snapshot->>'issueId')::uuid;
  END IF;
  IF candidate IS NOT NULL OR NEW.context_snapshot ? 'issueId' OR NEW.scope_kind = 'issue' THEN
    NEW.scope_kind := 'issue';
    SELECT id INTO NEW.issue_id FROM issues WHERE id = candidate AND company_id = NEW.company_id;
  ELSE
    NEW.scope_kind := 'company';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS heartbeat_runs_set_scope_kind ON heartbeat_runs;
--> statement-breakpoint
CREATE TRIGGER heartbeat_runs_set_scope_kind BEFORE INSERT OR UPDATE OF issue_id, native_issue_id, context_snapshot, scope_kind
  ON heartbeat_runs FOR EACH ROW EXECUTE FUNCTION set_heartbeat_run_scope_kind();
--> statement-breakpoint
-- Indexed primary-key keyset batches visit each historical run once. Missing
-- source tasks become issue-scoped tombstones, never company-visible run content.
DO $$ DECLARE cursor_id uuid := '00000000-0000-0000-0000-000000000000'; next_id uuid;
BEGIN LOOP
  WITH batch AS MATERIALIZED (SELECT id FROM heartbeat_runs WHERE id > cursor_id ORDER BY id LIMIT 1000),
  changed AS (UPDATE heartbeat_runs r SET scope_kind = r.scope_kind FROM batch b WHERE r.id = b.id RETURNING r.id)
  SELECT id INTO next_id FROM changed ORDER BY id DESC LIMIT 1;
  EXIT WHEN next_id IS NULL;
  cursor_id := next_id;
END LOOP; END $$;
--> statement-breakpoint
-- Existing structural children acquire downward inheritance without widening
-- any task's visibility. New provenance edges are written at task creation.
DO $$ DECLARE cursor_id uuid := '00000000-0000-0000-0000-000000000000'; next_id uuid;
BEGIN LOOP
  WITH batch AS MATERIALIZED (SELECT id FROM issues WHERE id > cursor_id ORDER BY id LIMIT 1000),
  changed AS (UPDATE issues i SET privacy_parent_issue_id = coalesce(i.privacy_parent_issue_id, i.parent_id)
    FROM batch b WHERE i.id = b.id RETURNING i.id)
  SELECT id INTO next_id FROM changed ORDER BY id DESC LIMIT 1;
  EXIT WHEN next_id IS NULL;
  cursor_id := next_id;
END LOOP; END $$;
--> statement-breakpoint
-- Keep workspace provenance after reassignment/deletion. A previous task may
-- have left files behind; losing the live FK must not publish those files.
CREATE OR REPLACE FUNCTION retain_workspace_privacy_sources() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sources jsonb := '{}'::jsonb; linked jsonb;
BEGIN
  IF TG_OP = 'UPDATE' AND jsonb_typeof(OLD.metadata->'_issuePrivacySources') = 'object' THEN
    sources := OLD.metadata->'_issuePrivacySources';
  END IF;
  IF NEW.source_issue_id IS NOT NULL THEN
    sources := sources || jsonb_build_object(NEW.source_issue_id::text, true);
  END IF;
  SELECT jsonb_object_agg(id::text, true) INTO linked FROM issues
    WHERE execution_workspace_id = NEW.id AND company_id = NEW.company_id;
  sources := sources || coalesce(linked, '{}'::jsonb);
  NEW.metadata := coalesce(NEW.metadata, '{}'::jsonb) || jsonb_build_object('_issuePrivacySources', sources);
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS execution_workspaces_privacy_sources ON execution_workspaces;
--> statement-breakpoint
CREATE TRIGGER execution_workspaces_privacy_sources BEFORE INSERT OR UPDATE OF source_issue_id, metadata
  ON execution_workspaces FOR EACH ROW EXECUTE FUNCTION retain_workspace_privacy_sources();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION record_issue_workspace_privacy_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.execution_workspace_id IS NOT NULL THEN
    UPDATE execution_workspaces SET metadata = metadata
      WHERE id = NEW.execution_workspace_id AND company_id = NEW.company_id;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS issues_record_workspace_privacy_source ON issues;
--> statement-breakpoint
CREATE TRIGGER issues_record_workspace_privacy_source AFTER INSERT OR UPDATE OF execution_workspace_id
  ON issues FOR EACH ROW EXECUTE FUNCTION record_issue_workspace_privacy_source();
--> statement-breakpoint
DO $$ DECLARE cursor_id uuid := '00000000-0000-0000-0000-000000000000'; next_id uuid;
BEGIN LOOP
  WITH batch AS MATERIALIZED (SELECT id FROM execution_workspaces WHERE id > cursor_id ORDER BY id LIMIT 1000),
  changed AS (UPDATE execution_workspaces w SET metadata = metadata FROM batch b WHERE w.id = b.id RETURNING w.id)
  SELECT id INTO next_id FROM changed ORDER BY id DESC LIMIT 1;
  EXIT WHEN next_id IS NULL;
  cursor_id := next_id;
END LOOP; END $$;

--> statement-breakpoint
-- Preserve operation history while retaining every original task/run boundary.
CREATE OR REPLACE FUNCTION paperclip_keep_operation_privacy_sources() RETURNS trigger AS $$
DECLARE issue_sources jsonb := '{}'::jsonb; run_sources jsonb := '{}'::jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    issue_sources := COALESCE(OLD.metadata->'_issuePrivacySources', '{}'::jsonb);
    run_sources := COALESCE(OLD.metadata->'_runPrivacySources', '{}'::jsonb);
    IF OLD.issue_id IS NOT NULL THEN issue_sources := issue_sources || jsonb_build_object(OLD.issue_id::text, true); END IF;
    IF OLD.heartbeat_run_id IS NOT NULL THEN run_sources := run_sources || jsonb_build_object(OLD.heartbeat_run_id::text, true); END IF;
  END IF;
  IF NEW.issue_id IS NOT NULL THEN issue_sources := issue_sources || jsonb_build_object(NEW.issue_id::text, true); END IF;
  IF NEW.heartbeat_run_id IS NOT NULL THEN run_sources := run_sources || jsonb_build_object(NEW.heartbeat_run_id::text, true); END IF;
  NEW.metadata := COALESCE(NEW.metadata, '{}'::jsonb) || jsonb_build_object('_issuePrivacySources', issue_sources, '_runPrivacySources', run_sources);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS workspace_operations_keep_privacy_sources ON workspace_operations;
--> statement-breakpoint
CREATE TRIGGER workspace_operations_keep_privacy_sources BEFORE INSERT OR UPDATE ON workspace_operations
FOR EACH ROW EXECUTE FUNCTION paperclip_keep_operation_privacy_sources();
--> statement-breakpoint
DO $$
DECLARE cursor_id uuid := '00000000-0000-0000-0000-000000000000'; batch_ids uuid[];
BEGIN
  LOOP
    SELECT array_agg(id ORDER BY id) INTO batch_ids FROM (
      SELECT id FROM workspace_operations WHERE id > cursor_id ORDER BY id LIMIT 1000
    ) batch;
    EXIT WHEN batch_ids IS NULL;
    UPDATE workspace_operations SET metadata = metadata WHERE id = ANY(batch_ids);
    cursor_id := batch_ids[array_length(batch_ids, 1)];
  END LOOP;
END $$;

--> statement-breakpoint
ALTER TABLE projects ADD COLUMN IF NOT EXISTS privacy_owner_user_id text;
--> statement-breakpoint
-- Recover management authority from creation evidence, never from read grants.
DO $$
DECLARE cursor_id uuid := '00000000-0000-0000-0000-000000000000'; batch_ids uuid[];
BEGIN
  LOOP
    SELECT array_agg(id ORDER BY id) INTO batch_ids FROM (
      SELECT id FROM projects WHERE id > cursor_id ORDER BY id LIMIT 1000
    ) batch;
    EXIT WHEN batch_ids IS NULL;
    UPDATE projects p SET privacy_owner_user_id = COALESCE(p.personal_owner_user_id, (
      SELECT CASE WHEN a.actor_type = 'user' THEN a.actor_id ELSE r.responsible_user_id END
      FROM activity_log a LEFT JOIN heartbeat_runs r ON r.id = a.run_id AND r.company_id = a.company_id
      WHERE a.company_id = p.company_id AND a.entity_type = 'project' AND a.entity_id = p.id::text AND a.action = 'project.created'
      ORDER BY a.created_at, a.id LIMIT 1
    )) WHERE p.id = ANY(batch_ids) AND p.privacy_owner_user_id IS NULL;
    INSERT INTO project_access_members (company_id, project_id, subject_type, subject_id)
      SELECT company_id, id, 'user', privacy_owner_user_id FROM projects
      WHERE id = ANY(batch_ids) AND visibility = 'private' AND privacy_owner_user_id IS NOT NULL
      ON CONFLICT (project_id, subject_type, subject_id) DO NOTHING;
    cursor_id := batch_ids[array_length(batch_ids, 1)];
  END LOOP;
END $$;
