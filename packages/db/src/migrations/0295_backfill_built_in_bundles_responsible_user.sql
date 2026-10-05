-- The literal "built-in-bundles" is a system marker, not a user account, but
-- older releases wrote it into responsible_user_id when installing built-in
-- bundles. Authorization looks up an active membership for that value, finds
-- none, and denies every company-scoped call with RESPONSIBLE_USER_UNAVAILABLE,
-- locking the routine's own assignee out of its issues.
--
-- Repair existing rows by resolving a real company user with the same fallback
-- order the runtime uses: a non-blank default_responsible_user_id, then the
-- oldest active owner, then the oldest active member that is not a viewer (a
-- viewer cannot authorize issue writes). Rows with no resolvable user are left
-- untouched (never set NULL: a null responsible user skips the user-permission
-- intersection entirely). Idempotent because each statement is predicated on the
-- marker value. Provenance columns created_by_user_id / updated_by_user_id and
-- the activity_log actor_id keep the marker unchanged.

UPDATE "routines" AS r
SET "responsible_user_id" = COALESCE(
  NULLIF(BTRIM(c."default_responsible_user_id"), ''),
  (
    SELECT m."principal_id"
    FROM "company_memberships" AS m
    WHERE m."company_id" = r."company_id"
      AND m."principal_type" = 'user'
      AND m."status" = 'active'
      AND (m."membership_role" IS NULL OR m."membership_role" <> 'viewer')
    ORDER BY CASE WHEN m."membership_role" = 'owner' THEN 0 ELSE 1 END ASC, m."created_at" ASC, m."id" ASC
    LIMIT 1
  )
)
FROM "companies" AS c
WHERE r."company_id" = c."id"
  AND r."responsible_user_id" = 'built-in-bundles'
  AND COALESCE(
    NULLIF(BTRIM(c."default_responsible_user_id"), ''),
    (
      SELECT m."principal_id"
      FROM "company_memberships" AS m
      WHERE m."company_id" = r."company_id"
        AND m."principal_type" = 'user'
        AND m."status" = 'active'
        AND (m."membership_role" IS NULL OR m."membership_role" <> 'viewer')
      ORDER BY CASE WHEN m."membership_role" = 'owner' THEN 0 ELSE 1 END ASC, m."created_at" ASC, m."id" ASC
      LIMIT 1
    )
  ) IS NOT NULL;
--> statement-breakpoint
UPDATE "routine_revisions" AS rr
SET "responsible_user_id" = COALESCE(
  NULLIF(BTRIM(c."default_responsible_user_id"), ''),
  (
    SELECT m."principal_id"
    FROM "company_memberships" AS m
    WHERE m."company_id" = rr."company_id"
      AND m."principal_type" = 'user'
      AND m."status" = 'active'
      AND (m."membership_role" IS NULL OR m."membership_role" <> 'viewer')
    ORDER BY CASE WHEN m."membership_role" = 'owner' THEN 0 ELSE 1 END ASC, m."created_at" ASC, m."id" ASC
    LIMIT 1
  )
)
FROM "companies" AS c
WHERE rr."company_id" = c."id"
  AND rr."responsible_user_id" = 'built-in-bundles'
  AND COALESCE(
    NULLIF(BTRIM(c."default_responsible_user_id"), ''),
    (
      SELECT m."principal_id"
      FROM "company_memberships" AS m
      WHERE m."company_id" = rr."company_id"
        AND m."principal_type" = 'user'
        AND m."status" = 'active'
        AND (m."membership_role" IS NULL OR m."membership_role" <> 'viewer')
      ORDER BY CASE WHEN m."membership_role" = 'owner' THEN 0 ELSE 1 END ASC, m."created_at" ASC, m."id" ASC
      LIMIT 1
    )
  ) IS NOT NULL;
--> statement-breakpoint
UPDATE "issues" AS i
SET "responsible_user_id" = COALESCE(
  NULLIF(BTRIM(c."default_responsible_user_id"), ''),
  (
    SELECT m."principal_id"
    FROM "company_memberships" AS m
    WHERE m."company_id" = i."company_id"
      AND m."principal_type" = 'user'
      AND m."status" = 'active'
      AND (m."membership_role" IS NULL OR m."membership_role" <> 'viewer')
    ORDER BY CASE WHEN m."membership_role" = 'owner' THEN 0 ELSE 1 END ASC, m."created_at" ASC, m."id" ASC
    LIMIT 1
  )
)
FROM "companies" AS c
WHERE i."company_id" = c."id"
  AND i."responsible_user_id" = 'built-in-bundles'
  AND COALESCE(
    NULLIF(BTRIM(c."default_responsible_user_id"), ''),
    (
      SELECT m."principal_id"
      FROM "company_memberships" AS m
      WHERE m."company_id" = i."company_id"
        AND m."principal_type" = 'user'
        AND m."status" = 'active'
        AND (m."membership_role" IS NULL OR m."membership_role" <> 'viewer')
      ORDER BY CASE WHEN m."membership_role" = 'owner' THEN 0 ELSE 1 END ASC, m."created_at" ASC, m."id" ASC
      LIMIT 1
    )
  ) IS NOT NULL;
--> statement-breakpoint
UPDATE "heartbeat_runs" AS h
SET "responsible_user_id" = COALESCE(
  NULLIF(BTRIM(c."default_responsible_user_id"), ''),
  (
    SELECT m."principal_id"
    FROM "company_memberships" AS m
    WHERE m."company_id" = h."company_id"
      AND m."principal_type" = 'user'
      AND m."status" = 'active'
      AND (m."membership_role" IS NULL OR m."membership_role" <> 'viewer')
    ORDER BY CASE WHEN m."membership_role" = 'owner' THEN 0 ELSE 1 END ASC, m."created_at" ASC, m."id" ASC
    LIMIT 1
  )
)
FROM "companies" AS c
WHERE h."company_id" = c."id"
  AND h."responsible_user_id" = 'built-in-bundles'
  AND COALESCE(
    NULLIF(BTRIM(c."default_responsible_user_id"), ''),
    (
      SELECT m."principal_id"
      FROM "company_memberships" AS m
      WHERE m."company_id" = h."company_id"
        AND m."principal_type" = 'user'
        AND m."status" = 'active'
        AND (m."membership_role" IS NULL OR m."membership_role" <> 'viewer')
      ORDER BY CASE WHEN m."membership_role" = 'owner' THEN 0 ELSE 1 END ASC, m."created_at" ASC, m."id" ASC
      LIMIT 1
    )
  ) IS NOT NULL;
