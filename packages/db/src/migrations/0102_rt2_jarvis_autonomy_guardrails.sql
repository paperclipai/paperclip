CREATE TABLE IF NOT EXISTS "rt2_jarvis_rewrite_proposals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "project_id" uuid REFERENCES "projects"("id") ON DELETE set null,
  "target_type" text NOT NULL,
  "target_id" text NOT NULL,
  "target_key" text NOT NULL,
  "title" text NOT NULL,
  "status" text DEFAULT 'proposed' NOT NULL,
  "risk_level" text DEFAULT 'low' NOT NULL,
  "proposed_diff" jsonb NOT NULL,
  "rationale" text,
  "citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "contradiction_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "approval_id" uuid REFERENCES "approvals"("id") ON DELETE set null,
  "approval_route" text,
  "latest_eval" jsonb,
  "created_by" text DEFAULT 'system' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "rt2_jarvis_rewrite_proposals_company_status_idx"
  ON "rt2_jarvis_rewrite_proposals" ("company_id", "status");
CREATE INDEX IF NOT EXISTS "rt2_jarvis_rewrite_proposals_target_idx"
  ON "rt2_jarvis_rewrite_proposals" ("company_id", "target_type", "target_id");
CREATE INDEX IF NOT EXISTS "rt2_jarvis_rewrite_proposals_approval_idx"
  ON "rt2_jarvis_rewrite_proposals" ("approval_id");

CREATE TABLE IF NOT EXISTS "rt2_jarvis_rewrite_evals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "proposal_id" uuid NOT NULL REFERENCES "rt2_jarvis_rewrite_proposals"("id") ON DELETE cascade,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "provider_status" text DEFAULT 'not_run' NOT NULL,
  "fallback_status" text DEFAULT 'completed' NOT NULL,
  "provider_rubric" jsonb,
  "fallback_rubric" jsonb NOT NULL,
  "comparison" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "rt2_jarvis_rewrite_evals_proposal_idx"
  ON "rt2_jarvis_rewrite_evals" ("proposal_id");
CREATE INDEX IF NOT EXISTS "rt2_jarvis_rewrite_evals_company_created_idx"
  ON "rt2_jarvis_rewrite_evals" ("company_id", "created_at");
