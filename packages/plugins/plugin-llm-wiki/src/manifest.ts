import { readFileSync } from "node:fs";
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { DEFAULT_AGENT_INSTRUCTION_FILES, DEFAULT_AGENT_INSTRUCTIONS } from "./templates.js";

export const PLUGIN_ID = "paperclipai.plugin-llm-wiki";
export const WIKI_ROOT_FOLDER_KEY = "wiki-root";
export const WIKI_MAINTAINER_AGENT_KEY = "wiki-maintainer";
export const WIKI_MAINTAINER_SKILL_KEY = "wiki-maintainer";
export const WIKI_INGEST_SKILL_KEY = "wiki-ingest";
export const WIKI_QUERY_SKILL_KEY = "wiki-query";
export const WIKI_LINT_SKILL_KEY = "wiki-lint";
export const PAPERCLIP_DISTILL_SKILL_KEY = "paperclip-distill";
export const INDEX_REFRESH_SKILL_KEY = "index-refresh";
export const WIKI_PROJECT_KEY = "llm-wiki";
export const CURSOR_WINDOW_ROUTINE_KEY = "cursor-window-processing";
export const NIGHTLY_LINT_ROUTINE_KEY = "nightly-wiki-lint";
export const INDEX_REFRESH_ROUTINE_KEY = "index-refresh";
export const DEFAULT_MAX_SOURCE_BYTES = 250000;
export const DEFAULT_MAX_PAPERCLIP_ISSUE_SOURCE_CHARS = 12000;
export const DEFAULT_MAX_PAPERCLIP_CURSOR_WINDOW_CHARS = 60000;
export const DEFAULT_MAX_PAPERCLIP_ROUTINE_RUN_CHARS = 120000;
export const DEFAULT_PAPERCLIP_COST_CENTS_PER_1K_CHARS = 1;
export const WIKI_MAINTENANCE_ROUTINE_KEYS = [
  CURSOR_WINDOW_ROUTINE_KEY,
  NIGHTLY_LINT_ROUTINE_KEY,
  INDEX_REFRESH_ROUTINE_KEY,
] as const;
export const WIKI_MANAGED_SKILL_KEYS = [
  WIKI_MAINTAINER_SKILL_KEY,
  WIKI_INGEST_SKILL_KEY,
  WIKI_QUERY_SKILL_KEY,
  WIKI_LINT_SKILL_KEY,
  PAPERCLIP_DISTILL_SKILL_KEY,
  INDEX_REFRESH_SKILL_KEY,
] as const;

function canonicalSkillKey(skillKey: string) {
  return `plugin/paperclipai-plugin-llm-wiki/${skillKey}`;
}

function skillMarkdown(skillKey: (typeof WIKI_MANAGED_SKILL_KEYS)[number]) {
  return readFileSync(new URL(`../skills/${skillKey}/SKILL.md`, import.meta.url), "utf8");
}

export const WIKI_MAINTAINER_SKILL_CANONICAL_KEY = canonicalSkillKey(WIKI_MAINTAINER_SKILL_KEY);
export const WIKI_MANAGED_SKILL_CANONICAL_KEYS = WIKI_MANAGED_SKILL_KEYS.map(canonicalSkillKey);

const CURSOR_WINDOW_ROUTINE_DESCRIPTION = `Process bounded Paperclip issue-history windows into the LLM Wiki.

Run procedure:
Target space: default (slug: default). Paperclip-derived indexing currently writes only into the default space, so this routine never sweeps other spaces. Per-space Paperclip ingestion profiles are a later phase; until they ship, treat any prompt to operate on a non-default space here as a bug and stop.
1. Resolve the configured wiki root, then read the default space AGENTS.md, wiki/index.md, and the recent entries in wiki/log.md.
2. Review recent Paperclip issue, comment, and document activity for non-plugin-operation work. Skip LLM Wiki operation issues so routine output does not feed back into itself.
3. Synthesize Paperclip project state into wiki/projects/<slug>/standup.md for the executive current-state view, then durable project or root-issue knowledge into focused pages under wiki/projects/<slug>/index.md, wiki/concepts/, or wiki/synthesis/. Keep transient run logs out of durable pages unless they change the project's state or decisions.
4. Write project material as concept-grouped executive synthesis. Link readable issue identifiers when useful, but do not turn project pages into issue-ID lists, UUID dumps, date ledgers, or metadata reports. Always pass wikiId \`default\` and spaceSlug \`default\` to LLM Wiki tools.
5. Refresh wiki/index.md and append a short wiki/log.md entry listing the source window, affected pages, skipped windows, warnings, and any follow-up issue needed.
6. If there is no new durable signal, record that in wiki/log.md and close the routine issue with a concise note.`;

