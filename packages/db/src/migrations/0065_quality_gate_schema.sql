-- Migration: 0065_quality_gate_schema
-- Phase 0.1: Quality gate (done = actually shipped)
-- Adds proof tracking columns to issues and new tables for CI/Live URL verification

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pr_ci_status" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "repository_full_name" text NOT NULL,
  "pr_number" integer NOT NULL,
  "head_sha" text NOT NULL,
  "workflow_run_id" text,
  "check_run_id" text,
  "check_run_name" text,
  "conclusion" text,
  "status" text,
  "url" text,
  "review_approved_at" timestamptz,
  "review_approved_by" text,
  "review_state" text,
  "received_at" timestamptz NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "pr_ci_status_company_repo_pr_idx" ON "pr_ci_status" ("company_id", "repository_full_name", "pr_number");
CREATE INDEX IF NOT EXISTS "pr_ci_status_head_sha_idx" ON "pr_ci_status" ("head_sha");
CREATE UNIQUE INDEX IF NOT EXISTS "pr_ci_status_workflow_run_id_idx" ON "pr_ci_status" ("workflow_run_id") WHERE "workflow_run_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "pr_ci_status_check_run_id_idx" ON "pr_ci_status" ("check_run_id") WHERE "check_run_id" IS NOT NULL;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_probe_specs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "app_name" text NOT NULL,
  "probe_url" text NOT NULL,
  "expected_status" integer NOT NULL DEFAULT 200,
  "body_regex" text,
  "body_excludes_regex" text,
  "smoke_endpoints" text[],
  "min_uptime_seconds" integer NOT NULL DEFAULT 30,
  "is_active" boolean NOT NULL DEFAULT true,
  "last_probed_at" timestamptz,
  "last_probe_result" text,
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "app_probe_specs_company_app_idx" ON "app_probe_specs" ("company_id", "app_name");
CREATE INDEX IF NOT EXISTS "app_probe_specs_active_idx" ON "app_probe_specs" ("is_active");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "issue_kind_proof_specs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "issue_kind" text NOT NULL UNIQUE,
  "requires_ci_proof" boolean NOT NULL DEFAULT true,
  "requires_live_url_proof" boolean NOT NULL DEFAULT false,
  "requires_review_approval" boolean NOT NULL DEFAULT false,
  "requires_doc_proof" boolean NOT NULL DEFAULT false,
  "proof_type_config" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "issue_kind_proof_specs_kind_idx" ON "issue_kind_proof_specs" ("issue_kind");

--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "proof_ci_url" text;
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "proof_live_url" text;
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "proof_status" text NOT NULL DEFAULT 'pending';
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "proof_verified_at" timestamptz;
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "proof_doc_id" uuid;

--> statement-breakpoint
-- Seed default proof specs for each issue kind
INSERT INTO "issue_kind_proof_specs" ("issue_kind", "requires_ci_proof", "requires_live_url_proof", "requires_review_approval", "requires_doc_proof", "proof_type_config") VALUES
  ('FIX', true, false, true, false, '{"ci": {"minConclusion": "success"}, "review": {"minApprovals": 1}}'),
  ('BUILD', true, true, true, false, '{"ci": {"minConclusion": "success"}, "liveUrl": {"minStatus": 200}, "review": {"minApprovals": 1}}'),
  ('REVIEW', false, false, false, false, '{"review": {"minApprovals": 1}}'),
  ('DEPLOY', true, true, false, false, '{"ci": {"minConclusion": "success"}, "liveUrl": {"minStatus": 200}}'),
  ('BREAK', false, false, false, false, '{}')
ON CONFLICT ("issue_kind") DO NOTHING;

--> statement-breakpoint
-- Trigger to enforce proof_status='verified' before status='done' transition
-- This is a DB-level backstop; the application middleware is the primary enforcement
CREATE OR REPLACE FUNCTION check_issue_proof_before_done()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'done' AND OLD.status != 'done' AND NEW.proof_status != 'verified' THEN
    RAISE EXCEPTION 'Cannot mark issue as done without verified proof (current proof_status: %)', NEW.proof_status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_check_issue_proof_before_done ON issues;
CREATE TRIGGER trigger_check_issue_proof_before_done
  BEFORE UPDATE OF status ON issues
  FOR EACH ROW
  EXECUTE FUNCTION check_issue_proof_before_done();
