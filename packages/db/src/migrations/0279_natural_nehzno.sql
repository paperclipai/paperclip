ALTER TABLE "principal_permission_grants" ADD COLUMN "grant_origin" text DEFAULT 'legacy_unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "principal_permission_grants" ALTER COLUMN "grant_origin" SET DEFAULT 'explicit';--> statement-breakpoint
ALTER TABLE "principal_permission_grants" ADD CONSTRAINT "principal_permission_grants_origin_check" CHECK ("principal_permission_grants"."grant_origin" in ('explicit', 'role_default', 'legacy_unknown'));
