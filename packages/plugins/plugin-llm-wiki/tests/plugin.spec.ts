import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Agent, Issue, PluginManagedRoutineResolution, Project } from "@paperclipai/plugin-sdk";
import manifest, {
  CURSOR_WINDOW_ROUTINE_KEY,
  INDEX_REFRESH_ROUTINE_KEY,
  NIGHTLY_LINT_ROUTINE_KEY,
  PAPERCLIP_DISTILL_SKILL_KEY,
  WIKI_MAINTAINER_AGENT_KEY,
  WIKI_MAINTAINER_SKILL_CANONICAL_KEY,
  WIKI_MAINTAINER_SKILL_KEY,
  WIKI_MANAGED_SKILL_CANONICAL_KEYS,
  WIKI_MANAGED_SKILL_KEYS,
  WIKI_MAINTENANCE_ROUTINE_KEYS,
  WIKI_PROJECT_KEY,
} from "../src/manifest.js";
import {
  DEFAULT_AGENT_INSTRUCTION_FILES,
  DEFAULT_AGENT_INSTRUCTIONS,
  DEFAULT_IDEA,
  DEFAULT_INDEX,
  DEFAULT_LOG,
  DEFAULT_WIKI_SCHEMA,
  KARPATHY_LLM_WIKI_GIST_URL,
  LINT_PROMPT,
  QUERY_PROMPT,
} from "../src/templates.js";
import { SettingsPage, SidebarLink, WikiPage, WikiRouteSidebar } from "../src/ui/index.js";
import plugin from "../src/worker.js";
import { OPERATION_ORIGIN_KIND, type WikiSkillResource } from "../src/wiki.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY_ID = "99999999-9999-4999-8999-999999999999";
const ORIGINAL_DEPLOYMENT_MODE = process.env.PAPERCLIP_DEPLOYMENT_MODE;
const ORIGINAL_DEPLOYMENT_EXPOSURE = process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE;
type TestBridgeGlobal = typeof globalThis & {
  __paperclipPluginBridge__?: {
    sdkUi?: Record<string, unknown>;
  };
};
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};
const DEFAULT_MANAGED_SKILL = {
  status: "resolved",
  skillId: "skill-1",
  resourceKey: WIKI_MAINTAINER_SKILL_KEY,
  details: {
    name: "LLM Wiki Maintainer",
    key: WIKI_MAINTAINER_SKILL_CANONICAL_KEY,
    description: "Use the LLM Wiki plugin tools to maintain a cited local company wiki.",
  },
  skill: {
    id: "skill-1",
    name: "LLM Wiki Maintainer",
    key: WIKI_MAINTAINER_SKILL_CANONICAL_KEY,
    description: "Use the LLM Wiki plugin tools to maintain a cited local company wiki.",
  },
};
const DEFAULT_MANAGED_SKILLS = WIKI_MANAGED_SKILL_KEYS.map((skillKey, index) => ({
  status: "resolved",
  skillId: `skill-${index + 1}`,
  resourceKey: skillKey,
  details: skillKey === WIKI_MAINTAINER_SKILL_KEY
    ? DEFAULT_MANAGED_SKILL.details
    : {
        name: skillKey.split("-").map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" "),
        key: WIKI_MANAGED_SKILL_CANONICAL_KEYS[index],
        description: null,
      },
  skill: skillKey === WIKI_MAINTAINER_SKILL_KEY
    ? DEFAULT_MANAGED_SKILL.skill
    : {
        id: `skill-${index + 1}`,
        name: skillKey.split("-").map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" "),
        key: WIKI_MANAGED_SKILL_CANONICAL_KEYS[index],
        description: null,
      },
}));

let mockPathname = "/PAP/wiki";
let mockSearch = "";
let mockAutoSelectFile: string | null = null;
let mockNavigatedTo: string | null = null;
let mockOverviewFolder: Record<string, unknown> | null = null;
let mockSettingsFolder: Record<string, unknown> | null = null;
let mockSettingsManagedAgent: Record<string, unknown> | null = null;
let mockSettingsManagedRoutines: Array<Record<string, unknown>> = [];
let mockSettingsManagedSkills: Array<Record<string, unknown>> = [];
let mockDistillationOverviewData: Record<string, unknown> | null = null;
let mockPageContentsByPath: Record<string, string> = {};
let mockPageMetadataByPath: Record<string, {
  backlinks?: string[];
  sourceRefs?: Array<Record<string, unknown> | string>;
}> = {};

beforeEach(() => {
  if (ORIGINAL_DEPLOYMENT_MODE == null) {
    delete process.env.PAPERCLIP_DEPLOYMENT_MODE;
  } else {
    process.env.PAPERCLIP_DEPLOYMENT_MODE = ORIGINAL_DEPLOYMENT_MODE;
  }
  if (ORIGINAL_DEPLOYMENT_EXPOSURE == null) {
    delete process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE;
  } else {
    process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE = ORIGINAL_DEPLOYMENT_EXPOSURE;
  }
  mockPathname = "/PAP/wiki";
  mockSearch = "";
  mockAutoSelectFile = null;
  mockNavigatedTo = null;
  mockOverviewFolder = null;
  mockSettingsFolder = null;
  mockSettingsManagedAgent = null;
  mockSettingsManagedRoutines = [];
  mockSettingsManagedSkills = [];
  mockDistillationOverviewData = null;
  mockPageContentsByPath = {};
  mockPageMetadataByPath = {};
  (globalThis as TestBridgeGlobal).__paperclipPluginBridge__ = {
    sdkUi: {
      usePluginData: (key: string, params?: Record<string, unknown>) => {
        if (key === "overview") {
          return {
            data: {
              status: "ok",
              checkedAt: new Date().toISOString(),
              wikiId: "default",
              folder: mockOverviewFolder ?? {
                configured: true,
                path: "/tmp/company-wiki",
                realPath: "/tmp/company-wiki",
                access: "readWrite",
                readable: true,
                writable: true,
                requiredDirectories: [],
                requiredFiles: [],
                missingDirectories: [],
                missingFiles: [],
                healthy: true,
                problems: [],
                checkedAt: new Date().toISOString(),
              },
              managedAgent: { status: "resolved", source: "managed", agentId: "agent-1", resourceKey: "wiki-maintainer", details: { name: "Wiki Maintainer", status: "idle", adapterType: "claude_local", icon: "book-open", urlKey: "wiki-maintainer" } },
              managedProject: { status: "resolved", projectId: "project-1", details: { name: "LLM Wiki", status: "in_progress" } },
              managedSkills: DEFAULT_MANAGED_SKILLS,
              operationCount: 0,
              eventIngestion: {
                enabled: false,
                sources: { issues: false, comments: false, documents: false },
                wikiId: "default",
                maxCharacters: 12000,
              },
              capabilities: [],
              prompts: { query: QUERY_PROMPT, lint: LINT_PROMPT },
            },
            loading: false,
            error: null,
            refresh: () => undefined,
          };
        }
        if (key === "spaces") {
          return {
            data: {
              spaces: [
                {
                  id: "space-default",
                  companyId: COMPANY_ID,
                  wikiId: "default",
                  slug: "default",
                  displayName: "default",
                  spaceType: "managed",
                  folderMode: "managed_subfolder",
                  rootFolderKey: "wiki-root",
                  pathPrefix: null,
                  configuredRootPath: null,
                  accessScope: "shared",
                  ownerUserId: null,
                  ownerAgentId: null,
                  teamKey: null,
                  settings: {},
                  status: "active",
                  createdAt: null,
                  updatedAt: null,
                },
              ],
            },
            loading: false,
            error: null,
            refresh: () => undefined,
          };
        }
        if (key === "pages") {
          return {
            data: {
              pages: [
                {
                  path: "wiki/concepts/sidebar-navigation.md",
                  title: "Sidebar navigation",
                  pageType: "concepts",
                  backlinkCount: 0,
                  sourceCount: 0,
                  contentHash: "abc123",
                  updatedAt: new Date().toISOString(),
                },
              ],
              sources: [
                {
                  rawPath: "raw/sidebar-notes.md",
                  title: "Sidebar notes",
                  sourceType: "text",
                  url: null,
                  status: "captured",
                  createdAt: new Date().toISOString(),
                },
              ],
            },
            loading: false,
            error: null,
            refresh: () => undefined,
          };
        }
        if (key === "settings") {
          return {
            data: {
              status: "ok",
              checkedAt: new Date().toISOString(),
              wikiId: "default",
              folder: mockSettingsFolder ?? {
                configured: true,
                path: "/tmp/company-wiki",
                realPath: "/tmp/company-wiki",
                access: "readWrite",
                readable: true,
                writable: true,
                requiredDirectories: [],
                requiredFiles: [],
                missingDirectories: [],
                missingFiles: [],
                healthy: true,
                problems: [],
                checkedAt: new Date().toISOString(),
              },
              managedAgent: mockSettingsManagedAgent ?? { status: "resolved", source: "managed", agentId: "agent-1", resourceKey: "wiki-maintainer", details: { name: "Wiki Maintainer", status: "idle", adapterType: "claude_local", icon: "book-open", urlKey: "wiki-maintainer" } },
              managedProject: { status: "resolved", source: "managed", projectId: "project-1", resourceKey: "llm-wiki", details: { name: "LLM Wiki", status: "in_progress" } },
              managedSkills: mockSettingsManagedSkills.length > 0 ? mockSettingsManagedSkills : DEFAULT_MANAGED_SKILLS,
              managedRoutines: mockSettingsManagedRoutines,
              managedRoutine: mockSettingsManagedRoutines[0] ?? null,
              eventIngestion: {
                enabled: false,
                sources: { issues: false, comments: false, documents: false },
                wikiId: "default",
                maxCharacters: 12000,
              },
              agentOptions: [{ id: "agent-1", name: "Wiki Maintainer", status: "idle", icon: "book-open", urlKey: "wiki-maintainer" }],
              projectOptions: [{ id: "project-1", name: "LLM Wiki", status: "in_progress", color: "#2563eb" }],
              capabilities: [],
            },
            loading: false,
            error: null,
            refresh: () => undefined,
          };
        }
        if (key === "space") {
          return {
            data: {
              id: "space-default",
              companyId: COMPANY_ID,
              wikiId: "default",
              slug: "default",
              displayName: "default",
              spaceType: "managed",
              folderMode: "managed_subfolder",
              rootFolderKey: "wiki-root",
              pathPrefix: null,
              configuredRootPath: null,
              accessScope: "shared",
              ownerUserId: null,
              ownerAgentId: null,
              teamKey: null,
              settings: {},
              status: "active",
              createdAt: null,
              updatedAt: null,
              relativeRoot: "",
              folder: {
                configured: true,
                path: "/tmp/company-wiki",
                realPath: "/tmp/company-wiki",
                access: "readWrite",
                readable: true,
                writable: true,
                requiredDirectories: ["raw", "wiki"],
                requiredFiles: ["AGENTS.md"],
                missingDirectories: [],
                missingFiles: [],
                healthy: true,
                problems: [],
                checkedAt: new Date().toISOString(),
              },
            },
            loading: false,
            error: null,
            refresh: () => undefined,
          };
        }
        if (key === "distillation-overview") {
          return {
            data: mockDistillationOverviewData,
            loading: false,
            error: null,
            refresh: () => undefined,
          };
        }
        if (key === "page-content") {
          const path = typeof params?.path === "string" ? params.path : "wiki/index.md";
          const contents = mockPageContentsByPath[path] ?? (path === "AGENTS.md"
            ? DEFAULT_AGENT_INSTRUCTIONS
            : path === "IDEA.md"
              ? DEFAULT_IDEA
              : `# ${path}\n`);
          return {
            data: {
              wikiId: "default",
              path,
              contents,
              title: path === "AGENTS.md" ? "LLM Wiki Maintainer" : path.replace(/\.md$/, ""),
              pageType: path === "AGENTS.md" ? null : "index",
              backlinks: mockPageMetadataByPath[path]?.backlinks ?? [],
              sourceRefs: mockPageMetadataByPath[path]?.sourceRefs ?? [],
              updatedAt: null,
              hash: "abc123",
            },
            loading: false,
            error: null,
            refresh: () => undefined,
          };
        }
        return { data: null, loading: false, error: null, refresh: () => undefined };
      },
      usePluginAction: () => async () => ({}),
      usePluginToast: () => () => null,
      useHostNavigation: () => ({
        resolveHref: (to: string) => `/PAP${to.startsWith("/") ? to : `/${to}`}`,
        navigate: (to: string) => { mockNavigatedTo = to; },
        linkProps: (to: string) => ({
          href: `/PAP${to.startsWith("/") ? to : `/${to}`}`,
          onClick: () => undefined,
        }),
      }),
      useHostLocation: () => ({
        pathname: mockPathname,
        search: mockSearch,
        hash: "",
      }),
      FileTree: (props: {
        nodes: Array<{ name: string; path: string; kind: string; children?: Array<{ name: string; path: string; kind: string }> }>;
        selectedFile?: string | null;
        ariaLabel?: string;
        wrapLabels?: boolean;
        fileBadges?: Record<string, unknown>;
        onSelectFile?: (path: string) => void;
      }) => {
        if (mockAutoSelectFile) props.onSelectFile?.(mockAutoSelectFile);
        return createElement(
          "div",
          {
            role: "tree",
            "aria-label": props.ariaLabel,
            "data-selected-file": props.selectedFile ?? "",
            "data-wrap-labels": String(props.wrapLabels),
            "data-has-file-badges": String(Boolean(props.fileBadges && Object.keys(props.fileBadges).length > 0)),
          },
          props.nodes.map((node) => createElement("div", { key: node.path }, node.name)),
        );
      },
      IssuesList: (props: {
        projectId?: string | null;
        filters?: { originKindPrefix?: string };
      }) => createElement(
        "div",
        { "data-testid": "plugin-issues-list" },
        `Issues table · ${props.projectId ?? "no-project"} · ${props.filters?.originKindPrefix ?? "no-origin-filter"}`,
      ),
      MarkdownBlock: ({ content }: { content: string }) => createElement("div", { "data-testid": "markdown-block" }, content),
      MarkdownEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => createElement("textarea", {
        "data-testid": "markdown-editor",
        value,
        onChange: (event: { currentTarget: { value: string } }) => onChange(event.currentTarget.value),
      }),
      AssigneePicker: (props: {
        value: string;
        placeholder?: string;
        onChange: (value: string, selection: { assigneeAgentId: string | null; assigneeUserId: string | null }) => void;
      }) => createElement(
        "button",
        {
          type: "button",
          "data-testid": "assignee-picker",
          onClick: () => props.onChange("agent:agent-1", { assigneeAgentId: "agent-1", assigneeUserId: null }),
        },
        props.value === "agent:agent-1" ? "Wiki Maintainer" : (props.placeholder ?? "Select assignee"),
      ),
      ProjectPicker: (props: {
        value: string;
        placeholder?: string;
        onChange: (projectId: string) => void;
      }) => createElement(
        "button",
        {
          type: "button",
          "data-testid": "project-picker",
          onClick: () => props.onChange("project-1"),
        },
        props.value === "project-1" ? "LLM Wiki" : (props.placeholder ?? "Project"),
      ),
      ManagedRoutinesList: (props: {
        routines: Array<{
          key: string;
          title: string;
          href?: string | null;
          projectId?: string | null;
          assigneeAgentId?: string | null;
          defaultDrift?: { changedFields: string[] } | null;
        }>;
        agents?: Array<{ id: string; name: string }>;
        projects?: Array<{ id: string; name: string }>;
        onReset?: (routine: { key: string; title: string }) => void;
      }) => createElement(
        "div",
        { "data-testid": "managed-routines-list" },
        props.routines.map((routine) => {
          const agent = props.agents?.find((item) => item.id === routine.assigneeAgentId);
          const project = props.projects?.find((item) => item.id === routine.projectId);
          return createElement(
            "div",
            { key: routine.key },
            createElement("span", null, routine.title),
            createElement("button", null, "Run now"),
            createElement("button", { role: "switch" }, "On"),
            routine.href ? createElement("a", { href: `/PAP${routine.href}` }, "Configure") : null,
            routine.defaultDrift?.changedFields.length
              ? createElement("span", null, `Plugin defaults changed: ${routine.defaultDrift.changedFields.join(", ")}`)
              : null,
            routine.defaultDrift?.changedFields.length && props.onReset
              ? createElement("button", null, "Reset")
              : null,
            createElement("span", null, `${project?.name ?? "No project"} · ${agent?.name ?? "No default agent"}`),
          );
        }),
      ),
    },
  };
});

afterEach(() => {
  if (ORIGINAL_DEPLOYMENT_MODE == null) {
    delete process.env.PAPERCLIP_DEPLOYMENT_MODE;
  } else {
    process.env.PAPERCLIP_DEPLOYMENT_MODE = ORIGINAL_DEPLOYMENT_MODE;
  }
  if (ORIGINAL_DEPLOYMENT_EXPOSURE == null) {
    delete process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE;
  } else {
    process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE = ORIGINAL_DEPLOYMENT_EXPOSURE;
  }
  delete (globalThis as TestBridgeGlobal).__paperclipPluginBridge__;
});

function wikiMaintainerAgent(): Agent {
  const now = new Date();
  return {
    id: "22222222-2222-4222-8222-222222222222",
    companyId: COMPANY_ID,
    name: "Wiki Maintainer",
    urlKey: "wiki-maintainer",
    role: "general",
    title: "LLM Wiki Maintainer",
    icon: "book-open",
    status: "idle",
    reportsTo: null,
    capabilities: "Maintains the wiki",
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: {
      paperclipManagedResource: {
        pluginKey: manifest.id,
        resourceKind: "agent",
        resourceKey: "wiki-maintainer",
      },
    },
    createdAt: now,
    updatedAt: now,
  };
}

function existingAgent(): Agent {
  return {
    ...wikiMaintainerAgent(),
    id: "44444444-4444-4444-8444-444444444444",
    name: "Existing Knowledge Agent",
    urlKey: "existing-knowledge-agent",
    title: "Knowledge Agent",
    metadata: {},
  };
}

