-- Phase 1: 26 specialists in adversarial config
-- Tables for role definitions and adversarial PR review state machine

-- =============================================================================
-- agent_role_definitions: defines each specialist role with filesystem scope
-- =============================================================================
CREATE TABLE IF NOT EXISTS "agent_role_definitions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "role" text NOT NULL UNIQUE,
  "display_name" text NOT NULL,
  "description" text,
  "mounted_paths" text[] NOT NULL DEFAULT '{}',
  "read_only_paths" text[] NOT NULL DEFAULT '{}',
  "candidate_models" text[] NOT NULL DEFAULT '{}',
  "default_skills" text[] NOT NULL DEFAULT '{}',
  "prompt_template_id" uuid,
  "model_family" text NOT NULL,
  "max_rounds" integer NOT NULL DEFAULT 3,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_role_definitions_role_idx" ON "agent_role_definitions" ("role");
CREATE INDEX IF NOT EXISTS "agent_role_definitions_model_family_idx" ON "agent_role_definitions" ("model_family");
CREATE INDEX IF NOT EXISTS "agent_role_definitions_active_idx" ON "agent_role_definitions" ("is_active") WHERE "is_active" = true;

-- =============================================================================
-- pr_review_states: adversarial review state machine
-- Tracks round-by-round builder/breaker positions for each PR under review
-- =============================================================================
CREATE TABLE IF NOT EXISTS "pr_review_states" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "repository_full_name" text NOT NULL,
  "pr_number" integer NOT NULL,
  "head_sha" text NOT NULL,
  "round" integer NOT NULL DEFAULT 1,
  "builder_agent_id" uuid REFERENCES "agents"("id"),
  "breaker_agent_id" uuid REFERENCES "agents"("id"),
  "builder_position" text,
  "breaker_position" text,
  "builder_family" text,
  "breaker_family" text,
  "jury_invoked" boolean NOT NULL DEFAULT false,
  "jury_triggered_at" timestamptz,
  "jury_verdict" text,
  "jury_deliberated_at" timestamptz,
  "review_complete" boolean NOT NULL DEFAULT false,
  "review_complete_at" timestamptz,
  "last_activity_at" timestamptz NOT NULL DEFAULT NOW(),
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE ("repository_full_name", "pr_number", "head_sha")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pr_review_states_company_repo_pr_idx" ON "pr_review_states" ("company_id", "repository_full_name", "pr_number");
CREATE INDEX IF NOT EXISTS "pr_review_states_head_sha_idx" ON "pr_review_states" ("head_sha");
CREATE INDEX IF NOT EXISTS "pr_review_states_active_idx" ON "pr_review_states" ("review_complete") WHERE "review_complete" = false;
CREATE INDEX IF NOT EXISTS "pr_review_states_jury_idx" ON "pr_review_states" ("jury_invoked") WHERE "jury_invoked" = true AND "review_complete" = false;

-- =============================================================================
-- reviewer_family_log: enforces family diversity in reviews (audit trail)
-- Prevents same-family reviewer appearing twice in the same PR review chain
-- =============================================================================
CREATE TABLE IF NOT EXISTS "reviewer_family_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "pr_review_state_id" uuid NOT NULL REFERENCES "pr_review_states"("id") ON DELETE CASCADE,
  "round" integer NOT NULL,
  "reviewer_agent_id" uuid REFERENCES "agents"("id"),
  "reviewer_family" text NOT NULL,
  "review_type" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reviewer_family_log_state_round_idx" ON "reviewer_family_log" ("pr_review_state_id", "round");

-- =============================================================================
-- Functions for adversarial review state machine
-- =============================================================================

-- Advance to next round or invoke jury if max rounds reached
CREATE OR REPLACE FUNCTION advance_review_round(
  p_repository_full_name text,
  p_pr_number integer,
  p_head_sha text,
  p_builder_position text,
  p_breaker_position text
) RETURNS pr_review_states AS $$
DECLARE
  v_state pr_review_states%ROWTYPE;
  v_max_rounds integer;
