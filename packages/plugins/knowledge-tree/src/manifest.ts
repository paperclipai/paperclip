import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.knowledge-tree";
const PLUGIN_VERSION = "0.1.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Knowledge Tree",
  description: "Connects Paperclip agents to the evolving_records knowledge graph (Neo4j AuraDB) and raw document ingest pipeline.",
  author: "Julius Halm",
  categories: ["automation", "connector"],
  capabilities: [
    "agent.tools.register",
    "ui.dashboardWidget.register",
    "issues.create",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  tools: [
    {
      name: "query_graph",
      displayName: "Query Knowledge Graph",
      description: "Run a read-only Cypher query against Neo4j AuraDB and return nodes/edges as JSON.",
      parametersSchema: {
        type: "object",
        properties: {
          cypher: { type: "string", description: "The Cypher query to run." },
          params: { type: "object", description: "Optional parameter map for the query." },
        },
        required: ["cypher"],
      },
    },
    {
      name: "ingest_document",
      displayName: "Ingest Raw Document",
      description: "Write markdown content to the raw/ folder. Run run_distill afterwards to extract insights into the graph.",
      parametersSchema: {
        type: "object",
        properties: {
          filename: { type: "string", description: "Filename including extension (e.g. note.md)." },
          content: { type: "string", description: "Markdown content to write." },
        },
        required: ["filename", "content"],
      },
    },
    {
      name: "get_pending_synthesis",
      displayName: "Get Pending Synthesis",
      description: "Count how many Insights have not yet been synthesized into Entity articles.",
      parametersSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "graph_health",
      displayName: "Graph Health",
      description: "Return Entity count, Insight count, Question count, Document count, and pending synthesis count.",
      parametersSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "create_issue",
      displayName: "Create Paperclip Issue",
      description:
        "Create a new issue in Paperclip so work is tracked and assigned before execution. " +
        "Use this to file development tasks, research tasks, distillation runs, or any other " +
        "unit of work. Returns the created issue ID and identifier (e.g. ENG-42).",
      parametersSchema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description:
              "Short, action-oriented title. Examples: " +
              "'distill: Fed rate analysis batch', " +
              "'research: shipping route disruptions', " +
              "'build: graph distance query library'.",
          },
          description: {
            type: "string",
            description: "Optional context, acceptance criteria, or background for the issue.",
          },
          priority: {
            type: "string",
            enum: ["critical", "high", "medium", "low"],
            description: "Issue priority. Defaults to 'medium'.",
          },
          assigneeAgentId: {
            type: "string",
            description:
              "UUID of the agent to assign this issue to. " +
              "If omitted the issue lands in the backlog unassigned.",
          },
        },
        required: ["title"],
      },
    },
    {
      name: "run_distill",
      displayName: "Run Distillation Pipeline",
      description:
        "Process pending Documents through the brain distiller (brain-distill.js). " +
        "Extracts atomic Insights with typed edges and creates Question nodes for unknowns. " +
        "Run this after ingesting new documents.",
      parametersSchema: {
        type: "object",
        properties: {
          dryRun: {
            type: "boolean",
            description:
              "If true, shows what would be created without writing to Neo4j. " +
              "Use this to preview the distillation before committing. Defaults to false.",
          },
        },
      },
    },
    {
      name: "run_synthesize",
      displayName: "Run Synthesis Pipeline",
      description:
        "Process unsynthesized Insights through the entity updater (brain-connect.js). " +
        "Groups Insights by Entity, updates descriptions, recalculates epistemic_weight, " +
        "and marks Insights as synthesized. Run this after distillation.",
      parametersSchema: {
        type: "object",
        properties: {
          dryRun: {
            type: "boolean",
            description:
              "If true, previews which concepts would be updated without writing. Defaults to false.",
          },
        },
      },
    },
  ],
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "knowledge-tree-health",
        displayName: "Knowledge Graph Health",
        exportName: "KnowledgeTreeHealthWidget",
      },
    ],
  },
};

export default manifest;
