ALTER TABLE "release_candidate_audit_events" ADD COLUMN IF NOT EXISTS "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "release_candidate_audit_events_authorization_idempotency_uq"
  ON "release_candidate_audit_events" USING btree ("authorization_id", "idempotency_key")
  WHERE "release_candidate_audit_events"."authorization_id" IS NOT NULL
    AND "release_candidate_audit_events"."idempotency_key" IS NOT NULL;
