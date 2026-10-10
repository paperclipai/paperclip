ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "origin_kind" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "origin_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routines_company_origin_idx" ON "routines" USING btree ("company_id","origin_kind","origin_id");
