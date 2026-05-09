ALTER TABLE "document_revisions" ADD COLUMN IF NOT EXISTS "title" text;--> statement-breakpoint
ALTER TABLE "document_revisions" ADD COLUMN IF NOT EXISTS "format" text;--> statement-breakpoint
ALTER TABLE "document_revisions" ALTER COLUMN "format" SET DEFAULT 'markdown';
--> statement-breakpoint
UPDATE "document_revisions" AS "dr"
SET
  "title" = COALESCE("dr"."title", "d"."title"),
  "format" = COALESCE("dr"."format", "d"."format", 'markdown')
FROM "documents" AS "d"
WHERE "d"."id" = "dr"."document_id";--> statement-breakpoint
ALTER TABLE "document_revisions" ALTER COLUMN "format" SET NOT NULL;
