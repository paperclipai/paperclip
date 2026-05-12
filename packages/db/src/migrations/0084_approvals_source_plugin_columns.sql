-- ADD COLUMN on nullable columns is a metadata-only operation in PG 11+ (no table rewrite, no long lock).
-- The FK constraint and index creation acquire ShareLock; on a large approvals table this may take
-- several seconds. Run during low-traffic window or replace the index line with
--   CREATE INDEX CONCURRENTLY "approvals_source_plugin_idx" ON "approvals" ...
-- outside the migration transaction (CONCURRENTLY cannot run inside a transaction block).
-- @migrationLockTimeout: low (ADD COLUMN nullable) / medium (FK + index, proportional to table size)
ALTER TABLE "approvals" ADD COLUMN "source_plugin_id" uuid;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "source_plugin_key" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_source_plugin_id_plugins_id_fk" FOREIGN KEY ("source_plugin_id") REFERENCES "public"."plugins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approvals_source_plugin_idx" ON "approvals" USING btree ("source_plugin_id","status");