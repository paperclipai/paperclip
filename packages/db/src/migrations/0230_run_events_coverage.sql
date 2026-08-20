-- JAC-4529 (child of JAC-3929): add run_events table for coverage-aware
-- fail-closed event fields. This captures EVERY run regardless of spend,
-- complementing cost_events (which only record spend line-items).
-- Token/cost fields are nullable: null = not_reported, 0 = explicitly zero.

CREATE TABLE IF NOT EXISTS "run_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "agent_id" uuid NOT NULL REFERENCES "agents"("id"),
  "issue_id" uuid REFERENCES "issues"("id"),
  "run_id" uuid NOT NULL REFERENCES "heartbeat_runs"("id"),
  "adapter_type" text NOT NULL,
  "model" text NOT NULL DEFAULT 'unknown',
  "provider" text NOT NULL DEFAULT 'unknown',
  "status" text NOT NULL DEFAULT 'success',
  "input_tokens" integer,
  "output_tokens" integer,
  "cached_input_tokens" integer,
  "reasoning_tokens" integer,
  "tool_call_tokens" integer,
  "cost_cents" integer,
  "currency" text NOT NULL DEFAULT 'USD',
  "usage_reported_state" text NOT NULL DEFAULT 'not_reported',
  "usage_source_field" text,
  -- Coverage-aware fail-closed fields.
  -- Defaults are fail-closed: absent/uncertain source reporting → "unknown"/"unavailable".
  "coverage_state" text NOT NULL DEFAULT 'unknown',
  "source_status" text NOT NULL DEFAULT 'unavailable',
  "safe_status" text NOT NULL DEFAULT 'unavailable',
  "confidence" text NOT NULL DEFAULT 'low',
  -- Privacy/retention visibility classification fields (JAC-4533).
  "visibility_class" text NOT NULL DEFAULT 'internal',
  "retention_class" text NOT NULL DEFAULT 'standard',
  "redaction_state" text NOT NULL DEFAULT 'unredacted',
  "source_permission_ref" text,
  "tenant_ref_hash" text,
  "subject_ref_hashes" text[] DEFAULT '{}'::text[] NOT NULL,
  "source_deleted_at" timestamptz,
  "tombstone_ref" text,
  "policy_version" text,
  -- Event identity and idempotency fields (JAC-4532).
  "source_system" text NOT NULL DEFAULT 'paperclip',
  "source_event_id" text,
  "source_event_version" text,
  "event_kind" text NOT NULL DEFAULT 'adapter_execution',
  "attempt_index" integer NOT NULL DEFAULT 0,
  "observed_sequence" integer,
  "supersedes_event_id" text,
  -- Action-safety semantics (JAC-4534).
  "routing_status" text NOT NULL DEFAULT 'unknown',
  "quota_status" text NOT NULL DEFAULT 'unknown',
  "publication_status" text NOT NULL DEFAULT 'unknown',
  "work_state_confidence" text NOT NULL DEFAULT 'unknown',
  "pause_eligible_scope" text NOT NULL DEFAULT 'none',
  "operator_decision_required" boolean NOT NULL DEFAULT false,
  -- Ingestion tracking.
  "observed_at" timestamptz NOT NULL DEFAULT now(),
  "ingest_id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "payload_hash" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "run_events_company_run_idx"
  ON "run_events" USING btree ("company_id", "run_id");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "run_events_company_coverage_idx"
  ON "run_events" USING btree ("company_id", "coverage_state", "observed_at");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "run_events_company_safe_status_idx"
  ON "run_events" USING btree ("company_id", "safe_status", "observed_at");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "run_events_payload_hash_idx"
  ON "run_events" USING btree ("company_id", "payload_hash");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "run_events_source_event_uq"
  ON "run_events" USING btree ("company_id", "source_system", "source_event_id", "event_kind", "attempt_index");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "run_events_routing_idx"
  ON "run_events" USING btree ("company_id", "routing_status", "observed_at");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "run_events_action_safety_idx"
  ON "run_events" USING btree ("company_id", "routing_status", "quota_status", "publication_status");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "run_events_privacy_idx"
  ON "run_events" USING btree ("company_id", "visibility_class", "retention_class", "redaction_state");--> statement-breakpoint
