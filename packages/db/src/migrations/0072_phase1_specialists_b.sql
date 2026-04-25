-- Phase 1: seed remaining specialist role definitions (10 new instances)
-- Brings total specialist roster to 26 agents

-- =============================================================================
-- Additional role definitions for second-pair specialists
-- =============================================================================

INSERT INTO "agent_role_definitions" ("role", "display_name", "description", "mounted_paths", "read_only_paths", "candidate_models", "default_skills", "model_family", "max_rounds") VALUES
  ('ui_engineer_2', 'UI Engineer #2', 'Builds user interfaces with React/Next.js (GPT-5.1 pair)', ARRAY['src/app', 'src/components', 'src/lib/ui', 'apps/web'], ARRAY['node_modules', '.git', 'packages/db'], ARRAY['gpt-5.1-codex'], ARRAY['react', 'typescript', 'css', 'shadcn-ui'], 'openai', 3),
  ('backend_engineer_2', 'Backend Engineer #2', 'Builds APIs and server logic (GPT-5.1 pair)', ARRAY['packages/api', 'packages/shared', 'src/lib'], ARRAY['node_modules', '.git', 'packages/db/src/migrations'], ARRAY['gpt-5.1-codex'], ARRAY['typescript', 'node.js', 'postgres', 'api-design'], 'openai', 3),
  ('data_engineer_2', 'Data Engineer #2', 'Data pipelines and processing (Gemini pair)', ARRAY['packages/db', 'src/lib/storage', 'src/lib/ingestion'], ARRAY['node_modules', '.git'], ARRAY['gemini-2.5-pro'], ARRAY['sql', 'postgres', 'data-modeling', 'etl'], 'google', 3),
  ('devops_engineer_2', 'DevOps Engineer #2', 'Infrastructure and deployment (GPT-5.1 pair)', ARRAY['Dockerfile', 'docker', '.github/workflows', 'scripts', 'infra'], ARRAY['node_modules', '.git'], ARRAY['gpt-5.1-codex'], ARRAY['docker', 'kubernetes', 'ci-cd', 'infrastructure', 'bash'], 'openai', 3),
  ('designer_2', 'Designer #2', 'UI/UX design (Gemini pair)', ARRAY['src/app', 'src/components', 'src/styles', 'figma'], ARRAY['node_modules', '.git', 'packages/db'], ARRAY['gemini-2.5-pro'], ARRAY['design', 'figma', 'ui-design', 'ux-research', 'visual-design'], 'google', 3),
  ('qa_reviewer_3', 'QA Reviewer #3', 'Quality assurance and acceptance testing (GPT-5.1 instance)', ARRAY['src', 'packages', '__tests__', 'tests'], ARRAY['node_modules', '.git'], ARRAY['gpt-5.1-codex'], ARRAY['qa', 'testing', 'acceptance-criteria', 'test-planning', 'bug-triaging'], 'openai', 3),
  ('security_reviewer_2', 'Security Reviewer #2', 'Security analysis (Gemini instance)', ARRAY['src', 'packages', 'security'], ARRAY['node_modules', '.git'], ARRAY['gemini-2.5-pro'], ARRAY['security', 'penetration-testing', 'vulnerability-assessment', 'owasp'], 'google', 3),
  ('perf_reviewer_2', 'Performance Reviewer #2', 'Performance analysis (BytePlus instance)', ARRAY['src', 'packages', 'perf-tests'], ARRAY['node_modules', '.git'], ARRAY['kimi-k2.5'], ARRAY['performance', 'profiling', 'optimization', 'load-testing', 'latency'], 'byteplus', 3)
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

-- =============================================================================
-- Add role candidates for the new specialist instances
-- =============================================================================

INSERT INTO "agent_role_candidates" ("role", "model", "harness", "subscription", "provider", "quality_rank") VALUES
  ('ui_engineer_2', 'gpt-5.1-codex', 'codex_local', 'ChatGPT Pro 20x', 'openai', 0.95),
  ('backend_engineer_2', 'gpt-5.1-codex', 'codex_local', 'ChatGPT Pro 20x', 'openai', 0.95),
  ('data_engineer_2', 'gemini-2.5-pro', 'gemini_local', 'Gemini AI Ultra', 'google', 0.85),
  ('devops_engineer_2', 'gpt-5.1-codex', 'codex_local', 'ChatGPT Pro 20x', 'openai', 0.95),
  ('designer_2', 'gemini-2.5-pro', 'gemini_local', 'Gemini AI Ultra', 'google', 0.85),
  ('qa_reviewer_3', 'gpt-5.1-codex', 'codex_local', 'ChatGPT Pro 20x', 'openai', 0.9),
  ('security_reviewer_2', 'gemini-2.5-pro', 'gemini_local', 'Gemini AI Ultra', 'google', 0.8),
  ('perf_reviewer_2', 'kimi-k2.5', 'opencode_local', 'BytePlus Coding Plan', 'byteplus', 0.85)
ON CONFLICT ("role", "model", "harness") DO UPDATE SET
  subscription = EXCLUDED.subscription,
  provider = EXCLUDED.provider,
  quality_rank = EXCLUDED.quality_rank,
  updated_at = NOW();