function existingProject(): Project {
  const now = new Date();
  return {
    id: "55555555-5555-4555-8555-555555555555",
    companyId: COMPANY_ID,
    urlKey: "existing-wiki-project",
    goalId: null,
    goalIds: [],
    goals: [],
    name: "Existing Wiki Project",
    description: "Existing project selected for wiki operations.",
    status: "in_progress",
    leadAgentId: null,
    targetDate: null,
    color: "#0f766e",
    env: null,
    pauseReason: null,
    pausedAt: null,
    executionWorkspacePolicy: null,
    codebase: {
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      defaultRef: null,
      repoName: null,
      localFolder: null,
      managedFolder: "/tmp/existing-wiki-project",
      effectiveLocalFolder: "/tmp/existing-wiki-project",
      origin: "managed_checkout",
    },
    workspaces: [],
    primaryWorkspace: null,
    managedByPlugin: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function paperclipIssue(overrides: Partial<Issue> = {}): Issue {
  const now = new Date();
  return {
    id: "66666666-6666-4666-8666-666666666666",
    companyId: COMPANY_ID,
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Design event ingestion controls",
    description: "Decide which Paperclip issues, comments, and documents can be ingested into the wiki.",
    status: "todo",
    workMode: "standard",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 3204,
    identifier: "PAP-3204",
    originId: null,
    originRunId: null,
    originFingerprint: null,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionPolicy: null,
    executionState: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function wikiSpaceRow(space: Record<string, unknown>) {
  return {
    id: space.id,
    company_id: space.companyId ?? COMPANY_ID,
    wiki_id: space.wikiId ?? "default",
    slug: space.slug,
    display_name: space.displayName,
    space_type: space.spaceType ?? "local_folder",
    folder_mode: space.folderMode ?? "managed_subfolder",
    root_folder_key: space.rootFolderKey ?? "wiki-root",
    path_prefix: space.pathPrefix ?? `spaces/${space.slug}`,
    configured_root_path: space.configuredRootPath ?? null,
    access_scope: space.accessScope ?? "shared",
    owner_user_id: space.ownerUserId ?? null,
    owner_agent_id: space.ownerAgentId ?? null,
    team_key: space.teamKey ?? null,
    settings: space.settings ?? {},
    status: space.status ?? "active",
    created_at: space.createdAt ?? null,
    updated_at: space.updatedAt ?? null,
  };
}

function defaultWikiSpaceRow() {
  return wikiSpaceRow({
    id: "77777777-7777-4777-8777-7777777777d0",
    companyId: COMPANY_ID,
    wikiId: "default",
    slug: "default",
    displayName: "default",
    pathPrefix: null,
    accessScope: "shared",
    settings: {},
  });
}

function mockPersistedWikiSpace(harness: ReturnType<typeof createTestHarness>, space: Record<string, unknown>) {
  const row = wikiSpaceRow(space);
  const originalQuery = harness.ctx.db.query.bind(harness.ctx.db);
  harness.ctx.db.query = async <T,>(sql: string, params?: unknown[]) => {
    if (sql.includes("wiki_spaces") && params?.[2] === row.slug) {
      return [row] as T[];
    }
    if (sql.includes("wiki_spaces") && sql.includes("ORDER BY CASE WHEN slug = 'default'")) {
      return [defaultWikiSpaceRow(), row] as T[];
    }
    return originalQuery<T>(sql, params);
  };
}

describe("LLM Wiki plugin scaffold", () => {
  it("declares standalone plugin surfaces without core wiki coupling", () => {
    expect(manifest.id).toBe("paperclipai.plugin-llm-wiki");
    expect(manifest.entrypoints.worker).toBe("./dist/worker.js");
    expect(manifest.entrypoints.ui).toBe("./dist/ui");
    expect(manifest.database?.namespaceSlug).toBe("llm_wiki");
    expect(manifest.localFolders?.[0]?.requiredDirectories).toContain("wiki/projects");
    expect(manifest.localFolders?.[0]?.requiredDirectories).not.toContain("projects");
    expect(manifest.localFolders?.[0]?.requiredFiles).toEqual([
      "AGENTS.md",
      "IDEA.md",
      "wiki/index.md",
      "wiki/log.md",
    ]);
    expect(manifest.agents?.[0]?.agentKey).toBe("wiki-maintainer");
    expect(manifest.agents?.[0]?.adapterType).toBe("claude_local");
    expect(manifest.agents?.[0]?.adapterConfig).toMatchObject({
      dangerouslySkipPermissions: false,
      dangerouslyBypassApprovalsAndSandbox: false,
      sandbox: true,
    });
    expect(manifest.agents?.[0]?.instructions?.entryFile).toBe("AGENTS.md");
    expect(manifest.agents?.[0]?.instructions?.content).toContain("You are the maintainer of this personal wiki");
    expect(manifest.agents?.[0]?.instructions?.files?.["AGENTS.md"]).toContain("{{localFolders.wiki-root.path}}");
    expect(manifest.agents?.[0]?.instructions?.assetPath).toBe("agents/wiki-maintainer");
    expect(manifest.projects?.[0]?.projectKey).toBe("llm-wiki");
    expect(manifest.routines?.map((routine) => routine.routineKey)).toEqual([
      CURSOR_WINDOW_ROUTINE_KEY,
      NIGHTLY_LINT_ROUTINE_KEY,
      INDEX_REFRESH_ROUTINE_KEY,
    ]);
    expect(manifest.routines).toEqual(
      WIKI_MAINTENANCE_ROUTINE_KEYS.map((routineKey) => expect.objectContaining({
        routineKey,
        assigneeRef: { resourceKind: "agent", resourceKey: WIKI_MAINTAINER_AGENT_KEY },
        projectRef: { resourceKind: "project", resourceKey: WIKI_PROJECT_KEY },
        concurrencyPolicy: "skip_if_active",
        catchUpPolicy: "skip_missed",
        issueTemplate: expect.objectContaining({
          surfaceVisibility: "plugin_operation",
          billingCode: expect.stringMatching(/^plugin-llm-wiki:/),
        }),
      })),
    );
    for (const routine of manifest.routines ?? []) {
      expect(routine.description).toContain("Run procedure:");
      expect(routine.description).toContain("Target space: default (slug: default)");
      expect(routine.description).toContain("spaceSlug `default`");
      expect(routine.description).toContain("AGENTS.md");
      expect(routine.description).toContain("wiki/log.md");
    }
    expect(manifest.tools?.map((tool) => tool.name)).toEqual([
      "wiki_search",
      "wiki_read_page",
      "wiki_write_page",
      "wiki_propose_patch",
      "wiki_list_sources",
      "wiki_read_source",
      "wiki_append_log",
      "wiki_update_index",
      "wiki_list_backlinks",
      "wiki_list_pages",
    ]);
    expect(manifest.ui?.slots?.map((slot) => slot.type)).toEqual([
      "sidebar",
      "page",
      "routeSidebar",
    ]);
    expect(manifest.capabilities).not.toContain("instance.settings.register");
    expect(manifest.instanceConfigSchema).toBeUndefined();
    const routeSidebarSlot = manifest.ui?.slots?.find((slot) => slot.type === "routeSidebar");
    expect(routeSidebarSlot).toMatchObject({
      id: "wiki-route-sidebar",
      exportName: "WikiRouteSidebar",
      routePath: "wiki",
    });
    expect(packageJson.dependencies).toBeUndefined();
    expect(packageJson.devDependencies?.react).toBeUndefined();
    expect(packageJson.devDependencies?.["react-dom"]).toBeDefined();
    expect(packageJson.devDependencies?.["@types/react-dom"]).toBeDefined();
    expect(packageJson.peerDependencies?.react).toBe(">=18");
  });

  it("renders a host-aligned sidebar link with an open-book icon", () => {
    const markup = renderToStaticMarkup(createElement(SidebarLink, {
      context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
    } as never));

    expect(markup).toContain('href="/PAP/wiki"');
    expect(markup).toContain("gap-2.5 px-3 py-2 text-[13px] font-medium");
    expect(markup).toContain("hover:bg-accent/50 hover:text-foreground");
    expect(markup).toContain("<svg");
    expect(markup).toContain("M12 7v14");
    expect(markup).not.toContain("Wiki plugin");
    expect(markup).not.toContain("border-radius:999");
    expect(markup).not.toContain("📖");
  });

  it("ships Karpathy-pattern schema and workflow prompts by default", () => {
    expect(DEFAULT_WIKI_SCHEMA).toContain("You are the maintainer of this personal wiki");
    expect(DEFAULT_WIKI_SCHEMA).toContain("raw/");
    expect(DEFAULT_WIKI_SCHEMA).toContain("wiki/projects/<project-slug>/standup.md");
    expect(DEFAULT_WIKI_SCHEMA).toContain("wiki/projects/<project-slug>/index.md");
    expect(DEFAULT_WIKI_SCHEMA).toContain("Do not create a top-level `projects/` directory");
    expect(DEFAULT_WIKI_SCHEMA).not.toContain("\n├── projects/");
    expect(DEFAULT_WIKI_SCHEMA).toContain("wiki/");
    expect(DEFAULT_WIKI_SCHEMA).toContain("AGENTS.md");
    expect(DEFAULT_IDEA).toContain("persistent, compounding artifact");
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain("You are the maintainer of this personal wiki");
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain("ingest, query, lint, index, or maintenance work");
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain("dedicated LLM Wiki skill installed on this agent");
    expect(DEFAULT_AGENT_INSTRUCTIONS).not.toContain("skills/<name>/SKILL.md");
    expect(DEFAULT_AGENT_INSTRUCTION_FILES["skills/wiki-ingest/SKILL.md"]).toBeUndefined();
    expect(manifest.skills?.map((skill) => skill.skillKey)).toEqual([...WIKI_MANAGED_SKILL_KEYS]);
    expect(manifest.agents?.[0]?.adapterConfig?.paperclipSkillSync).toEqual({
      desiredSkills: WIKI_MANAGED_SKILL_CANONICAL_KEYS,
    });
    expect(QUERY_PROMPT).toContain("wiki-query skill");
    expect(QUERY_PROMPT).not.toContain("skills/wiki-query/SKILL.md");
    expect(QUERY_PROMPT).toContain("filed back into wiki/");
    expect(LINT_PROMPT).toContain("wiki-lint skill");
    expect(LINT_PROMPT).not.toContain("skills/wiki-lint/SKILL.md");
    expect(LINT_PROMPT).toContain("severity");
  });

  it("renders the route-scoped Wiki sidebar with tool actions, page navigation, and a back link", () => {
    const markup = renderToStaticMarkup(createElement(WikiRouteSidebar, {
      context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
    } as never));

    expect(markup).toContain('href="/PAP/dashboard"');
    expect(markup).toContain("PAP");
    expect(markup).toContain('href="/PAP/wiki/query"');
    expect(markup).not.toContain('href="/PAP/wiki/lint"');
    expect(markup).toContain('href="/PAP/wiki/history"');
    expect(markup).toContain('href="/PAP/wiki/settings"');
    expect(markup).not.toContain('href="/PAP/wiki/operations"');
    // Add Content reuses the legacy /wiki/ingest route so deep links still work.
    expect(markup).toContain('href="/PAP/wiki/ingest"');
    expect(markup).toContain('aria-label="Wiki primary"');
    expect(markup).toContain('aria-label="Wiki secondary"');
    for (const label of ["Ask", "Add Content", "History", "Settings", "Shared Spaces", "default", "raw", "wiki", "AGENTS.md", "IDEA.md"]) {
      expect(markup).toContain(label);
    }
    expect(markup).not.toContain(">Lint</span>");
    expect(markup).not.toContain(">Ingest</span>");
    expect(markup).not.toContain(">Operations</span>");
    expect(markup).not.toContain('text-sm font-bold text-foreground">Wiki');
    expect(markup).not.toContain("Browse");
    expect(markup).not.toContain(">Query<");
    expect(markup).toContain('role="tree"');
    expect(markup).toContain('data-selected-file=""');
    expect(markup).toContain('data-wrap-labels="false"');
    expect(markup).toContain('data-has-file-badges="false"');
  });

  it("routes legacy Wiki operations URLs to the History issue table", () => {
    mockPathname = "/PAP/wiki/operations";
    const markup = renderToStaticMarkup(createElement(WikiPage, {
      context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
    } as never));

    expect(markup).toContain("Issues table · project-1 · plugin:paperclipai.plugin-llm-wiki:operation");
    expect(markup).not.toContain("Recent runs");
    expect(markup).not.toContain(">Operations</h2>");
  });

  it("loads AGENTS.md from the Wiki page and exposes an edit affordance", () => {
    mockPathname = "/PAP/wiki/page/templates/AGENTS.md";
    const markup = renderToStaticMarkup(createElement(WikiPage, {
      context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
    } as never));

    expect(markup).toContain("AGENTS");
    expect(markup).toContain(">AGENTS.md</h1>");
    expect(markup).not.toContain(">LLM Wiki Maintainer</h1>");
    expect(markup).toContain("You are the maintainer of this personal wiki");
    expect(markup).toContain("wiki-root `AGENTS.md`");
    expect(markup).toContain("Edit page");
    expect(markup).toContain("Updated —");
    expect(markup).not.toContain("0 backlinks");
    expect(markup).not.toContain("0 sources");
    expect(markup).not.toContain("abc123");
    expect(markup).not.toContain("+ Ingest");
    expect(markup).not.toContain("Folder healthy");
  });

  it("does not render page footer sources and backlinks", () => {
    mockPathname = "/PAP/wiki/page/wiki/projects/control-plane/index.md";
    mockPageContentsByPath["wiki/projects/control-plane/index.md"] = "# Control plane\n\nCurrent project state.";
    mockPageMetadataByPath["wiki/projects/control-plane/index.md"] = {
      backlinks: ["wiki/backlinks/hidden-footer-link.md"],
      sourceRefs: [{ kind: "issue", issueIdentifier: "PAP-FOOTER-1" }],
    };

    const markup = renderToStaticMarkup(createElement(WikiPage, {
      context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
    } as never));

    expect(markup).toContain("Current project state.");
    expect(markup).not.toContain(">Sources</");
    expect(markup).not.toContain(">Backlinks</");
    expect(markup).not.toContain("PAP-FOOTER-1");
    expect(markup).not.toContain("hidden-footer-link");
  });

  it("renders YAML frontmatter as foldable properties without duplicating title", () => {
    mockPathname = "/PAP/wiki/page/wiki/concepts/sidebar-navigation.md";
    mockPageContentsByPath["wiki/concepts/sidebar-navigation.md"] = `---
title: Sidebar navigation
type: concept
tags: [paperclip, wiki]
sources:
  - raw/sidebar-notes.md
created: 2026-05-04
updated: 2026-05-04
---
# Sidebar navigation

Route sidebar state stays attached to the selected wiki page.
`;

    const markup = renderToStaticMarkup(createElement(WikiPage, {
      context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
    } as never));

    expect(markup).toContain("<summary");
    expect(markup).toContain("Properties");
    expect(markup).toContain(">type</dt>");
    expect(markup).toContain("concept");
    expect(markup).toContain(">tags</dt>");
    expect(markup).toContain("paperclip");
    expect(markup).toContain("wiki");
    expect(markup).toContain(">sources</dt>");
    expect(markup).toContain("raw/sidebar-notes.md");
    expect(markup).toContain("Route sidebar state");
    expect(markup).not.toContain("title: Sidebar navigation");
    expect(markup).not.toContain("title</dt>");
    expect(markup).not.toContain("---");
  });

  it("renders a foldable on-this-page pane from wiki page headings", () => {
    mockPathname = "/PAP/wiki/page/wiki/concepts/sidebar-navigation.md";
    mockPageContentsByPath["wiki/concepts/sidebar-navigation.md"] = `# Sidebar navigation

## Why it matters

Route sidebar state stays attached to the selected wiki page.

### Deep link behavior

Wiki links preserve normal browser navigation.

\`\`\`md
## Ignored code heading
\`\`\`

## Why it matters

Duplicate headings receive stable suffixes.
`;

    const markup = renderToStaticMarkup(createElement(WikiPage, {
      context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
    } as never));

    expect(markup).toContain('aria-label="On this page"');
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('aria-current="location"');
    expect(markup).toContain('href="#why-it-matters"');
    expect(markup).toContain('href="#deep-link-behavior"');
    expect(markup).toContain('href="#why-it-matters-2"');
    expect(markup).not.toContain('href="#ignored-code-heading"');
    const tocMarkup = markup.slice(
      markup.indexOf('aria-label="On this page"'),
      markup.indexOf("</aside>", markup.indexOf('aria-label="On this page"')),
    );
    expect(tocMarkup).toContain("position:sticky");
    expect(tocMarkup).toContain("top:88px");
    expect(tocMarkup).not.toContain("background:color-mix");
    expect(tocMarkup).not.toContain("border-radius");
  });

  it("shows folder repair instead of reading pages when the wiki root is stale", () => {
    mockPathname = "/PAP/wiki/page/AGENTS.md";
    mockOverviewFolder = {
      configured: true,
      path: "/tmp/deleted-wiki-root",
      realPath: null,
      access: "readWrite",
      readable: false,
      writable: false,
      requiredDirectories: ["raw", "wiki"],
      requiredFiles: ["AGENTS.md"],
      missingDirectories: ["raw", "wiki"],
      missingFiles: ["AGENTS.md"],
      healthy: false,
      problems: [
        { code: "missing", message: "Configured local folder cannot be inspected.", path: "/tmp/deleted-wiki-root" },
      ],
      checkedAt: new Date().toISOString(),
    };

    const markup = renderToStaticMarkup(createElement(WikiPage, {
      context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
    } as never));

    expect(markup).toContain("Repair wiki root folder");
    expect(markup).toContain("/tmp/deleted-wiki-root");
    expect(markup).toContain("Configured local folder cannot be inspected.");
    expect(markup).toContain("Repair &amp; bootstrap");
    expect(markup).not.toContain("Failed to read AGENTS.md");
    expect(markup).not.toContain(">AGENTS.md</h1>");
  });

  it("serializes root template pages as regular path segments", () => {
    mockAutoSelectFile = "AGENTS.md";
    renderToStaticMarkup(createElement(WikiRouteSidebar, {
      context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
    } as never));

    expect(mockNavigatedTo).toBe("/wiki/page/AGENTS.md");
  });

  it("highlights Settings for legacy lint links after lint moved under Settings", () => {
    mockPathname = "/PAP/wiki/lint";
    const markup = renderToStaticMarkup(createElement(WikiRouteSidebar, {
      context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
    } as never));

    expect(markup).not.toContain('href="/PAP/wiki/lint"');
    const settingsAnchor = markup.match(/<a[^>]*href="\/PAP\/wiki\/settings"[^>]*>/);
    expect(settingsAnchor?.[0]).toContain('aria-current="page"');
    expect(settingsAnchor?.[0]).toContain("text-foreground");
    expect(settingsAnchor?.[0]).not.toContain("bg-accent");
    const askAnchor = markup.match(/<a[^>]*href="\/PAP\/wiki\/query"[^>]*>/);
    expect(askAnchor?.[0]).not.toContain('aria-current="page"');
  });

  it("renders the maintainer settings without plugin metadata or inline AGENTS.md editing", () => {
    mockPathname = "/PAP/wiki/settings/maintainer";
    const markup = renderToStaticMarkup(createElement(WikiPage, {
      context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
    } as never));

    expect(markup).toContain("Wiki Maintainer");
    expect(markup).toContain("Adapter: claude local");
    expect(markup).toContain("Maintainer");
    expect(markup).toContain("Repair");
    expect(markup).toContain("Reset to defaults");
    expect(markup).not.toContain("Provided maintainer");
    expect(markup).not.toContain("Managed by LLM Wiki");
    expect(markup).not.toContain("Suggested default");
    expect(markup).not.toContain("AGENT INSTRUCTIONS");
    expect(markup).not.toContain("Stable key");
    expect(markup).not.toContain("Plugin managed default");
  });

  it("recommends approval when the wiki maintainer is pending board approval", () => {
    mockPathname = "/PAP/wiki/settings/maintainer";
    mockSettingsManagedAgent = {
      status: "created",
      source: "managed",
      agentId: "agent-1",
      resourceKey: "wiki-maintainer",
      details: { name: "Wiki Maintainer", status: "pending_approval", adapterType: "claude_local", icon: "book-open", urlKey: "wiki-maintainer" },
    };

    const markup = renderToStaticMarkup(createElement(WikiPage, {
      context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
    } as never));

    expect(markup).toContain("pending approval");
    expect(markup).toContain("Approve the agent");
    expect(markup).toContain("Adapter: claude local");
  });

  it("renders root settings as a compact health checklist with the shared path picker", () => {
    mockPathname = "/PAP/wiki/settings";
    const markup = renderToStaticMarkup(createElement(WikiPage, {
      context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
    } as never));

    expect(markup).toContain(">Setup</");
    expect(markup).toContain("Base Folder");
    expect(markup).toContain("Managed Agents");
    expect(markup).toContain("Managed Skills");
    expect(markup).toContain("Managed Projects");
    expect(markup).toContain("Managed Routines");
    expect(markup.indexOf(">Managed Agents</h2>")).toBeLessThan(markup.indexOf(">Managed Skills</h2>"));
    expect(markup.indexOf(">Managed Skills</h2>")).toBeLessThan(markup.indexOf(">Managed Projects</h2>"));
    expect(markup.indexOf(">Managed Projects</h2>")).toBeLessThan(markup.indexOf(">Managed Routines</h2>"));
    expect(markup).toContain("Adapter: claude local");
    expect(markup).toContain("Status: in progress");
    expect(markup).toContain("Wiki root health checklist");
    expect(markup).toContain("Health check");
    expect(markup).toContain("Wiki agents health checklist");
    expect(markup).toContain("Wiki routines health checklist");
    expect(markup).toContain("Wiki skills health checklist");
    expect(markup).toContain("Wiki projects health checklist");
    const routineChecklistStart = markup.indexOf('aria-label="Wiki routines health checklist"');
    const routineChecklist = markup.slice(routineChecklistStart);
    expect(routineChecklist).toContain("left:8px");
    expect(routineChecklist).toContain("background:oklch(0.38 0.09 145)");
    expect(routineChecklist).toContain("Process LLM Wiki updates");
    expect(routineChecklist).toContain("Run LLM Wiki lint");
    expect(routineChecklist).toContain("Refresh LLM Wiki index");
    expect(routineChecklist).not.toContain("Wiki Maintainer");
    expect(routineChecklist).not.toContain("LLM Wiki project");
    const skillChecklistStart = markup.indexOf('aria-label="Wiki skills health checklist"');
    const skillChecklist = markup.slice(skillChecklistStart, markup.indexOf('aria-label="Wiki projects health checklist"'));
    expect(skillChecklist).toContain("left:8px");
    expect(skillChecklist).toContain("background:oklch(0.38 0.09 145)");
    for (const headline of ["Path configured", "Readable", "Writable", "Baseline files", "Wiki folders"]) {
      expect(markup).toContain(headline);
    }
    expect(markup).toContain("Local wiki folder");
    expect(markup).toContain("Choose");
    expect(markup).toContain("Apply path");
    expect(markup).not.toContain("AGENTS.md, IDEA.md");
    expect(markup).not.toContain("Ready</span>");
    expect(markup).not.toContain("Needs attention</span>");
    expect(markup).not.toContain("wiki/sources/");
    expect(markup).not.toContain("wiki/entities/");
    expect(markup).not.toContain("Wiki root folder");
    expect(markup).not.toContain("Provided maintainer");
    expect(markup).not.toContain(">Project</span>");
    expect(markup).toContain("Ingestion Settings");
  });

  it("shows a top-level fix-all banner when settings configuration has errors", () => {
    mockPathname = "/PAP/wiki/settings";
    mockSettingsFolder = {
      configured: true,
      path: "/tmp/company-wiki",
      realPath: "/tmp/company-wiki",
      access: "readWrite",
      readable: true,
      writable: true,
      requiredDirectories: ["raw", "wiki"],
      requiredFiles: ["AGENTS.md"],
      missingDirectories: ["raw"],
      missingFiles: ["AGENTS.md"],
      healthy: false,
      problems: [
        { code: "missing_directory", message: "Required directory is missing.", path: "raw" },
        { code: "missing_file", message: "Required file is missing.", path: "AGENTS.md" },
      ],
      checkedAt: new Date().toISOString(),
    };

    const markup = renderToStaticMarkup(createElement(WikiPage, {
      context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
    } as never));

    expect(markup).toContain("configuration errors detected, fix them all?");
    expect(markup).toContain("Wiki root folder");
    expect(markup).toContain("Managed routines");
    expect(markup).toContain("need attention.");
    expect(markup).toContain("Fix them all");
    expect(markup.indexOf("configuration errors detected")).toBeLessThan(markup.indexOf(">Base Folder</"));
  });

  it("shows missing managed skills in setup health with a re-sync action", () => {
    mockPathname = "/PAP/wiki/settings";
    mockSettingsManagedSkills = [{
      status: "missing",
      skillId: null,
      resourceKey: WIKI_MAINTAINER_SKILL_KEY,
      details: {
        name: "LLM Wiki Maintainer",
        key: WIKI_MAINTAINER_SKILL_CANONICAL_KEY,
        description: null,
      },
    }];

    const markup = renderToStaticMarkup(createElement(WikiPage, {
      context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
    } as never));

    expect(markup).toContain("Managed Skills");
    expect(markup).toContain("skill issue(s) need attention");
    expect(markup).toContain("LLM Wiki Maintainer is not installed in the company skill library.");
    expect(markup).toContain("Re-sync skills");
  });

  it("shows managed skill default drift in setup health", () => {
    mockPathname = "/PAP/wiki/settings";
    mockSettingsManagedSkills = [{
      status: "resolved",
      skillId: "skill-1",
      resourceKey: WIKI_MAINTAINER_SKILL_KEY,
      defaultDrift: { changedFiles: ["SKILL.md"] },
      details: {
        name: "LLM Wiki Maintainer",
        key: WIKI_MAINTAINER_SKILL_CANONICAL_KEY,
        description: null,
      },
    }];

    const markup = renderToStaticMarkup(createElement(WikiPage, {
      context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
    } as never));

    expect(markup).toContain("skill issue(s) need attention");
    expect(markup).toContain("LLM Wiki Maintainer differs from the plugin default: SKILL.md.");
    expect(markup).toContain("Re-sync skills");
  });

  it("renders host settings directly as the Setup page without an extra plugin heading", () => {
    const markup = renderToStaticMarkup(createElement(SettingsPage, {
      context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
    } as never));

    expect(markup).toContain(">Setup</h1>");
    expect(markup).toContain("Base Folder");
    expect(markup).not.toContain("LLM Wiki Settings");
    expect(markup).not.toContain("These settings live inside the plugin");
  });

  it("renders project settings as a project picker without managed-resource metadata", () => {
    mockPathname = "/PAP/wiki/settings/project";
    const markup = renderToStaticMarkup(createElement(WikiPage, {
      context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
    } as never));

    expect(markup).toContain("Use existing project");
    expect(markup).toContain("LLM Wiki");
    expect(markup).toContain("Save project");
    expect(markup).toContain("Open project");
    expect(markup).toContain("Repair / reconcile");
    expect(markup).toContain("Reset to plugin defaults");
    expect(markup).not.toContain("Managed by LLM Wiki");
    expect(markup).not.toContain("Operations project binding");
    expect(markup).not.toContain("Stable key");
    expect(markup).not.toContain("Resolved project");
    expect(markup).toContain("Status: in progress");
    expect(markup).not.toContain("Plugin managed default");
  });

  it("renders space settings with health line styling and disabled access controls", () => {
    mockPathname = "/PAP/wiki/settings/spaces/default";

    const markup = renderToStaticMarkup(createElement(WikiPage, {
      context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
    } as never));

    expect(markup).toContain("Space folder health checklist");
    expect(markup).toContain("left:8px");
    expect(markup).toContain("background:oklch(0.38 0.09 145)");
    expect(markup).toContain("Folder readable");
    expect(markup).toContain("raw/ present");
    expect(markup).toContain("Access");
    expect(markup).toContain("Coming soon");
    expect(markup).not.toContain("Future enforcement");
    expect(markup).not.toContain("stored only");
    expect(markup).not.toContain("Permissions are stored but not enforced");
  });

  it("renders distillation settings with assigned-agent model selection and cheap path without budget controls", () => {
    mockPathname = "/PAP/wiki/settings/distillation";
    mockDistillationOverviewData = {
      counts: { cursors: 1, runningRuns: 0, failedRuns24h: 0, reviewRequired: 0 },
      cursors: [{
        id: "cursor-1",
        projectId: "project-1",
        rootIssueId: null,
        projectName: "Existing Wiki Project",
        rootIssueIdentifier: null,
        sourceScope: "project",
        scopeKey: "project-1",
      }],
      runs: [],
    };

    const markup = renderToStaticMarkup(createElement(WikiPage, {
      context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
    } as never));

    expect(markup).toContain("Agent execution");
    expect(markup).toContain("Assigned maintainer");
    expect(markup).toContain("Wiki Maintainer · claude local");
    expect(markup).toContain("Cheap path");
    expect(markup).toContain("assigneeAdapterOverrides.modelProfile = cheap");
    expect(markup).toContain("All sections — apply when source hash matches and confidence");
    expect(markup).not.toContain("Per-task budget");
    expect(markup).not.toContain("Project total budget");
    expect(markup).not.toContain("/task");
    expect(markup).not.toContain("Model lanes");
    expect(markup).not.toContain("Claude Haiku");
    expect(markup).not.toContain("Daily plugin cap");
    expect(markup).not.toContain("Monthly plugin cap");
  });

  it("renders managed routines as normal routine rows with run, toggle, and configure controls", () => {
    mockPathname = "/PAP/wiki/settings/routines";
    mockSettingsManagedRoutines = [{
      status: "resolved",
      routineId: "routine-1",
      resourceKey: "nightly-wiki-lint",
      routine: {
        id: "routine-1",
        title: "Run LLM Wiki lint",
        status: "active",
        assigneeAgentId: "agent-1",
        projectId: "project-1",
        lastTriggeredAt: "2026-05-03T12:00:00Z",
        managedByPlugin: { pluginDisplayName: "LLM Wiki", resourceKey: "nightly-wiki-lint" },
      },
      details: { cronExpression: "0 3 * * *" },
    }];
    const markup = renderToStaticMarkup(createElement(WikiPage, {
      context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
    } as never));

    expect(markup).toContain("Run LLM Wiki lint");
    expect(markup).toContain("Run now");
    expect(markup).toContain("Configure");
    expect(markup).toContain("role=\"switch\"");
    expect(markup).toContain("LLM Wiki · Wiki Maintainer");
    expect(markup).toContain("href=\"/PAP/routines/routine-1\"");
  });

  it("alerts when managed routine defaults changed and offers a reset path", () => {
    mockPathname = "/PAP/wiki/settings/routines";
    mockSettingsManagedRoutines = [{
      status: "resolved",
      routineId: "routine-1",
      resourceKey: "nightly-wiki-lint",
      defaultDrift: {
        changedFields: ["description"],
        defaultTitle: "Run LLM Wiki lint",
        defaultDescription: "Updated instructions",
      },
      routine: {
        id: "routine-1",
        title: "Run LLM Wiki lint",
        status: "active",
        assigneeAgentId: "agent-1",
        projectId: "project-1",
        managedByPlugin: { pluginDisplayName: "LLM Wiki", resourceKey: "nightly-wiki-lint" },
      },
      details: { cronExpression: "0 3 * * *" },
    }];

    const markup = renderToStaticMarkup(createElement(WikiPage, {
      context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
    } as never));

    expect(markup).toContain("Routine defaults changed");
    expect(markup).toContain("Plugin defaults changed: description");
    expect(markup).toContain(">Reset</button>");
  });

  it("shows managed agent instruction drift in the setup health check", () => {
    mockPathname = "/PAP/wiki/settings";
    mockSettingsManagedAgent = {
      status: "resolved",
      source: "managed",
      agentId: "agent-1",
      resourceKey: "wiki-maintainer",
      defaultDrift: { entryFile: "AGENTS.md", changedFiles: ["AGENTS.md"] },
      details: { name: "Wiki Maintainer", status: "idle", adapterType: "claude_local", icon: "book-open", urlKey: "wiki-maintainer" },
    };

    const markup = renderToStaticMarkup(createElement(WikiPage, {
      context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
    } as never));

    expect(markup).toContain("Wiki Maintainer instructions differ from the plugin default: AGENTS.md.");
    expect(markup).toContain("Wiki Maintainer instruction defaults changed: AGENTS.md");
  });

  it("shows one routine repair warning instead of per-routine reconcile controls", () => {
    mockPathname = "/PAP/wiki/settings/routines";
    mockSettingsManagedRoutines = [{
      status: "resolved",
      routineId: "routine-1",
      resourceKey: "nightly-wiki-lint",
      routine: {
        id: "routine-1",
        title: "Run LLM Wiki lint",
        status: "active",
        assigneeAgentId: "other-agent",
        projectId: "project-1",
        managedByPlugin: { pluginDisplayName: "LLM Wiki", resourceKey: "nightly-wiki-lint" },
      },
      details: { cronExpression: "0 3 * * *" },
    }];

    const markup = renderToStaticMarkup(createElement(WikiPage, {
      context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
    } as never));

    expect(markup).toContain("Routine setup needs repair");
    expect(markup).toContain("Fix routines");
    expect(markup).toContain("not assigned to the Wiki Maintainer");
    expect(markup).not.toContain("Plugin-managed routine defaults can be reconciled from here");
    expect(markup).not.toContain(">Reconcile</button>");
    expect(markup).not.toContain(">Reset</button>");
  });

  it("renders legacy lint routes inside the Wiki settings section", () => {
    mockPathname = "/PAP/wiki/lint";
    const markup = renderToStaticMarkup(createElement(WikiPage, {
      context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
    } as never));

    expect(markup).toContain("Run lint now");
    expect(markup).toContain("Recent lint runs");
    expect(markup).toContain("LLM Wiki settings sections");
  });

  it("does not expose IDEA.md pattern editing as a settings section", () => {
    mockPathname = "/PAP/wiki/settings";
    const markup = renderToStaticMarkup(createElement(WikiPage, {
      context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
    } as never));

    expect(markup).toContain("LLM Wiki settings sections");
    expect(markup).not.toContain(">Pattern</span>");
    expect(markup).not.toContain("Pattern · IDEA.md");
    expect(markup).not.toContain("IDEA.md skeleton reference");
  });

  it("does not expose plugin capabilities as a settings section", () => {
    mockPathname = "/PAP/wiki/settings";
    const markup = renderToStaticMarkup(createElement(WikiPage, {
      context: { companyId: COMPANY_ID, companyPrefix: "PAP" },
    } as never));

    expect(markup).toContain("LLM Wiki settings sections");
    expect(markup).not.toContain("Plugin capabilities");
    expect(markup).not.toContain("api.routes.register");
  });

  it("reconciles managed maintenance routines through stable agent and project refs", async () => {
    const harness = createTestHarness({ manifest });
    const writes: Array<{ path: string; contents: string }> = [];
    harness.ctx.localFolders.writeTextAtomic = async (_companyId, _folderKey, relativePath, contents) => {
      writes.push({ path: relativePath, contents });
      return harness.ctx.localFolders.status(COMPANY_ID, "wiki-root");
    };

    await plugin.definition.setup(harness.ctx);

    const missing = await harness.performAction<PluginManagedRoutineResolution>("reconcile-managed-routine", {
      companyId: COMPANY_ID,
      routineKey: NIGHTLY_LINT_ROUTINE_KEY,
    });
    expect(missing.status).toBe("missing_refs");
    expect(missing.missingRefs).toEqual([
      expect.objectContaining({ resourceKind: "agent", resourceKey: WIKI_MAINTAINER_AGENT_KEY }),
      expect.objectContaining({ resourceKind: "project", resourceKey: WIKI_PROJECT_KEY }),
    ]);

    await harness.performAction("bootstrap-root", { companyId: COMPANY_ID, path: "/tmp/company-wiki" });
    const reconciled = await Promise.all(
      WIKI_MAINTENANCE_ROUTINE_KEYS.map((routineKey) =>
        harness.performAction<PluginManagedRoutineResolution>("reconcile-managed-routine", {
          companyId: COMPANY_ID,
          routineKey,
        })),
    );

    expect(reconciled.map((routine) => routine.resourceKey)).toEqual([...WIKI_MAINTENANCE_ROUTINE_KEYS]);
    expect(reconciled).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resourceKey: NIGHTLY_LINT_ROUTINE_KEY,
          routine: expect.objectContaining({
            projectId: expect.any(String),
            assigneeAgentId: expect.any(String),
            managedByPlugin: expect.objectContaining({
              defaultsJson: expect.objectContaining({
                issueTemplate: expect.objectContaining({ surfaceVisibility: "plugin_operation" }),
              }),
            }),
          }),
        }),
        expect.objectContaining({ resourceKey: INDEX_REFRESH_ROUTINE_KEY, routineId: expect.any(String) }),
      ]),
    );
  });

  it("requires an explicit managed routine key for single-routine actions", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    await expect(harness.performAction("reconcile-managed-routine", {
      companyId: COMPANY_ID,
    })).rejects.toThrow("routineKey is required");
  });

  it("repairs all managed maintenance routines through one action", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    await harness.performAction("bootstrap-root", { companyId: COMPANY_ID, path: "/tmp/company-wiki" });

    const repaired = await harness.performAction<{
      managedRoutines: PluginManagedRoutineResolution[];
    }>("reconcile-managed-routines", { companyId: COMPANY_ID });

    expect(repaired.managedRoutines).toHaveLength(WIKI_MAINTENANCE_ROUTINE_KEYS.length);
    expect(repaired.managedRoutines.map((routine) => routine.resourceKey)).toEqual([...WIKI_MAINTENANCE_ROUTINE_KEYS]);
    for (const routine of repaired.managedRoutines) {
      expect(routine.routine).toEqual(expect.objectContaining({
        assigneeAgentId: expect.any(String),
        projectId: expect.any(String),
      }));
      expect(routine.missingRefs).toEqual([]);
    }
  });

  it("installs and resets managed company skills through setup actions", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    const before = await harness.getData<{ managedSkills: WikiSkillResource[] }>("settings", {
      companyId: COMPANY_ID,
    });
    expect(before.managedSkills.map((skill) => skill.resourceKey)).toEqual([...WIKI_MANAGED_SKILL_KEYS]);
    expect(before.managedSkills[0]).toMatchObject({
      status: "missing",
      skillId: null,
    });

    const repaired = await harness.performAction<{
      managedSkills: WikiSkillResource[];
    }>("reconcile-managed-skills", { companyId: COMPANY_ID });
    expect(repaired.managedSkills).toHaveLength(WIKI_MANAGED_SKILL_KEYS.length);
    expect(repaired.managedSkills[0]).toMatchObject({
      status: "created",
      skillId: expect.any(String),
      resourceKey: WIKI_MAINTAINER_SKILL_KEY,
      details: {
        name: "LLM Wiki Maintainer",
        key: WIKI_MAINTAINER_SKILL_CANONICAL_KEY,
      },
    });

    const resolved = await harness.getData<{ managedSkills: WikiSkillResource[] }>("settings", {
      companyId: COMPANY_ID,
    });
    expect(resolved.managedSkills[0]).toMatchObject({
      status: "resolved",
      resourceKey: WIKI_MAINTAINER_SKILL_KEY,
      details: { key: WIKI_MAINTAINER_SKILL_CANONICAL_KEY },
    });

    const reset = await harness.performAction<{
      managedSkills: WikiSkillResource[];
    }>("reset-managed-skills", { companyId: COMPANY_ID });
    expect(reset.managedSkills[0]).toMatchObject({
      status: "reset",
      skillId: expect.any(String),
      resourceKey: WIKI_MAINTAINER_SKILL_KEY,
    });
  });

  it("registers worker data, actions, and tools", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    const overview = await harness.getData<{ status: string; operationCount: number; eventIngestion: { enabled: boolean } }>("overview", {
      companyId: COMPANY_ID,
    });
    expect(overview.status).toBe("ok");
    expect(overview.operationCount).toBe(0);
    expect(overview.eventIngestion.enabled).toBe(false);

    const pages = await harness.executeTool<{ content?: string }>("wiki_list_pages", {
      companyId: COMPANY_ID,
      wikiId: "default",
    });
    expect(pages.content).toBe("No pages indexed yet.");
  });

  it("filters stale page and raw source rows out of browse data", async () => {
    const harness = createTestHarness({ manifest });
    const files = new Map<string, string>([
      ["wiki/concepts/live.md", "# Live Page\n"],
      ["raw/live-source.md", "# Live Source\n"],
    ]);
    const now = new Date().toISOString();
    harness.ctx.localFolders.readText = async (_companyId, _folderKey, relativePath) => {
      const contents = files.get(relativePath);
      if (contents == null) throw new Error(`missing ${relativePath}`);
      return contents;
    };
    harness.ctx.db.query = async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      harness.dbQueries.push({ sql, params });
      if (sql.includes("wiki_pages")) {
        return [
          {
            path: "wiki/concepts/live.md",
            title: "Live Page",
            page_type: "concepts",
            backlinks: [],
            source_refs: [],
            content_hash: "live",
            updated_at: now,
          },
          {
            path: "wiki/concepts/stale.md",
            title: "Stale Page",
            page_type: "concepts",
            backlinks: [],
            source_refs: [],
            content_hash: "stale",
            updated_at: now,
          },
        ] as T[];
      }
      if (sql.includes("wiki_sources")) {
        return [
          {
            raw_path: "raw/missing-source.md",
            title: "Missing Source",
            source_type: "text",
            url: null,
            status: "captured",
            created_at: now,
          },
          {
            raw_path: "raw/live-source.md",
            title: "Live Source",
            source_type: "text",
            url: null,
            status: "captured",
            created_at: now,
          },
        ] as T[];
      }
      return [];
    };

    await plugin.definition.setup(harness.ctx);
    const result = await harness.getData<{
      pages: Array<{ path: string }>;
      sources: Array<{ rawPath: string }>;
    }>("pages", {
      companyId: COMPANY_ID,
      wikiId: "default",
      includeRaw: true,
    });

    expect(result.pages.map((page) => page.path)).toEqual(["wiki/concepts/live.md"]);
    expect(result.sources.map((source) => source.rawPath)).toEqual(["raw/live-source.md"]);
  });

  it("includes local wiki files in browse data before metadata is indexed", async () => {
    const harness = createTestHarness({ manifest });
    const modifiedAt = new Date().toISOString();
    harness.ctx.localFolders.list = async (_companyId, folderKey, options) => ({
      folderKey,
      relativePath: options?.relativePath ?? null,
      truncated: false,
      entries: options?.relativePath === "wiki"
        ? [
            { path: "wiki/concepts/agent-memory-layer.md", name: "agent-memory-layer.md", kind: "file", size: 12, modifiedAt },
            { path: "wiki/entities/paperclip.md", name: "paperclip.md", kind: "file", size: 10, modifiedAt },
            { path: "wiki/projects/llm-wiki/standup.md", name: "standup.md", kind: "file", size: 16, modifiedAt },
          ]
        : [
            { path: "raw/2026-04-09-thomas-gieselmann-fundraising-call.md", name: "2026-04-09-thomas-gieselmann-fundraising-call.md", kind: "file", size: 14, modifiedAt },
          ],
    });
    harness.ctx.db.query = async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      harness.dbQueries.push({ sql, params });
      return [] as T[];
    };

    await plugin.definition.setup(harness.ctx);
    const result = await harness.getData<{
      pages: Array<{ path: string; title: string | null }>;
      sources: Array<{ rawPath: string; title: string | null }>;
    }>("pages", {
      companyId: COMPANY_ID,
      wikiId: "default",
      includeRaw: true,
    });

    expect(result.pages).toEqual([
      expect.objectContaining({ path: "wiki/concepts/agent-memory-layer.md", title: null }),
      expect.objectContaining({ path: "wiki/entities/paperclip.md", title: null }),
      expect.objectContaining({ path: "wiki/projects/llm-wiki/standup.md", title: null }),
    ]);
    expect(result.sources).toEqual([
      expect.objectContaining({ rawPath: "raw/2026-04-09-thomas-gieselmann-fundraising-call.md", title: null }),
    ]);
  });

  it("does not ingest Paperclip events until operator controls enable them", async () => {
    const harness = createTestHarness({ manifest });
    const issue = paperclipIssue();
    harness.seed({ issues: [issue] });
    const writes: Array<{ path: string; contents: string }> = [];
    harness.ctx.localFolders.writeTextAtomic = async (_companyId, _folderKey, relativePath, contents) => {
      writes.push({ path: relativePath, contents });
      return harness.ctx.localFolders.status(COMPANY_ID, "wiki-root");
    };

    await plugin.definition.setup(harness.ctx);
    await harness.emit("issue.created", { identifier: issue.identifier }, {
      companyId: COMPANY_ID,
      entityId: issue.id,
      entityType: "issue",
      eventId: "event-disabled-issue-created",
    });

    expect(writes).toHaveLength(0);
    expect(harness.dbExecutes.some((execute) => execute.sql.includes("wiki_sources"))).toBe(false);
    expect(harness.dbExecutes.some((execute) => execute.sql.includes("wiki_operations"))).toBe(false);
  });

  it("records enabled Paperclip issue events as cursor observations without creating ingest operations", async () => {
    const harness = createTestHarness({ manifest });
    const issue = paperclipIssue();
    harness.seed({ issues: [issue] });
    const writes: Array<{ path: string; contents: string }> = [];
    harness.ctx.localFolders.writeTextAtomic = async (_companyId, _folderKey, relativePath, contents) => {
      writes.push({ path: relativePath, contents });
      return harness.ctx.localFolders.status(COMPANY_ID, "wiki-root");
    };

    await plugin.definition.setup(harness.ctx);
    const policy = await harness.performAction<{ enabled: boolean; sources: { issues: boolean; comments: boolean; documents: boolean } }>(
      "update-event-ingestion-settings",
      {
        companyId: COMPANY_ID,
        enabled: true,
        sources: { issues: true, comments: false, documents: false },
      },
    );
    expect(policy).toMatchObject({ enabled: true, sources: { issues: true, comments: false, documents: false } });

    await harness.emit("issue.created", { identifier: issue.identifier }, {
      companyId: COMPANY_ID,
      entityId: issue.id,
      entityType: "issue",
      eventId: "event-enabled-issue-created",
    });

    expect(writes).toHaveLength(0);
    const operations = await harness.ctx.issues.list({
      companyId: COMPANY_ID,
      originKindPrefix: String(OPERATION_ORIGIN_KIND),
    });
    expect(operations).toHaveLength(0);
    expect(harness.dbExecutes.some((execute) => execute.sql.includes("wiki_sources"))).toBe(false);
    expect(harness.dbExecutes.some((execute) => execute.sql.includes("wiki_operations"))).toBe(false);
    const cursorUpsert = harness.dbExecutes.find((execute) => execute.sql.includes("paperclip_distillation_cursors"));
    expect(cursorUpsert?.params).toEqual(expect.arrayContaining([
      COMPANY_ID,
      "default",
      "company",
      null,
      null,
    ]));
  });

  it("preserves Paperclip event ingestion sources when only enabled changes", async () => {
    const harness = createTestHarness({ manifest });

    await plugin.definition.setup(harness.ctx);
    await harness.performAction("update-event-ingestion-settings", {
      companyId: COMPANY_ID,
      enabled: true,
      sources: { issues: true, comments: true, documents: true },
    });

    const disabled = await harness.performAction<{
      enabled: boolean;
      sources: { issues: boolean; comments: boolean; documents: boolean };
    }>("update-event-ingestion-settings", {
      companyId: COMPANY_ID,
      enabled: false,
    });
    expect(disabled).toMatchObject({
      enabled: false,
      sources: { issues: true, comments: true, documents: true },
    });

    const reenabled = await harness.performAction<{
      enabled: boolean;
      sources: { issues: boolean; comments: boolean; documents: boolean };
    }>("update-event-ingestion-settings", {
      companyId: COMPANY_ID,
      enabled: true,
    });
    expect(reenabled).toMatchObject({
      enabled: true,
      sources: { issues: true, comments: true, documents: true },
    });
  });

  it("keeps Paperclip event cursor observations company scoped and ignores plugin-operation issues", async () => {
    const harness = createTestHarness({ manifest });
    const visibleIssue = paperclipIssue({ projectId: "77777777-7777-4777-8777-777777777777" });
    const otherCompanyIssue = paperclipIssue({
      id: "77777777-7777-4777-8777-777777777778",
      companyId: OTHER_COMPANY_ID,
      projectId: "77777777-7777-4777-8777-777777777779",
      identifier: "PAP-9999",
    });
    const operationIssue = paperclipIssue({
      id: "77777777-7777-4777-8777-777777777780",
      originKind: `${OPERATION_ORIGIN_KIND}:ingest`,
    });
    harness.seed({ issues: [visibleIssue, otherCompanyIssue, operationIssue] });

    await plugin.definition.setup(harness.ctx);
    await harness.performAction("update-event-ingestion-settings", {
      companyId: COMPANY_ID,
      enabled: true,
      sources: { issues: true, comments: true, documents: true },
    });

    await harness.emit("issue.updated", {}, {
      companyId: COMPANY_ID,
      entityId: visibleIssue.id,
      entityType: "issue",
      eventId: "event-visible",
    });
    await harness.emit("issue.updated", {}, {
      companyId: OTHER_COMPANY_ID,
      entityId: otherCompanyIssue.id,
      entityType: "issue",
      eventId: "event-other-company",
    });
    await harness.emit("issue.updated", {}, {
      companyId: COMPANY_ID,
      entityId: operationIssue.id,
      entityType: "issue",
      eventId: "event-plugin-operation",
    });

    const cursorWrites = harness.dbExecutes.filter((execute) => execute.sql.includes("paperclip_distillation_cursors"));
    expect(cursorWrites).toHaveLength(1);
    expect(cursorWrites[0].params).toEqual(expect.arrayContaining([
      COMPANY_ID,
      "default",
      "project",
      visibleIssue.projectId,
    ]));
  });

  it("routes Paperclip issue, comment, and document event cursors only to the default space", async () => {
    const harness = createTestHarness({ manifest });
    const issue = paperclipIssue({ projectId: "77777777-7777-4777-8777-777777777777" });
    harness.seed({ issues: [issue] });

    await plugin.definition.setup(harness.ctx);
    const created = await harness.performAction<{
      space: { id: string; slug: string };
    }>("create-space", {
      companyId: COMPANY_ID,
      displayName: "Team Research",
    });
    await harness.performAction("update-event-ingestion-settings", {
      companyId: COMPANY_ID,
      enabled: true,
      sources: { issues: true, comments: true, documents: true },
    });

    await harness.emit("issue.created", {}, {
      companyId: COMPANY_ID,
      entityId: issue.id,
      entityType: "issue",
      eventId: "event-default-issue-created",
    });
    await harness.emit("issue.comment.created", { commentId: "comment-1" }, {
      companyId: COMPANY_ID,
      entityId: issue.id,
      entityType: "issue",
      eventId: "event-default-comment-created",
    });
    await harness.emit("issue.document.updated", { key: "plan", revisionId: "revision-1" }, {
      companyId: COMPANY_ID,
      entityId: issue.id,
      entityType: "issue",
      eventId: "event-default-document-updated",
    });

    const cursorWrites = harness.dbExecutes.filter((execute) => execute.sql.includes("paperclip_distillation_cursors"));
    expect(cursorWrites).toHaveLength(3);
    expect(cursorWrites.every((execute) => execute.params?.[10] !== created.space.id)).toBe(true);
    expect(cursorWrites.map((execute) => execute.params?.[2])).toEqual(["default", "default", "default"]);
    expect(String(cursorWrites[0].params?.[9])).toContain('"lastSourceKind":"issues"');
    expect(String(cursorWrites[1].params?.[9])).toContain('"lastSourceKind":"comments"');
    expect(String(cursorWrites[2].params?.[9])).toContain('"lastSourceKind":"documents"');
  });

  it("routes Paperclip events into an explicitly enabled shared non-default space", async () => {
    const harness = createTestHarness({ manifest });
    const project = existingProject();
    const issue = paperclipIssue({ projectId: project.id });
    harness.seed({ projects: [project], issues: [issue] });

    await plugin.definition.setup(harness.ctx);
    const created = await harness.performAction<{
      space: { id: string; slug: string };
    }>("create-space", {
      companyId: COMPANY_ID,
      displayName: "Engineering Wiki",
      accessScope: "shared",
    });
    mockPersistedWikiSpace(harness, created.space as unknown as Record<string, unknown>);
    const enabledProfile = {
      version: 1,
      enabled: true,
      sourceScopes: [{ kind: "selected_projects", projectIds: [project.id] }],
      sourceKinds: { issues: true, comments: true, documents: true, attachments: "off", workProducts: "off" },
      cursor: { maxWindowCharacters: 60000, maxCharactersPerSource: 12000, minSourceAgeMinutes: 15, maxWindowsPerRun: 6, staleAfterHours: 72 },
      backfill: { requireManualQueue: true },
    };
    await harness.performAction("update-paperclip-ingestion-profile", {
      companyId: COMPANY_ID,
      spaceSlug: created.space.slug,
      profile: enabledProfile,
    });
    mockPersistedWikiSpace(harness, { ...(created.space as unknown as Record<string, unknown>), settings: { paperclipIngestion: enabledProfile } });

    await harness.emit("issue.created", {}, {
      companyId: COMPANY_ID,
      entityId: issue.id,
      entityType: "issue",
      eventId: "event-non-default-enabled",
    });

    const cursorWrites = harness.dbExecutes.filter((execute) => execute.sql.includes("paperclip_distillation_cursors"));
    expect(cursorWrites.some((execute) => execute.params?.[10] === created.space.id)).toBe(true);
  });

  it("stops new non-default observations after the per-space profile is disabled", async () => {
    const harness = createTestHarness({ manifest });
    const project = existingProject();
    const issue = paperclipIssue({ projectId: project.id });
    harness.seed({ projects: [project], issues: [issue] });

    await plugin.definition.setup(harness.ctx);
    const created = await harness.performAction<{
      space: { id: string; slug: string };
    }>("create-space", {
      companyId: COMPANY_ID,
      displayName: "Support Wiki",
      accessScope: "shared",
    });
    mockPersistedWikiSpace(harness, created.space as unknown as Record<string, unknown>);
    const enabledProfile = {
      version: 1,
      enabled: true,
      sourceScopes: [{ kind: "selected_projects", projectIds: [project.id] }],
      sourceKinds: { issues: true, comments: false, documents: false, attachments: "off", workProducts: "off" },
      cursor: { maxWindowCharacters: 60000, maxCharactersPerSource: 12000, minSourceAgeMinutes: 15, maxWindowsPerRun: 6, staleAfterHours: 72 },
      backfill: { requireManualQueue: true },
    };
    await harness.performAction("update-paperclip-ingestion-profile", {
      companyId: COMPANY_ID,
      spaceSlug: created.space.slug,
      profile: enabledProfile,
    });
    mockPersistedWikiSpace(harness, { ...(created.space as unknown as Record<string, unknown>), settings: { paperclipIngestion: enabledProfile } });
    await harness.emit("issue.created", {}, {
      companyId: COMPANY_ID,
      entityId: issue.id,
      entityType: "issue",
      eventId: "event-before-disable",
    });
    await harness.performAction("update-paperclip-ingestion-profile", {
      companyId: COMPANY_ID,
      spaceSlug: created.space.slug,
      profile: { ...enabledProfile, enabled: false },
    });
    mockPersistedWikiSpace(harness, { ...(created.space as unknown as Record<string, unknown>), settings: { paperclipIngestion: { ...enabledProfile, enabled: false } } });
    await harness.emit("issue.updated", {}, {
      companyId: COMPANY_ID,
      entityId: issue.id,
      entityType: "issue",
      eventId: "event-after-disable",
    });

    const nonDefaultCursorWrites = harness.dbExecutes.filter((execute) =>
      execute.sql.includes("paperclip_distillation_cursors") && execute.params?.[10] === created.space.id);
    expect(nonDefaultCursorWrites).toHaveLength(1);
  });

  it("assembles deterministic Paperclip source bundles with issue, document, and comment provenance", async () => {
    const harness = createTestHarness({ manifest });
    const root = paperclipIssue({
      id: "77777777-7777-4777-8777-777777777781",
      identifier: "PAP-4000",
      title: "Root distillation issue",
      projectId: "77777777-7777-4777-8777-777777777777",
      updatedAt: new Date("2026-05-01T10:00:00Z"),
    });
    const child = paperclipIssue({
      id: "77777777-7777-4777-8777-777777777782",
      identifier: "PAP-4001",
      title: "Child source issue",
      parentId: root.id,
      projectId: root.projectId,
      description: "Child issue has a decision and implementation notes.",
      updatedAt: new Date("2026-05-02T10:00:00Z"),
    });
    harness.seed({
      issues: [root, child],
      issueComments: [{
        id: "77777777-7777-4777-8777-777777777783",
        companyId: COMPANY_ID,
        issueId: child.id,
        authorType: "user",
        authorAgentId: null,
        authorUserId: null,
        body: "Comment evidence for the source bundle.",
        presentation: null,
        metadata: null,
        createdAt: new Date("2026-05-03T10:00:00Z"),
        updatedAt: new Date("2026-05-03T10:00:00Z"),
      }],
    });

    await plugin.definition.setup(harness.ctx);
    await harness.ctx.issues.documents.upsert({
      companyId: COMPANY_ID,
      issueId: child.id,
      key: "plan",
      title: "Plan",
      body: "Document evidence for the source bundle.",
    });

    const first = await harness.performAction<{
      markdown: string;
      sourceRefs: Array<{ kind: string; issueIdentifier: string | null; documentKey?: string; commentId?: string }>;
      sourceHash: string;
      sourceWindowEnd: string | null;
    }>("assemble-paperclip-source-bundle", {
      companyId: COMPANY_ID,
      rootIssueId: root.id,
      maxCharacters: 20000,
    });
    const second = await harness.performAction<typeof first>("assemble-paperclip-source-bundle", {
      companyId: COMPANY_ID,
      rootIssueId: root.id,
      maxCharacters: 20000,
    });

    expect(second.sourceHash).toBe(first.sourceHash);
    expect(first.markdown).toContain("Root distillation issue");
    expect(first.markdown).toContain("Child issue has a decision");
    expect(first.markdown).toContain("Document evidence for the source bundle.");
    expect(first.markdown).toContain("Comment evidence for the source bundle.");
    expect(first.sourceRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "issue", issueIdentifier: "PAP-4001" }),
      expect.objectContaining({ kind: "document", documentKey: "plan" }),
      expect.objectContaining({ kind: "comment", commentId: "77777777-7777-4777-8777-777777777783" }),
    ]));
    expect(first.sourceWindowEnd).toEqual(expect.any(String));
  });

  it("suppresses secret-like comment and document bodies before storing distillation snapshots", async () => {
    const harness = createTestHarness({ manifest });
    const issue = paperclipIssue({
      id: "77777777-7777-4777-8777-777777777784",
      identifier: "PAP-4002",
      title: "Sensitive source issue",
      projectId: "77777777-7777-4777-8777-777777777777",
      description: "Keep the project page current without copying credential material into the wiki.",
      updatedAt: new Date("2026-05-04T10:00:00Z"),
    });
    harness.seed({
      issues: [issue],
      issueComments: [{
        id: "77777777-7777-4777-8777-777777777785",
        companyId: COMPANY_ID,
        issueId: issue.id,
        authorType: "user",
        authorAgentId: null,
        authorUserId: null,
        body: "Authorization: Bearer ghp_supersecretcommenttoken1234567890",
        presentation: null,
        metadata: null,
        createdAt: new Date("2026-05-04T11:00:00Z"),
        updatedAt: new Date("2026-05-04T11:00:00Z"),
      }],
    });

    await plugin.definition.setup(harness.ctx);
    await harness.ctx.issues.documents.upsert({
      companyId: COMPANY_ID,
      issueId: issue.id,
      key: "plan",
      title: "Plan",
      body: "OPENAI_API_KEY=sk-supersecretdocumentvalue1234567890",
    });

    const run = await harness.performAction<{
      bundle: {
        markdown: string;
        warnings: string[];
        sourceRefs: Array<Record<string, unknown>>;
      };
    }>("create-paperclip-distillation-run", {
      companyId: COMPANY_ID,
      projectId: issue.projectId,
      maxCharacters: 20000,
    });

    expect(run.bundle.markdown).toContain("Suppressed by LLM Wiki distillation security policy");
    expect(run.bundle.markdown).not.toContain("ghp_supersecretcommenttoken1234567890");
    expect(run.bundle.markdown).not.toContain("sk-supersecretdocumentvalue1234567890");
    expect(run.bundle.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("Suppressed comment content"),
      expect.stringContaining("Suppressed document content"),
    ]));
    expect(run.bundle.sourceRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "comment", redactionStatus: "suppressed_sensitive_content" }),
      expect.objectContaining({ kind: "document", redactionStatus: "suppressed_sensitive_content" }),
    ]));

    const snapshotInsert = harness.dbExecutes.find((execute) => execute.sql.includes("paperclip_source_snapshots"));
    const storedSourceRefs = String(snapshotInsert?.params?.[9] ?? "");
    const storedMarkdown = String(snapshotInsert?.params?.[10] ?? "");
    expect(storedSourceRefs).toContain("suppressed_sensitive_content");
    expect(storedMarkdown).toContain("Suppressed by LLM Wiki distillation security policy");
    expect(storedMarkdown).not.toContain("ghp_supersecretcommenttoken1234567890");
    expect(storedMarkdown).not.toContain("sk-supersecretdocumentvalue1234567890");
  });

  it("creates source snapshots and only advances cursors after successful distillation outcomes", async () => {
    const harness = createTestHarness({ manifest });
    const issue = paperclipIssue({
      projectId: "77777777-7777-4777-8777-777777777777",
      updatedAt: new Date("2026-05-02T10:00:00Z"),
    });
    harness.seed({ issues: [issue] });
    await plugin.definition.setup(harness.ctx);

    const run = await harness.performAction<{
      runId: string;
      cursorId: string;
      snapshotId: string;
      bundle: { sourceHash: string; sourceWindowEnd: string };
    }>("create-paperclip-distillation-run", {
      companyId: COMPANY_ID,
      projectId: issue.projectId,
    });
    expect(run.snapshotId).toEqual(expect.any(String));
    expect(harness.dbExecutes.some((execute) => execute.sql.includes("paperclip_source_snapshots"))).toBe(true);

    const failed = await harness.performAction<{ cursorAdvanced: boolean }>("record-paperclip-distillation-outcome", {
      companyId: COMPANY_ID,
      runId: run.runId,
      cursorId: run.cursorId,
      status: "failed",
      sourceHash: run.bundle.sourceHash,
      sourceWindowEnd: run.bundle.sourceWindowEnd,
      warning: "writer failed",
    });
    expect(failed.cursorAdvanced).toBe(false);
    const cursorUpdatesAfterFailure = harness.dbExecutes.filter((execute) =>
      execute.sql.trim().startsWith("UPDATE") && execute.sql.includes("paperclip_distillation_cursors"));
    expect(cursorUpdatesAfterFailure).toHaveLength(0);

    const succeeded = await harness.performAction<{ cursorAdvanced: boolean }>("record-paperclip-distillation-outcome", {
      companyId: COMPANY_ID,
      runId: run.runId,
      cursorId: run.cursorId,
      status: "succeeded",
      sourceHash: run.bundle.sourceHash,
      sourceWindowEnd: run.bundle.sourceWindowEnd,
    });
    expect(succeeded.cursorAdvanced).toBe(true);
    const cursorSuccessUpdate = harness.dbExecutes.find((execute) =>
      execute.sql.trim().startsWith("UPDATE") && execute.sql.includes("paperclip_distillation_cursors"));
    expect(cursorSuccessUpdate?.params).toEqual(expect.arrayContaining([
      COMPANY_ID,
      "default",
      run.runId,
      run.bundle.sourceWindowEnd,
      run.bundle.sourceHash,
      run.cursorId,
    ]));
  });

  it("uses the existing distillation cursor id after an upsert conflict", async () => {
    const harness = createTestHarness({ manifest });
    const project = existingProject();
    const issue = paperclipIssue({
      id: "77777777-7777-4777-8777-777777777800",
      identifier: "PAP-4099",
      title: "Existing cursor target",
      projectId: project.id,
      status: "in_progress",
    });
    const existingCursorId = "77777777-7777-4777-8777-777777777899";
    const originalQuery = harness.ctx.db.query.bind(harness.ctx.db);
    harness.ctx.db.query = async <T,>(sql: string, params?: unknown[]) => {
      if (sql.includes("SELECT id") && sql.includes("paperclip_distillation_cursors")) {
        return [{ id: existingCursorId }] as T[];
      }
      return originalQuery<T>(sql, params);
    };
    harness.seed({ projects: [project], issues: [issue] });

    await plugin.definition.setup(harness.ctx);
    const result = await harness.performAction<{ cursorId: string }>("create-paperclip-distillation-run", {
      companyId: COMPANY_ID,
      projectId: project.id,
    });

    expect(result.cursorId).toBe(existingCursorId);
    const runInsert = harness.dbExecutes.find((execute) =>
      execute.sql.includes("paperclip_distillation_runs") && execute.sql.includes("'source_ready'"));
    expect(runInsert?.params?.[3]).toBe(existingCursorId);
  });

  it("creates explicit distillation work items for manual, retry, and backfill lanes", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    await harness.performAction("create-paperclip-distillation-work-item", {
      companyId: COMPANY_ID,
      kind: "manual",
      projectId: "77777777-7777-4777-8777-777777777777",
      idempotencyKey: "manual:project:77777777-7777-4777-8777-777777777777",
    });
    await harness.performAction("create-paperclip-distillation-work-item", {
      companyId: COMPANY_ID,
      kind: "retry",
      rootIssueId: "77777777-7777-4777-8777-777777777781",
      priority: "high",
      idempotencyKey: "retry:run:1",
    });
    await harness.performAction("create-paperclip-distillation-work-item", {
      companyId: COMPANY_ID,
      kind: "backfill",
      projectId: "77777777-7777-4777-8777-777777777777",
      priority: "low",
      metadata: { window: "last-30-days" },
      idempotencyKey: "backfill:last-30-days",
    });

    const workItemWrites = harness.dbExecutes.filter((execute) => execute.sql.includes("paperclip_distillation_work_items"));
    expect(workItemWrites).toHaveLength(3);
    expect(workItemWrites.map((write) => write.params?.[3])).toEqual(["manual", "retry", "backfill"]);
    expect(String(workItemWrites[0].params?.[9])).toContain('"sourceScope":"project"');
    expect(String(workItemWrites[1].params?.[9])).toContain('"sourceScope":"root_issue"');
    expect(String(workItemWrites[2].params?.[9])).toContain('"sourceScope":"project"');

    await expect(harness.performAction("create-paperclip-distillation-work-item", {
      companyId: COMPANY_ID,
      kind: "backfill",
      idempotencyKey: "backfill:company",
    })).rejects.toThrow("whole-company backfill is not allowed");
  });

  it("records estimated Paperclip distillation cost without refusing on legacy cost config", async () => {
    const harness = createTestHarness({
      manifest,
      config: {
        maxPaperclipRoutineRunCostCents: 1,
        maxPaperclipDistillationTaskCostCents: 1,
        maxPaperclipDistillationProjectCostCents: 1,
        paperclipCostCentsPerThousandSourceCharacters: 100,
      },
    });
    const project = existingProject();
    const issue = paperclipIssue({
      id: "77777777-7777-4777-8777-777777777795",
      identifier: "PAP-4104",
      title: "Large source bundle",
      description: `Accepted plan. ${"Detailed implementation note. ".repeat(160)}`,
      projectId: project.id,
      status: "in_progress",
    });
    harness.seed({ projects: [project], issues: [issue] });

    await plugin.definition.setup(harness.ctx);
    const result = await harness.performAction<{
      status: string;
      estimatedCostCents: number;
      snapshotId: string | null;
    }>("create-paperclip-distillation-run", {
      companyId: COMPANY_ID,
      projectId: project.id,
      routineRun: true,
    });

    expect(result.status).toBe("source_ready");
    expect(result.estimatedCostCents).toBeGreaterThan(1);
    expect(result.snapshotId).toEqual(expect.any(String));
    const readyRun = harness.dbExecutes.find((execute) =>
      execute.sql.includes("paperclip_distillation_runs") && execute.sql.includes("'source_ready'"));
    expect(readyRun?.params).toEqual(expect.arrayContaining([
      COMPANY_ID,
      "default",
      expect.any(String),
      expect.any(String),
      null,
      project.id,
    ]));
    expect(harness.dbExecutes.some((execute) => execute.sql.includes("paperclip_source_snapshots"))).toBe(true);
    expect(harness.dbExecutes.some((execute) => execute.sql.includes("refused_cost_cap"))).toBe(false);
  });

  it("queues visible manual distill operation issues for a company-wide stale cursor scan", async () => {
    const harness = createTestHarness({ manifest });
    const project = existingProject();
    const issue = paperclipIssue({
      id: "77777777-7777-4777-8777-777777777796",
      identifier: "PAP-4105",
      title: "Manual distillation target",
      description: "Implemented enough evidence to manually distill into the wiki.",
      status: "done",
      projectId: project.id,
    });
    harness.seed({ agents: [wikiMaintainerAgent()], projects: [project], issues: [issue] });

    await plugin.definition.setup(harness.ctx);
    const result = await harness.performAction<{
      status: string;
      operation: { issue: { originKind: string; billingCode: string | null; assigneeAgentId: string | null; assigneeAdapterOverrides: { modelProfile?: string } | null; description: string | null } };
      workItem: { kind: string; workItemId: string };
    }>("distill-paperclip-now", {
      companyId: COMPANY_ID,
      autoApply: false,
      useCheapModelProfile: true,
      includeSupportingPages: false,
    });

    expect(result.status).toBe("queued");
    expect(result.workItem.kind).toBe("manual");
    expect(result.operation.issue.originKind).toBe(`${OPERATION_ORIGIN_KIND}:distill`);
    expect(result.operation.issue.billingCode).toBe("plugin-llm-wiki:default");
    expect(result.operation.issue.assigneeAgentId).toBe(wikiMaintainerAgent().id);
    expect(result.operation.issue.assigneeAdapterOverrides).toEqual({ modelProfile: "cheap" });
    expect(result.operation.issue.description).toContain("Prompt source: LLM Wiki plugin action `distill-paperclip-now`");
    expect(result.operation.issue.description).toContain(`Required skill: use the installed \`${PAPERCLIP_DISTILL_SKILL_KEY}\` skill`);
    expect(result.operation.issue.description).toContain("Do not hardcode a single project");
    expect(result.operation.issue.description).not.toContain(`Source project ID: ${project.id}`);
    const workItemInsert = harness.dbExecutes.find((execute) =>
      execute.sql.includes("paperclip_distillation_work_items") && execute.params?.[3] === "manual");
    expect(workItemInsert?.params).toEqual(expect.arrayContaining([
      COMPANY_ID,
      "default",
      "manual",
      "medium",
      null,
      null,
    ]));
    const runInsert = harness.dbExecutes.find((execute) =>
      execute.sql.includes("paperclip_distillation_runs") && execute.sql.includes("operation_issue_id"));
    expect(runInsert).toBeUndefined();
  });

  it("enables distillation cursors for the most recently active non-plugin projects", async () => {
    const harness = createTestHarness({ manifest });
    const recentProject = {
      ...existingProject(),
      id: "77777777-7777-4777-8777-777777777801",
      name: "Recent Active Project",
      status: "in_progress" as const,
      updatedAt: new Date("2026-05-04T18:00:00Z"),
    };
    const olderProject = {
      ...existingProject(),
      id: "77777777-7777-4777-8777-777777777802",
      name: "Older Active Project",
      status: "in_progress" as const,
      updatedAt: new Date("2026-05-03T18:00:00Z"),
    };
    const overflowProject = {
      ...existingProject(),
      id: "77777777-7777-4777-8777-777777777803",
      name: "Overflow Active Project",
      status: "in_progress" as const,
      updatedAt: new Date("2026-05-02T18:00:00Z"),
    };
    const completedProject = {
      ...existingProject(),
      id: "77777777-7777-4777-8777-777777777804",
      name: "Completed Project",
      status: "completed" as const,
      updatedAt: new Date("2026-05-04T19:00:00Z"),
    };
    const pluginProject = {
      ...existingProject(),
      id: "77777777-7777-4777-8777-777777777805",
      name: "LLM Wiki",
      status: "in_progress" as const,
      updatedAt: new Date("2026-05-04T20:00:00Z"),
      managedByPlugin: {
        id: "77777777-7777-4777-8777-777777777806",
        pluginId: "plugin-instance-1",
        pluginKey: manifest.id,
        pluginDisplayName: manifest.displayName,
        resourceKind: "project" as const,
        resourceKey: WIKI_PROJECT_KEY,
        defaultsJson: {},
        createdAt: new Date("2026-05-04T00:00:00Z"),
        updatedAt: new Date("2026-05-04T00:00:00Z"),
      },
    };
    harness.seed({ projects: [recentProject, olderProject, overflowProject, completedProject, pluginProject] });

    await plugin.definition.setup(harness.ctx);
    const result = await harness.performAction<{
      selectedProjects: Array<{ id: string; observedAt: string | null }>;
      eventIngestion: { enabled: boolean; sources: { issues: boolean; comments: boolean; documents: boolean } };
    }>("enable-paperclip-distillation-active-projects", {
      companyId: COMPANY_ID,
      limit: 2,
    });

    expect(result.selectedProjects.map((project) => project.id)).toEqual([recentProject.id, olderProject.id]);
    expect(result.eventIngestion).toMatchObject({
      enabled: true,
      sources: { issues: true, comments: true, documents: true },
    });
    const cursorWrites = harness.dbExecutes.filter((execute) => execute.sql.includes("paperclip_distillation_cursors"));
    expect(cursorWrites).toHaveLength(2);
    expect(cursorWrites.map((execute) => execute.params?.[5])).toEqual([recentProject.id, olderProject.id]);
    expect(cursorWrites.map((execute) => execute.params?.[8])).toEqual([1, 1]);
    expect(String(cursorWrites[0]?.params?.[9])).toContain('"configuredBy":"enable-active-projects"');
  });

  it("backfills only the selected Paperclip project and date window", async () => {
    const harness = createTestHarness({ manifest });
    const project = existingProject();
    const inWindow = paperclipIssue({
      id: "77777777-7777-4777-8777-777777777797",
      identifier: "PAP-4106",
      title: "Backfill in-window decision",
      description: "Accepted historical decision that should appear in the backfill page.",
      status: "done",
      projectId: project.id,
      updatedAt: new Date("2026-04-15T12:00:00Z"),
    });
    const outOfWindow = paperclipIssue({
      id: "77777777-7777-4777-8777-777777777798",
      identifier: "PAP-4107",
      title: "Backfill out-of-window decision",
      description: "This old decision must not be included in the selected date window.",
      status: "done",
      projectId: project.id,
      updatedAt: new Date("2026-03-01T12:00:00Z"),
    });
    const otherProject = paperclipIssue({
      id: "77777777-7777-4777-8777-777777777799",
      identifier: "PAP-4108",
      title: "Other project decision",
      description: "This issue belongs to a different project and must not be included.",
      status: "done",
      projectId: "88888888-8888-4888-8888-888888888888",
      updatedAt: new Date("2026-04-16T12:00:00Z"),
    });
    harness.seed({ agents: [wikiMaintainerAgent()], projects: [project], issues: [inWindow, outOfWindow, otherProject] });

    await plugin.definition.setup(harness.ctx);
    const result = await harness.performAction<{
      status: string;
      patches: Array<{ operationType: string; proposedContents: string }>;
      workItem: { kind: string };
      operation: { issue: { originKind: string } };
    }>("backfill-paperclip-distillation", {
      companyId: COMPANY_ID,
      projectId: project.id,
      backfillStartAt: "2026-04-01T00:00:00Z",
      backfillEndAt: "2026-04-30T23:59:59Z",
      autoApply: false,
      includeSupportingPages: false,
    });

    expect(result.status).toBe("review_required");
    expect(result.workItem.kind).toBe("backfill");
    expect(result.operation.issue.originKind).toBe(`${OPERATION_ORIGIN_KIND}:backfill`);
    const projectPatch = result.patches.find((patch) => patch.operationType === "project_page_distill");
    expect(projectPatch?.proposedContents).toContain("PAP-4106");
    expect(projectPatch?.proposedContents).not.toContain("PAP-4107");
    expect(projectPatch?.proposedContents).not.toContain("PAP-4108");
    const workItemInsert = harness.dbExecutes.find((execute) =>
      execute.sql.includes("paperclip_distillation_work_items") && execute.params?.[3] === "backfill");
    expect(String(workItemInsert?.params?.[9])).toContain('"backfillStartAt":"2026-04-01T00:00:00Z"');
  });

  it("generates review-required Paperclip project page patches with provenance, index, and log updates", async () => {
    const harness = createTestHarness({ manifest });
    const project = existingProject();
    const issue = paperclipIssue({
      id: "77777777-7777-4777-8777-777777777791",
      identifier: "PAP-4100",
      title: "Approved project page distillation plan",
      description: "Accepted plan: write stable project overview sections with source provenance.",
      status: "in_progress",
      projectId: project.id,
      updatedAt: new Date("2026-05-03T10:00:00Z"),
    });
    const files = new Map<string, string>([
      ["wiki/index.md", DEFAULT_INDEX],
      ["wiki/log.md", DEFAULT_LOG],
    ]);
    const writes: Array<{ path: string; contents: string }> = [];
    harness.seed({ projects: [project], issues: [issue] });
    harness.ctx.localFolders.readText = async (_companyId, _folderKey, relativePath) => {
      const contents = files.get(relativePath);
      if (contents == null) throw new Error(`missing ${relativePath}`);
      return contents;
    };
    harness.ctx.localFolders.writeTextAtomic = async (_companyId, _folderKey, relativePath, contents) => {
      writes.push({ path: relativePath, contents });
      files.set(relativePath, contents);
      return harness.ctx.localFolders.status(COMPANY_ID, "wiki-root");
    };

    await plugin.definition.setup(harness.ctx);
    const result = await harness.performAction<{
      status: string;
      patches: Array<{ pagePath: string; operationType: string; currentHash: string | null; proposedContents: string; sourceRefs: Array<{ issueIdentifier: string | null }> }>;
      warnings: string[];
    }>("distill-paperclip-project-page", {
      companyId: COMPANY_ID,
      projectId: project.id,
      autoApply: false,
      maxCharacters: 20000,
      includeSupportingPages: false,
    });

    expect(result.status).toBe("review_required");
    expect(writes).toHaveLength(0);
    expect(result.patches.map((patch) => patch.operationType)).toEqual([
      "standup_update",
      "project_page_distill",
      "index_refresh",
      "log_append",
    ]);
    const standupPatch = result.patches[0];
    expect(standupPatch.pagePath).toBe("wiki/projects/existing-wiki-project/standup.md");
    expect(standupPatch.proposedContents).toContain("## Executive Readout");
    expect(standupPatch.proposedContents).toContain("## What Changed");
    const projectPatch = result.patches[1];
    expect(projectPatch.currentHash).toBeNull();
    expect(projectPatch.pagePath).toBe("wiki/projects/existing-wiki-project/index.md");
    expect(projectPatch.proposedContents).toContain("## Workstreams");
    expect(projectPatch.proposedContents).toContain("PAP-4100");
    expect(projectPatch.sourceRefs).toEqual([expect.objectContaining({ issueIdentifier: "PAP-4100" })]);
    expect(result.patches[2].proposedContents).toContain("[[wiki/projects/existing-wiki-project/index.md]]");
    expect(result.patches[2].proposedContents).toContain("[[wiki/projects/existing-wiki-project/standup.md]]");
    expect(result.patches[3].proposedContents).toContain("paperclip-distill | proposed");
    expect(result.warnings).toContain("Auto-apply policy disabled; proposed patches require review.");
  });

  it("keeps suppressed secret-like source content out of generated wiki patches", async () => {
    const harness = createTestHarness({ manifest });
    const project = existingProject();
    const issue = paperclipIssue({
      id: "77777777-7777-4777-8777-777777777796",
      identifier: "PAP-4104",
      title: "Distill sanitized provenance",
      description: "Publish enough project state for a reviewable project page without leaking credentials.",
      status: "in_progress",
      projectId: project.id,
      updatedAt: new Date("2026-05-04T10:00:00Z"),
    });
    const files = new Map<string, string>([
      ["wiki/index.md", DEFAULT_INDEX],
      ["wiki/log.md", DEFAULT_LOG],
    ]);
    harness.seed({
      projects: [project],
      issues: [issue],
      issueComments: [{
        id: "77777777-7777-4777-8777-777777777797",
        companyId: COMPANY_ID,
        issueId: issue.id,
        authorType: "user",
        authorAgentId: null,
        authorUserId: null,
        body: "Authorization: Bearer ghp_patchsecretcommenttoken1234567890",
        presentation: null,
        metadata: null,
        createdAt: new Date("2026-05-04T11:00:00Z"),
        updatedAt: new Date("2026-05-04T11:00:00Z"),
      }],
    });
    harness.ctx.localFolders.readText = async (_companyId, _folderKey, relativePath) => {
      const contents = files.get(relativePath);
      if (contents == null) throw new Error(`missing ${relativePath}`);
      return contents;
    };
    harness.ctx.localFolders.writeTextAtomic = async (_companyId, _folderKey, relativePath, contents) => {
      files.set(relativePath, contents);
      return harness.ctx.localFolders.status(COMPANY_ID, "wiki-root");
    };

    await plugin.definition.setup(harness.ctx);
    await harness.ctx.issues.documents.upsert({
      companyId: COMPANY_ID,
      issueId: issue.id,
      key: "plan",
      title: "Plan",
      body: "OPENAI_API_KEY=sk-patchsecretdocumentvalue1234567890",
    });

    const result = await harness.performAction<{
      status: string;
      patches: Array<{ operationType: string; proposedContents: string }>;
    }>("distill-paperclip-project-page", {
      companyId: COMPANY_ID,
      projectId: project.id,
      maxCharacters: 20000,
      includeSupportingPages: false,
    });

    expect(result.status).toBe("review_required");
    const combinedPatchContents = result.patches.map((patch) => patch.proposedContents).join("\n");
    expect(combinedPatchContents).toContain("redaction=suppressed_sensitive_content");
    expect(combinedPatchContents).toContain("redaction_reasons=secret_like_token");
    expect(combinedPatchContents).not.toContain("ghp_patchsecretcommenttoken1234567890");
    expect(combinedPatchContents).not.toContain("sk-patchsecretdocumentvalue1234567890");
  });

  it("auto-applies Paperclip project page patches by default when policy allows and records page bindings", async () => {
    const harness = createTestHarness({ manifest });
    const project = existingProject();
    const issue = paperclipIssue({
      id: "77777777-7777-4777-8777-777777777792",
      identifier: "PAP-4101",
      title: "Implement project page writer",
      description: "Implementation completed enough to publish the generated project page.",
      status: "done",
      projectId: project.id,
      updatedAt: new Date("2026-05-04T10:00:00Z"),
    });
    const files = new Map<string, string>([
      ["wiki/index.md", DEFAULT_INDEX],
      ["wiki/log.md", DEFAULT_LOG],
    ]);
    harness.seed({ projects: [project], issues: [issue] });
    harness.ctx.localFolders.readText = async (_companyId, _folderKey, relativePath) => {
      const contents = files.get(relativePath);
      if (contents == null) throw new Error(`missing ${relativePath}`);
      return contents;
    };
    harness.ctx.localFolders.writeTextAtomic = async (_companyId, _folderKey, relativePath, contents) => {
      files.set(relativePath, contents);
      return harness.ctx.localFolders.status(COMPANY_ID, "wiki-root");
    };

    await plugin.definition.setup(harness.ctx);
    const result = await harness.performAction<{
      status: string;
      appliedPages: string[];
      patches: Array<{ pagePath: string; sourceHash: string }>;
    }>("distill-paperclip-project-page", {
      companyId: COMPANY_ID,
      projectId: project.id,
      autoApply: true,
      maxCharacters: 20000,
      includeSupportingPages: false,
    });

    expect(result.status).toBe("applied");
    expect(result.appliedPages).toEqual([
      "wiki/projects/existing-wiki-project/standup.md",
      "wiki/projects/existing-wiki-project/index.md",
      "wiki/index.md",
      "wiki/log.md",
    ]);
    expect(files.get("wiki/projects/existing-wiki-project/standup.md")).toContain("## Executive Readout");
    expect(files.get("wiki/projects/existing-wiki-project/index.md")).toContain("## Current Direction");
    expect(files.get("wiki/projects/existing-wiki-project/index.md")).toContain("## References");
    expect(files.get("wiki/index.md")).toContain("wiki/projects/existing-wiki-project/index.md");
    expect(files.get("wiki/log.md")).toContain("paperclip-distill | proposed");
    const bindingWrites = harness.dbExecutes.filter((execute) => execute.sql.includes("paperclip_page_bindings"));
    expect(bindingWrites).toHaveLength(4);
    expect(bindingWrites[0].params).toEqual(expect.arrayContaining([
      COMPANY_ID,
      "default",
      project.id,
      null,
      "wiki/projects/existing-wiki-project/standup.md",
      result.patches[0].sourceHash,
    ]));
  });

  it("refuses auto-apply Paperclip project page patches in authenticated/public deployments", async () => {
    process.env.PAPERCLIP_DEPLOYMENT_MODE = "authenticated";
    process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE = "public";
    const harness = createTestHarness({ manifest, config: { autoApplyIngestPatches: true } });
    const project = existingProject();
    const issue = paperclipIssue({
      id: "77777777-7777-4777-8777-77777777779a",
      identifier: "PAP-4101",
      title: "Implement project page writer",
      description: "Implementation completed enough to publish the generated project page.",
      status: "done",
      projectId: project.id,
      updatedAt: new Date("2026-05-04T10:00:00Z"),
    });
    const files = new Map<string, string>([
      ["wiki/index.md", DEFAULT_INDEX],
      ["wiki/log.md", DEFAULT_LOG],
    ]);
    const writes: string[] = [];
    harness.seed({ projects: [project], issues: [issue] });
    harness.ctx.localFolders.readText = async (_companyId, _folderKey, relativePath) => {
      const contents = files.get(relativePath);
      if (contents == null) throw new Error(`missing ${relativePath}`);
      return contents;
    };
    harness.ctx.localFolders.writeTextAtomic = async (_companyId, _folderKey, relativePath, contents) => {
      writes.push(relativePath);
      files.set(relativePath, contents);
      return harness.ctx.localFolders.status(COMPANY_ID, "wiki-root");
    };

    await plugin.definition.setup(harness.ctx);
    const result = await harness.performAction<{
      status: string;
      appliedPages: string[];
      warnings: string[];
    }>("distill-paperclip-project-page", {
      companyId: COMPANY_ID,
      projectId: project.id,
      autoApply: true,
      maxCharacters: 20000,
      includeSupportingPages: false,
    });

    expect(result.status).toBe("review_required");
    expect(result.appliedPages).toEqual([]);
    expect(writes).toHaveLength(0);
    expect(result.warnings).toContain(
      "Authenticated/public deployments always require manual review before wiki writes.",
    );
  });

  it("refuses stale project page hashes before writing generated Paperclip pages", async () => {
    const harness = createTestHarness({ manifest, config: { autoApplyIngestPatches: true } });
    const project = existingProject();
    const issue = paperclipIssue({
      id: "77777777-7777-4777-8777-777777777793",
      identifier: "PAP-4102",
      title: "Publish project page",
      description: "Ready to publish.",
      status: "done",
      projectId: project.id,
    });
    const files = new Map<string, string>([
      ["wiki/projects/existing-wiki-project/index.md", "# Existing\n"],
      ["wiki/index.md", DEFAULT_INDEX],
      ["wiki/log.md", DEFAULT_LOG],
    ]);
    const writes: string[] = [];
    harness.seed({ projects: [project], issues: [issue] });
    harness.ctx.localFolders.readText = async (_companyId, _folderKey, relativePath) => {
      const contents = files.get(relativePath);
      if (contents == null) throw new Error(`missing ${relativePath}`);
      return contents;
    };
    harness.ctx.localFolders.writeTextAtomic = async (_companyId, _folderKey, relativePath, contents) => {
      writes.push(relativePath);
      files.set(relativePath, contents);
      return harness.ctx.localFolders.status(COMPANY_ID, "wiki-root");
    };

    await plugin.definition.setup(harness.ctx);
    await expect(harness.performAction("distill-paperclip-project-page", {
      companyId: COMPANY_ID,
      projectId: project.id,
      autoApply: true,
      expectedProjectPageHash: "stale",
      includeSupportingPages: false,
    })).rejects.toThrow("Refusing to overwrite");
    expect(writes).toHaveLength(0);
  });

  it("skips low-signal Paperclip source windows without proposing wiki writes", async () => {
    const harness = createTestHarness({ manifest });
    const project = existingProject();
    const issue = paperclipIssue({
      id: "77777777-7777-4777-8777-777777777794",
      identifier: "PAP-4103",
      title: "Routine heartbeat",
      description: "",
      status: "todo",
      projectId: project.id,
    });
    const writes: string[] = [];
    harness.seed({ projects: [project], issues: [issue] });
    harness.ctx.localFolders.writeTextAtomic = async (_companyId, _folderKey, relativePath, contents) => {
      writes.push(relativePath);
      return harness.ctx.localFolders.status(COMPANY_ID, "wiki-root");
    };

    await plugin.definition.setup(harness.ctx);
    const result = await harness.performAction<{ status: string; reason: string; patches: unknown[] }>("distill-paperclip-project-page", {
      companyId: COMPANY_ID,
      projectId: project.id,
      maxCharacters: 20000,
    });

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("low_signal");
    expect(result.patches).toEqual([]);
    expect(writes).toHaveLength(0);
  });

  it("bootstraps required local wiki files through the local folder API", async () => {
    const harness = createTestHarness({ manifest });
    const writes: Array<{ path: string; contents: string }> = [];
    harness.ctx.localFolders.writeTextAtomic = async (_companyId, _folderKey, relativePath, contents) => {
      writes.push({ path: relativePath, contents });
      return harness.ctx.localFolders.status(COMPANY_ID, "wiki-root");
    };

    await plugin.definition.setup(harness.ctx);
    const result = await harness.performAction<{ writtenFiles: string[]; managedSkills: WikiSkillResource[] }>("bootstrap-root", {
      companyId: COMPANY_ID,
      path: "/tmp/company-wiki",
    });

    expect(result.writtenFiles).toContain("AGENTS.md");
    expect(result.writtenFiles).toContain("IDEA.md");
    expect(result.managedSkills[0]).toMatchObject({
      status: "created",
      resourceKey: WIKI_MAINTAINER_SKILL_KEY,
      details: { key: WIKI_MAINTAINER_SKILL_CANONICAL_KEY },
    });
    expect(writes.map((write) => write.path)).toEqual([
      ".gitignore",
      "AGENTS.md",
      "IDEA.md",
      "wiki/index.md",
      "wiki/log.md",
      "raw/.gitkeep",
      "wiki/sources/.gitkeep",
      "wiki/projects/.gitkeep",
      "wiki/entities/.gitkeep",
      "wiki/concepts/.gitkeep",
      "wiki/synthesis/.gitkeep",
    ]);
    expect(writes.find((write) => write.path === "AGENTS.md")?.contents).toContain("LLM Wiki Schema");
    expect(writes.find((write) => write.path === "AGENTS.md")?.contents).toContain("wiki/projects/<project-slug>/index.md");
    expect(writes.find((write) => write.path === "AGENTS.md")?.contents).toContain("wiki/projects/<project-slug>/standup.md");
  });

  it("creates a managed space with an immediately readable baseline skeleton", async () => {
    const harness = createTestHarness({ manifest });
    const files = new Map<string, string>();
    harness.ctx.localFolders.readText = async (_companyId, _folderKey, relativePath) => {
      const value = files.get(relativePath);
      if (value == null) throw new Error(`missing ${relativePath}`);
      return value;
    };
    harness.ctx.localFolders.writeTextAtomic = async (_companyId, _folderKey, relativePath, contents) => {
      files.set(relativePath, contents);
      return harness.ctx.localFolders.status(COMPANY_ID, "wiki-root");
    };

    await plugin.definition.setup(harness.ctx);
    const created = await harness.performAction<{
      space: { slug: string; pathPrefix: string | null };
    }>("create-space", {
      companyId: COMPANY_ID,
      displayName: "QA Space",
    });

    expect(created.space).toMatchObject({
      slug: "qa-space",
      pathPrefix: "spaces/qa-space",
    });
    await expect(harness.ctx.localFolders.readText(
      COMPANY_ID,
      "wiki-root",
      "spaces/qa-space/AGENTS.md",
    )).resolves.toContain("LLM Wiki Schema");
    expect(files.get("spaces/qa-space/IDEA.md")).toBe(DEFAULT_IDEA);
    expect(files.has("spaces/qa-space/raw/.gitkeep")).toBe(true);
    expect(files.has("spaces/qa-space/projects/.gitkeep")).toBe(false);
    expect(files.has("spaces/qa-space/wiki/projects/.gitkeep")).toBe(true);
    expect(files.has("spaces/qa-space/wiki/index.md")).toBe(true);
  });

  it("prevents the default space from being archived through update-space", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    await expect(harness.performAction("update-space", {
      companyId: COMPANY_ID,
      spaceSlug: "default",
      status: "archived",
    })).rejects.toThrow("The default LLM Wiki space cannot be archived.");
    const defaultSpaceInsert = harness.dbExecutes.find((execute) =>
      execute.sql.includes("INSERT INTO") && execute.sql.includes("wiki_spaces"));
    expect(defaultSpaceInsert?.params?.[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(harness.dbExecutes.some((execute) =>
      execute.sql.includes("UPDATE") &&
      execute.sql.includes("wiki_spaces") &&
      execute.params?.includes("archived"))).toBe(false);
  });

  it("archives a non-default space through update-space without re-resolving it as active", async () => {
    const harness = createTestHarness({ manifest });
    const spaceRow = wikiSpaceRow({
      id: "77777777-7777-4777-8777-7777777777b1",
      slug: "qa-space",
      displayName: "QA Space",
      pathPrefix: "spaces/qa-space",
      status: "active",
      settings: { owner: "qa" },
    });
    let archived = false;
    const originalQuery = harness.ctx.db.query.bind(harness.ctx.db);
    harness.ctx.db.query = async <T,>(sql: string, params?: unknown[]) => {
      harness.dbQueries.push({ sql, params });
      if (sql.includes("wiki_spaces") && params?.[2] === "qa-space") {
        return archived && sql.includes("status <> 'archived'") ? [] as T[] : [spaceRow] as T[];
      }
      return originalQuery<T>(sql, params);
    };
    const originalExecute = harness.ctx.db.execute.bind(harness.ctx.db);
    harness.ctx.db.execute = async (sql: string, params?: unknown[]) => {
      if (sql.includes("UPDATE") && sql.includes("wiki_spaces") && params?.includes("archived")) archived = true;
      return originalExecute(sql, params);
    };

    await plugin.definition.setup(harness.ctx);
    const updated = await harness.performAction<{
      status: string;
      space: { slug: string; displayName: string; status: string; settings: Record<string, unknown> };
    }>("update-space", {
      companyId: COMPANY_ID,
      spaceSlug: "qa-space",
      displayName: "Archived QA",
      settings: { archivedBy: "test" },
      status: "archived",
    });

    expect(updated.status).toBe("ok");
    expect(updated.space).toMatchObject({
      slug: "qa-space",
      displayName: "Archived QA",
      status: "archived",
      settings: { owner: "qa", archivedBy: "test" },
    });
    expect(archived).toBe(true);
  });

  it("restores an archived non-default space through update-space", async () => {
    const harness = createTestHarness({ manifest });
    const spaceRow = wikiSpaceRow({
      id: "77777777-7777-4777-8777-7777777777b2",
      slug: "qa-space",
      displayName: "QA Space",
      pathPrefix: "spaces/qa-space",
      status: "archived",
    });
    let restored = false;
    const originalQuery = harness.ctx.db.query.bind(harness.ctx.db);
    harness.ctx.db.query = async <T,>(sql: string, params?: unknown[]) => {
      harness.dbQueries.push({ sql, params });
      if (sql.includes("wiki_spaces") && params?.[2] === "qa-space") {
        if (!restored && sql.includes("status <> 'archived'")) return [] as T[];
        return [{
          ...spaceRow,
          status: restored ? "active" : "archived",
        }] as T[];
      }
      return originalQuery<T>(sql, params);
    };
    const originalExecute = harness.ctx.db.execute.bind(harness.ctx.db);
    harness.ctx.db.execute = async (sql: string, params?: unknown[]) => {
      if (sql.includes("UPDATE") && sql.includes("wiki_spaces") && params?.includes("active")) restored = true;
      return originalExecute(sql, params);
    };

    await plugin.definition.setup(harness.ctx);
    const updated = await harness.performAction<{
      status: string;
      space: { slug: string; status: string };
    }>("update-space", {
      companyId: COMPANY_ID,
      spaceSlug: "qa-space",
      status: "active",
    });

    expect(updated.status).toBe("ok");
    expect(updated.space).toMatchObject({
      slug: "qa-space",
      status: "active",
    });
    expect(restored).toBe(true);
  });

  it("rejects unknown space statuses through update-space", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    await expect(harness.performAction("update-space", {
      companyId: COMPANY_ID,
      spaceSlug: "default",
      status: "suspended",
    })).rejects.toThrow("LLM Wiki space status must be active or archived.");
    expect(harness.dbExecutes.some((execute) =>
      execute.sql.includes("UPDATE") &&
      execute.sql.includes("wiki_spaces") &&
      execute.params?.includes("suspended"))).toBe(false);
  });

  it("omits archived spaces from the spaces data API", async () => {
    const harness = createTestHarness({ manifest });
    const activeRow = wikiSpaceRow({
      id: "77777777-7777-4777-8777-7777777777a1",
      slug: "team-research",
      displayName: "Team Research",
      pathPrefix: "spaces/team-research",
      status: "active",
    });
    const archivedRow = wikiSpaceRow({
      id: "77777777-7777-4777-8777-7777777777a2",
      slug: "qa-team-lock",
      displayName: "QA Team Lock",
      pathPrefix: "spaces/qa-team-lock",
      status: "archived",
    });
    harness.ctx.db.query = async <T,>(sql: string, params?: unknown[]) => {
      harness.dbQueries.push({ sql, params });
      if (sql.includes("wiki_spaces") && sql.includes("ORDER BY CASE WHEN slug = 'default'")) {
        const rows = [defaultWikiSpaceRow(), activeRow];
        if (!sql.includes("status <> 'archived'")) rows.push(archivedRow);
        return rows as T[];
      }
      if (sql.includes("wiki_spaces") && sql.includes("slug = 'default'")) {
        return [defaultWikiSpaceRow()] as T[];
      }
      return [] as T[];
    };

    await plugin.definition.setup(harness.ctx);
    const result = await harness.getData<{ spaces: Array<{ slug: string }> }>("spaces", {
      companyId: COMPANY_ID,
      wikiId: "default",
    });

    expect(result.spaces.map((space) => space.slug)).toEqual(["default", "team-research"]);
    expect(harness.dbQueries.some((query) => query.sql.includes("status <> 'archived'"))).toBe(true);
  });

  it("captures raw sources into local files and plugin metadata", async () => {
    const harness = createTestHarness({ manifest });
    const writes: Array<{ path: string; contents: string }> = [];
    harness.ctx.localFolders.writeTextAtomic = async (_companyId, _folderKey, relativePath, contents) => {
      writes.push({ path: relativePath, contents });
      return harness.ctx.localFolders.status(COMPANY_ID, "wiki-root");
    };

    await plugin.definition.setup(harness.ctx);
    const result = await harness.performAction<{ rawPath: string; hash: string }>("capture-source", {
      companyId: COMPANY_ID,
      wikiId: "default",
      title: "Plugin Boundaries",
      contents: "# Plugin Boundaries\n\nKeep wiki logic in the plugin.",
    });

    expect(result.rawPath).toMatch(/^raw\/\d{4}-\d{2}-\d{2}-plugin-boundaries-/);
    expect(result.hash).toHaveLength(64);
    expect(writes[0]).toMatchObject({ path: result.rawPath });
    expect(harness.dbExecutes.some((execute) => execute.sql.includes("wiki_sources"))).toBe(true);
  });

  it("preserves manual source ingest for non-default spaces while refusing Paperclip distillation there", async () => {
    const harness = createTestHarness({ manifest });
    const writes: Array<{ path: string; contents: string }> = [];
    harness.ctx.localFolders.writeTextAtomic = async (_companyId, _folderKey, relativePath, contents) => {
      writes.push({ path: relativePath, contents });
      return harness.ctx.localFolders.status(COMPANY_ID, "wiki-root");
    };
    harness.seed({
      agents: [wikiMaintainerAgent()],
      projects: [existingProject()],
    });
    const spaces = new Map<string, Record<string, unknown>>();
    const originalQuery = harness.ctx.db.query.bind(harness.ctx.db);
    harness.ctx.db.query = async <T,>(sql: string, params?: unknown[]) => {
      if (sql.includes("wiki_spaces")) {
        const slug = typeof params?.[2] === "string" ? params[2] : null;
        if (slug && spaces.has(slug)) return [spaces.get(slug)] as T[];
      }
      return originalQuery<T>(sql, params);
    };

    await plugin.definition.setup(harness.ctx);
    const created = await harness.performAction<{
      space: { id: string; companyId: string; wikiId: string; slug: string; displayName: string; pathPrefix: string | null };
    }>("create-space", {
      companyId: COMPANY_ID,
      displayName: "Team Research",
    });
    spaces.set(created.space.slug, {
      id: created.space.id,
      company_id: created.space.companyId,
      wiki_id: created.space.wikiId,
      slug: created.space.slug,
      display_name: created.space.displayName,
      space_type: "local_folder",
      folder_mode: "managed_subfolder",
      root_folder_key: "wiki-root",
      path_prefix: created.space.pathPrefix,
      configured_root_path: null,
      access_scope: "shared",
      owner_user_id: null,
      owner_agent_id: null,
      team_key: null,
      settings: {},
      status: "active",
      created_at: null,
      updated_at: null,
    });

    const source = await harness.performAction<{ rawPath: string; spaceSlug: string }>("capture-source", {
      companyId: COMPANY_ID,
      spaceSlug: created.space.slug,
      title: "Team notes",
      contents: "# Team notes\n\nManual source ingest still belongs to the selected space.",
    });

    expect(source.spaceSlug).toBe(created.space.slug);
    expect(writes.map((write) => write.path)).toContain(`spaces/${created.space.slug}/${source.rawPath}`);
    await expect(harness.performAction("distill-paperclip-now", {
      companyId: COMPANY_ID,
      spaceSlug: created.space.slug,
      projectId: existingProject().id,
    })).rejects.toThrow("Paperclip ingestion policy denied queue");
  });

  it("fails closed for direct Paperclip ingestion actions against restricted spaces", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({
      agents: [wikiMaintainerAgent()],
      projects: [existingProject()],
    });

    await plugin.definition.setup(harness.ctx);
    const created = await harness.performAction<{
      space: { slug: string; accessScope: string };
    }>("create-space", {
      companyId: COMPANY_ID,
      displayName: "Private Notes",
      accessScope: "personal",
    });

    expect(created.space.accessScope).toBe("personal");
    const originalQuery = harness.ctx.db.query.bind(harness.ctx.db);
    harness.ctx.db.query = async <T,>(sql: string, params?: unknown[]) => {
      if (sql.includes("wiki_spaces") && params?.[2] === created.space.slug) {
        return [{
          id: "77777777-7777-4777-8777-7777777777b2",
          company_id: COMPANY_ID,
          wiki_id: "default",
          slug: created.space.slug,
          display_name: "Private Notes",
          space_type: "local_folder",
          folder_mode: "managed_subfolder",
          root_folder_key: "wiki-root",
          path_prefix: `spaces/${created.space.slug}`,
          configured_root_path: null,
          access_scope: "personal",
          owner_user_id: null,
          owner_agent_id: null,
          team_key: null,
          settings: {},
          status: "active",
          created_at: null,
          updated_at: null,
        }] as T[];
      }
      return originalQuery<T>(sql, params);
    };
    await expect(harness.performAction("distill-paperclip-now", {
      companyId: COMPANY_ID,
      spaceSlug: created.space.slug,
      projectId: existingProject().id,
    })).rejects.toThrow("Paperclip ingestion policy denied queue");

    const operations = await harness.ctx.issues.list({
      companyId: COMPANY_ID,
      originKindPrefix: String(OPERATION_ORIGIN_KIND),
    });
    expect(operations).toHaveLength(0);
    expect(harness.dbExecutes.some((execute) => execute.sql.includes("paperclip_distillation_work_items"))).toBe(false);
  });

  it("re-checks Paperclip ingestion policy at execution time for queued work", async () => {
    const harness = createTestHarness({ manifest });
    const project = existingProject();
    const issue = paperclipIssue({
      id: "77777777-7777-4777-8777-7777777777b0",
      identifier: "PAP-4111",
      title: "Queued distillation source",
      description: "Accepted queued work should not run after policy changes.",
      projectId: project.id,
      status: "done",
    });
    harness.seed({ agents: [wikiMaintainerAgent()], projects: [project], issues: [issue] });

    await plugin.definition.setup(harness.ctx);
    const queued = await harness.performAction<{ status: string }>("distill-paperclip-now", {
      companyId: COMPANY_ID,
      projectId: project.id,
    });
    expect(queued.status).toBe("queued");

    const originalQuery = harness.ctx.db.query.bind(harness.ctx.db);
    harness.ctx.db.query = async <T,>(sql: string, params?: unknown[]) => {
      if (sql.includes("wiki_spaces") && sql.includes("slug = 'default'")) {
        return [{
          id: "77777777-7777-4777-8777-7777777777b1",
          company_id: COMPANY_ID,
          wiki_id: "default",
          slug: "default",
          display_name: "default",
          space_type: "local_folder",
          folder_mode: "managed_subfolder",
          root_folder_key: "wiki-root",
          path_prefix: null,
          configured_root_path: null,
          access_scope: "personal",
          owner_user_id: null,
          owner_agent_id: null,
          team_key: null,
          settings: {},
          status: "active",
          created_at: null,
          updated_at: null,
        }] as T[];
      }
      return originalQuery<T>(sql, params);
    };

    await expect(harness.performAction("create-paperclip-distillation-run", {
      companyId: COMPANY_ID,
      projectId: project.id,
    })).rejects.toThrow("personal spaces cannot ingest Paperclip sources");
    expect(harness.dbExecutes.some((execute) =>
      execute.sql.includes("paperclip_distillation_runs") && execute.sql.includes("'source_ready'"))).toBe(false);
  });

  it("queues Paperclip ingestion backfills for every selected project scope", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    const queued = await harness.performAction<{
      status: string;
      workItemId: string;
      issueId: string;
      workItems: Array<{ workItemId: string; issueId: string; projectId: string | null; rootIssueId: string | null }>;
    }>("queue-paperclip-ingestion-backfill", {
      companyId: COMPANY_ID,
      sourceScope: {
        kind: "selected_projects",
        projectIds: [
          "77777777-7777-4777-8777-7777777777a1",
          "77777777-7777-4777-8777-7777777777a2",
        ],
      },
      backfillStartAt: "2026-05-01T00:00:00.000Z",
      backfillEndAt: "2026-05-02T00:00:00.000Z",
    });

    expect(queued.status).toBe("queued");
    expect(queued.workItems).toHaveLength(2);
    expect(queued.workItemId).toBe(queued.workItems[0]?.workItemId);
    expect(queued.issueId).toBe(queued.workItems[0]?.issueId);
    expect(queued.workItems.map((item) => item.projectId)).toEqual([
      "77777777-7777-4777-8777-7777777777a1",
      "77777777-7777-4777-8777-7777777777a2",
    ]);
    expect(harness.dbExecutes.filter((execute) => execute.sql.includes("paperclip_distillation_work_items"))).toHaveLength(2);
  });

  it("rejects oversized Paperclip ingestion profile and source-scope payloads", async () => {
    const harness = createTestHarness({ manifest });

    await plugin.definition.setup(harness.ctx);
    await expect(harness.performAction("update-event-ingestion-settings", {
      companyId: COMPANY_ID,
      enabled: true,
      maxCharacters: 20001,
      sources: { issues: true },
    })).rejects.toThrow("maxCharacters exceeds the hard Paperclip ingestion cap");

    await expect(harness.performAction("enable-paperclip-distillation-active-projects", {
      companyId: COMPANY_ID,
      limit: 26,
    })).rejects.toThrow("fan-out exceeds the hard cap");

    await expect(harness.performAction("assemble-paperclip-source-bundle", {
      companyId: COMPANY_ID,
      projectId: "77777777-7777-4777-8777-777777777777",
      rootIssueId: "77777777-7777-4777-8777-777777777778",
    })).rejects.toThrow("either projectId or rootIssueId");

    await expect(harness.performAction("assemble-paperclip-source-bundle", {
      companyId: COMPANY_ID,
      projectId: "77777777-7777-4777-8777-777777777777",
      maxCharacters: 60001,
    })).rejects.toThrow("maxCharacters exceeds the hard Paperclip ingestion cap");
  });

  it("keeps default-space files at the root and isolates managed spaces under slug prefixes", async () => {
    const harness = createTestHarness({ manifest });
    const files = new Map<string, string>();
    const writes: Array<{ path: string; contents: string }> = [];
    harness.ctx.localFolders.readText = async (_companyId, _folderKey, relativePath) => {
      const value = files.get(relativePath);
      if (value == null) throw new Error(`missing ${relativePath}`);
      return value;
    };
    harness.ctx.localFolders.writeTextAtomic = async (_companyId, _folderKey, relativePath, contents) => {
      writes.push({ path: relativePath, contents });
      files.set(relativePath, contents);
      return harness.ctx.localFolders.status(COMPANY_ID, "wiki-root");
    };
    const spaces = new Map<string, Record<string, unknown>>();
    const originalQuery = harness.ctx.db.query.bind(harness.ctx.db);
    harness.ctx.db.query = async <T,>(sql: string, params?: unknown[]) => {
      if (sql.includes("wiki_spaces")) {
        const slug = typeof params?.[2] === "string" ? params[2] : null;
        if (slug && spaces.has(slug)) return [spaces.get(slug)] as T[];
      }
      return originalQuery<T>(sql, params);
    };

    await plugin.definition.setup(harness.ctx);
    const created = await harness.performAction<{
      space: { id: string; companyId: string; wikiId: string; slug: string; displayName: string; pathPrefix: string | null };
    }>("create-space", {
      companyId: COMPANY_ID,
      displayName: "Research Space",
    });
    spaces.set(created.space.slug, {
      id: created.space.id,
      company_id: created.space.companyId,
      wiki_id: created.space.wikiId,
      slug: created.space.slug,
      display_name: created.space.displayName,
      space_type: "local_folder",
      folder_mode: "managed_subfolder",
      root_folder_key: "wiki-root",
      path_prefix: created.space.pathPrefix,
      configured_root_path: null,
      access_scope: "shared",
      owner_user_id: null,
      owner_agent_id: null,
      team_key: null,
      settings: {},
      status: "active",
      created_at: null,
      updated_at: null,
    });
    await harness.performAction("bootstrap-space", {
      companyId: COMPANY_ID,
      spaceSlug: created.space.slug,
    });
    await harness.performAction("write-page", {
      companyId: COMPANY_ID,
      wikiId: "default",
      path: "wiki/concepts/shared.md",
      contents: "# Default Shared\n",
    });
    await harness.performAction("write-page", {
      companyId: COMPANY_ID,
      wikiId: "default",
      spaceSlug: created.space.slug,
      path: "wiki/concepts/shared.md",
      contents: "# Space Shared\n",
    });
    await harness.performAction("capture-source", {
      companyId: COMPANY_ID,
      wikiId: "default",
      rawPath: "raw/shared.md",
      title: "Shared Source",
      contents: "# Default Raw\n",
    });
    await harness.performAction("capture-source", {
      companyId: COMPANY_ID,
      wikiId: "default",
      spaceSlug: created.space.slug,
      rawPath: "raw/shared.md",
      title: "Shared Source",
      contents: "# Space Raw\n",
    });

    expect(created.space).toMatchObject({
      slug: "research-space",
      pathPrefix: "spaces/research-space",
    });
    expect(files.get("wiki/concepts/shared.md")).toBe("# Default Shared\n");
    expect(files.get("spaces/research-space/wiki/concepts/shared.md")).toBe("# Space Shared\n");
    expect(files.get("raw/shared.md")).toBe("# Default Raw\n");
    expect(files.get("spaces/research-space/raw/shared.md")).toBe("# Space Raw\n");
    expect(writes.map((write) => write.path)).not.toContain("spaces/default/wiki/concepts/shared.md");

    const pageWrites = harness.dbExecutes.filter((execute) => execute.sql.includes("wiki_pages"));
    const sourceWrites = harness.dbExecutes.filter((execute) => execute.sql.includes("wiki_sources"));
    expect(pageWrites.every((write) => write.sql.includes("space_id"))).toBe(true);
    expect(sourceWrites.every((write) => write.sql.includes("space_id"))).toBe(true);
  });

  it("ingests source metadata and creates a hidden plugin-operation issue", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({ agents: [wikiMaintainerAgent()] });
    const writes: Array<{ path: string; contents: string }> = [];
    harness.ctx.localFolders.writeTextAtomic = async (_companyId, _folderKey, relativePath, contents) => {
      writes.push({ path: relativePath, contents });
      return harness.ctx.localFolders.status(COMPANY_ID, "wiki-root");
    };

    await plugin.definition.setup(harness.ctx);
    const result = await harness.performAction<{
      source: { rawPath: string; title: string; hash: string };
      operation: { operationId: string; issue: { originKind: string; originId: string | null; billingCode: string | null; assigneeAgentId: string | null } };
    }>("ingest-source", {
      companyId: COMPANY_ID,
      wikiId: "engineering",
      sourceType: "url",
      title: "Standalone Plugin Notes",
      url: "https://example.test/wiki",
      contents: "# Standalone Plugin Notes\n\nKeep wiki behavior in the plugin package.",
      rawPath: "raw/standalone-plugin-notes.md",
      metadata: { importedBy: "alpha-verification" },
    });

    expect(result.source.rawPath).toBe("raw/standalone-plugin-notes.md");
    expect(result.source.title).toBe("Standalone Plugin Notes");
    expect(result.source.hash).toHaveLength(64);
    expect(writes).toEqual([
      expect.objectContaining({
        path: "raw/standalone-plugin-notes.md",
        contents: expect.stringContaining("Keep wiki behavior in the plugin package."),
      }),
    ]);
    expect(result.operation.issue.originKind).toBe(`${OPERATION_ORIGIN_KIND}:ingest`);
    expect(result.operation.issue.originId).toBe(`wiki:engineering:operation:${result.operation.operationId}`);
    expect(result.operation.issue.billingCode).toBe("plugin-llm-wiki:engineering");
    expect(result.operation.issue.assigneeAgentId).toBe(wikiMaintainerAgent().id);

    const sourceInsert = harness.dbExecutes.find((execute) => execute.sql.includes("wiki_sources"));
    expect(sourceInsert?.params).toEqual(expect.arrayContaining([
      COMPANY_ID,
      "engineering",
      "url",
      "Standalone Plugin Notes",
      "https://example.test/wiki",
      "raw/standalone-plugin-notes.md",
      JSON.stringify({ importedBy: "alpha-verification" }),
    ]));
    const operationInsert = harness.dbExecutes.find((execute) => execute.sql.includes("wiki_operations"));
    expect(operationInsert?.params).toEqual(expect.arrayContaining([
      result.operation.operationId,
      COMPANY_ID,
      "engineering",
      "ingest",
      "queued",
    ]));
  });

  it("rejects oversized source capture before raw writes or operation creation", async () => {
    const harness = createTestHarness({ manifest, config: { maxSourceBytes: 16 } });
    harness.seed({ agents: [wikiMaintainerAgent()] });
    const writes: Array<{ path: string; contents: string }> = [];
    harness.ctx.localFolders.writeTextAtomic = async (_companyId, _folderKey, relativePath, contents) => {
      writes.push({ path: relativePath, contents });
      return harness.ctx.localFolders.status(COMPANY_ID, "wiki-root");
    };

    await plugin.definition.setup(harness.ctx);
    await expect(harness.performAction("ingest-source", {
      companyId: COMPANY_ID,
      wikiId: "default",
      sourceType: "text",
      title: "Oversized source",
      contents: "x".repeat(17),
    })).rejects.toThrow("exceeds the configured LLM Wiki source limit");

    expect(writes).toHaveLength(0);
    expect(harness.dbExecutes.some((execute) => execute.sql.includes("wiki_sources"))).toBe(false);
    expect(harness.dbExecutes.some((execute) => execute.sql.includes("wiki_operations"))).toBe(false);
    const operations = await harness.ctx.issues.list({
      companyId: COMPANY_ID,
      originKindPrefix: String(OPERATION_ORIGIN_KIND),
    });
    expect(operations).toHaveLength(0);
  });

  it("writes pages atomically, records metadata, and rejects stale hashes", async () => {
    const harness = createTestHarness({ manifest });
    const files = new Map<string, string>([
      ["wiki/concepts/plugin-boundaries.md", "# Old Title\n"],
    ]);
    harness.ctx.localFolders.readText = async (_companyId, _folderKey, relativePath) => {
      const value = files.get(relativePath);
      if (value == null) throw new Error("missing");
      return value;
    };
    harness.ctx.localFolders.writeTextAtomic = async (_companyId, _folderKey, relativePath, contents) => {
      files.set(relativePath, contents);
      return harness.ctx.localFolders.status(COMPANY_ID, "wiki-root");
    };

    await plugin.definition.setup(harness.ctx);
    const staleWrite = harness.executeTool("wiki_write_page", {
      companyId: COMPANY_ID,
      wikiId: "default",
      path: "wiki/concepts/plugin-boundaries.md",
      contents: "# New Title\n",
      expectedHash: "stale",
    });
    await expect(staleWrite).rejects.toThrow("Refusing to overwrite");

    const result = await harness.executeTool<{ data?: { hash: string } }>("wiki_write_page", {
      companyId: COMPANY_ID,
      wikiId: "default",
      path: "wiki/concepts/plugin-boundaries.md",
      contents: "# Plugin Boundaries\n\nSee [Knowledge](wiki/areas/knowledge.md).",
    });

    expect(result.data?.hash).toHaveLength(64);
    expect(files.get("wiki/concepts/plugin-boundaries.md")).toContain("Plugin Boundaries");
    expect(harness.dbExecutes.some((execute) => execute.sql.includes("wiki_pages"))).toBe(true);
    expect(harness.dbExecutes.some((execute) => execute.sql.includes("wiki_page_revisions"))).toBe(true);
  });

  it("blocks agent-tool writes to AGENTS.md but allows explicit board edits", async () => {
    const harness = createTestHarness({ manifest });
    const files = new Map<string, string>([
      ["AGENTS.md", "# LLM Wiki Maintainer\n\nOriginal instructions.\n"],
    ]);
    harness.ctx.localFolders.readText = async (_companyId, _folderKey, relativePath) => {
      const value = files.get(relativePath);
      if (value == null) throw new Error("missing");
      return value;
    };
    harness.ctx.localFolders.writeTextAtomic = async (_companyId, _folderKey, relativePath, contents) => {
      files.set(relativePath, contents);
      return harness.ctx.localFolders.status(COMPANY_ID, "wiki-root");
    };

    await plugin.definition.setup(harness.ctx);

    await expect(harness.executeTool("wiki_write_page", {
      companyId: COMPANY_ID,
      wikiId: "default",
      path: "AGENTS.md",
      contents: "# LLM Wiki Maintainer\n\nCompromised instructions.\n",
    })).rejects.toThrow("Refusing to overwrite protected wiki control file AGENTS.md");

    const result = await harness.performAction<{ hash: string }>("write-page", {
      companyId: COMPANY_ID,
      wikiId: "default",
      path: "AGENTS.md",
      contents: "# LLM Wiki Maintainer\n\nBoard-updated instructions.\n",
    });

    expect(result.hash).toHaveLength(64);
    expect(files.get("AGENTS.md")).toContain("Board-updated instructions.");
  });

  it("creates plugin-operation issues for LLM workflows", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({ agents: [wikiMaintainerAgent()] });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.performAction<{ issue: { originKind: string; billingCode: string | null } }>(
      "create-operation",
      {
        companyId: COMPANY_ID,
        operationType: "query",
        title: "Ask the wiki about plugin boundaries",
        prompt: "Which files own wiki behavior?",
      },
    );

    expect(result.issue.originKind).toBe(`${OPERATION_ORIGIN_KIND}:query`);
    expect(result.issue.billingCode).toBe("plugin-llm-wiki:default");
    expect(harness.dbExecutes.some((execute) => execute.sql.includes("wiki_resource_bindings"))).toBe(true);
    expect(harness.dbExecutes.some((execute) => execute.sql.includes("wiki_operations"))).toBe(true);
  });

  it("stamps resolved space context into hidden operation issues and operation metadata", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({ agents: [wikiMaintainerAgent()] });
    const spaces = new Map<string, Record<string, unknown>>();
    const originalQuery = harness.ctx.db.query.bind(harness.ctx.db);
    harness.ctx.db.query = async <T,>(sql: string, params?: unknown[]) => {
      if (sql.includes("wiki_spaces")) {
        const slug = typeof params?.[2] === "string" ? params[2] : null;
        if (slug && spaces.has(slug)) return [spaces.get(slug)] as T[];
      }
      return originalQuery<T>(sql, params);
    };
    await plugin.definition.setup(harness.ctx);

    const created = await harness.performAction<{
      space: { id: string; companyId: string; wikiId: string; slug: string; displayName: string; pathPrefix: string | null };
    }>("create-space", {
      companyId: COMPANY_ID,
      displayName: "Research Space",
    });
    spaces.set(created.space.slug, {
      id: created.space.id,
      company_id: created.space.companyId,
      wiki_id: created.space.wikiId,
      slug: created.space.slug,
      display_name: created.space.displayName,
      space_type: "local_folder",
      folder_mode: "managed_subfolder",
      root_folder_key: "wiki-root",
      path_prefix: created.space.pathPrefix,
      configured_root_path: null,
      access_scope: "shared",
      owner_user_id: null,
      owner_agent_id: null,
      team_key: null,
      settings: {},
      status: "active",
      created_at: null,
      updated_at: null,
    });

    const result = await harness.performAction<{
      operationId: string;
      issue: { title: string; description: string | null; billingCode: string | null; originId: string | null };
    }>("create-operation", {
      companyId: COMPANY_ID,
      operationType: "lint",
      title: "Run LLM Wiki lint",
      prompt: "Audit wiki structure.",
      spaceSlug: created.space.slug,
    });

    expect(result.issue.title).toBe("Run LLM Wiki lint [space: Research Space / research-space]");
    expect(result.issue.description).toContain("Space: Research Space (research-space)");
    expect(result.issue.description).toContain("Space root: wiki-root/spaces/research-space");
    expect(result.issue.description).toContain("Pass wikiId `default` and spaceSlug `research-space`");
    expect(result.issue.description).toContain("Manual ingest, query, lint, index, and file-as-page operations follow the named destination space");
    expect(result.issue.billingCode).toBe("plugin-llm-wiki:default:research-space");
    expect(result.issue.originId).toBe(`wiki:default:space:research-space:operation:${result.operationId}`);
    const operationInsert = harness.dbExecutes.find((execute) =>
      execute.sql.includes("wiki_operations") && execute.params?.[0] === result.operationId);
    const metadata = JSON.parse(String(operationInsert?.params?.[8]));
    expect(metadata).toMatchObject({
      operationType: "lint",
      operationId: result.operationId,
      wikiId: "default",
      spaceId: created.space.id,
      spaceSlug: "research-space",
      spaceName: "Research Space",
      spaceRoot: "wiki-root/spaces/research-space",
      billingCode: "plugin-llm-wiki:default:research-space",
    });
  });

  it("uses selected existing agent and project bindings for new operations", async () => {
    const harness = createTestHarness({ manifest });
    const agent = existingAgent();
    const project = existingProject();
    harness.seed({ agents: [agent], projects: [project] });
    await plugin.definition.setup(harness.ctx);

    const selectedAgent = await harness.performAction<{ source: string; agentId: string }>("select-managed-agent", {
      companyId: COMPANY_ID,
      agentId: agent.id,
    });
    const selectedProject = await harness.performAction<{ source: string; projectId: string }>("select-managed-project", {
      companyId: COMPANY_ID,
      projectId: project.id,
    });

    expect(selectedAgent).toMatchObject({ source: "selected", agentId: agent.id });
    expect(selectedProject).toMatchObject({ source: "selected", projectId: project.id });
    expect(harness.dbExecutes.filter((execute) => execute.sql.includes("wiki_resource_bindings"))).toHaveLength(2);

    harness.ctx.db.query = async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      harness.dbQueries.push({ sql, params });
      if (sql.includes("wiki_resource_bindings") && params?.[2] === "agent") {
        return [{ resolved_id: agent.id, metadata: { source: "selected-existing" } }] as T[];
      }
      if (sql.includes("wiki_resource_bindings") && params?.[2] === "project") {
        return [{ resolved_id: project.id, metadata: { source: "selected-existing" } }] as T[];
      }
      if (sql.includes("wiki_operations")) return [{ count: "0" }] as T[];
      return [];
    };

    const result = await harness.performAction<{
      issue: { assigneeAgentId: string | null; projectId: string | null };
    }>("create-operation", {
      companyId: COMPANY_ID,
      operationType: "lint",
      title: "Lint selected wiki",
    });

    expect(result.issue.assigneeAgentId).toBe(agent.id);
    expect(result.issue.projectId).toBe(project.id);
  });

  it("starts query sessions, records run ids, and forwards session events to plugin streams", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({ agents: [wikiMaintainerAgent()] });
    const streamEvents: unknown[] = [];
    harness.ctx.streams.emit = (_channel, event) => {
      streamEvents.push(event);
    };
    await plugin.definition.setup(harness.ctx);

    const result = await harness.performAction<{
      operationId: string;
      querySessionId: string;
      sessionId: string;
      runId: string;
      channel: string;
    }>("start-query", {
      companyId: COMPANY_ID,
      question: "Which files own wiki behavior?",
    });

    expect(result.querySessionId).toBe(result.operationId);
    expect(result.channel).toBe(`llm-wiki:query:${result.operationId}`);
    expect(harness.dbExecutes.some((execute) => execute.sql.includes("wiki_query_sessions"))).toBe(true);
    expect(harness.dbExecutes.some((execute) => execute.sql.includes("run_ids"))).toBe(true);

    harness.simulateSessionEvent(result.sessionId, {
      runId: result.runId,
      seq: 1,
      eventType: "chunk",
      stream: "stdout",
      message: "Keep wiki behavior in the plugin.",
      payload: null,
    });
    harness.simulateSessionEvent(result.sessionId, {
      runId: result.runId,
      seq: 2,
      eventType: "done",
      stream: "system",
      message: "Run completed",
      payload: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(streamEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "query.started", operationId: result.operationId }),
      expect.objectContaining({ type: "agent.event", message: "Keep wiki behavior in the plugin." }),
      expect.objectContaining({ type: "query.done", answer: "Keep wiki behavior in the plugin." }),
    ]));
    expect(harness.dbExecutes.some((execute) =>
      execute.sql.includes("wiki_query_sessions") && execute.params?.includes("completed"),
    )).toBe(true);
  });

  it("files a streamed query answer as a page through a hidden file-as-page operation", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({ agents: [wikiMaintainerAgent()] });
    const writes: Array<{ path: string; contents: string }> = [];
    harness.ctx.localFolders.writeTextAtomic = async (_companyId, _folderKey, relativePath, contents) => {
      writes.push({ path: relativePath, contents });
      return harness.ctx.localFolders.status(COMPANY_ID, "wiki-root");
    };
    await plugin.definition.setup(harness.ctx);

    const result = await harness.performAction<{ path: string; operationId: string; page: { revisionId: string } }>(
      "file-as-page",
      {
        companyId: COMPANY_ID,
        querySessionId: "33333333-3333-4333-8333-333333333333",
        question: "Where should wiki code live?",
        answer: "Wiki-specific code lives in the standalone plugin package.",
        path: "wiki/concepts/plugin-boundaries.md",
        title: "Plugin Boundaries",
      },
    );

    expect(result.path).toBe("wiki/concepts/plugin-boundaries.md");
    expect(writes[0]).toMatchObject({ path: "wiki/concepts/plugin-boundaries.md" });
    expect(writes[0]?.contents).toContain("Wiki-specific code lives in the standalone plugin package.");
    expect(harness.dbExecutes.some((execute) => execute.sql.includes("wiki_operations"))).toBe(true);
    expect(harness.dbExecutes.some((execute) => execute.sql.includes("wiki_page_revisions"))).toBe(true);
    expect(harness.dbExecutes.some((execute) => execute.sql.includes("filed_outputs"))).toBe(true);
  });
});
