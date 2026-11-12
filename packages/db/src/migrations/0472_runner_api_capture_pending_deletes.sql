ALTER TABLE "runner_api_response_reservations" ADD COLUMN IF NOT EXISTS "pending_delete_object_key" text;--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "runner_api_response_reservations_asset_idx" ON "runner_api_response_reservations" USING btree ("asset_id");
