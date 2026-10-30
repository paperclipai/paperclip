ALTER TABLE "folders" ADD COLUMN IF NOT EXISTS "parent_id" uuid;
--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN IF NOT EXISTS "slug" text;
--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN IF NOT EXISTS "system_key" text;
--> statement-breakpoint
WITH normalized AS (
  SELECT
    "id",
    COALESCE(
      NULLIF(TRIM(BOTH '-' FROM REGEXP_REPLACE(LOWER("name"), '[^a-z0-9]+', '-', 'g')), ''),
      'folder'
    ) AS base_slug,
    ROW_NUMBER() OVER (
      PARTITION BY "company_id", "kind", COALESCE(
        NULLIF(TRIM(BOTH '-' FROM REGEXP_REPLACE(LOWER("name"), '[^a-z0-9]+', '-', 'g')), ''),
        'folder'
      )
      ORDER BY "id"
    ) AS duplicate_number
  FROM "folders"
  WHERE "slug" IS NULL
)
UPDATE "folders" AS folder
SET "slug" = CASE
  WHEN normalized.duplicate_number = 1 THEN normalized.base_slug
  ELSE normalized.base_slug || '-' || LEFT(folder."id"::text, 8)
END
FROM normalized
WHERE folder."id" = normalized."id";
--> statement-breakpoint
ALTER TABLE "folders" ALTER COLUMN "slug" SET NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "folders_company_kind_name_uq";
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "pg_constraint" WHERE "conname" = 'folders_parent_id_folders_id_fk'
  ) THEN
    ALTER TABLE "folders" ADD CONSTRAINT "folders_parent_id_folders_id_fk"
      FOREIGN KEY ("parent_id") REFERENCES "public"."folders"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "folders" DROP CONSTRAINT IF EXISTS "folders_company_kind_parent_slug_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "folders_company_kind_root_slug_uq"
  ON "folders" USING btree ("company_id", "kind", "slug")
  WHERE "parent_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "folders_company_kind_parent_slug_uq"
  ON "folders" USING btree ("company_id", "kind", "parent_id", "slug")
  WHERE "parent_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "folders_company_kind_system_key_uq"
  ON "folders" USING btree ("company_id", "kind", "system_key")
  WHERE "system_key" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "folders_company_kind_parent_position_idx"
  ON "folders" USING btree ("company_id", "kind", "parent_id", "position", "name");
--> statement-breakpoint
UPDATE "folders" AS folder
SET "slug" = 'bundled-' || LEFT(REPLACE(folder."id"::text, '-', ''), 8), "updated_at" = now()
WHERE folder."kind" = 'skill'
  AND folder."parent_id" IS NULL
  AND folder."slug" = 'bundled'
  AND folder."system_key" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "company_skills" AS skill
    WHERE skill."company_id" = folder."company_id"
      AND skill."folder_id" IS NULL
      AND (skill."key" LIKE 'paperclipai/bundled/%' OR skill."metadata"->>'sourceKind' = 'paperclip_bundled')
  );
--> statement-breakpoint
INSERT INTO "folders" ("company_id", "kind", "parent_id", "name", "slug", "system_key", "position")
SELECT DISTINCT skill."company_id", 'skill', NULL::uuid, 'Bundled', 'bundled', 'bundled', 0
FROM "company_skills" AS skill
WHERE skill."folder_id" IS NULL
  AND (skill."key" LIKE 'paperclipai/bundled/%' OR skill."metadata"->>'sourceKind' = 'paperclip_bundled')
  AND NOT EXISTS (
    SELECT 1 FROM "folders" AS folder
    WHERE folder."company_id" = skill."company_id"
      AND folder."kind" = 'skill'
      AND folder."system_key" = 'bundled'
  )
ON CONFLICT DO NOTHING;
--> statement-breakpoint
WITH bundled_categories AS (
  SELECT DISTINCT ON (skill."company_id", category.slug)
    skill."company_id",
    category.name,
    category.slug
  FROM "company_skills" AS skill
  CROSS JOIN LATERAL (
    SELECT
      COALESCE(NULLIF(SPLIT_PART(skill."key", '/', 3), ''), 'other') AS name,
      COALESCE(
        NULLIF(TRIM(BOTH '-' FROM REGEXP_REPLACE(LOWER(COALESCE(NULLIF(SPLIT_PART(skill."key", '/', 3), ''), 'other')), '[^a-z0-9]+', '-', 'g')), ''),
        'other'
      ) AS slug
  ) AS category
  WHERE skill."folder_id" IS NULL
    AND (skill."key" LIKE 'paperclipai/bundled/%' OR skill."metadata"->>'sourceKind' = 'paperclip_bundled')
  ORDER BY skill."company_id", category.slug, category.name
)
INSERT INTO "folders" ("company_id", "kind", "parent_id", "name", "slug", "system_key", "position")
SELECT category."company_id", 'skill', root."id", category."name", category."slug", 'bundled:' || category."slug", 0
FROM bundled_categories AS category
JOIN "folders" AS root
  ON root."company_id" = category."company_id"
  AND root."kind" = 'skill'
  AND root."system_key" = 'bundled'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "company_skills" AS skill
