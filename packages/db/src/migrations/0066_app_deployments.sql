CREATE TABLE IF NOT EXISTS "app_deployments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "app_name" text NOT NULL,
  "image_sha" text NOT NULL,
  "deployed_at" timestamptz NOT NULL DEFAULT NOW(),
  "includes_migration" boolean NOT NULL DEFAULT false,
  "migration_summary" text,
  "verified_stable" boolean NOT NULL DEFAULT false,
  "verified_stable_at" timestamptz,
  "last_rollback_at" timestamptz,
  "dokploy_deploy_id" text,
  "created_at" timestamptz NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_deployments_app_name_idx" ON "app_deployments" USING btree ("app_name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_deployments_verified_stable_idx" ON "app_deployments" USING btree ("app_name", "verified_stable") WHERE "verified_stable" = true;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_deployments_deployed_at_idx" ON "app_deployments" USING btree ("deployed_at" DESC);