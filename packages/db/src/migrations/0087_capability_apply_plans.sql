-- LET-357: Capability Apply Plans (stub executor, live flag OFF)
-- Tables: capability_apply_plans, capability_apply_steps, capability_apply_events
-- Production migration is a SEPARATE ticket; do not apply to prod.

CREATE TABLE IF NOT EXISTS "capability_apply_plans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "base_desired_config_revision_id" text,
  "dry_run_hash" text NOT NULL,
  "state" text NOT NULL DEFAULT 'pending',
  "steps_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "redaction_summary_json" jsonb,
  "approval_id" uuid REFERENCES "approvals"("id") ON DELETE SET NULL,
  "created_by_user_id" text,
  "created_by_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "idempotency_key" text NOT NULL,
  "optimistic_version" integer NOT NULL DEFAULT 1,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "cap_apply_plans_company_agent_hash_uidx"
  ON "capability_apply_plans" ("company_id", "agent_id", "dry_run_hash");

CREATE UNIQUE INDEX IF NOT EXISTS "cap_apply_plans_idempotency_key_uidx"
  ON "capability_apply_plans" ("idempotency_key");

CREATE INDEX IF NOT EXISTS "cap_apply_plans_company_agent_idx"
  ON "capability_apply_plans" ("company_id", "agent_id");

CREATE TABLE IF NOT EXISTS "capability_apply_steps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "plan_id" uuid NOT NULL REFERENCES "capability_apply_plans"("id") ON DELETE CASCADE,
  "ordinal" integer NOT NULL,
  "kind" text NOT NULL,
  "target_ref_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "risk_class" text NOT NULL,
  "annotations_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "expected_named_secrets_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "state" text NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "last_error_code" text,
  "last_error_message" text,
  "before_snapshot_json" jsonb,
  "after_snapshot_json" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "cap_apply_steps_plan_ordinal_uidx"
  ON "capability_apply_steps" ("plan_id", "ordinal");

CREATE TABLE IF NOT EXISTS "capability_apply_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "plan_id" uuid NOT NULL REFERENCES "capability_apply_plans"("id") ON DELETE CASCADE,
  "step_id" uuid REFERENCES "capability_apply_steps"("id") ON DELETE SET NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "actor_user_id" text,
  "actor_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "run_id" uuid,
  "kind" text NOT NULL,
  "payload_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "cap_apply_events_plan_idx"
  ON "capability_apply_events" ("plan_id", "created_at");

CREATE INDEX IF NOT EXISTS "cap_apply_events_company_idx"
  ON "capability_apply_events" ("company_id", "created_at");

-- CHECK constraints — enforce allowed enum values at the DB layer per LET-353.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'capability_apply_plans_state_chk') THEN
    ALTER TABLE "capability_apply_plans"
      ADD CONSTRAINT "capability_apply_plans_state_chk"
      CHECK ("state" IN ('pending','approval_requested','approved','executing','applied','cancelled','declined','expired','partially_applied'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'capability_apply_steps_state_chk') THEN
    ALTER TABLE "capability_apply_steps"
      ADD CONSTRAINT "capability_apply_steps_state_chk"
      CHECK ("state" IN ('pending','executing','completed','failed','skipped'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'capability_apply_steps_risk_class_chk') THEN
    ALTER TABLE "capability_apply_steps"
      ADD CONSTRAINT "capability_apply_steps_risk_class_chk"
      CHECK ("risk_class" IN ('internal_safe','external_readonly','external_write','destructive_or_spend','governance_critical'));
  END IF;
END $$;
