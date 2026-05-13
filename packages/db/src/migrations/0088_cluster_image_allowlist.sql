ALTER TABLE "cluster_connections" ADD COLUMN IF NOT EXISTS "image_allowlist" text[] DEFAULT ARRAY[]::text[] NOT NULL;
