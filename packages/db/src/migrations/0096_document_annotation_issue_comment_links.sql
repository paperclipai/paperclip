ALTER TABLE "document_annotation_comments" ADD COLUMN IF NOT EXISTS "issue_comment_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_annotation_comments" ADD CONSTRAINT "document_annotation_comments_issue_comment_id_issue_comments_id_fk" FOREIGN KEY ("issue_comment_id") REFERENCES "public"."issue_comments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_annotation_comments_issue_comment_idx" ON "document_annotation_comments" USING btree ("issue_comment_id");
