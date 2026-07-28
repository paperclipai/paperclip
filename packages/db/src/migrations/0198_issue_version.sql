ALTER TABLE "issues"
  ADD COLUMN "version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "issues"
  ADD CONSTRAINT "issues_version_positive"
  CHECK ("issues"."version" > 0);
