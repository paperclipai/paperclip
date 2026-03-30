/**
 * Ruflo MCP Bridge Plugin Manifest
 * 
 * Integrates Ruflo multi-agent orchestration, memory management,
 * and workflow automation capabilities into Paperclip.
 */

import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "ruflo.bridge",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Ruflo MCP Bridge",
  description: "Bridge plugin that integrates Ruflo MCP capabilities for multi-agent orchestration, semantic memory management, and workflow automation",
  author: "Ruflo AI",
  categories: ["automation", "connector"],
  
  // Capabilities required by this plugin
  capabilities: [
    "agent.tools.register",
    "plugin.state.read",
    "plugin.state.write",
    "events.subscribe",
    "events.emit",
    "jobs.schedule",
  ],
  
  // Worker entrypoint
  entrypoints: {
    worker: "./dist/worker.js",
  },
  
  // Agent tools contributed by this plugin
  tools: [
    {
      name: "agent_spawn",
      displayName: "Ruflo Agent Spawn",
      description: "Spawn a new Ruflo agent with intelligent model selection. Creates a specialized agent optimized for the given task type.",
      parametersSchema: {
        type: "object",
        properties: {
          agentType: {
            type: "string",
            description: "Type of agent to spawn (e.g., 'worker', 'specialist', 'scout')",
            enum: ["worker", "specialist", "scout", "coordinator", "analyst"]
          },
          task: {
            type: "string",
            description: "Task description for intelligent model routing"
          },
          model: {
            type: "string",
            enum: ["haiku", "sonnet", "opus", "inherit"],
            default: "inherit",
            description: "Claude model for the agent (haiku=fast, sonnet=balanced, opus=capable)"
          },
          domain: {
            type: "string",
            description: "Domain for the agent (e.g., 'engineering', 'research', 'design')"
          }
        },
        required: ["agentType"]
      }
    },
    {
      name: "swarm_init",
      displayName: "Ruflo Swarm Init",
      description: "Initialize a coordinated swarm for complex multi-agent tasks. Creates a hierarchical or mesh topology of agents working together.",
      parametersSchema: {
        type: "object",
        properties: {
          topology: {
            type: "string",
            enum: ["hierarchical", "mesh", "hierarchical-mesh", "ring", "star", "hybrid", "adaptive"],
            default: "hierarchical-mesh",
            description: "Network topology for the swarm"
          },
          maxAgents: {
            type: "number",
            default: 10,
            description: "Maximum number of agents (1-300)"
          },
          strategy: {
            type: "string",
            enum: ["specialized", "balanced", "adaptive"],
            default: "adaptive",
            description: "Agent strategy for task distribution"
          }
        }
      }
    },
    {
      name: "memory_store",
      displayName: "Ruflo Memory Store",
      description: "Store a value in Ruflo memory with vector embedding for semantic search. Enables persistent memory across agent sessions.",
      parametersSchema: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: "Unique key for this memory entry"
          },
          value: {
            description: "Value to store (any JSON-serializable data)"
          },
          namespace: {
            type: "string",
            default: "paperclip",
            description: "Namespace for organization"
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Optional tags for filtering"
          }
        },
        required: ["key", "value"]
      }
    },
    {
      name: "memory_search",
      displayName: "Ruflo Memory Search",
      description: "Semantic vector search using HNSW index. Finds similar memories based on meaning, not just keywords.",
      parametersSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query (natural language)"
          },
          namespace: {
            type: "string",
            default: "paperclip",
            description: "Namespace to search within"
          },
          limit: {
            type: "number",
            default: 10,
            description: "Maximum results to return"
          }
        },
        required: ["query"]
      }
    },
    {
      name: "workflow_create",
      displayName: "Ruflo Workflow Create",
      description: "Create a new workflow with defined steps. Enables structured multi-step automation.",
      parametersSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Workflow name"
          },
          description: {
            type: "string",
            description: "Workflow description"
          },
          steps: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                type: { type: "string", enum: ["task", "condition", "parallel", "loop", "wait"] }
              }
            },
            description: "Workflow steps"
          }
        },
        required: ["name"]
      }
    },
    {
      name: "workflow_execute",
      displayName: "Ruflo Workflow Execute",
      description: "Execute a previously created workflow with optional runtime variables.",
      parametersSchema: {
        type: "object",
        properties: {
          workflowId: {
            type: "string",
            description: "ID of the workflow to execute"
          },
          variables: {
            type: "object",
            description: "Runtime variables to inject"
          }
        },
        required: ["workflowId"]
      }
    },
    {
      name: "coordination_orchestrate",
      displayName: "Ruflo Coordination Orchestrate",
      description: "Orchestrate multi-agent coordination for a specific task.",
      parametersSchema: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "Task to orchestrate"
          },
          agents: {
            type: "array",
            items: { type: "string" },
            description: "Agent IDs to coordinate"
          },
          strategy: {
            type: "string",
            enum: ["parallel", "sequential", "pipeline", "broadcast"],
            default: "parallel",
            description: "Orchestration strategy"
          }
        },
        required: ["task"]
      }
    },
    {
      name: "autopilot_status",
      displayName: "Ruflo Autopilot Status",
      description: "Get current autopilot state including iteration count, task progress, and learning metrics.",
      parametersSchema: {
        type: "object",
        properties: {}
      }
    },
    {
      name: "hooks_route",
      displayName: "Ruflo Hooks Route",
      description: "Route a task to optimal agent using semantic similarity. Intelligent task distribution.",
      parametersSchema: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "Task description to route"
          },
          context: {
            type: "string",
            description: "Additional context for routing"
          }
        },
        required: ["task"]
      }
    }
  ],
  
  // Scheduled jobs (optional)
  jobs: [
    {
      jobKey: "health-check",
      displayName: "Ruflo Bridge Health Check",
      description: "Periodic health check for Ruflo MCP connection",
      schedule: "*/15 * * * *"
    }
  ],
};

export default manifest;
