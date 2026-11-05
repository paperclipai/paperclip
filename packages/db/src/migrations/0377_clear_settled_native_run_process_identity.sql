UPDATE "heartbeat_runs" AS "run"
SET "process_pid" = NULL, "process_group_id" = NULL, "process_started_at" = NULL
WHERE "run"."runtime_mode" = 'native'
  AND "run"."status" IN ('failed', 'cancelled', 'timed_out', 'interrupted')
  AND "run"."finished_at" < now() - interval '1 day'
  AND ("run"."process_pid" IS NOT NULL OR "run"."process_group_id" IS NOT NULL OR "run"."process_started_at" IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1 FROM "native_run_finalizations" AS "coordinator"
    WHERE "coordinator"."run_id" = "run"."id"
      AND "coordinator"."phase" NOT IN ('committed', 'terminal_failure')
  )
  AND (
    coalesce(jsonb_typeof("run"."runner_profile_json" -> 'sessionCheckpoint'), 'null') <> 'null'
    OR EXISTS (
      SELECT 1 FROM "heartbeat_run_events" AS "event"
      WHERE "event"."run_id" = "run"."id"
        AND "event"."event_type" IN ('harness.ready', 'session.started', 'session.resumed', 'session.updated', 'turn.started', 'provider.event', 'provider.rpc_result')
    )
  )
  AND EXISTS (
    SELECT 1 FROM "environment_leases" AS "lease"
    WHERE "lease"."heartbeat_run_id" = "run"."id"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "environment_leases" AS "lease"
    WHERE "lease"."heartbeat_run_id" = "run"."id"
      AND NOT coalesce((
        "lease"."company_id" = "run"."company_id"
        AND "lease"."provider" IS NOT NULL
        AND "lease"."provider" <> 'local'
        AND "lease"."provider_lease_id" IS NOT NULL
        AND "lease"."released_at" IS NOT NULL
        AND "lease"."cleanup_status" = 'success'
        AND "lease"."status" IN ('released', 'expired', 'failed')
        AND "lease"."metadata" -> 'remoteExecutionTermination' ->> 'schema' = 'paperclip.remote-termination.v1'
        AND "lease"."metadata" -> 'remoteExecutionTermination' ->> 'companyId' = "lease"."company_id"::text
        AND "lease"."metadata" -> 'remoteExecutionTermination' ->> 'runId' = "lease"."heartbeat_run_id"::text
        AND "lease"."metadata" -> 'remoteExecutionTermination' ->> 'leaseId' = "lease"."id"::text
        AND "lease"."metadata" -> 'remoteExecutionTermination' ->> 'provider' = "lease"."provider"
        AND "lease"."metadata" -> 'remoteExecutionTermination' ->> 'providerLeaseId' = "lease"."provider_lease_id"
        AND "lease"."metadata" -> 'remoteExecutionTermination' ->> 'state' IN ('stopped', 'destroyed')
      ), false)
  );
