-- Migration: synthesized_skills table for skill synthesizer
-- Parent issue: KIT-3609 (K.2.1 Skill synthesizer with eval gate)

CREATE TABLE IF NOT EXISTS synthesized_skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_id uuid NOT NULL REFERENCES knowledge_topics(id) ON DELETE CASCADE,
  skill_name text NOT NULL,
  skill_path text NOT NULL,
  status text NOT NULL DEFAULT 'pending_eval' CHECK (status IN ('pending_eval', 'published', 'needs_human_review', 'archived')),
  eval_score numeric(3,2),
  eval_tasks jsonb,
  synthesized_at timestamptz NOT NULL DEFAULT NOW(),
  reviewed_at timestamptz,
  reviewed_by uuid,
  UNIQUE(topic_id)
);

CREATE INDEX IF NOT EXISTS synthesized_skills_topic_id_idx ON synthesized_skills(topic_id);
CREATE INDEX IF NOT EXISTS synthesized_skills_status_idx ON synthesized_skills(status);
CREATE INDEX IF NOT EXISTS synthesized_skills_skill_name_idx ON synthesized_skills(skill_name);