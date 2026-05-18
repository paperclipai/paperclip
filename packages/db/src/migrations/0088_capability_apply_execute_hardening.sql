-- LET-395: Capability Apply execute-route hardening (live flag OFF)
-- Adds DB-level guarantees required before wiring POST /execute:
--   * Single-use approval binding: no two plans may share the same approval row.
--   * Step terminal-state guard (CHECK already covers via 0087); no schema change.
-- Production migration is a SEPARATE ticket; do not apply to prod.

CREATE UNIQUE INDEX IF NOT EXISTS "cap_apply_plans_approval_id_uidx"
  ON "capability_apply_plans" ("approval_id")
  WHERE "approval_id" IS NOT NULL;
