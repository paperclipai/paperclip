-- NET-6788 / NET-6789: per-fire origin_fingerprint + drop fingerprint-lookup coalesce filter.
--
-- Background: `issues_open_routine_execution_uq` (created in 0062) wedges
-- whenever two open routine_execution issues share the same (company_id,
-- origin_kind, origin_id, origin_fingerprint). The server-side fix in this
-- PR mints a fresh per-fire occurrenceId and mixes it into the fingerprint,
-- so new fires naturally get distinct fingerprints. This migration does
-- three cheap, defensive things to drain residual wedge state:
--
--   1. Add routine_runs.dispatch_occurrence_id (NULLable) for debuggability —
--      populated by the new server-side code so future investigations can
--      correlate runs to fires without joining on (payload+revision+env).
--   2. Cancel any open routine_execution issue still carrying the legacy
--      `origin_fingerprint = 'default'` whose heartbeat run is already
--      terminal. Those rows are the wedge residue; the board operator has
--      already cancelled 97 manually, this catches the rest.
--   3. Same cleanup as a no-op safety net: same predicate but for issues
--      whose execution_run_id is NULL (heartbeat row already pruned).
--
-- NOTE: this does NOT cover `process_lost` heartbeat runs (NET-6719). A
-- process_lost run never transitions to a terminal status, so the heartbeat-
-- bound predicate below cannot see it. After NET-6788 lands, NET-6719 (the
-- harness-side classifier + index-slot release on reap) closes that residual
-- wedge.
--
-- No index changes: the partial unique index already keys on
-- `origin_fingerprint`; per-fire fingerprints naturally stop wedging.

ALTER TABLE "routine_runs" ADD COLUMN IF NOT EXISTS "dispatch_occurrence_id" uuid;
--> statement-breakpoint

-- Defensive cleanup: terminal heartbeat runs bound to legacy 'default'-fingerprint
-- open issues. The issue becomes stranded (no execution_run_id) and cancelled.
UPDATE "issues" AS i
   SET "execution_run_id" = NULL,
       "execution_agent_name_key" = NULL,
       "execution_locked_at" = NULL,
       "status" = 'cancelled',
       "cancelled_at" = now()
  FROM "heartbeat_runs" AS hr
 WHERE i."origin_kind" = 'routine_execution'
   AND i."origin_fingerprint" = 'default'
   AND i."execution_run_id" IS NOT NULL
   AND hr."id" = i."execution_run_id"
   AND hr."status" IN ('completed','failed','cancelled','expired','skipped')
   AND i."hidden_at" IS NULL
   AND i."status" NOT IN ('done','cancelled');
--> statement-breakpoint

-- Same cleanup for issues whose heartbeat row has already been pruned entirely
-- (the original `process_lost` reap path). These can never have a live
-- execution run, so it is safe to cancel them.
--
-- Predicate: there is NO live heartbeat bound to this issue. Concretely:
--   * `i.execution_run_id IS NULL` — the FK was nulled (most process_lost
--     reaps null the FK on reap, leaving issue.execution_run_id NULL), OR
--   * `i.execution_run_id` points to a heartbeat row that no longer exists
--     (the heartbeat row was hard-deleted without nulling the FK — rare, but
--     possible from older operator cleanup paths). A correlated NOT EXISTS
--     against heartbeat_runs covers that orphan-FK case so we still cancel
--     the stranded issue rather than leave it wedging the index.
--
-- Critically, this update EXCLUDES any issue whose execution_run_id still
-- points to a live (non-terminal, existing) heartbeat run — cancelling such
-- an issue would be the exact dispatch wedge the PR claims to fix.
UPDATE "issues" AS i
   SET "execution_run_id" = NULL,
       "execution_agent_name_key" = NULL,
       "execution_locked_at" = NULL,
       "status" = 'cancelled',
       "cancelled_at" = now()
 WHERE i."origin_kind" = 'routine_execution'
   AND i."origin_fingerprint" = 'default'
   AND (
     i."execution_run_id" IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM "heartbeat_runs" hr2 WHERE hr2."id" = i."execution_run_id"
     )
   )
   AND i."hidden_at" IS NULL
   AND i."status" NOT IN ('done','cancelled');