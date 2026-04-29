-- CMP-648 Phase 1: promote agents.org_level to NOT NULL after backfill (0075 + backfill-hierarchy-cmp648.ts).
-- Kept as a hand-rolled SQL migration so the drizzle TS column type can stay nullable
-- (avoids churn across ~80 existing test/seed inserts that don't yet set org_level).
--
-- Defensive backfill for any pre-existing rows outside the canonical 9 (CMP-647 design):
-- those agents are necessarily generic (role="general" default), so "executor" is the
-- correct level. The canonical mgr/exec/qa/policy/pm rows are already set by the TS
-- backfill, so this UPDATE leaves them untouched.
UPDATE "agents" SET "org_level" = 'executor' WHERE "org_level" IS NULL;--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "org_level" SET NOT NULL;
