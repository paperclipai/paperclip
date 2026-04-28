CREATE TABLE IF NOT EXISTS "rt2_reverse_design_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "target_type" text NOT NULL,
  "target_id" uuid NOT NULL,
  "result_data" jsonb NOT NULL,
  "context_data" jsonb,
  "method" text DEFAULT 'auto' NOT NULL,
  "inferred_causes" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "root_cause" text,
  "confidence_score" integer DEFAULT 0 NOT NULL,
  "reconstructed_process" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reverse_design_runs_company_idx" ON "rt2_reverse_design_runs" ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reverse_design_runs_target_idx" ON "rt2_reverse_design_runs" ("target_type","target_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reverse_design_runs_status_idx" ON "rt2_reverse_design_runs" ("status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rt2_process_mining_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "process_type" text NOT NULL,
  "process_key" text NOT NULL,
  "traces" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "patterns" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "bottlenecks" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "total_executions" integer DEFAULT 0 NOT NULL,
  "success_rate" integer DEFAULT 0 NOT NULL,
  "avg_duration_ms" integer DEFAULT 0 NOT NULL,
  "recommendations" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "process_mining_snapshots_company_idx" ON "rt2_process_mining_snapshots" ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "process_mining_snapshots_process_type_idx" ON "rt2_process_mining_snapshots" ("process_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "process_mining_snapshots_process_key_idx" ON "rt2_process_mining_snapshots" ("process_key");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rt2_runtime_skill_injections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "agent_id" uuid NOT NULL,
  "skill_id" uuid REFERENCES "companies"("id"),
  "skill_key" text NOT NULL,
  "context" jsonb,
  "injection_type" text DEFAULT 'prompt' NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "effectiveness_score" integer DEFAULT 0 NOT NULL,
  "usage_count" integer DEFAULT 0 NOT NULL,
  "last_used_at" timestamp with time zone,
  "activated_at" timestamp with time zone,
  "expires_at" timestamp with time zone,
  "deactivated_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runtime_skill_injections_company_idx" ON "rt2_runtime_skill_injections" ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runtime_skill_injections_agent_idx" ON "rt2_runtime_skill_injections" ("agent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runtime_skill_injections_skill_key_idx" ON "rt2_runtime_skill_injections" ("skill_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runtime_skill_injections_status_idx" ON "rt2_runtime_skill_injections" ("status");
