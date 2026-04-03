-- Grant tasks:assign and agents:create to all existing active board users
INSERT INTO "principal_permission_grants" ("company_id", "principal_type", "principal_id", "permission_key", "scope", "granted_by_user_id", "created_at", "updated_at")
SELECT m."company_id", 'user', m."principal_id", 'tasks:assign', NULL, NULL, now(), now()
FROM "company_memberships" m
WHERE m."principal_type" = 'user' AND m."status" = 'active'
ON CONFLICT DO NOTHING;

INSERT INTO "principal_permission_grants" ("company_id", "principal_type", "principal_id", "permission_key", "scope", "granted_by_user_id", "created_at", "updated_at")
SELECT m."company_id", 'user', m."principal_id", 'agents:create', NULL, NULL, now(), now()
FROM "company_memberships" m
WHERE m."principal_type" = 'user' AND m."status" = 'active'
ON CONFLICT DO NOTHING;

-- Grant tasks:assign to all existing CEO agents
INSERT INTO "principal_permission_grants" ("company_id", "principal_type", "principal_id", "permission_key", "scope", "granted_by_user_id", "created_at", "updated_at")
SELECT a."company_id", 'agent', a."id", 'tasks:assign', NULL, NULL, now(), now()
FROM "agents" a WHERE a."role" = 'ceo'
ON CONFLICT DO NOTHING;
