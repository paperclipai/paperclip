-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable, and this partial unique index backstops the advisory-lock-guarded issue_children_completed wake claim (SSC-1728) with no forward-only alternative.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_wakeup_requests_children_completed_key_uq"
  ON "agent_wakeup_requests" USING btree ("company_id", "idempotency_key")
  WHERE "reason" = 'issue_children_completed' and "idempotency_key" is not null and "status" in ('queued', 'deferred_issue_execution', 'claimed', 'completed');
