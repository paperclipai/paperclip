ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "origin_payload_fingerprint" text;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "issues"
    WHERE "origin_kind" LIKE 'external:%' AND "origin_id" IS NOT NULL
    GROUP BY "company_id", "origin_kind", "origin_id"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot install external issue source identity: duplicate company/origin_kind/origin_id rows require operator resolution';
  END IF;
END $$;

-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally; duplicate preflight fails before the short maintenance-gated unique-index lock.
CREATE UNIQUE INDEX IF NOT EXISTS "issues_external_source_uq"
  ON "issues" ("company_id", "origin_kind", "origin_id")
  WHERE "origin_kind" LIKE 'external:%' AND "origin_id" IS NOT NULL;
