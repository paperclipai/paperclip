-- Migration: skill_eval_results table for AI-assisted skill curation eval gate
-- Parent issue: KIT-3652 (Phase 1e - AI-assisted skill curation scaffold + eval gate)

CREATE TABLE IF NOT EXISTS skill_eval_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id uuid NOT NULL REFERENCES synthesized_skills(id) ON DELETE CASCADE,
  eval_run_id text NOT NULL,
  score real NOT NULL CHECK (score >= 0 AND score <= 1),
  test_tasks text NOT NULL,
  passed boolean NOT NULL DEFAULT false,
  reviewed_at timestamptz,
  reviewer_agent_id uuid,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE(skill_id, eval_run_id)
);

CREATE INDEX IF NOT EXISTS skill_eval_results_skill_id_idx ON skill_eval_results(skill_id);
CREATE INDEX IF NOT EXISTS skill_eval_results_eval_run_id_idx ON skill_eval_results(eval_run_id);
CREATE INDEX IF NOT EXISTS skill_eval_results_passed_idx ON skill_eval_results(passed);