BEGIN
  SELECT * INTO v_state
  FROM pr_review_states
  WHERE repository_full_name = p_repository_full_name
    AND pr_number = p_pr_number
    AND head_sha = p_head_sha;

  IF v_state.id IS NULL THEN
    RAISE EXCEPTION 'PR review state not found for % #% at %',
      p_repository_full_name, p_pr_number, p_head_sha;
  END IF;

  SELECT max_rounds INTO v_max_rounds
  FROM agent_role_definitions
  WHERE role = 'breaker';

  IF v_state.round >= COALESCE(v_max_rounds, 3) AND NOT v_state.jury_invoked THEN
    UPDATE pr_review_states
    SET
      builder_position = p_builder_position,
      breaker_position = p_breaker_position,
      round = round + 1,
      jury_invoked = true,
      jury_triggered_at = NOW(),
      last_activity_at = NOW(),
      updated_at = NOW()
    WHERE id = v_state.id
    RETURNING * INTO v_state;
  ELSE
    UPDATE pr_review_states
    SET
      builder_position = p_builder_position,
      breaker_position = p_breaker_position,
      round = round + 1,
      last_activity_at = NOW(),
      updated_at = NOW()
    WHERE id = v_state.id
    RETURNING * INTO v_state;
  END IF;

  RETURN v_state;
END;
$$ LANGUAGE plpgsql;

-- Complete review and record verdict
CREATE OR REPLACE FUNCTION complete_pr_review(
  p_repository_full_name text,
  p_pr_number integer,
  p_head_sha text,
  p_jury_verdict text DEFAULT NULL
) RETURNS pr_review_states AS $$
DECLARE
  v_state pr_review_states%ROWTYPE;
BEGIN
  UPDATE pr_review_states
  SET
    review_complete = true,
    review_complete_at = NOW(),
    jury_verdict = p_jury_verdict,
    last_activity_at = NOW(),
    updated_at = NOW()
  WHERE repository_full_name = p_repository_full_name
    AND pr_number = p_pr_number
    AND head_sha = p_head_sha
  RETURNING * INTO v_state;
  RETURN v_state;
END;
$$ LANGUAGE plpgsql;

-- Check if a reviewer family is already used in current round chain
CREATE OR REPLACE FUNCTION is_family_exhausted_for_pr(
  p_repository_full_name text,
  p_pr_number integer,
  p_head_sha text,
  p_reviewer_family text
) RETURNS boolean AS $$
DECLARE
  v_used_families text[];
BEGIN
  SELECT ARRAY_AGG(DISTINCT rfl.reviewer_family) INTO v_used_families
  FROM reviewer_family_log rfl
  JOIN pr_review_states prs ON rfl.pr_review_state_id = prs.id
  WHERE prs.repository_full_name = p_repository_full_name
    AND prs.pr_number = p_pr_number
    AND prs.head_sha = p_head_sha
    AND prs.review_complete = false;

  RETURN p_reviewer_family = ANY(v_used_families);
END;
$$ LANGUAGE plpgsql STABLE;

-- Record a reviewer's participation in the adversarial chain
CREATE OR REPLACE FUNCTION record_reviewer_participation(
  p_pr_review_state_id uuid,
  p_round integer,
  p_reviewer_agent_id uuid,
  p_reviewer_family text,
  p_review_type text
) RETURNS reviewer_family_log AS $$
DECLARE
  v_log_entry reviewer_family_log%ROWTYPE;
BEGIN
  INSERT INTO reviewer_family_log (
    pr_review_state_id, round, reviewer_agent_id, reviewer_family, review_type
  ) VALUES (
    p_pr_review_state_id, p_round, p_reviewer_agent_id, p_reviewer_family, p_review_type
  )
  RETURNING * INTO v_log_entry;
  RETURN v_log_entry;
END;
$$ LANGUAGE plpgsql;

