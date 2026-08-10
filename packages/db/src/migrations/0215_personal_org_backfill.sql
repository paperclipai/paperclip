-- Backfill: auto-create a "personal" organization per existing company whose
-- organization_id is NULL. Assigns the first active 'owner' user membership as
-- the org owner. Companies without an identifiable owner are left unlinked and
-- must be reconciled manually (logged in server boot; see access service).
DO $$
DECLARE
    cmp RECORD;
    owner_uid TEXT;
    new_org_id UUID;
BEGIN
    FOR cmp IN SELECT id, name FROM companies WHERE organization_id IS NULL LOOP
        SELECT principal_id INTO owner_uid
        FROM company_memberships
        WHERE company_id = cmp.id
          AND principal_type = 'user'
          AND membership_role = 'owner'
          AND status = 'active'
        ORDER BY created_at ASC
        LIMIT 1;

        IF owner_uid IS NULL THEN
            CONTINUE;
        END IF;

        INSERT INTO organizations (name, owner_user_id)
        VALUES (cmp.name, owner_uid)
        RETURNING id INTO new_org_id;

        INSERT INTO org_memberships (organization_id, user_id, role)
        VALUES (new_org_id, owner_uid, 'owner');

        UPDATE companies SET organization_id = new_org_id WHERE id = cmp.id;
    END LOOP;
END $$;
--> statement-breakpoint
-- Backfill: set agents.owner_user_id = first user owner of the agent's company
-- so agent scope falls back to owner's grants. Leaves NULL if no owner exists
-- (those agents will fail the owner-scope check until an owner is set).
UPDATE agents
SET owner_user_id = sub.owner_uid
FROM (
    SELECT DISTINCT ON (cm.company_id)
        cm.company_id,
        cm.principal_id AS owner_uid
    FROM company_memberships cm
    WHERE cm.principal_type = 'user'
      AND cm.membership_role = 'owner'
      AND cm.status = 'active'
    ORDER BY cm.company_id, cm.created_at ASC
) sub
WHERE agents.company_id = sub.company_id
  AND agents.owner_user_id IS NULL;
