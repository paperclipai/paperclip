-- Allow activity_log rows that aren't tied to a company — needed so
-- instance-scoped operations (e.g. instance-secret create/rotate/delete)
-- can produce audit rows. See packages/db/src/schema/activity_log.ts.

ALTER TABLE "activity_log" ALTER COLUMN "company_id" DROP NOT NULL;
