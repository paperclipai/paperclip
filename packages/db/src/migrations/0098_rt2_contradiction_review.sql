CREATE TABLE IF NOT EXISTS "rt2_v33_contradiction_candidates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "project_id" uuid REFERENCES "projects"("id") ON DELETE set null,
  "status" text DEFAULT 'open' NOT NULL,
  "reason_code" text NOT NULL,
  "title" text NOT NULL,
  "explanation" text,
  "source_type" text NOT NULL,
  "source_id" text NOT NULL,
  "source_key" text NOT NULL,
  "conflicting_source_type" text NOT NULL,
  "conflicting_source_id" text NOT NULL,
  "conflicting_source_key" text NOT NULL,
  "confidence" text DEFAULT 'unknown' NOT NULL,
  "raw_evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "deterministic_signals" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "provider_explanation" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "rt2_v33_contra_candidates_company_status_idx"
  ON "rt2_v33_contradiction_candidates" ("company_id", "status");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "rt2_v33_contra_candidates_project_status_idx"
  ON "rt2_v33_contradiction_candidates" ("company_id", "project_id", "status");
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "rt2_v33_contra_candidates_source_pair_uq"
  ON "rt2_v33_contradiction_candidates" (
    "company_id",
    "reason_code",
    "source_type",
    "source_id",
    "conflicting_source_type",
    "conflicting_source_id"
  );
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "rt2_v33_contradiction_resolutions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "candidate_id" uuid NOT NULL REFERENCES "rt2_v33_contradiction_candidates"("id") ON DELETE cascade,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "decision" text NOT NULL,
  "reason" text NOT NULL,
  "follow_up_issue_id" uuid,
  "resolved_by" text NOT NULL,
  "audit_event_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "rt2_v33_contra_resolutions_candidate_idx"
  ON "rt2_v33_contradiction_resolutions" ("company_id", "candidate_id");
