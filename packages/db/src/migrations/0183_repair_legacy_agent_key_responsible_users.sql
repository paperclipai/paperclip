WITH ranked_responsible_users AS (
  SELECT
    membership."company_id",
    membership."principal_id" AS "user_id",
    row_number() OVER (
      PARTITION BY membership."company_id"
      ORDER BY
        CASE
          WHEN company."default_responsible_user_id" = membership."principal_id" THEN 0
          WHEN membership."membership_role" = 'owner' THEN 1
          ELSE 2
        END,
        membership."created_at" ASC,
        membership."id" ASC
    ) AS "rank"
  FROM "company_memberships" AS membership
  INNER JOIN "companies" AS company
    ON company."id" = membership."company_id"
  INNER JOIN "user" AS auth_user
    ON auth_user."id" = membership."principal_id"
  WHERE membership."principal_type" = 'user'
    AND membership."status" = 'active'
    AND membership."principal_id" <> ''
),
company_responsible_users AS (
  SELECT "company_id", "user_id"
  FROM ranked_responsible_users
  WHERE "rank" = 1
)
UPDATE "agent_api_keys" AS key
SET "responsible_user_id" = responsible_user."user_id"
FROM company_responsible_users AS responsible_user
WHERE key."company_id" = responsible_user."company_id"
  AND key."responsible_user_id" IS NULL
  AND key."revoked_at" IS NULL;
