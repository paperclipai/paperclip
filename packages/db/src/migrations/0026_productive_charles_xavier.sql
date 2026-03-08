ALTER TABLE "issues" ADD COLUMN "backend_type" text DEFAULT 'paperclip' NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "external_metadata" jsonb;--> statement-breakpoint
CREATE INDEX "issues_backend_type_idx" ON "issues" USING btree ("backend_type");--> statement-breakpoint
CREATE INDEX "issues_external_id_idx" ON "issues" USING btree ("external_id");