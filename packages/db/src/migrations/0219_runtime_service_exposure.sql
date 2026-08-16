ALTER TABLE "workspace_runtime_services" ADD COLUMN IF NOT EXISTS "exposure" jsonb;
ALTER TABLE "workspace_runtime_services" ADD COLUMN IF NOT EXISTS "exposure_handle" text;
ALTER TABLE "workspace_runtime_services" ADD COLUMN IF NOT EXISTS "backend_url" text;
