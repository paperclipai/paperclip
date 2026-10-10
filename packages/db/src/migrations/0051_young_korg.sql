CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "issue_comments_body_search_idx" ON "issue_comments" USING gin ("body" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "issues_title_search_idx" ON "issues" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "issues_identifier_search_idx" ON "issues" USING gin ("identifier" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "issues_description_search_idx" ON "issues" USING gin ("description" gin_trgm_ops);
