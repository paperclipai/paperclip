ALTER TABLE "issues" ADD COLUMN "backend_type" text DEFAULT 'paperclip' NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "external_metadata" jsonb;--> statement-breakpoint
CREATE INDEX "issues_company_backend_external_idx" ON "issues" USING btree ("company_id","backend_type","external_id");