INSERT INTO "agent_permission_grants" ("company_id", "grantee_id", "agent_id", "permission")
SELECT a1."company_id", a1."id", a2."id", p.permission
FROM "agents" a1
CROSS JOIN "agents" a2
CROSS JOIN (VALUES ('assign'), ('comment')) AS p(permission)
WHERE a1."company_id" = a2."company_id"
  AND a1."id" != a2."id"
ON CONFLICT DO NOTHING;
