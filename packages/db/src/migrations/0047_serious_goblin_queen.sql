ALTER TABLE "issues" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "issues_open_subtask_dedupe_uq" ON "issues" USING btree ("parent_id","dedupe_key") WHERE "issues"."parent_id" is not null
          and "issues"."dedupe_key" is not null
          and "issues"."hidden_at" is null
          and "issues"."status" in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked');