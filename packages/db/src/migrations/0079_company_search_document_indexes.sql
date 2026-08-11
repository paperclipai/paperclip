CREATE INDEX IF NOT EXISTS "documents_title_search_idx" ON "documents" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_latest_body_search_idx" ON "documents" USING gin ("latest_body" gin_trgm_ops);