-- Get next eligible breaker candidate respecting family diversity
-- Returns agent_id or NULL if no eligible candidate
CREATE OR REPLACE FUNCTION get_next_breaker_candidate(
  p_repository_full_name text,
  p_pr_number integer,
  p_head_sha text,
  p_breaker_role text DEFAULT 'breaker'
) RETURNS uuid AS $$
DECLARE
  v_state pr_review_states%ROWTYPE;
  v_used_families text[];
  v_candidate_id uuid;
BEGIN
  SELECT * INTO v_state
  FROM pr_review_states
  WHERE repository_full_name = p_repository_full_name
    AND pr_number = p_pr_number
    AND head_sha = p_head_sha;

  IF v_state.id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT ARRAY_AGG(DISTINCT rfl.reviewer_family) INTO v_used_families
  FROM reviewer_family_log rfl
  WHERE rfl.pr_review_state_id = v_state.id;

  SELECT a.id INTO v_candidate_id
  FROM agents a
  JOIN agent_role_candidates arc ON a.role = arc.role
  WHERE arc.role = p_breaker_role
    AND arc.is_saturated = false
    AND a.status NOT IN ('paused', 'terminated')
    AND (
      v_used_families IS NULL
      OR arc.provider NOT IN (SELECT unnest(v_used_families))
    )
  ORDER BY arc.quality_rank DESC
  LIMIT 1;

  RETURN v_candidate_id;
END;
$$ LANGUAGE plpgsql STABLE;

-- =============================================================================
-- Seed default role definitions for the 26 specialists
-- =============================================================================

