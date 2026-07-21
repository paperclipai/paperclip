CREATE TABLE IF NOT EXISTS "agent_hire_operations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "principal_type" text NOT NULL,
  "principal_id" text NOT NULL,
  "idempotency_key_hash" text NOT NULL,
  "request_hash" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "stage" text DEFAULT 'queued' NOT NULL,
  "agent_id" uuid NOT NULL,
  "response" jsonb,
  "error" jsonb,
  "stage_timings" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "lease_token" text,
  "lease_expires_at" timestamp with time zone,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_hire_operations_status_check"
    CHECK ("status" IN ('pending', 'succeeded', 'failed'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_hire_operations_scoped_key_uq"
  ON "agent_hire_operations" USING btree (
    "company_id",
    "principal_type",
    "principal_id",
    "idempotency_key_hash"
  );--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_hire_operations_company_operation_idx"
  ON "agent_hire_operations" USING btree ("company_id", "id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_hire_operations_pending_lease_idx"
  ON "agent_hire_operations" USING btree ("status", "lease_expires_at");