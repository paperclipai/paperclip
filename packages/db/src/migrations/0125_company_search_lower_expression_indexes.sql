CREATE INDEX IF NOT EXISTS "issues_company_identifier_lower_visible_idx"
  ON "issues" ("company_id", lower(coalesce("identifier", '')))
  WHERE "hidden_at" IS NULL AND "identifier" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_title_lower_search_idx"
  ON "issues" USING gin (lower("title") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_identifier_lower_search_idx"
  ON "issues" USING gin (lower(coalesce("identifier", '')) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_description_lower_search_idx"
  ON "issues" USING gin (lower(coalesce("description", '')) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_comments_body_lower_search_idx"
  ON "issue_comments" USING gin (lower("body") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_title_lower_search_idx"
  ON "documents" USING gin (lower(coalesce("title", '')) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_latest_body_lower_search_idx"
  ON "documents" USING gin (lower("latest_body") gin_trgm_ops);
