import { readFileSync } from "node:fs";
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "paperclipai.plugin-weknora";
export const PLUGIN_VERSION = "0.1.0";
export const MAINTAINER_AGENT_KEY = "weknora-maintainer";
export const PROJECT_KEY = "weknora";
export const HEALTH_ROUTINE_KEY = "weekly-weknora-health";
export const LINT_ROUTINE_KEY = "weekly-weknora-wiki-lint";

export const TOOL_NAMES = {
  listKnowledgeBases: "weknora_list_knowledge_bases",
  search: "weknora_search",
  readDocument: "weknora_read_document",
  listWikiPages: "weknora_list_wiki_pages",
  readWikiPage: "weknora_read_wiki_page",
  searchWiki: "weknora_search_wiki",
  health: "weknora_health",
} as const;

export const SKILL_KEYS = [
  "weknora-query",
  "weknora-browse",
  "weknora-ingest",
  "weknora-health",
  "weknora-maintenance",
] as const;

export const ROUTE_KEYS = {
  overview: "overview",
  knowledgeBases: "knowledge-bases",
  search: "search",
  document: "document",
  wikiPages: "wiki-pages",
  wikiPage: "wiki-page",
  wikiSearch: "wiki-search",
  health: "health",
  ingestManual: "ingest-manual",
  ingestUrl: "ingest-url",
  rebuildWikiLinks: "rebuild-wiki-links",
  autoFixWiki: "auto-fix-wiki",
} as const;

function readSkill(skillKey: string): string {
  return readFileSync(new URL(`../skills/${skillKey}/SKILL.md`, import.meta.url), "utf8");
}

const capabilities = [
  "http.outbound",
  "secrets.read-ref",
  "instance.settings.register",
  "agent.tools.register",
  "api.routes.register",
  "ui.sidebar.register",
  "ui.page.register",
  "skills.managed",
  "agents.managed",
  "projects.managed",
  "routines.managed",
  "activity.log.write",
  "metrics.write",
] as const;

const configSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    baseUrl: {
      type: "string",
      title: "WeKnora Base URL",
      description: "The WeKnora origin or API root. The plugin adds /api/v1 once.",
    },
    apiKeyRef: {
      type: "string",
      format: "secret-ref",
      title: "WeKnora API Key",
      description: "A Paperclip secret reference. The key is resolved only for an outbound request.",
    },
    tenantId: {
      type: "string",
      title: "Tenant ID",
      "x-paperclip-advanced": true,
    },
    defaultKnowledgeBaseIds: {
      type: "array",
      title: "Default Knowledge Base IDs",
      items: { type: "string" },
      default: [],
      "x-paperclip-advanced": true,
    },
    defaultWikiKnowledgeBaseId: {
      type: "string",
      title: "Default Wiki Knowledge Base ID",
      "x-paperclip-advanced": true,
    },
    maxResults: {
      type: "integer",
      title: "Maximum Results",
      minimum: 1,
      maximum: 50,
      default: 8,
      "x-paperclip-advanced": true,
    },
    maxChunkChars: {
      type: "integer",
      title: "Maximum Chunk Characters",
      minimum: 200,
      maximum: 10000,
      default: 1200,
      "x-paperclip-advanced": true,
    },
    requestTimeoutMs: {
      type: "integer",
      title: "Request Timeout (ms)",
      minimum: 1000,
      maximum: 120000,
      default: 30000,
      "x-paperclip-advanced": true,
    },
    resourceUrls: {
      type: "string",
      enum: ["handle"],
      default: "handle",
      readOnly: true,
      "x-paperclip-advanced": true,
    },
    enableWriteActions: {
      type: "boolean",
      title: "Enable Board Write Actions",
      description: "Enables manual/URL ingest and wiki maintenance actions for board users. Agent tools remain read-only.",
      default: false,
    },
  },
  required: ["baseUrl", "apiKeyRef"],
};

