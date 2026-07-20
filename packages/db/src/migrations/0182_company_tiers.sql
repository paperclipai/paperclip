ALTER TABLE "companies" ADD COLUMN "tier" text NOT NULL DEFAULT 'starter';
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "tier_changed_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "companies_tier_idx" ON "companies" USING btree ("tier");
