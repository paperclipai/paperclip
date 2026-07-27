CREATE TABLE IF NOT EXISTS "company_agent_manager_settings" (
  "company_id" uuid PRIMARY KEY NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "enabled" boolean DEFAULT false NOT NULL,
  "supervisor_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "escalation_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "judge_model_profile" text DEFAULT 'cheap' NOT NULL,
  "score_threshold" integer DEFAULT 70 NOT NULL,
  "max_reflection_attempts" integer DEFAULT 3 NOT NULL,
  "evaluate_failed_runs" boolean DEFAULT true NOT NULL,
  "evaluate_needs_followup" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "issue_supervision_state" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE CASCADE,
  "reflection_attempt_count" integer DEFAULT 0 NOT NULL,
  "last_evaluation_id" uuid,
  "last_score" integer,
  "escalated_at" timestamp with time zone,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_supervision_state_issue_uq" ON "issue_supervision_state" ("issue_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_supervision_state_company_issue_idx" ON "issue_supervision_state" ("company_id", "issue_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_manager_evaluations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE CASCADE,
  "run_id" uuid NOT NULL REFERENCES "heartbeat_runs"("id") ON DELETE CASCADE,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "supervisor_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "trigger" text NOT NULL,
  "score" integer,
  "rationale" text,
  "criteria_results" jsonb,
  "corrections" jsonb,
  "outcome" text NOT NULL,
  "reflection_attempt" integer DEFAULT 0 NOT NULL,
  "judge_model" text,
  "judge_latency_ms" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_manager_evaluations_run_uq" ON "agent_manager_evaluations" ("run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_manager_evaluations_company_issue_idx" ON "agent_manager_evaluations" ("company_id", "issue_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_manager_evaluations_company_created_idx" ON "agent_manager_evaluations" ("company_id", "created_at");
