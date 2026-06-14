ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "telemetry_id" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_telemetry_id_unique" ON "user" USING btree ("telemetry_id");
