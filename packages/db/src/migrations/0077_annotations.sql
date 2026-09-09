CREATE TYPE IF NOT EXISTS "annotation_type" AS ENUM ('perimeter', 'hazard', 'resource', 'note');
CREATE TYPE IF NOT EXISTS "annotation_severity" AS ENUM ('critical', 'warning', 'info');
CREATE TYPE IF NOT EXISTS "annotation_visibility" AS ENUM ('org_wide', 'admin_only');

CREATE TABLE IF NOT EXISTS "annotations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "author_id" text NOT NULL,
  "author_name" text,
  "label" text NOT NULL,
  "annotation_type" "annotation_type" NOT NULL DEFAULT 'note',
  "severity" "annotation_severity" NOT NULL DEFAULT 'info',
  "visibility" "annotation_visibility" NOT NULL DEFAULT 'org_wide',
  "geometry" jsonb NOT NULL,
  "irwin_incident_id" text,
  "is_deleted" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX "annotations_company_idx" ON "annotations" ("company_id", "is_deleted", "created_at");
CREATE INDEX "annotations_author_idx" ON "annotations" ("author_id", "company_id");
