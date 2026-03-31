import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { ToolResult } from "@paperclipai/plugin-sdk";

const SKILLS_HUB_URL = process.env.SKILLS_HUB_URL || "http://localhost:8100";

async function fetchAPI(endpoint: string, options: RequestInit = {}): Promise<any> {
  const response = await fetch(`${SKILLS_HUB_URL}${endpoint}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`Skills Hub API error: ${response.status}`);
  }
  return response.json();
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("Skills Hub plugin initializing", { url: SKILLS_HUB_URL });

    // Tool: search_skills
    ctx.tools.register(
      "search_skills",
      {
        displayName: "Search Skills",
        description: "Search for agent skills, MCP servers, and AI tools. Filter by category, platform, and query.",
        parametersSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query to find relevant skills" },
            category: { type: "string", description: "Filter by category (mcp-server, claude-skill, agent-tool, ai-skill, llm-plugin, codex-skill)" },
            platform: { type: "string", description: "Filter by platform compatibility" },
            limit: { type: "number", description: "Maximum number of results (default 20, max 100)" }
          }
        }
      },
      async (params: any, runCtx): Promise<ToolResult> => {
        const searchParams = new URLSearchParams();
        if (params.query) searchParams.append("search", params.query);
        if (params.category) searchParams.append("category", params.category);
        if (params.platform) searchParams.append("platform", params.platform);
        if (params.limit) searchParams.append("page_size", String(params.limit));

        const data = await fetchAPI(`/api/skills?${searchParams.toString()}`);
        return {
          content: JSON.stringify({
            skills: data.items.map((skill: any) => ({
              id: skill.id,
              name: skill.repo_name,
              full_name: skill.repo_full_name,
              description: skill.description,
              stars: skill.stars,
              score: skill.score,
              category: skill.category,
              language: skill.language,
              url: skill.repo_url,
            })),
            total: data.total,
            page: data.page,
          })
        };
      }
    );

    // Tool: get_skill
    ctx.tools.register(
      "get_skill",
      {
        displayName: "Get Skill Details",
        description: "Get detailed information about a specific skill by ID, including quality metrics and compatible skills.",
        parametersSchema: {
          type: "object",
          properties: {
            skill_id: { type: "number", description: "The ID of the skill to retrieve" }
          },
          required: ["skill_id"]
        }
      },
      async (params: any, runCtx): Promise<ToolResult> => {
        const skill = await fetchAPI(`/api/skills/${params.skill_id}`);
        return {
          content: JSON.stringify({
            id: skill.id,
            name: skill.repo_name,
            full_name: skill.repo_full_name,
            description: skill.description,
            stars: skill.stars,
            score: skill.score,
            category: skill.category,
            language: skill.language,
            url: skill.repo_url,
            quality: {
              completeness: skill.quality_completeness,
              clarity: skill.quality_clarity,
              specificity: skill.quality_specificity,
              examples: skill.quality_examples,
              agent_readiness: skill.quality_agent_readiness,
            },
            compatible_skills: skill.compatible_skills || [],
          })
        };
      }
    );

    // Tool: get_trending
    ctx.tools.register(
      "get_trending",
      {
        displayName: "Get Trending Skills",
        description: "Get trending skills - repos with high star velocity (stars relative to age).",
        parametersSchema: {
          type: "object",
          properties: {
            days: { type: "number", description: "Number of days to look back (default 7, max 30)" },
            limit: { type: "number", description: "Maximum number of results (default 10)" }
          }
        }
      },
      async (params: any, runCtx): Promise<ToolResult> => {
        const searchParams = new URLSearchParams();
        if (params.days) searchParams.append("days", String(params.days));
        if (params.limit) searchParams.append("limit", String(params.limit));

        const skills = await fetchAPI(`/api/trending?${searchParams.toString()}`);
        return {
          content: JSON.stringify(skills.map((skill: any) => ({
            id: skill.id,
            name: skill.repo_name,
            full_name: skill.repo_full_name,
            description: skill.description,
            stars: skill.stars,
            score: skill.score,
            category: skill.category,
            url: skill.repo_url,
          })))
        };
      }
    );

    // Tool: get_top_rated
    ctx.tools.register(
      "get_top_rated",
      {
        displayName: "Get Top Rated Skills",
        description: "Get the highest quality-scored skills of all time.",
        parametersSchema: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Maximum number of results (default 10)" }
          }
        }
      },
      async (params: any, runCtx): Promise<ToolResult> => {
        const limit = params.limit || 10;
        const skills = await fetchAPI(`/api/top-rated?limit=${limit}`);
        return {
          content: JSON.stringify(skills.map((skill: any) => ({
            id: skill.id,
            name: skill.repo_name,
            full_name: skill.repo_full_name,
            description: skill.description,
            stars: skill.stars,
            score: skill.score,
            category: skill.category,
            url: skill.repo_url,
          })))
        };
      }
    );

    // Tool: get_rising
    ctx.tools.register(
      "get_rising",
      {
        displayName: "Get Rising Skills",
        description: "Get new and rising skills - repos created recently with growing popularity.",
        parametersSchema: {
          type: "object",
          properties: {
            days: { type: "number", description: "Number of days to look back (default 7)" },
            limit: { type: "number", description: "Maximum number of results (default 10)" }
          }
        }
      },
      async (params: any, runCtx): Promise<ToolResult> => {
        const searchParams = new URLSearchParams();
        if (params.days) searchParams.append("days", String(params.days));
        if (params.limit) searchParams.append("limit", String(params.limit));

        const skills = await fetchAPI(`/api/rising?${searchParams.toString()}`);
        return {
          content: JSON.stringify(skills.map((skill: any) => ({
            id: skill.id,
            name: skill.repo_name,
            full_name: skill.repo_full_name,
            description: skill.description,
            stars: skill.stars,
            score: skill.score,
            category: skill.category,
            url: skill.repo_url,
          })))
        };
      }
    );

    // Tool: get_categories
    ctx.tools.register(
      "get_categories",
      {
        displayName: "Get Categories",
        description: "List all skill categories with their counts.",
        parametersSchema: {
          type: "object",
          properties: {}
        }
      },
      async (params: any, runCtx): Promise<ToolResult> => {
        const categories = await fetchAPI("/api/categories");
        return {
          content: JSON.stringify(categories.map((cat: any) => ({
            name: cat.name,
            count: cat.count,
          })))
        };
      }
    );

    // Tool: get_masters
    ctx.tools.register(
      "get_masters",
      {
        displayName: "Get Skill Masters",
        description: "Get verified skill creators and emerging builders with their top repos.",
        parametersSchema: {
          type: "object",
          properties: {}
        }
      },
      async (params: any, runCtx): Promise<ToolResult> => {
        const masters = await fetchAPI("/api/masters");
        return {
          content: JSON.stringify(masters.map((master: any) => ({
            github: master.github,
            name: master.name,
            bio: master.bio,
            avatar_url: master.avatar_url,
            repo_count: master.repo_count,
            total_stars: master.total_stars,
            top_repos: master.top_repos,
          })))
        };
      }
    );

    // Tool: get_stats
    ctx.tools.register(
      "get_stats",
      {
        displayName: "Get Statistics",
        description: "Get overall statistics about the skills database.",
        parametersSchema: {
          type: "object",
          properties: {}
        }
      },
      async (params: any, runCtx): Promise<ToolResult> => {
        const stats = await fetchAPI("/api/stats");
        return { content: JSON.stringify(stats) };
      }
    );

    // Tool: submit_skill
    ctx.tools.register(
      "submit_skill",
      {
        displayName: "Submit Skill",
        description: "Submit a GitHub repository URL to be indexed in the skills hub.",
        parametersSchema: {
          type: "object",
          properties: {
            repo_url: { type: "string", description: "Full GitHub repository URL (e.g., https://github.com/owner/repo)" }
          },
          required: ["repo_url"]
        }
      },
      async (params: any, runCtx): Promise<ToolResult> => {
        const result = await fetchAPI("/api/submit-skill", {
          method: "POST",
          body: JSON.stringify({ repo_url: params.repo_url }),
        });
        return { content: JSON.stringify(result) };
      }
    );

    // Tool: scan_security
    ctx.tools.register(
      "scan_security",
      {
        displayName: "Scan Security",
        description: "Perform security analysis on a GitHub repository.",
        parametersSchema: {
          type: "object",
          properties: {
            repo_url: { type: "string", description: "Full GitHub repository URL to analyze" }
          },
          required: ["repo_url"]
        }
      },
      async (params: any, runCtx): Promise<ToolResult> => {
        const result = await fetchAPI("/api/analyzer/scan", {
          method: "POST",
          body: JSON.stringify({ repo_url: params.repo_url }),
        });
        return { content: JSON.stringify(result) };
      }
    );

    // Tool: get_workflows
    ctx.tools.register(
      "get_workflows",
      {
        displayName: "Get Workflows",
        description: "Get skill workflows grouped by category - useful for discovering related skills.",
        parametersSchema: {
          type: "object",
          properties: {}
        }
      },
      async (params: any, runCtx): Promise<ToolResult> => {
        const workflows = await fetchAPI("/api/workflows");
        return { content: JSON.stringify(workflows) };
      }
    );

    // Tool: get_landing
    ctx.tools.register(
      "get_landing",
      {
        displayName: "Get Landing Data",
        description: "Get pre-bundled landing page data including trending, top-rated, rising skills and statistics.",
        parametersSchema: {
          type: "object",
          properties: {}
        }
      },
      async (params: any, runCtx): Promise<ToolResult> => {
        const landing = await fetchAPI("/api/landing");
        return { content: JSON.stringify(landing) };
      }
    );

    ctx.logger.info("Skills Hub plugin initialized with 12 tools registered");
  },

  async onHealth() {
    try {
      const stats = await fetchAPI("/api/stats");
      return { status: "ok", message: `Skills Hub connected with ${stats.total_skills || 0} skills` };
    } catch (error) {
      return { status: "degraded", message: "Skills Hub API unreachable" };
    }
  }
});

export default plugin;
runWorker(plugin, import.meta.url);
