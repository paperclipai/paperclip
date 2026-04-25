-- Phase 2.1: Model evaluation database schema
-- Tables: model_benchmark_runs, model_evaluations, agent_canary_pairings
-- Tracks model evaluation results, benchmark runs, and challenger testing per role

-- =============================================================================
-- Model Benchmark Runs
-- Tracks a batch of evaluations
-- =============================================================================
CREATE TABLE "model_benchmark_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "benchmark_type" text NOT NULL,
  "description" text,
  "status" text NOT NULL DEFAULT 'running',
  "total_tasks" integer NOT NULL DEFAULT 0,
  "completed_tasks" integer NOT NULL DEFAULT 0,
  "started_at" timestamptz NOT NULL DEFAULT NOW(),
  "completed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX "model_benchmark_runs_benchmark_type_idx" ON "model_benchmark_runs" ("benchmark_type");
CREATE INDEX "model_benchmark_runs_status_idx" ON "model_benchmark_runs" ("status");
CREATE INDEX "model_benchmark_runs_started_at_idx" ON "model_benchmark_runs" ("started_at");

-- =============================================================================
-- Model Evaluations
-- Tracks individual model evaluation results per task
-- =============================================================================
CREATE TABLE "model_evaluations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "role" text NOT NULL,
  "model" text NOT NULL,
  "harness" text NOT NULL,
  "subscription" text NOT NULL,
  "benchmark_type" text NOT NULL,
  "benchmark_run_id" uuid REFERENCES "model_benchmark_runs"("id"),
  "task_identifier" text NOT NULL,
  "task_outcome" text NOT NULL,
  "quality_score" real,
  "token_cost" integer,
  "latency_ms" integer,
  "evaluated_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX "model_evaluations_role_idx" ON "model_evaluations" ("role");
CREATE INDEX "model_evaluations_model_idx" ON "model_evaluations" ("model");
CREATE INDEX "model_evaluations_benchmark_run_id_idx" ON "model_evaluations" ("benchmark_run_id");
CREATE INDEX "model_evaluations_benchmark_type_idx" ON "model_evaluations" ("benchmark_type");
CREATE INDEX "model_evaluations_task_outcome_idx" ON "model_evaluations" ("task_outcome");
CREATE INDEX "model_evaluations_evaluated_at_idx" ON "model_evaluations" ("evaluated_at");

-- =============================================================================
-- Agent Canary Pairings
-- Tracks challenger testing per role
-- =============================================================================
CREATE TABLE "agent_canary_pairings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "role" text NOT NULL UNIQUE,
  "primary_model" text NOT NULL,
  "challenger_model" text NOT NULL,
  "primary_harness" text NOT NULL,
  "challenger_harness" text NOT NULL,
  "canary_percent" integer NOT NULL DEFAULT 20,
  "status" text NOT NULL DEFAULT 'active',
  "trials_started_at" timestamptz,
  "trials_completed_at" timestamptz,
  "recommendation" text,
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX "agent_canary_pairings_role_idx" ON "agent_canary_pairings" ("role");
CREATE INDEX "agent_canary_pairings_status_idx" ON "agent_canary_pairings" ("status");

-- =============================================================================
-- Updated_at trigger
-- =============================================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW."updated_at" = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_agent_canary_pairings_updated_at
  BEFORE UPDATE ON "agent_canary_pairings"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();