INSERT INTO "agent_role_definitions" ("role", "display_name", "description", "mounted_paths", "read_only_paths", "candidate_models", "default_skills", "model_family", "max_rounds") VALUES
  ('ui_engineer', 'UI Engineer', 'Builds user interfaces with React/Next.js', ARRAY['src/app', 'src/components', 'src/lib/ui', 'apps/web'], ARRAY['node_modules', '.git', 'packages/db'], ARRAY['claude-sonnet-4-6', 'gpt-5.1-codex'], ARRAY['react', 'typescript', 'css', 'shadcn-ui'], 'claude', 3),
  ('backend_engineer', 'Backend Engineer', 'Builds APIs and server logic', ARRAY['packages/api', 'packages/shared', 'src/lib'], ARRAY['node_modules', '.git', 'packages/db/src/migrations'], ARRAY['claude-sonnet-4-6', 'gpt-5.1-codex'], ARRAY['typescript', 'node.js', 'postgres', 'api-design'], 'claude', 3),
  ('data_engineer', 'Data Engineer', 'Data pipelines, storage, and processing', ARRAY['packages/db', 'src/lib/storage', 'src/lib/ingestion'], ARRAY['node_modules', '.git'], ARRAY['claude-sonnet-4-6', 'gemini-2.5-pro'], ARRAY['sql', 'postgres', 'data-modeling', 'etl'], 'claude', 3),
  ('devops_engineer', 'DevOps Engineer', 'Infrastructure, deployment, and operations', ARRAY['Dockerfile', 'docker', '.github/workflows', 'scripts', 'infra'], ARRAY['node_modules', '.git'], ARRAY['claude-sonnet-4-6', 'gpt-5.1-codex'], ARRAY['docker', 'kubernetes', 'ci-cd', 'infrastructure', 'bash'], 'claude', 3),
  ('test_engineer', 'Test Engineer', 'QA, testing, and verification', ARRAY['src', 'packages', '__tests__', 'tests'], ARRAY['node_modules', '.git'], ARRAY['claude-sonnet-4-6'], ARRAY['testing', 'jest', 'playwright', 'test-automation', 'quality'], 'claude', 3),
  ('refactorer', 'Refactorer', 'Code quality, debt reduction, and cleanup', ARRAY['src', 'packages'], ARRAY['node_modules', '.git', 'packages/db/src/migrations'], ARRAY['claude-opus-4-7'], ARRAY['refactoring', 'typescript', 'code-review', 'technical-debt'], 'claude', 3),
  ('architect', 'Architect', 'System design and technical decisions', ARRAY['src', 'packages', 'docs', 'plans'], ARRAY['node_modules'], ARRAY['claude-opus-4-7'], ARRAY['system-design', 'architecture', 'technical-planning', 'decision-making'], 'claude', 5),
  ('mobile_engineer', 'Mobile Engineer', 'React Native and mobile development', ARRAY['src', 'apps/mobile', 'packages/mobile'], ARRAY['node_modules', '.git'], ARRAY['claude-sonnet-4-6'], ARRAY['react-native', 'typescript', 'mobile', 'ios', 'android'], 'claude', 3),
  ('designer', 'Designer', 'UI/UX design and visual direction', ARRAY['src/app', 'src/components', 'src/styles', 'figma'], ARRAY['node_modules', '.git', 'packages/db'], ARRAY['claude-opus-4-7', 'gemini-2.5-pro'], ARRAY['design', 'figma', 'ui-design', 'ux-research', 'visual-design'], 'claude', 3),
  ('image_producer', 'Image Producer', 'Generates visual assets and marketing images', ARRAY['public', 'src/assets', 'src/images', 'marketing'], ARRAY['node_modules', '.git', 'packages/db'], ARRAY['claude-sonnet-4-6'], ARRAY['image-generation', 'flux', 'comfyui', 'marketing-assets', 'visual-content'], 'claude', 3),
  ('marketer', 'Marketer / Content', 'Content creation and marketing', ARRAY['src/app', 'src/content', 'marketing', 'docs'], ARRAY['node_modules', '.git', 'packages/db', 'packages/api'], ARRAY['claude-opus-4-7'], ARRAY['content-writing', 'seo', 'marketing', 'copywriting', 'positioning'], 'claude', 3),
  ('qa_reviewer', 'QA Reviewer', 'Quality assurance and acceptance testing', ARRAY['src', 'packages', '__tests__', 'tests'], ARRAY['node_modules', '.git'], ARRAY['kimi-k2.5', 'gpt-5.1-codex', 'gemini-2.5-pro'], ARRAY['qa', 'testing', 'acceptance-criteria', 'test-planning', 'bug-triaging'], 'kimi', 3),
  ('security_reviewer', 'Security Reviewer', 'Security analysis and vulnerability assessment', ARRAY['src', 'packages', 'security'], ARRAY['node_modules', '.git'], ARRAY['gpt-5.1-codex', 'claude-sonnet-4-6'], ARRAY['security', 'penetration-testing', 'vulnerability-assessment', 'owasp'], 'openai', 3),
  ('perf_reviewer', 'Performance Reviewer', 'Performance analysis and optimization', ARRAY['src', 'packages', 'perf-tests'], ARRAY['node_modules', '.git'], ARRAY['gemini-2.5-pro', 'claude-sonnet-4-6'], ARRAY['performance', 'profiling', 'optimization', 'load-testing', 'latency'], 'google', 3),
  ('ceo', 'CEO', 'Strategic direction and board coordination', ARRAY['.'], ARRAY[], ARRAY['claude-opus-4-7'], ARRAY['strategy', 'leadership', 'decision-making', 'board-relations'], 'claude', 3),
  ('chief_of_staff', 'Chief of Staff', 'Operations and coordination', ARRAY['.'], ARRAY[], ARRAY['claude-sonnet-4-6'], ARRAY['operations', 'coordination', 'process', 'executive-support'], 'claude', 3)
ON CONFLICT ("role") DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  mounted_paths = EXCLUDED.mounted_paths,
  read_only_paths = EXCLUDED.read_only_paths,
  candidate_models = EXCLUDED.candidate_models,
  default_skills = EXCLUDED.default_skills,
  model_family = EXCLUDED.model_family,
  max_rounds = EXCLUDED.max_rounds,
  updated_at = NOW();
