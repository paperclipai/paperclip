ALTER TABLE "issues" ADD COLUMN "needed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "review_by" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "estimated_review_minutes" integer;--> statement-breakpoint
CREATE INDEX "issues_company_review_by_idx" ON "issues" USING btree ("company_id","review_by");