-- Migration: add_project_documents
-- Spec: projects/jarvis-os-redesign/docs/2026-04-30-system-redesign-design.md, Phase 6 Memory-Mapping.
-- Phase: 0.5 draft. Validate in sandbox before any production apply.

ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "tags" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
UPDATE "documents" SET "tags" = '[]'::jsonb WHERE "tags" IS NULL;
--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "tags" SET DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "tags" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
UPDATE "documents" SET "metadata" = '{}'::jsonb WHERE "metadata" IS NULL;
--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "metadata" SET DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "metadata" SET NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'project_documents_company_id_companies_id_fk'
			AND conrelid = 'public.project_documents'::regclass
	) THEN
		ALTER TABLE "project_documents"
			ADD CONSTRAINT "project_documents_company_id_companies_id_fk"
			FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id")
			ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'project_documents_project_id_projects_id_fk'
			AND conrelid = 'public.project_documents'::regclass
	) THEN
		ALTER TABLE "project_documents"
			ADD CONSTRAINT "project_documents_project_id_projects_id_fk"
			FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id")
			ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'project_documents_document_id_documents_id_fk'
			AND conrelid = 'public.project_documents'::regclass
	) THEN
		ALTER TABLE "project_documents"
			ADD CONSTRAINT "project_documents_document_id_documents_id_fk"
			FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id")
			ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_documents_company_project_key_uq"
ON "project_documents" USING btree ("company_id", "project_id", "key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_documents_document_uq"
ON "project_documents" USING btree ("document_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_documents_company_project_updated_idx"
ON "project_documents" USING btree ("company_id", "project_id", "updated_at");