SET "folder_id" = category_folder."id", "updated_at" = now()
FROM "folders" AS root
JOIN "folders" AS category_folder
  ON category_folder."company_id" = root."company_id"
  AND category_folder."kind" = 'skill'
  AND category_folder."parent_id" = root."id"
WHERE skill."company_id" = root."company_id"
  AND root."kind" = 'skill'
  AND root."system_key" = 'bundled'
  AND skill."folder_id" IS NULL
  AND (skill."key" LIKE 'paperclipai/bundled/%' OR skill."metadata"->>'sourceKind' = 'paperclip_bundled')
  AND category_folder."system_key" = 'bundled:' || COALESCE(
    NULLIF(TRIM(BOTH '-' FROM REGEXP_REPLACE(LOWER(COALESCE(NULLIF(SPLIT_PART(skill."key", '/', 3), ''), 'other')), '[^a-z0-9]+', '-', 'g')), ''),
    'other'
  );
--> statement-breakpoint
UPDATE "folders" AS folder
SET "slug" = 'projects-' || LEFT(REPLACE(folder."id"::text, '-', ''), 8), "updated_at" = now()
WHERE folder."kind" = 'skill'
  AND folder."parent_id" IS NULL
  AND folder."slug" = 'projects'
  AND folder."system_key" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "company_skills" AS skill
    WHERE skill."company_id" = folder."company_id"
      AND skill."folder_id" IS NULL
      AND skill."metadata"->>'sourceKind' = 'project_scan'
      AND skill."metadata"->>'projectId' IS NOT NULL
  );
--> statement-breakpoint
INSERT INTO "folders" ("company_id", "kind", "parent_id", "name", "slug", "system_key", "position")
SELECT DISTINCT skill."company_id", 'skill', NULL::uuid, 'Projects', 'projects', 'projects', 1
FROM "company_skills" AS skill
WHERE skill."folder_id" IS NULL
  AND skill."metadata"->>'sourceKind' = 'project_scan'
  AND skill."metadata"->>'projectId' IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "folders" AS folder
    WHERE folder."company_id" = skill."company_id"
      AND folder."kind" = 'skill'
      AND folder."system_key" = 'projects'
  )
ON CONFLICT DO NOTHING;
--> statement-breakpoint
WITH project_sources AS (
  SELECT DISTINCT ON (skill."company_id", skill."metadata"->>'projectId')
    skill."company_id",
    skill."metadata"->>'projectId' AS project_id,
    COALESCE(project."name", NULLIF(skill."metadata"->>'projectName', ''), 'Project') AS project_name
  FROM "company_skills" AS skill
  LEFT JOIN "projects" AS project
    ON project."id"::text = skill."metadata"->>'projectId'
    AND project."company_id" = skill."company_id"
  WHERE skill."folder_id" IS NULL
    AND skill."metadata"->>'sourceKind' = 'project_scan'
    AND skill."metadata"->>'projectId' IS NOT NULL
  ORDER BY skill."company_id", skill."metadata"->>'projectId', skill."id"
), project_folders AS (
  SELECT
    source."company_id",
    source.project_id,
    source.project_name,
    container."id" AS parent_id,
    COALESCE(
      NULLIF(TRIM(BOTH '-' FROM REGEXP_REPLACE(LOWER(source.project_name), '[^a-z0-9]+', '-', 'g')), ''),
      'project'
    ) AS base_slug
  FROM project_sources AS source
  JOIN "folders" AS container
    ON container."company_id" = source."company_id"
    AND container."kind" = 'skill'
    AND container."system_key" = 'projects'
), ranked_project_folders AS (
  SELECT
    source.*,
    ROW_NUMBER() OVER (
      PARTITION BY source."company_id", source.parent_id, source.base_slug
      ORDER BY source.project_id
    ) AS duplicate_number
  FROM project_folders AS source
)
INSERT INTO "folders" ("company_id", "kind", "parent_id", "name", "slug", "system_key", "position")
SELECT
  source."company_id",
  'skill',
  source.parent_id,
  source.project_name,
  CASE
    WHEN sibling."id" IS NULL AND source.duplicate_number = 1 THEN source.base_slug
    ELSE source.base_slug || '-' || LEFT(source.project_id, 8)
  END,
  'project:' || source.project_id,
  0
FROM ranked_project_folders AS source
LEFT JOIN "folders" AS sibling
  ON sibling."company_id" = source."company_id"
  AND sibling."kind" = 'skill'
  AND sibling."parent_id" = source.parent_id
  AND sibling."slug" = source.base_slug
WHERE NOT EXISTS (
  SELECT 1 FROM "folders" AS existing
  WHERE existing."company_id" = source."company_id"
    AND existing."kind" = 'skill'
    AND existing."system_key" = 'project:' || source.project_id
)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "company_skills" AS skill
SET "folder_id" = project_folder."id", "updated_at" = now()
FROM "folders" AS project_folder
WHERE project_folder."company_id" = skill."company_id"
  AND project_folder."kind" = 'skill'
  AND project_folder."system_key" = 'project:' || (skill."metadata"->>'projectId')
  AND skill."folder_id" IS NULL
  AND skill."metadata"->>'sourceKind' = 'project_scan';
