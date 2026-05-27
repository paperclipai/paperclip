export interface BrabrixSkillHubSearchParams {
  query?: string | null;
  category?: string | null;
  tags?: string[];
  limit?: number;
  offset?: number;
}

export interface BrabrixSkillHubContentBlock {
  type: "markdown" | "prompt" | "rules" | "workflow" | "architecture" | "convention" | "context" | "unknown";
  title?: string | null;
  content: string;
}

export interface BrabrixSkillHubSkill {
  id: string;
  slug: string;
  name: string;
  summary?: string | null;
  description?: string | null;
  category?: string | null;
  tags: string[];
  featured: boolean;
  version?: string | null;
  updatedAt?: string | null;
  author?: string | null;
  contentBlocks: BrabrixSkillHubContentBlock[];
  metadata?: Record<string, unknown>;
}

export interface BrabrixSkillHubSearchResponse {
  skills: BrabrixSkillHubSkill[];
  total: number | null;
}

export interface BrabrixSkillHubCategory {
  key: string;
  label: string;
  description?: string | null;
}

export interface BrabrixSkillHubConfig {
  apiUrl: string | null;
  enabled: boolean;
  apiToken: string | null;
  apiKey: string | null;
  endpoints: {
    searchSkills: string;
    getSkillById: string;
    getSkillCategories: string;
    getFeaturedSkills: string;
  };
  timeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
}

export interface BrabrixSkillHubReadyConfig {
  apiUrl: string;
  apiToken: string | null;
  apiKey: string | null;
  endpoints: {
    searchSkills: string;
    getSkillById: string;
    getSkillCategories: string;
    getFeaturedSkills: string;
  };
  timeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
}
