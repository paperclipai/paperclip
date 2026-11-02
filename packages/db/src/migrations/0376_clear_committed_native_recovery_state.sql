UPDATE "native_run_finalizations"
SET "recovery_state" = NULL, "recovery_request_id" = NULL, "updated_at" = now()
WHERE "phase" = 'committed' AND "lease_owner" IS NULL AND "recovery_state" IS NOT NULL;
