-- TSMC-20938 residual (schema drift): the live database carries two protective
-- objects on agent_fallback_sisters that were applied out-of-band and existed
-- nowhere in repo migrations:
--   1. Partial unique index agent_fallback_sisters_company_active_sister_idx —
--      a sister agent can back at most ONE active (revoked_at IS NULL) lane per
--      company.
--   2. Lane-topology trigger agent_fallback_sisters_primary_not_sister_trigger —
--      an agent that is an ACTIVE sister in one lane cannot also become a
--      primary in another active lane (and vice versa, since the sister side is
--      covered by the unique index above plus the route pre-flight).
-- This migration brings both under repo control. Every statement is idempotent:
-- applying against the LIVE db (objects already present) is a no-op, and against
-- a fresh db it produces identical objects.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_fallback_sisters_company_active_sister_idx"
  ON "agent_fallback_sisters" ("company_id","sister_agent_id")
  WHERE "revoked_at" IS NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agent_fallback_sisters_primary_not_sister_guard() RETURNS trigger AS $guard$
  DECLARE claiming_primary uuid;
  BEGIN
    IF NEW.revoked_at IS NULL THEN
      SELECT primary_agent_id INTO claiming_primary
        FROM agent_fallback_sisters
        WHERE company_id = NEW.company_id
          AND sister_agent_id = NEW.primary_agent_id
          AND revoked_at IS NULL
        LIMIT 1;
      IF claiming_primary IS NOT NULL THEN
        RAISE EXCEPTION 'agent % already belongs to fallback lane primary % and cannot also become a primary in another active lane',
          NEW.primary_agent_id, claiming_primary;
      END IF;
    END IF;
    RETURN NEW;
  END
$guard$ LANGUAGE plpgsql;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'agent_fallback_sisters_primary_not_sister_trigger'
      AND tgrelid = 'public.agent_fallback_sisters'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER agent_fallback_sisters_primary_not_sister_trigger
      BEFORE INSERT OR UPDATE ON agent_fallback_sisters
      FOR EACH ROW EXECUTE FUNCTION agent_fallback_sisters_primary_not_sister_guard();
  END IF;
END $$;