function tool(name: string, displayName: string, description: string, properties: Record<string, unknown>, required: string[]) {
  return { name, displayName, description, parametersSchema: { type: "object", properties, required } };
}

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "WeKnora",
  description: "Thin WeKnora connector for auditable retrieval, wiki browsing, health checks, and board-governed maintenance.",
  author: "Paperclip",
  categories: ["connector", "automation", "ui"],
  capabilities: [...capabilities],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
  instanceConfigSchema: configSchema,
  agents: [
    {
      agentKey: MAINTAINER_AGENT_KEY,
      displayName: "WeKnora Maintainer",
      role: "knowledge-maintainer",
      title: "WeKnora Maintainer",
      icon: "book-open",
      capabilities: "Maintains WeKnora knowledge and wiki workflows through bounded, cited read tools and board handoffs.",
      adapterType: "codex_local",
      adapterPreference: ["codex_local", "claude_local", "gemini_local", "opencode_local", "cursor", "pi_local"],
      adapterConfig: {
        dangerouslySkipPermissions: false,
        dangerouslyBypassApprovalsAndSandbox: false,
        sandbox: true,
        paperclipSkillSync: { desiredSkills: SKILL_KEYS.map((key) => `plugin/paperclip-plugin-weknora/${key}`) },
      },
      permissions: { pluginTools: [PLUGIN_ID] },
      status: "paused",
      budgetMonthlyCents: 0,
      instructions: {
        entryFile: "AGENTS.md",
        content: readFileSync(new URL("../agents/weknora-maintainer/AGENTS.md", import.meta.url), "utf8"),
        files: { "AGENTS.md": readFileSync(new URL("../agents/weknora-maintainer/AGENTS.md", import.meta.url), "utf8") },
        assetPath: "agents/weknora-maintainer",
      },
    },
  ],
  projects: [
    {
      projectKey: PROJECT_KEY,
      displayName: "WeKnora",
      description: "Plugin-managed operation issues for WeKnora retrieval, wiki health, and governed maintenance.",
      status: "in_progress",
      color: "#2563eb",
    },
  ],
  routines: [
    {
      routineKey: HEALTH_ROUTINE_KEY,
      title: "Run weekly WeKnora health check",
      description: "Read WeKnora knowledge-base and wiki diagnostics. Report partial failures and never change upstream data.",
      status: "paused",
      priority: "low",
      assigneeRef: { resourceKind: "agent", resourceKey: MAINTAINER_AGENT_KEY },
      projectRef: { resourceKind: "project", resourceKey: PROJECT_KEY },
      concurrencyPolicy: "skip_if_active",
      catchUpPolicy: "skip_missed",
      triggers: [{ kind: "schedule", label: "Weekly", enabled: false, cronExpression: "0 4 * * 1", timezone: "UTC", signingMode: null, replayWindowSec: null }],
      issueTemplate: { surfaceVisibility: "plugin_operation", originId: `routine:${HEALTH_ROUTINE_KEY}`, billingCode: "plugin-weknora:health" },
    },
    {
      routineKey: LINT_ROUTINE_KEY,
      title: "Run weekly WeKnora wiki lint",
      description: "Read WeKnora wiki statistics and lint findings. Do not apply fixes automatically.",
      status: "paused",
      priority: "low",
      assigneeRef: { resourceKind: "agent", resourceKey: MAINTAINER_AGENT_KEY },
      projectRef: { resourceKind: "project", resourceKey: PROJECT_KEY },
      concurrencyPolicy: "skip_if_active",
      catchUpPolicy: "skip_missed",
      triggers: [{ kind: "schedule", label: "Weekly", enabled: false, cronExpression: "0 5 * * 1", timezone: "UTC", signingMode: null, replayWindowSec: null }],
      issueTemplate: { surfaceVisibility: "plugin_operation", originId: `routine:${LINT_ROUTINE_KEY}`, billingCode: "plugin-weknora:maintenance" },
    },
  ],
  skills: SKILL_KEYS.map((skillKey) => ({
    skillKey,
    displayName: skillKey.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" "),
    slug: skillKey,
    description: `Use the ${skillKey} workflow with WeKnora's bounded Paperclip tools.`,
    markdown: readSkill(skillKey),
  })),
  tools: [
    tool(TOOL_NAMES.listKnowledgeBases, "List WeKnora Knowledge Bases", "List visible WeKnora knowledge bases with bounded counts.", {}, ["companyId"]),
    tool(TOOL_NAMES.search, "Search WeKnora", "Search ranked WeKnora passages. Cite knowledge and chunk identifiers in the answer.", { companyId: { type: "string" }, query: { type: "string" }, knowledgeBaseIds: { type: "array", items: { type: "string" } }, knowledgeIds: { type: "array", items: { type: "string" } }, maxResults: { type: "integer", minimum: 1, maximum: 50 } }, ["companyId", "query"]),
    tool(TOOL_NAMES.readDocument, "Read WeKnora Document", "Read one document and an explicit page of ordered chunks.", { companyId: { type: "string" }, knowledgeId: { type: "string" }, page: { type: "integer", minimum: 1 }, pageSize: { type: "integer", minimum: 1, maximum: 50 } }, ["companyId", "knowledgeId"]),
    tool(TOOL_NAMES.listWikiPages, "List WeKnora Wiki Pages", "List one WeKnora wiki's pages with explicit paging.", { companyId: { type: "string" }, knowledgeBaseId: { type: "string" }, page: { type: "integer", minimum: 1 }, pageSize: { type: "integer", minimum: 1, maximum: 50 } }, ["companyId", "knowledgeBaseId"]),
    tool(TOOL_NAMES.readWikiPage, "Read WeKnora Wiki Page", "Read one WeKnora wiki page by its stable slug.", { companyId: { type: "string" }, knowledgeBaseId: { type: "string" }, slug: { type: "string" } }, ["companyId", "knowledgeBaseId", "slug"]),
    tool(TOOL_NAMES.searchWiki, "Search WeKnora Wiki", "Search one WeKnora wiki and return cited page slugs.", { companyId: { type: "string" }, knowledgeBaseId: { type: "string" }, query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 50 } }, ["companyId", "knowledgeBaseId", "query"]),
    tool(TOOL_NAMES.health, "Check WeKnora Health", "Aggregate knowledge-base and wiki diagnostics with partial-result warnings.", { companyId: { type: "string" }, knowledgeBaseId: { type: "string" } }, ["companyId"]),
  ],
  apiRoutes: [
    { routeKey: ROUTE_KEYS.overview, method: "GET", path: "/overview", auth: "board-or-agent", capability: "api.routes.register", companyResolution: { from: "query", key: "companyId" } },
    { routeKey: ROUTE_KEYS.knowledgeBases, method: "GET", path: "/knowledge-bases", auth: "board-or-agent", capability: "api.routes.register", companyResolution: { from: "query", key: "companyId" } },
    { routeKey: ROUTE_KEYS.search, method: "POST", path: "/search", auth: "board-or-agent", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
    { routeKey: ROUTE_KEYS.document, method: "GET", path: "/knowledge/:knowledgeId", auth: "board-or-agent", capability: "api.routes.register", companyResolution: { from: "query", key: "companyId" } },
    { routeKey: ROUTE_KEYS.wikiPages, method: "GET", path: "/wiki/:knowledgeBaseId/pages", auth: "board-or-agent", capability: "api.routes.register", companyResolution: { from: "query", key: "companyId" } },
    { routeKey: ROUTE_KEYS.wikiPage, method: "GET", path: "/wiki/:knowledgeBaseId/page", auth: "board-or-agent", capability: "api.routes.register", companyResolution: { from: "query", key: "companyId" } },
    { routeKey: ROUTE_KEYS.wikiSearch, method: "GET", path: "/wiki/:knowledgeBaseId/search", auth: "board-or-agent", capability: "api.routes.register", companyResolution: { from: "query", key: "companyId" } },
    { routeKey: ROUTE_KEYS.health, method: "GET", path: "/health", auth: "board-or-agent", capability: "api.routes.register", companyResolution: { from: "query", key: "companyId" } },
    { routeKey: ROUTE_KEYS.ingestManual, method: "POST", path: "/knowledge/:knowledgeBaseId/manual", auth: "board", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
    { routeKey: ROUTE_KEYS.ingestUrl, method: "POST", path: "/knowledge/:knowledgeBaseId/url", auth: "board", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
    { routeKey: ROUTE_KEYS.rebuildWikiLinks, method: "POST", path: "/wiki/:knowledgeBaseId/rebuild-links", auth: "board", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
    { routeKey: ROUTE_KEYS.autoFixWiki, method: "POST", path: "/wiki/:knowledgeBaseId/auto-fix", auth: "board", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
  ],
  ui: {
    slots: [
      { type: "sidebar", id: "weknora-sidebar", displayName: "WeKnora", exportName: "SidebarLink", order: 36 },
      { type: "page", id: "weknora-page", displayName: "WeKnora", exportName: "WeKnoraPage", routePath: "weknora" },
    ],
  },
};

export default manifest;
