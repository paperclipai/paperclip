DROP INDEX "memory_entries_company_key_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "memory_entries_company_key_uq" ON "memory_entries" USING btree ("company_id","key");