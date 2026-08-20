-- JAC-4529 (P0 of JAC-3929): add coverage-aware fail-closed fields to cost_events.
-- JAC-4532: add event identity and idempotency fields.
-- JAC-4533: add privacy/retention visibility classification fields.
-- New columns: reasoning_tokens, tool_call_tokens, currency, pricing_version_ref,
-- coverage_state, source_status, safe_status, confidence, coverage_warning,
-- visibility_class, retention_class, redaction_state, source_permission_ref,
-- tenant_ref_hash, subject_ref_hashes, source_deleted_at, tombstone_ref,
-- policy_version, source_system, source_event_id, source_event_version,
-- event_kind, attempt_index.
-- New index: cost_events_company_coverage_idx.

ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "reasoning_tokens" integer;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "tool_call_tokens" integer;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "currency" text DEFAULT 'USD' NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "pricing_version_ref" text;--> statement-breakpoint

-- Coverage-aware fail-closed fields.
-- Defaults are fail-closed: absent/uncertain source reporting → "unknown"/"unavailable".
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "coverage_state" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "source_status" text DEFAULT 'unavailable' NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "safe_status" text DEFAULT 'unavailable' NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "confidence" text DEFAULT 'low' NOT NULL;--> statement-breakpoint

-- Coverage warning: surfaced separately from spend totals so consumers can
-- distinguish "zero because no tokens used" from "zero because not reported".
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "coverage_warning" text;--> statement-breakpoint

-- Privacy/retention visibility classification fields (JAC-4533).
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "visibility_class" text DEFAULT 'internal' NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "retention_class" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "redaction_state" text DEFAULT 'unredacted' NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "source_permission_ref" text;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "tenant_ref_hash" text;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "subject_ref_hashes" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "source_deleted_at" timestamptz;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "tombstone_ref" text;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "policy_version" text;--> statement-breakpoint

-- Event identity and idempotency fields (JAC-4532).
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "source_system" text DEFAULT 'paperclip' NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "source_event_id" text;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "source_event_version" text;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "event_kind" text DEFAULT 'cost_report' NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "attempt_index" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
