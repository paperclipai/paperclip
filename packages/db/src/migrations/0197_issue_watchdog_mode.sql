ALTER TABLE "issue_watchdogs" ADD COLUMN IF NOT EXISTS "mode" text NOT NULL DEFAULT 'subtask';

-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable and the partial predicate only indexes the new task_watchdog_self key namespace and existing rows cannot match.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_wakeup_requests_task_watchdog_self_idempotency_uq"
  ON "agent_wakeup_requests" ("company_id", "idempotency_key")
  WHERE "idempotency_key" LIKE 'task_watchdog_self:%' AND "run_id" IS NOT NULL;
