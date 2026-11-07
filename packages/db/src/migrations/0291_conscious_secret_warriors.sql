CREATE TABLE IF NOT EXISTS "company_skill_source_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"path" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"skill_id" uuid,
	"selection" text DEFAULT 'new' NOT NULL,
	"present" boolean DEFAULT true NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_skill_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"repository_id" text,
	"repository_url" text NOT NULL,
	"full_name" text NOT NULL,
	"tracking_ref" text NOT NULL,
	"connection_id" uuid,
	"excluded_folders" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_scan_commit" text,
	"last_error" text,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_skill_source_entries_company_id_companies_id_fk' AND conrelid = 'company_skill_source_entries'::regclass) THEN
    ALTER TABLE "company_skill_source_entries" ADD CONSTRAINT "company_skill_source_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_skill_source_entries_source_id_company_skill_sources_id_fk' AND conrelid = 'company_skill_source_entries'::regclass) THEN
    ALTER TABLE "company_skill_source_entries" ADD CONSTRAINT "company_skill_source_entries_source_id_company_skill_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."company_skill_sources"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_skill_source_entries_skill_id_company_skills_id_fk' AND conrelid = 'company_skill_source_entries'::regclass) THEN
    ALTER TABLE "company_skill_source_entries" ADD CONSTRAINT "company_skill_source_entries_skill_id_company_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."company_skills"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_skill_sources_company_id_companies_id_fk' AND conrelid = 'company_skill_sources'::regclass) THEN
    ALTER TABLE "company_skill_sources" ADD CONSTRAINT "company_skill_sources_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_skill_sources_connection_id_tool_connections_id_fk' AND conrelid = 'company_skill_sources'::regclass) THEN
    ALTER TABLE "company_skill_sources" ADD CONSTRAINT "company_skill_sources_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_skill_source_entries_source_path_idx" ON "company_skill_source_entries" USING btree ("source_id","path");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_skill_source_entries_company_skill_idx" ON "company_skill_source_entries" USING btree ("company_id","skill_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_skill_sources_repository_ref_idx" ON "company_skill_sources" USING btree ("company_id","repository_url","tracking_ref");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_skill_sources_identity_ref_idx" ON "company_skill_sources" USING btree ("company_id","repository_id","tracking_ref");
--> statement-breakpoint
-- Adopt only actual GitHub imports. Keyset batches use company_skills' primary
-- key; only source provenance is added, with no provider requests, content rewrites, or credential assumptions.
DO $$
DECLARE
  skill record;
  last_id uuid := '00000000-0000-0000-0000-000000000000';
  adopted_source_id uuid;
  repo_url text;
  repo_name text;
  adopted_tracking_ref text;
  skill_path text;
  batch_count integer;
BEGIN
  LOOP
    batch_count := 0;
    FOR skill IN
      SELECT id, company_id, name, description, slug, metadata, source_ref
      FROM company_skills
      WHERE id > last_id AND source_type = 'github'
        AND coalesce(metadata->>'hostname', 'github.com') = 'github.com'
        AND coalesce(metadata->>'sourceKind', '') NOT IN ('paperclip_bundled', 'catalog')
        AND metadata->>'catalogId' IS NULL
        AND metadata->>'owner' ~ '^[A-Za-z0-9_.-]+$'
        AND metadata->>'repo' ~ '^[A-Za-z0-9_.-]+$'
      ORDER BY id LIMIT 500
    LOOP
      last_id := skill.id;
      batch_count := batch_count + 1;
      repo_name := (skill.metadata->>'owner') || '/' || (skill.metadata->>'repo');
      repo_url := 'https://github.com/' || lower(repo_name);
      -- Older imports recorded only the installed commit. Keep explicit tracking
      -- refs (including intentional commit pins); resolve unknown refs on first refresh.
      adopted_tracking_ref := coalesce(
        nullif(skill.metadata->>'trackingRef', ''),
        CASE WHEN skill.metadata->>'ref' !~* '^[0-9a-f]{40}$' THEN nullif(skill.metadata->>'ref', '') END,
        CASE WHEN skill.source_ref !~* '^[0-9a-f]{40}$' THEN nullif(skill.source_ref, '') END,
        'HEAD'
      );
      skill_path := trim(both '/' from coalesce(skill.metadata->>'repoSkillDir', skill.slug));
      IF skill_path = '.' THEN skill_path := ''; END IF;
      skill_path := CASE WHEN skill_path = '' THEN 'SKILL.md' ELSE skill_path || '/SKILL.md' END;
      INSERT INTO company_skill_sources (company_id, repository_url, full_name, tracking_ref)
        VALUES (skill.company_id, repo_url, repo_name, adopted_tracking_ref)
        ON CONFLICT (company_id, repository_url, tracking_ref) DO NOTHING;
      SELECT id INTO adopted_source_id FROM company_skill_sources
        WHERE company_id = skill.company_id AND repository_url = repo_url AND company_skill_sources.tracking_ref = adopted_tracking_ref;
      INSERT INTO company_skill_source_entries (company_id, source_id, path, name, description, skill_id, selection)
        VALUES (skill.company_id, adopted_source_id, skill_path, skill.name, skill.description, skill.id, 'selected')
        ON CONFLICT (source_id, path) DO NOTHING;
      UPDATE company_skills SET metadata = coalesce(metadata, '{}'::jsonb)
        || jsonb_build_object('legacySkillSourceId', adopted_source_id, 'skillSourcePath', skill_path)
        WHERE id = skill.id AND company_id = skill.company_id;
    END LOOP;
    EXIT WHEN batch_count < 500;
  END LOOP;
END $$;
