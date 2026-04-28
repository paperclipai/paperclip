ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "capacity_critical" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routines_capacity_critical_idx" ON "routines" USING btree ("company_id","capacity_critical") WHERE "capacity_critical" = true;
