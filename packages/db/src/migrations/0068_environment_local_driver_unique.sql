DROP INDEX IF EXISTS "environments_company_driver_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "environments_company_driver_idx" ON "environments" USING btree ("company_id","driver") WHERE "driver" = 'local';
