DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'issue_prefixes'
  ) THEN
    CREATE TABLE "issue_prefixes" (
      "prefix" text PRIMARY KEY NOT NULL,
      "owner_type" text NOT NULL CHECK ("owner_type" IN ('company', 'project')),
      "owner_id" uuid NOT NULL UNIQUE,
      "counter" integer DEFAULT 0 NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    );
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "issue_prefix" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_prefixes_owner_id_idx" ON "issue_prefixes" USING btree ("owner_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_prefixes_owner_lookup_idx" ON "issue_prefixes" USING btree ("owner_type","owner_id");
--> statement-breakpoint
INSERT INTO "issue_prefixes" ("prefix", "owner_type", "owner_id", "counter")
SELECT
  c.issue_prefix,
  'company',
  c.id,
  COALESCE(c.issue_counter, 0)
FROM "companies" c
ON CONFLICT ("owner_id") DO UPDATE
SET
  "prefix" = EXCLUDED."prefix",
  "owner_type" = EXCLUDED."owner_type",
  "counter" = GREATEST("issue_prefixes"."counter", EXCLUDED."counter");
--> statement-breakpoint
DO $$
DECLARE
  project_row RECORD;
  existing_prefix text;
  base_prefix text;
  candidate_prefix text;
  suffix_attempt integer;
BEGIN
  FOR project_row IN
    SELECT p.id, p.name, p.issue_prefix
    FROM "projects" p
    ORDER BY p.created_at ASC, p.id ASC
  LOOP
    SELECT ip.prefix INTO existing_prefix
    FROM "issue_prefixes" ip
    WHERE ip.owner_type = 'project' AND ip.owner_id = project_row.id;

    IF existing_prefix IS NOT NULL THEN
      UPDATE "projects"
      SET issue_prefix = existing_prefix
      WHERE id = project_row.id;
      CONTINUE;
    END IF;

    base_prefix := COALESCE(
      NULLIF(SUBSTRING(REGEXP_REPLACE(UPPER(COALESCE(project_row.issue_prefix, project_row.name)), '[^A-Z]', '', 'g') FROM 1 FOR 3), ''),
      'CMP'
    );
    candidate_prefix := base_prefix;
    suffix_attempt := 1;

    WHILE EXISTS (SELECT 1 FROM "issue_prefixes" ip WHERE ip.prefix = candidate_prefix) LOOP
      suffix_attempt := suffix_attempt + 1;
      candidate_prefix := base_prefix || REPEAT('A', suffix_attempt - 1);
    END LOOP;

    INSERT INTO "issue_prefixes" ("prefix", "owner_type", "owner_id", "counter")
    VALUES (candidate_prefix, 'project', project_row.id, 0);

    UPDATE "projects"
    SET issue_prefix = candidate_prefix
    WHERE id = project_row.id;
  END LOOP;
END $$;
--> statement-breakpoint
WITH renumbered_project_issues AS (
  SELECT
    i.id,
    p.issue_prefix,
    ROW_NUMBER() OVER (
      PARTITION BY i.project_id
      ORDER BY i.created_at ASC, i.id ASC
    )::integer AS issue_number
  FROM "issues" i
  INNER JOIN "projects" p ON p.id = i.project_id
  WHERE i.project_id IS NOT NULL
    AND p.issue_prefix IS NOT NULL
)
UPDATE "issues" i
SET
  issue_number = renumbered_project_issues.issue_number,
  identifier = renumbered_project_issues.issue_prefix || '-' || renumbered_project_issues.issue_number::text
FROM renumbered_project_issues
WHERE i.id = renumbered_project_issues.id;
--> statement-breakpoint
WITH project_max AS (
  SELECT
    p.id AS project_id,
    COALESCE(MAX(i.issue_number), 0)::integer AS max_issue_number
  FROM "projects" p
  LEFT JOIN "issues" i ON i.project_id = p.id
  GROUP BY p.id
)
UPDATE "issue_prefixes" ip
SET counter = project_max.max_issue_number
FROM project_max
WHERE ip.owner_type = 'project'
  AND ip.owner_id = project_max.project_id;
--> statement-breakpoint
WITH company_max AS (
  SELECT
    c.id AS company_id,
    COALESCE(MAX(i.issue_number), 0)::integer AS max_issue_number
  FROM "companies" c
  LEFT JOIN "issues" i
    ON i.company_id = c.id
   AND i.project_id IS NULL
  GROUP BY c.id
)
UPDATE "issue_prefixes" ip
SET counter = company_max.max_issue_number
FROM company_max
WHERE ip.owner_type = 'company'
  AND ip.owner_id = company_max.company_id;
--> statement-breakpoint
UPDATE "companies" c
SET issue_counter = COALESCE(ip.counter, 0)
FROM "issue_prefixes" ip
WHERE ip.owner_type = 'company'
  AND ip.owner_id = c.id;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'projects_issue_prefix_issue_prefixes_prefix_fk'
  ) THEN
    ALTER TABLE "projects"
      ADD CONSTRAINT "projects_issue_prefix_issue_prefixes_prefix_fk"
      FOREIGN KEY ("issue_prefix")
      REFERENCES "public"."issue_prefixes"("prefix")
      ON DELETE set null
      ON UPDATE cascade;
  END IF;
END $$;
