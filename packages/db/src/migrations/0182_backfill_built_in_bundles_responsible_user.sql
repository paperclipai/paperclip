-- Replace the system marker "built-in-bundles" (not a real user account) that was
-- historically written into responsible_user_id columns. Auth looks up an active
-- membership for that value, finds none, and denies company_access — so agents
-- lose access to the whole company. Substitute companies.default_responsible_user_id
-- when present; leave rows unchanged when the company has no default (never SET NULL,
-- which would skip the user-permission intersection entirely). Idempotent via the
-- WHERE responsible_user_id = 'built-in-bundles' predicate. Does not touch
-- activity_log (correct system actor_id) or created_by_user_id / updated_by_user_id.

-- Routines seeded from built-in bundles stored the marker as responsible_user_id;
-- swap to the company default so auth intersects with a real membership.
UPDATE "routines" AS r
SET "responsible_user_id" = c."default_responsible_user_id"
FROM "companies" AS c
WHERE r."company_id" = c."id"
  AND r."responsible_user_id" = 'built-in-bundles'
  AND c."default_responsible_user_id" IS NOT NULL
  AND c."default_responsible_user_id" <> '';
--> statement-breakpoint
-- Routine revisions inherit the same marker from built-in reconcile/reset paths.
UPDATE "routine_revisions" AS rr
SET "responsible_user_id" = c."default_responsible_user_id"
FROM "companies" AS c
WHERE rr."company_id" = c."id"
  AND rr."responsible_user_id" = 'built-in-bundles'
  AND c."default_responsible_user_id" IS NOT NULL
  AND c."default_responsible_user_id" <> '';
--> statement-breakpoint
-- Issues created by those routines propagated the marker onto task authorization.
UPDATE "issues" AS i
SET "responsible_user_id" = c."default_responsible_user_id"
FROM "companies" AS c
WHERE i."company_id" = c."id"
  AND i."responsible_user_id" = 'built-in-bundles'
  AND c."default_responsible_user_id" IS NOT NULL
  AND c."default_responsible_user_id" <> '';
--> statement-breakpoint
-- Heartbeat runs for that work also carried the marker into run-scoped access checks.
UPDATE "heartbeat_runs" AS h
SET "responsible_user_id" = c."default_responsible_user_id"
FROM "companies" AS c
WHERE h."company_id" = c."id"
  AND h."responsible_user_id" = 'built-in-bundles'
  AND c."default_responsible_user_id" IS NOT NULL
  AND c."default_responsible_user_id" <> '';