const NIGHTLY_LINT_ROUTINE_DESCRIPTION = `Lint the LLM Wiki for structure, provenance, and stale synthesis.

Run procedure:
Target space: default (slug: default). Paperclip-derived indexing currently writes only into the default space, so this routine never sweeps other spaces. Per-space Paperclip ingestion profiles are a later phase; until they ship, treat any prompt to operate on a non-default space here as a bug and stop.
1. Resolve the configured wiki root, then read the default space AGENTS.md, wiki/index.md, wiki/log.md, and the current page list.
2. Check for orphan pages, missing backlinks, stale source provenance, weak citations, duplicate concepts, contradictory claims, and index/log drift.
3. Inspect the relevant wiki pages and raw sources before changing content. Do not invent missing provenance.
4. Apply low-risk fixes directly: refresh backlinks, repair index entries, add missing source links, and append a wiki/log.md lint entry. Always pass wikiId \`default\` and spaceSlug \`default\` to LLM Wiki tools.
5. For ambiguous contradictions or major rewrites, leave the pages unchanged and create or comment a follow-up Paperclip issue with the exact files and evidence.
6. Close the routine issue with counts by severity, files changed, and unresolved findings.`;

const INDEX_REFRESH_ROUTINE_DESCRIPTION = `Refresh the LLM Wiki navigation and change log.

Run procedure:
Target space: default (slug: default). Paperclip-derived indexing currently writes only into the default space, so this routine never sweeps other spaces. Per-space Paperclip ingestion profiles are a later phase; until they ship, treat any prompt to operate on a non-default space here as a bug and stop.
1. Resolve the configured wiki root, then read the default space AGENTS.md, wiki/index.md, wiki/log.md, and the current page list.
2. Rebuild wiki/index.md so it lists current wiki pages by category with concise summaries and valid wikilinks, and attaches wiki/projects/<slug>/standup.md links to matching project entries.
3. Verify recently changed wiki pages and project standups are present in the index and that removed or renamed pages no longer appear.
4. Do not rewrite content pages unless a broken title or link prevents the index from being accurate. Always pass wikiId \`default\` and spaceSlug \`default\` to LLM Wiki tools.
5. Append a wiki/log.md entry with the index refresh time, page counts by category, and any unresolved indexing problems.
6. Close the routine issue with the index changes and any follow-up needed.`;

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "LLM Wiki",
  description: "Local-file LLM Wiki plugin for source ingestion, wiki browsing, query, lint, and maintenance workflows.",
  author: "Paperclip",
  categories: ["automation", "ui"],
  capabilities: [
    "events.subscribe",
    "api.routes.register",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "companies.read",
    "projects.read",
    "projects.managed",
    "skills.managed",
    "issues.read",
    "issue.subtree.read",
    "issues.create",
    "issues.update",
    "issues.wakeup",
    "issues.orchestration.read",
    "issue.comments.read",
    "issue.comments.create",
    "issue.documents.read",
    "issue.documents.write",
    "agents.read",
    "agents.managed",
    "agent.sessions.create",
    "agent.sessions.list",
    "agent.sessions.send",
    "agent.sessions.close",
    "routines.managed",
    "local.folders",
    "agent.tools.register",
    "metrics.write",
    "activity.log.write",
    "plugin.state.read",
    "plugin.state.write",
    "ui.sidebar.register",
    "ui.page.register"
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui"
  },
  database: {
    namespaceSlug: "llm_wiki",
    migrationsDir: "migrations",
    coreReadTables: ["companies", "issues", "projects", "agents"]
  },
  localFolders: [
    {
      folderKey: WIKI_ROOT_FOLDER_KEY,
      displayName: "Wiki root",
      description: "Company-scoped local folder that stores raw sources, wiki pages, Paperclip project standups under wiki/projects/, AGENTS.md, IDEA.md, wiki/index.md, and wiki/log.md.",
      access: "readWrite",
      requiredDirectories: [
        "raw",
        "wiki",
        "wiki/sources",
        "wiki/projects",
        "wiki/entities",
        "wiki/concepts",
        "wiki/synthesis"
      ],
      requiredFiles: ["AGENTS.md", "IDEA.md", "wiki/index.md", "wiki/log.md"]
    }
  ],
  agents: [
    {
      agentKey: WIKI_MAINTAINER_AGENT_KEY,
      displayName: "Wiki Maintainer",
      role: "knowledge-maintainer",
      title: "LLM Wiki Maintainer",
      icon: "book-open",
      capabilities: "Ingests source material, maintains local wiki pages, answers cited questions, and runs wiki lint/maintenance through plugin tools.",
      adapterType: "claude_local",
      adapterPreference: ["claude_local", "codex_local", "gemini_local", "opencode_local", "cursor", "pi_local"],
      adapterConfig: {
        dangerouslySkipPermissions: false,
        dangerouslyBypassApprovalsAndSandbox: false,
        sandbox: true,
        paperclipSkillSync: {
          desiredSkills: WIKI_MANAGED_SKILL_CANONICAL_KEYS
        }
      },
      runtimeConfig: {
        modelProfiles: {
          cheap: {
            purpose: "classification, lint planning, index maintenance"
          }
        }
      },
      permissions: {
        pluginTools: [PLUGIN_ID]
      },
      status: "paused",
      budgetMonthlyCents: 0,
      instructions: {
        entryFile: "AGENTS.md",
        content: DEFAULT_AGENT_INSTRUCTIONS,
        files: DEFAULT_AGENT_INSTRUCTION_FILES,
        assetPath: "agents/wiki-maintainer"
      }
    }
  ],
  projects: [
    {
      projectKey: WIKI_PROJECT_KEY,
      displayName: "LLM Wiki",
      description: "Plugin-managed inspection area for LLM Wiki ingest, query, lint, and maintenance operation issues.",
      status: "in_progress",
      color: "#2563eb"
    }
  ],
  skills: [
    {
      skillKey: WIKI_MAINTAINER_SKILL_KEY,
      displayName: "LLM Wiki Maintainer",
      slug: "llm-wiki-maintainer",
      description: "Use the LLM Wiki plugin tools to maintain a cited local company wiki.",
      markdown: skillMarkdown(WIKI_MAINTAINER_SKILL_KEY)
    },
    {
      skillKey: WIKI_INGEST_SKILL_KEY,
      displayName: "Wiki Ingest",
      slug: WIKI_INGEST_SKILL_KEY,
      description: "Turn captured raw source material into cited durable LLM Wiki pages.",
      markdown: skillMarkdown(WIKI_INGEST_SKILL_KEY)
    },
    {
      skillKey: WIKI_QUERY_SKILL_KEY,
      displayName: "Wiki Query",
      slug: WIKI_QUERY_SKILL_KEY,
      description: "Answer questions from the LLM Wiki with citations and optional durable synthesis.",
      markdown: skillMarkdown(WIKI_QUERY_SKILL_KEY)
    },
    {
      skillKey: WIKI_LINT_SKILL_KEY,
      displayName: "Wiki Lint",
      slug: WIKI_LINT_SKILL_KEY,
      description: "Audit the LLM Wiki for contradictions, orphan pages, weak provenance, broken links, and missing concepts.",
      markdown: skillMarkdown(WIKI_LINT_SKILL_KEY)
    },
    {
      skillKey: PAPERCLIP_DISTILL_SKILL_KEY,
      displayName: "Paperclip Distill",
      slug: PAPERCLIP_DISTILL_SKILL_KEY,
      description: "Turn Paperclip cursor-window, distill, or backfill source bundles into wiki-insightful project knowledge.",
      markdown: skillMarkdown(PAPERCLIP_DISTILL_SKILL_KEY)
    },
    {
      skillKey: INDEX_REFRESH_SKILL_KEY,
      displayName: "Index Refresh",
      slug: INDEX_REFRESH_SKILL_KEY,
      description: "Refresh wiki/index.md so it accurately catalogs current wiki pages.",
      markdown: skillMarkdown(INDEX_REFRESH_SKILL_KEY)
    }
  ],
  routines: [
    {
      routineKey: CURSOR_WINDOW_ROUTINE_KEY,
      title: "Process LLM Wiki updates",
      description: CURSOR_WINDOW_ROUTINE_DESCRIPTION,
      status: "paused",
      priority: "low",
      assigneeRef: { resourceKind: "agent", resourceKey: WIKI_MAINTAINER_AGENT_KEY },
      projectRef: { resourceKind: "project", resourceKey: WIKI_PROJECT_KEY },
      concurrencyPolicy: "skip_if_active",
      catchUpPolicy: "skip_missed",
      triggers: [
        {
          kind: "schedule",
          label: "Every 6 hours",
          enabled: false,
          cronExpression: "0 */6 * * *",
          timezone: "UTC",
          signingMode: null,
          replayWindowSec: null
        }
      ],
      issueTemplate: {
        surfaceVisibility: "plugin_operation",
        originId: "routine:cursor-window-processing",
        billingCode: "plugin-llm-wiki:distillation"
      }
    },
    {
      routineKey: NIGHTLY_LINT_ROUTINE_KEY,
      title: "Run LLM Wiki lint",
      description: NIGHTLY_LINT_ROUTINE_DESCRIPTION,
      status: "paused",
      priority: "low",
      assigneeRef: { resourceKind: "agent", resourceKey: WIKI_MAINTAINER_AGENT_KEY },
      projectRef: { resourceKind: "project", resourceKey: WIKI_PROJECT_KEY },
      concurrencyPolicy: "skip_if_active",
      catchUpPolicy: "skip_missed",
      triggers: [
        {
          kind: "schedule",
          label: "Nightly",
          enabled: false,
          cronExpression: "0 3 * * *",
          timezone: "UTC",
          signingMode: null,
          replayWindowSec: null
        }
      ],
      issueTemplate: {
        surfaceVisibility: "plugin_operation",
        originId: "routine:nightly-wiki-lint",
        billingCode: "plugin-llm-wiki:maintenance"
      }
    },
    {
      routineKey: INDEX_REFRESH_ROUTINE_KEY,
      title: "Refresh LLM Wiki index",
      description: INDEX_REFRESH_ROUTINE_DESCRIPTION,
      status: "paused",
      priority: "low",
      assigneeRef: { resourceKind: "agent", resourceKey: WIKI_MAINTAINER_AGENT_KEY },
      projectRef: { resourceKind: "project", resourceKey: WIKI_PROJECT_KEY },
      concurrencyPolicy: "skip_if_active",
      catchUpPolicy: "skip_missed",
      triggers: [
        {
          kind: "schedule",
          label: "Hourly",
          enabled: false,
          cronExpression: "0 * * * *",
          timezone: "UTC",
          signingMode: null,
          replayWindowSec: null
        }
      ],
      issueTemplate: {
        surfaceVisibility: "plugin_operation",
        originId: "routine:index-refresh",
        billingCode: "plugin-llm-wiki:maintenance"
      }
    }
  ],
  tools: [
    {
      name: "wiki_search",
      displayName: "Search Wiki",
      description: "Search indexed wiki page and source metadata for one wiki space. Operation agents should pass the issue's spaceSlug; omitting it uses the default space.",
      parametersSchema: {
        type: "object",
        properties: {
          companyId: { type: "string" },
          wikiId: { type: "string" },
          spaceSlug: { type: "string" },
          query: { type: "string" },
          limit: { type: "number" }
        },
        required: ["companyId", "wikiId", "query"]
      }
    },
    {
      name: "wiki_read_page",
      displayName: "Read Wiki Page",
      description: "Read a markdown wiki page from one wiki space. Operation agents should pass the issue's spaceSlug; omitting it uses the default space.",
      parametersSchema: {
        type: "object",
        properties: {
          companyId: { type: "string" },
          wikiId: { type: "string" },
          spaceSlug: { type: "string" },
          path: { type: "string" }
        },
        required: ["companyId", "wikiId", "path"]
      }
    },
    {
      name: "wiki_write_page",
      displayName: "Write Wiki Page",
      description: "Atomically write a markdown wiki page in one wiki space after plugin path validation and optional hash conflict checks. Operation agents should pass the issue's spaceSlug; omitting it uses the default space. Protected control files such as AGENTS.md and IDEA.md are excluded from agent-tool writes.",
      parametersSchema: {
        type: "object",
        properties: {
          companyId: { type: "string" },
          wikiId: { type: "string" },
          spaceSlug: { type: "string" },
          path: { type: "string" },
          contents: { type: "string" },
          expectedHash: { type: "string" },
          summary: { type: "string" }
        },
        required: ["companyId", "wikiId", "path", "contents"]
      }
    },
    {
      name: "wiki_propose_patch",
      displayName: "Propose Wiki Patch",
      description: "Return a structured proposed page write for one wiki space without changing files. Operation agents should pass the issue's spaceSlug; omitting it uses the default space.",
      parametersSchema: {
        type: "object",
        properties: {
          companyId: { type: "string" },
          wikiId: { type: "string" },
          spaceSlug: { type: "string" },
          path: { type: "string" },
          contents: { type: "string" },
          summary: { type: "string" }
        },
        required: ["companyId", "wikiId", "path", "contents"]
      }
    },
    {
      name: "wiki_list_sources",
      displayName: "List Wiki Sources",
      description: "Return captured raw source metadata from one wiki space. Operation agents should pass the issue's spaceSlug; omitting it uses the default space.",
      parametersSchema: {
        type: "object",
        properties: {
          companyId: { type: "string" },
          wikiId: { type: "string" },
          spaceSlug: { type: "string" },
          limit: { type: "number" }
        },
        required: ["companyId", "wikiId"]
      }
    },
    {
      name: "wiki_read_source",
      displayName: "Read Wiki Source",
      description: "Read a captured raw source from one wiki space. Operation agents should pass the issue's spaceSlug; omitting it uses the default space.",
      parametersSchema: {
        type: "object",
        properties: {
          companyId: { type: "string" },
          wikiId: { type: "string" },
          spaceSlug: { type: "string" },
          rawPath: { type: "string" }
        },
        required: ["companyId", "wikiId", "rawPath"]
      }
    },
    {
      name: "wiki_append_log",
      displayName: "Append Wiki Log",
      description: "Append a maintenance note to one wiki space's wiki/log.md. Operation agents should pass the issue's spaceSlug; omitting it uses the default space.",
      parametersSchema: {
        type: "object",
        properties: {
          companyId: { type: "string" },
          wikiId: { type: "string" },
          spaceSlug: { type: "string" },
          entry: { type: "string" }
        },
        required: ["companyId", "wikiId", "entry"]
      }
    },
    {
      name: "wiki_update_index",
      displayName: "Update Wiki Index",
      description: "Atomically replace one wiki space's wiki/index.md with optional hash conflict checks. Operation agents should pass the issue's spaceSlug; omitting it uses the default space.",
      parametersSchema: {
        type: "object",
        properties: {
          companyId: { type: "string" },
          wikiId: { type: "string" },
          spaceSlug: { type: "string" },
          contents: { type: "string" },
          expectedHash: { type: "string" }
        },
        required: ["companyId", "wikiId", "contents"]
      }
    },
    {
      name: "wiki_list_backlinks",
      displayName: "List Wiki Backlinks",
      description: "Return indexed backlinks for a wiki page in one wiki space. Operation agents should pass the issue's spaceSlug; omitting it uses the default space.",
      parametersSchema: {
        type: "object",
        properties: {
          companyId: { type: "string" },
          wikiId: { type: "string" },
          spaceSlug: { type: "string" },
          path: { type: "string" }
        },
        required: ["companyId", "wikiId", "path"]
      }
    },
    {
      name: "wiki_list_pages",
      displayName: "List Wiki Pages",
      description: "Return the known page index from one wiki space's plugin metadata. Operation agents should pass the issue's spaceSlug; omitting it uses the default space.",
      parametersSchema: {
        type: "object",
        properties: {
          companyId: { type: "string" },
          wikiId: { type: "string" },
          spaceSlug: { type: "string" }
        },
        required: ["companyId", "wikiId"]
      }
    }
  ],
  apiRoutes: [
    {
      routeKey: "overview",
      method: "GET",
      path: "/overview",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" }
    },
    {
      routeKey: "bootstrap",
      method: "POST",
      path: "/bootstrap",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" }
    },
    {
      routeKey: "capture-source",
      method: "POST",
      path: "/sources",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" }
    },
    {
      routeKey: "spaces",
      method: "GET",
      path: "/spaces",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" }
    },
    {
      routeKey: "create-space",
      method: "POST",
      path: "/spaces",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" }
    },
    {
      routeKey: "update-space",
      method: "PATCH",
      path: "/spaces/:spaceSlug",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" }
    },
    {
      routeKey: "bootstrap-space",
      method: "POST",
      path: "/spaces/:spaceSlug/bootstrap",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" }
    },
    {
      routeKey: "archive-space",
      method: "POST",
      path: "/spaces/:spaceSlug/archive",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" }
    },
    {
      routeKey: "operations",
      method: "GET",
      path: "/operations",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" }
    },
    {
      routeKey: "start-query",
      method: "POST",
      path: "/query-sessions",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" }
    },
    {
      routeKey: "file-as-page",
      method: "POST",
      path: "/file-as-page",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" }
    }
  ],
  ui: {
    slots: [
      {
        type: "sidebar",
        id: "wiki-sidebar",
        displayName: "Wiki",
        exportName: "SidebarLink",
        order: 35
      },
      {
        type: "page",
        id: "wiki-page",
        displayName: "Wiki",
        exportName: "WikiPage",
        routePath: "wiki"
      },
      {
        type: "routeSidebar",
        id: "wiki-route-sidebar",
        displayName: "Wiki",
        exportName: "WikiRouteSidebar",
        routePath: "wiki"
      }
    ]
  }
};

export default manifest;
