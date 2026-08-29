-- Human-gate agent-mutation grant claim uniqueness guard.
--
-- Without this index, two concurrent agent requests can both pass the
-- assertHumanAssignedIssueMutationAllowed guard: they each read the
-- activity_log, both find the same grant unconsumed (no row yet), both
-- proceed past the check, and both write their mutations — one human
-- approval authorising two mutations. The unique constraint turns the
-- second concurrent INSERT into a 23505 error, which the guard maps to
-- a 403 before any mutation reaches the database.
--
-- The index is partial: it covers only the action that records human-gate
-- grant consumption, and only rows where interactionId is present (every
-- well-formed entry). Existing rows are unaffected and the IF NOT EXISTS
-- guard makes the migration safe to replay.
--
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: partial index on a new action variant with zero existing rows — no backfill and negligible lock window
CREATE UNIQUE INDEX IF NOT EXISTS "activity_log_human_gate_grant_claim_uq"
ON "activity_log"
USING btree (entity_id, ((details->>'interactionId')))
WHERE action = 'issue.human_authorized_agent_mutation'
  AND (details->>'interactionId') IS NOT NULL;

-- The index name follows the existing convention for partial unique indexes in
-- this repo: table name + purpose slug + "_uq" suffix.
