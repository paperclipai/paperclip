ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "resumed_at" timestamp with time zone;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issues_active_watchdog_rollup_uq"
  ON "issues" USING btree ("company_id","origin_kind","origin_id")
  WHERE "origin_kind" = 'watchdog_rollup'
    AND "origin_id" IS NOT NULL
    AND "hidden_at" IS NULL
    AND "status" NOT IN ('done', 'cancelled');
