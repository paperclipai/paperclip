-- Skills Marketplace System
-- Enables extensibility through reusable, composable skills

-- Skills library (all available skills)
CREATE TABLE skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL,
  category TEXT NOT NULL, -- math, text, data, utility, custom
  description TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '1.0.0',
  status TEXT NOT NULL DEFAULT 'published', -- published, draft, deprecated
  author_id UUID REFERENCES users(id),
  parameters JSONB,  -- JSON schema for input parameters
  returns JSONB,     -- JSON schema for return value
  source_code TEXT,  -- Full implementation (JS or Python)
  runtime TEXT,      -- 'javascript' or 'python'
  is_builtin BOOLEAN DEFAULT false,
  download_count INTEGER DEFAULT 0,
  rating FLOAT DEFAULT 0.0,
  rating_count INTEGER DEFAULT 0,
  repository_url TEXT,
  documentation_url TEXT,
  tags TEXT[],       -- e.g. ['math', 'calculate', 'numbers']
  dependencies JSONB, -- e.g. {"lodash": "^4.0.0"}
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  published_at TIMESTAMP WITH TIME ZONE,
  INDEX skills_name_idx (name),
  INDEX skills_category_idx (category),
  INDEX skills_status_idx (status),
  INDEX skills_tags_idx USING GIN (tags)
);

-- Skill installations (which agents/companies have installed which skills)
CREATE TABLE skill_installations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE, -- NULL = company-wide
  version TEXT NOT NULL, -- Version of skill when installed
  enabled BOOLEAN DEFAULT true,
  configuration JSONB,  -- Custom config for this installation
  installed_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(skill_id, company_id, agent_id),
  INDEX skill_installations_company_idx (company_id),
  INDEX skill_installations_agent_idx (agent_id),
  INDEX skill_installations_skill_idx (skill_id)
);

-- Skill execution logs
CREATE TABLE skill_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  workflow_run_id UUID,  -- NULL if run from agent chat, reference if from workflow
  status TEXT NOT NULL, -- 'pending', 'running', 'success', 'error'
  input_data JSONB,
  output_data JSONB,
  error_message TEXT,
  execution_time_ms INTEGER,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE,
  INDEX skill_executions_agent_idx (agent_id),
  INDEX skill_executions_status_idx (status),
  INDEX skill_executions_created_idx (created_at)
);

-- Skill ratings and reviews
CREATE TABLE skill_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  review_text TEXT,
  helpful_count INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(skill_id, user_id),
  INDEX skill_reviews_skill_idx (skill_id),
  INDEX skill_reviews_rating_idx (rating)
);
