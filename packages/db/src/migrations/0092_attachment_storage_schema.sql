ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "storage_backend" text NOT NULL DEFAULT 'local_disk';--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "download_url_ttl_seconds" integer;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "compliance_mode" boolean NOT NULL DEFAULT false;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'companies_storage_backend_check') THEN
    ALTER TABLE "companies" ADD CONSTRAINT "companies_storage_backend_check" CHECK (storage_backend IN ('local_disk', 's3', 'vercel_blob', 'supabase_storage'));
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'ready';--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "scan_status" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assets_pending_created_idx" ON "assets" USING btree ("created_at") WHERE (status = 'pending');
