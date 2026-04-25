-- Phase 3.1: Experience layer schema (pgvector + pr_experiences + pr_outcomes)
-- Migration 0076 was supposed to add company_id to existing tables
-- But the original create migration was lost in repo resets
-- This migration (0078) creates the tables correctly WITH company_id

CREATE EXTENSION IF NOT EXISTS pgvector;

-- Create pr_experiences table (idempotent - IF NOT EXISTS)
CREATE TABLE IF NOT EXISTS "pr_experiences" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "pr_id" text NOT NULL,
  "company_id" uuid NOT NULL,
  "problem_summary" text NOT NULL,
  "solution_diff_summary" text NOT NULL,
  "review_feedback" text,
  "outcome_metric" text,
  "embedding" vector(384),
  "inserted_at" timestamptz NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "pr_experiences_company_id_idx" ON "pr_experiences" ("company_id");
CREATE INDEX IF NOT EXISTS "pr_experiences_pr_id_idx" ON "pr_experiences" ("pr_id");
CREATE INDEX IF NOT EXISTS "pr_experiences_embedding_idx" ON "pr_experiences" USING hnsw ("embedding" vector_cosine_ops);

-- Create pr_outcomes table (idempotent - IF NOT EXISTS)
CREATE TABLE IF NOT EXISTS "pr_outcomes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "pr_id" text NOT NULL UNIQUE,
  "company_id" uuid NOT NULL,
  "merged_at" timestamptz,
  "follow_up_fix_count" integer NOT NULL DEFAULT 0,
  "regression_caused" boolean NOT NULL DEFAULT false,
  "reverted_at" timestamptz,
  "customer_impact" text,
  "inserted_at" timestamptz NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "pr_outcomes_company_id_idx" ON "pr_outcomes" ("company_id");
CREATE INDEX IF NOT EXISTS "pr_outcomes_pr_id_idx" ON "pr_outcomes" ("pr_id");
CREATE INDEX IF NOT EXISTS "pr_outcomes_merged_at_idx" ON "pr_outcomes" ("merged_at");
CREATE INDEX IF NOT EXISTS "pr_outcomes_regression_caused_idx" ON "pr_outcomes" ("regression_caused");

-- Triggers for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_pr_experiences_updated_at ON "pr_experiences";
CREATE TRIGGER update_pr_experiences_updated_at
  BEFORE UPDATE ON "pr_experiences"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_pr_outcomes_updated_at ON "pr_outcomes";
CREATE TRIGGER update_pr_outcomes_updated_at
  BEFORE UPDATE ON "pr_outcomes"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();