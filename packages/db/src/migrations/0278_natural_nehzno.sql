ALTER TABLE "principal_permission_grants" ADD COLUMN "grant_origin" text DEFAULT 'explicit' NOT NULL;--> statement-breakpoint
UPDATE "principal_permission_grants" grants
SET "grant_origin" = 'role_default'
FROM "company_memberships" memberships
WHERE grants."company_id" = memberships."company_id"
	AND grants."principal_type" = 'user'
	AND grants."principal_id" = memberships."principal_id"
	AND memberships."principal_type" = 'user'
	AND memberships."status" = 'active'
	AND grants."scope" IS NULL
	AND grants."granted_by_user_id" IS NULL
	AND (
		(memberships."membership_role" = 'owner' AND grants."permission_key" IN (
			'agents:create',
			'agents:configure',
			'skills:create',
			'environments:manage',
			'users:invite',
			'users:manage_permissions',
			'tasks:assign',
			'tasks:manage_active_checkouts',
			'joins:approve',
			'pipelines:write',
			'audit:view_agent_actions',
			'tools:manage_connections',
			'tools:manage_runtime',
			'tools:use',
			'tools:admin'
		))
		OR (memberships."membership_role" = 'admin' AND grants."permission_key" IN (
			'agents:create',
			'agents:configure',
			'skills:create',
			'environments:manage',
			'users:invite',
			'tasks:assign',
			'tasks:manage_active_checkouts',
			'joins:approve',
			'pipelines:write',
			'audit:view_agent_actions',
			'tools:manage_connections',
			'tools:manage_runtime',
			'tools:use',
			'tools:admin'
		))
		OR (memberships."membership_role" IN ('member', 'operator') AND grants."permission_key" = 'tasks:assign')
	);--> statement-breakpoint
ALTER TABLE "principal_permission_grants" ADD CONSTRAINT "principal_permission_grants_origin_check" CHECK ("principal_permission_grants"."grant_origin" in ('explicit', 'role_default'));
