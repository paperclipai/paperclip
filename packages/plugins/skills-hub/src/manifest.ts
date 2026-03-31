/**
 * Agent Skills Hub Plugin Manifest
 *
 * Integrates Agent Skills Hub - discover, evaluate, and compare
 * 6,000+ open-source Agent Skills, MCP servers, and AI tools.
 */

import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "skills.hub",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Agent Skills Hub",
  description: "Discover, evaluate, and compare 6,000+ open-source Agent Skills, MCP servers, and AI tools. Search by category, quality score, trending status, and security grade.",
  author: "Agent Skills Hub",
  categories: ["connector"],

  // Capabilities required by this plugin
  capabilities: [
    "agent.tools.register",
    "plugin.state.read",
    "plugin.state.write",
    "events.subscribe",
    "events.emit",
  ],

  // Worker entrypoint
  entrypoints: {
    worker: "./dist/worker.js",
  },

  // Agent tools contributed by this plugin
  tools: [
    {
      name: "search_skills",
      displayName: "Search Skills",
      description: "Search for agent skills, MCP servers, and AI tools. Filter by category, platform, and query.",
      parametersSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query to find relevant skills"
          },
          category: {
            type: "string",
            description: "Filter by category (mcp-server, claude-skill, agent-tool, ai-skill, llm-plugin, codex-skill)"
          },
          platform: {
            type: "string",
            description: "Filter by platform compatibility"
          },
          limit: {
            type: "number",
            description: "Maximum number of results (default 20, max 100)"
          }
        }
      }
    },
    {
      name: "get_skill",
      displayName: "Get Skill Details",
      description: "Get detailed information about a specific skill by ID, including quality metrics and compatible skills.",
      parametersSchema: {
        type: "object",
        properties: {
          skill_id: {
            type: "number",
            description: "The ID of the skill to retrieve"
          }
        },
        required: ["skill_id"]
      }
    },
    {
      name: "get_trending",
      displayName: "Get Trending Skills",
      description: "Get trending skills - repos with high star velocity (stars relative to age).",
      parametersSchema: {
        type: "object",
        properties: {
          days: {
            type: "number",
            description: "Number of days to look back (default 7, max 30)"
          },
          limit: {
            type: "number",
            description: "Maximum number of results (default 10)"
          }
        }
      }
    },
    {
      name: "get_top_rated",
      displayName: "Get Top Rated Skills",
      description: "Get the highest quality-scored skills of all time.",
      parametersSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Maximum number of results (default 10)"
          }
        }
      }
    },
    {
      name: "get_rising",
      displayName: "Get Rising Skills",
      description: "Get new and rising skills - repos created recently with growing popularity.",
      parametersSchema: {
        type: "object",
        properties: {
          days: {
            type: "number",
            description: "Number of days to look back (default 7)"
          },
          limit: {
            type: "number",
            description: "Maximum number of results (default 10)"
          }
        }
      }
    },
    {
      name: "get_categories",
      displayName: "Get Categories",
      description: "List all skill categories with their counts.",
      parametersSchema: {
        type: "object",
        properties: {}
      }
    },
    {
      name: "get_masters",
      displayName: "Get Skill Masters",
      description: "Get verified skill creators and emerging builders with their top repos.",
      parametersSchema: {
        type: "object",
        properties: {}
      }
    },
    {
      name: "get_stats",
      displayName: "Get Statistics",
      description: "Get overall statistics about the skills database.",
      parametersSchema: {
        type: "object",
        properties: {}
      }
    },
    {
      name: "submit_skill",
      displayName: "Submit Skill",
      description: "Submit a GitHub repository URL to be indexed in the skills hub.",
      parametersSchema: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description: "Full GitHub repository URL (e.g., https://github.com/owner/repo)"
          }
        },
        required: ["repo_url"]
      }
    },
    {
      name: "scan_security",
      displayName: "Scan Security",
      description: "Perform security analysis on a GitHub repository.",
      parametersSchema: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description: "Full GitHub repository URL to analyze"
          }
        },
        required: ["repo_url"]
      }
    },
    {
      name: "get_workflows",
      displayName: "Get Workflows",
      description: "Get skill workflows grouped by category - useful for discovering related skills.",
      parametersSchema: {
        type: "object",
        properties: {}
      }
    },
    {
      name: "get_landing",
      displayName: "Get Landing Data",
      description: "Get pre-bundled landing page data including trending, top-rated, rising skills and statistics.",
      parametersSchema: {
        type: "object",
        properties: {}
      }
    }
  ],

  // Instance configuration schema
  instanceConfigSchema: {
    type: "object",
    properties: {
      SKILLS_HUB_URL: {
        type: "string",
        description: "URL of the Agent Skills Hub API server",
        default: "http://localhost:8100"
      }
    }
  }
};

export default manifest;
