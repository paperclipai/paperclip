import { useEffect, useState } from "react";
import { SettingsPage, SidebarLink, WikiPage, WikiRouteSidebar } from "../../src/ui/index.js";
import type {
  FileTreeNode,
  FileTreeBadge,
  FileTreeProps,
  IssuesListProps,
} from "@paperclipai/plugin-sdk/ui";

// ---------------------------------------------------------------------------
// Bridge mocks. The real SDK runtime hooks read from a global registry; we
// inline an alternate registry here so the plugin UI can render with canned
// data inside a screenshot harness.
// ---------------------------------------------------------------------------

const NOW = "2026-05-01T20:30:00.000Z";

const FOLDER_HEALTHY = {
  folderKey: "wiki-root",
  configured: true,
  path: "/Users/operator/work/wiki/engineering",
  realPath: "/Users/operator/work/wiki/engineering",
  access: "readWrite" as const,
  readable: true,
  writable: true,
  requiredDirectories: ["raw", "wiki", "wiki/sources", "wiki/projects", "wiki/entities", "wiki/concepts", "wiki/synthesis"],
  requiredFiles: ["AGENTS.md", "IDEA.md", "wiki/index.md", "wiki/log.md"],
  missingDirectories: [],
  missingFiles: [],
  healthy: true,
  problems: [],
  checkedAt: NOW,
};

const MANAGED_AGENT = {
  status: "active",
  agentId: "agt-c14a-7b2f-4e90",
  resourceKey: "paperclipai.plugin-llm-wiki:agent:wiki-maintainer",
  details: { name: "Wiki Maintainer", status: "active", adapterType: "claude_local", icon: "book-open", urlKey: "wiki-maintainer" },
};

const MANAGED_PROJECT = {
  status: "active",
  projectId: "prj-llmw-7e1a",
  resourceKey: "paperclipai.plugin-llm-wiki:project:llm-wiki",
  details: { name: "LLM Wiki Operations", status: "in_progress" },
};

const MANAGED_ROUTINE = {
  status: "active",
  routineId: "rtn-llmw-night",
  resourceKey: "paperclipai.plugin-llm-wiki:routine:nightly-wiki-lint",
  routine: {
    id: "rtn-llmw-night",
    title: "Run LLM Wiki lint",
    status: "active",
    cronExpression: "0 3 * * *",
    enabled: true,
    assigneeAgentId: "agt-c14a-7b2f-4e90",
    projectId: "prj-llmw-7e1a",
    nextRunAt: "2026-05-02T03:00:00Z",
    lastRunAt: "2026-05-01T03:00:00Z",
  },
  details: {
    title: "Run LLM Wiki lint",
    status: "active",
    cronExpression: "0 3 * * *",
    enabled: true,
    assigneeAgentId: "agt-c14a-7b2f-4e90",
    nextRunAt: "2026-05-02T03:00:00Z",
    lastRunAt: "2026-05-01T03:00:00Z",
  },
};

const MANAGED_ROUTINES = [
  {
    status: "active",
    routineId: "rtn-llmw-cursor",
    resourceKey: "paperclipai.plugin-llm-wiki:routine:cursor-window-processing",
    routine: {
      id: "rtn-llmw-cursor",
      title: "Process LLM Wiki updates",
      status: "active",
      cronExpression: "0 */6 * * *",
      enabled: true,
      assigneeAgentId: "agt-c14a-7b2f-4e90",
      projectId: "prj-llmw-7e1a",
      lastRunAt: "2026-05-01T18:00:00Z",
    },
    details: {
      title: "Process LLM Wiki updates",
      status: "active",
      cronExpression: "0 */6 * * *",
      enabled: true,
    },
  },
  MANAGED_ROUTINE,
  {
    status: "active",
    routineId: "rtn-llmw-index",
    resourceKey: "paperclipai.plugin-llm-wiki:routine:index-refresh",
    routine: {
      id: "rtn-llmw-index",
      title: "Refresh LLM Wiki index",
      status: "active",
      cronExpression: "0 * * * *",
      enabled: true,
      assigneeAgentId: "agt-c14a-7b2f-4e90",
      projectId: "prj-llmw-7e1a",
      lastRunAt: "2026-05-01T20:00:00Z",
    },
    details: {
      title: "Refresh LLM Wiki index",
      status: "active",
      cronExpression: "0 * * * *",
      enabled: true,
    },
  },
];

const MANAGED_SKILL = {
  status: "resolved",
  skillId: "skl-llmw-maintainer",
  resourceKey: "wiki-maintainer",
  details: {
    name: "LLM Wiki Maintainer",
    key: "plugin/paperclipai-plugin-llm-wiki/wiki-maintainer",
    description: "Use the LLM Wiki plugin tools to maintain a cited local company wiki.",
  },
};
const MANAGED_SKILLS = [
  MANAGED_SKILL,
  { status: "resolved", skillId: "skl-llmw-ingest", resourceKey: "wiki-ingest", details: { name: "Wiki Ingest", key: "plugin/paperclipai-plugin-llm-wiki/wiki-ingest", description: null } },
  { status: "resolved", skillId: "skl-llmw-query", resourceKey: "wiki-query", details: { name: "Wiki Query", key: "plugin/paperclipai-plugin-llm-wiki/wiki-query", description: null } },
  { status: "resolved", skillId: "skl-llmw-lint", resourceKey: "wiki-lint", details: { name: "Wiki Lint", key: "plugin/paperclipai-plugin-llm-wiki/wiki-lint", description: null } },
  { status: "resolved", skillId: "skl-llmw-distill", resourceKey: "paperclip-distill", details: { name: "Paperclip Distill", key: "plugin/paperclipai-plugin-llm-wiki/paperclip-distill", description: null } },
  { status: "resolved", skillId: "skl-llmw-index", resourceKey: "index-refresh", details: { name: "Index Refresh", key: "plugin/paperclipai-plugin-llm-wiki/index-refresh", description: null } },
];

const OVERVIEW = {
  status: "ok",
  checkedAt: NOW,
  wikiId: "default",
  folder: FOLDER_HEALTHY,
  managedAgent: MANAGED_AGENT,
  managedProject: MANAGED_PROJECT,
  managedSkills: MANAGED_SKILLS,
  operationCount: 128,
  capabilities: [
    "api.routes.register",
    "issues.create",
    "issues.read",
    "agents.managed",
    "projects.managed",
    "routines.managed",
    "agent.tools.register",
  ],
  prompts: {
    query: "Answer from the LLM Wiki.\n\nRead wiki/index.md first, inspect relevant pages and raw/source references, cite the pages used, and say when the wiki does not contain enough evidence.",
    lint: "Lint the LLM Wiki for contradictions, stale claims, orphan pages, missing backlinks, weak provenance, and wiki/index.md / wiki/log.md drift.",
  },
  eventIngestion: {
    enabled: false,
    sources: { issues: false, comments: false, documents: false },
    wikiId: "default",
    maxCharacters: 12000,
  },
};

const SETTINGS = {
  folder: FOLDER_HEALTHY,
  managedAgent: MANAGED_AGENT,
  managedProject: MANAGED_PROJECT,
  managedRoutine: MANAGED_ROUTINE,
  managedRoutines: MANAGED_ROUTINES,
  managedSkills: MANAGED_SKILLS,
  agentOptions: [{ id: "agt-c14a-7b2f-4e90", name: "Wiki Maintainer", status: "active", icon: "book-open", urlKey: "wiki-maintainer" }],
  projectOptions: [],
  eventIngestion: OVERVIEW.eventIngestion,
  capabilities: OVERVIEW.capabilities,
};

const PAGES = {
  pages: [
    { path: "wiki/areas/control-plane.md", title: "Control plane", pageType: "areas", backlinkCount: 5, sourceCount: 2, contentHash: "a1b2c3d4", updatedAt: "2026-05-01T18:00:00Z" },
    { path: "wiki/areas/plugin-runtime.md", title: "Plugin runtime", pageType: "areas", backlinkCount: 4, sourceCount: 2, contentHash: "b1b2c3d4", updatedAt: "2026-05-01T16:00:00Z" },
    { path: "wiki/concepts/managed-resources.md", title: "Managed resources", pageType: "concepts", backlinkCount: 7, sourceCount: 2, contentHash: "c1b2c3d4", updatedAt: "2026-05-01T19:30:00Z" },
    { path: "wiki/concepts/origin-kind.md", title: "Origin kind", pageType: "concepts", backlinkCount: 3, sourceCount: 1, contentHash: "d1b2c3d4", updatedAt: "2026-05-01T15:00:00Z" },
    { path: "wiki/concepts/heartbeat.md", title: "Agent heartbeat", pageType: "concepts", backlinkCount: 2, sourceCount: 1, contentHash: "e1b2c3d4", updatedAt: "2026-04-30T10:00:00Z" },
    { path: "wiki/projects/llm-wiki/standup.md", title: "LLM Wiki plugin Standup", pageType: "project-standup", backlinkCount: 1, sourceCount: 3, contentHash: "s1b2c3d4", updatedAt: "2026-05-01T20:00:00Z" },
    { path: "wiki/projects/llm-wiki/index.md", title: "LLM Wiki plugin", pageType: "projects", backlinkCount: 6, sourceCount: 3, contentHash: "f1b2c3d4", updatedAt: "2026-05-01T17:30:00Z" },
    { path: "wiki/sources/karpathy-llm-wiki.md", title: "Karpathy LLM Wiki gist (summary)", pageType: "sources", backlinkCount: 3, sourceCount: 1, contentHash: "g1b2c3d4", updatedAt: "2026-05-01T11:30:00Z" },
    { path: "wiki/index.md", title: "LLM Wiki Index", pageType: "index", backlinkCount: 0, sourceCount: 0, contentHash: "h1b2c3d4", updatedAt: "2026-05-01T19:30:00Z" },
    { path: "wiki/log.md", title: "LLM Wiki Log", pageType: "log", backlinkCount: 0, sourceCount: 0, contentHash: "i1b2c3d4", updatedAt: "2026-05-01T19:30:00Z" },
  ],
  sources: [
    { rawPath: "raw/karpathy-llm-wiki.md", title: "Karpathy LLM Wiki gist", sourceType: "url", url: "https://gist.github.com/karpathy/.../llm-wiki", status: "captured", createdAt: "2026-05-01T19:00:00Z" },
    { rawPath: "raw/paperclip-v1-spec.md", title: "Paperclip V1 spec", sourceType: "file", url: null, status: "captured", createdAt: "2026-05-01T18:30:00Z" },
    { rawPath: "raw/design-doc-2026-04.md", title: "Design doc — April 2026", sourceType: "file", url: null, status: "captured", createdAt: "2026-04-28T14:00:00Z" },
  ],
};

const PAGE_CONTENT = {
  wikiId: "default",
  path: "wiki/concepts/managed-resources.md",
  contents: `# Managed Resources

A **plugin-managed resource** is a normal Paperclip resource (agent, routine, project) that a plugin has seeded with suggested defaults. The plugin marks ownership via a stable \`resourceKey\` so that installs, imports, and upgrades can find the resource even when UUIDs differ.

The host treats managed resources as fully editable. The operator can rename, change adapter config, edit instructions, change schedule, etc. The plugin can offer a *reset to plugin defaults* action that re-applies the suggested values.

## Why it matters

- Stable references survive dev resets and re-imports.
- Plugin upgrades don't clobber operator edits.
- Operations remain inspectable through native Agents / Routines / Projects pages.
`,
  title: "Managed Resources",
  pageType: "concepts",
  backlinks: ["wiki/areas/plugin-runtime.md", "wiki/concepts/origin-kind.md", "wiki/projects/llm-wiki/index.md"],
  sourceRefs: ["raw/karpathy-llm-wiki.md", "raw/paperclip-v1-spec.md"],
  updatedAt: "2026-05-01T19:30:00Z",
  hash: "deadbeefcafe1234",
};

const OPERATIONS = {
  operations: [
    { id: "2944aaaaaaaa", operationType: "ingest", status: "running", hiddenIssueId: "ii-2944", hiddenIssueIdentifier: "PAP-OP-2944", hiddenIssueTitle: "Ingest URL: karpathy/llm-wiki gist", hiddenIssueStatus: "in_progress", projectId: "prj-llmw-7e1a", costCents: 1, warnings: [], affectedPages: [], createdAt: "2026-05-01T20:29:48Z", updatedAt: "2026-05-01T20:29:48Z" },
    { id: "2943bbbbbbbb", operationType: "query", status: "done", hiddenIssueId: "ii-2943", hiddenIssueIdentifier: "PAP-OP-2943", hiddenIssueTitle: "How do plugin-managed routines resolve their default agent…", hiddenIssueStatus: "done", projectId: "prj-llmw-7e1a", costCents: 1, warnings: [], affectedPages: [], createdAt: "2026-05-01T20:25:00Z", updatedAt: "2026-05-01T20:26:30Z" },
    { id: "2942cccccccc", operationType: "file-as-page", status: "done", hiddenIssueId: "ii-2942", hiddenIssueIdentifier: "PAP-OP-2942", hiddenIssueTitle: "File answer as concepts/routine-agent-resolution.md", hiddenIssueStatus: "done", projectId: "prj-llmw-7e1a", costCents: 0, warnings: [], affectedPages: [{ path: "wiki/concepts/routine-agent-resolution.md" }], createdAt: "2026-05-01T20:25:30Z", updatedAt: "2026-05-01T20:25:35Z" },
    { id: "2941dddddddd", operationType: "query", status: "done", hiddenIssueId: "ii-2941", hiddenIssueIdentifier: "PAP-OP-2941", hiddenIssueTitle: "Compare managed agent reset vs detach…", hiddenIssueStatus: "done", projectId: "prj-llmw-7e1a", costCents: 1, warnings: [], affectedPages: [], createdAt: "2026-05-01T20:18:00Z", updatedAt: "2026-05-01T20:18:30Z" },
    { id: "2940eeeeeeee", operationType: "lint", status: "done", hiddenIssueId: "ii-2940", hiddenIssueIdentifier: "PAP-OP-2940", hiddenIssueTitle: "Nightly wiki lint · 17 findings (2 critical)", hiddenIssueStatus: "done", projectId: "prj-llmw-7e1a", costCents: 4, warnings: [
      { severity: "critical", message: "Contradiction: managed-resources.md vs raw/karpathy-llm-wiki.md (run-time vs install-time resolution)", path: "wiki/concepts/managed-resources.md" },
      { severity: "critical", message: "Conflicting claim about plugin manifest version", path: "wiki/concepts/origin-kind.md" },
      { severity: "orphan", message: "people/aaron-norvig.md has no inbound backlinks", path: "wiki/people/aaron-norvig.md" },
      { severity: "orphan", message: "concepts/sandboxing.md is referenced from raw/ only", path: "wiki/concepts/sandboxing.md" },
      { severity: "stale", message: "areas/control-plane.md last source observed 41d ago", path: "wiki/areas/control-plane.md" },
      { severity: "backlink", message: "Missing reverse links: managed-resources.md -> wiki/projects/llm-wiki/index.md" },
      { severity: "index", message: "index.md does not list 5 pages created in last 24h" },
    ], affectedPages: [], createdAt: "2026-05-01T18:00:00Z", updatedAt: "2026-05-01T18:02:30Z" },
    { id: "2939ffffffff", operationType: "ingest", status: "done", hiddenIssueId: "ii-2939", hiddenIssueIdentifier: "PAP-OP-2939", hiddenIssueTitle: "paperclip-v1-spec.md · 3 pages created", hiddenIssueStatus: "done", projectId: "prj-llmw-7e1a", costCents: 2, warnings: [], affectedPages: [{ path: "wiki/areas/control-plane.md" }, { path: "wiki/concepts/managed-resources.md" }, { path: "wiki/concepts/origin-kind.md" }], createdAt: "2026-05-01T18:30:00Z", updatedAt: "2026-05-01T18:32:00Z" },
    { id: "2934gggggggg", operationType: "ingest", status: "failed", hiddenIssueId: "ii-2934", hiddenIssueIdentifier: "PAP-OP-2934", hiddenIssueTitle: "Internal wiki dump (PDF) · outbound URL not on allowlist", hiddenIssueStatus: "blocked", projectId: "prj-llmw-7e1a", costCents: 0, warnings: [{ message: "outbound URL not on allowlist" }], affectedPages: [], createdAt: "2026-05-01T16:00:00Z", updatedAt: "2026-05-01T16:00:30Z" },
  ],
};

const TEMPLATE_IDEA = {
  path: "IDEA.md",
  exists: true,
  hash: "abc123",
  contents: `# LLM Wiki

A pattern for building personal knowledge bases using LLMs.
`,
};

const TEMPLATE_AGENTS = {
  path: "AGENTS.md",
  exists: true,
  hash: "def456",
  contents: `# LLM Wiki Maintainer

You maintain this wiki through Paperclip plugin tools.

Before answering or editing:

1. Read AGENTS.md.
2. Read wiki/index.md.
3. Cite raw sources or source pages for factual claims.
4. Use proposed patches for substantial rewrites.
5. Append a short note to wiki/log.md for maintenance changes.
`,
};

const HOST_CONTEXT = {
  companyId: "company-demo",
  companyPrefix: "PAP",
  projectId: null,
  entityId: null,
  entityType: null,
  userId: "user-demo",
  parentEntityId: null,
};

function fakeData<T>(value: T) {
  return { data: value, loading: false, error: null, refresh: () => undefined };
}

const DISTILLATION_CURSOR = {
  id: "cur-control-plane-1",
  sourceScope: "project",
  scopeKey: "prj-control-plane",
  projectId: "prj-control-plane",
  projectName: "Control plane",
  projectColor: "#2563eb",
  rootIssueId: null,
  rootIssueIdentifier: null,
  rootIssueTitle: null,
  lastProcessedAt: "2026-05-04T15:00:00Z",
  lastObservedAt: "2026-05-04T18:55:00Z",
  pendingEventCount: 4,
  lastSourceHash: "7f3a92041b210def",
  lastSuccessfulRunId: "run-1",
};

const DISTILLATION_RUNS = [
  {
    id: "run-1",
    cursorId: "cur-control-plane-1",
    workItemId: null,
    projectId: "prj-control-plane",
    projectName: "Control plane",
    rootIssueId: null,
    rootIssueIdentifier: null,
    sourceWindowStart: "2026-04-30T14:22:00Z",
    sourceWindowEnd: "2026-05-04T15:01:00Z",
    sourceHash: "7f3a92041b210def",
    status: "succeeded",
    costCents: 12,
    retryCount: 0,
    warnings: [],
    metadata: {},
    operationIssueId: "ii-op-3201",
    operationIssueIdentifier: "PAP-OP-3201",
    operationIssueTitle: "LLM Wiki distillation · Control plane",
    affectedPagePaths: ["wiki/projects/control-plane/index.md"],
    createdAt: "2026-05-04T15:01:00Z",
    updatedAt: "2026-05-04T15:02:14Z",
  },
  {
    id: "run-2",
    cursorId: "cur-billing-1",
    workItemId: null,
    projectId: "prj-billing",
    projectName: "Billing",
    rootIssueId: null,
    rootIssueIdentifier: null,
    sourceWindowStart: "2026-05-03T08:00:00Z",
    sourceWindowEnd: "2026-05-04T18:55:00Z",
    sourceHash: "92d44102be7c08aa",
    status: "review_required",
    costCents: 8,
    retryCount: 0,
    warnings: ["Touches the Decisions section. Auto-apply policy is 'Status sections only'."],
    metadata: {},
    operationIssueId: "ii-op-3204",
    operationIssueIdentifier: "PAP-OP-3204",
    operationIssueTitle: "LLM Wiki distillation · Billing",
    affectedPagePaths: ["wiki/projects/billing/index.md", "wiki/projects/billing/decisions.md"],
    createdAt: "2026-05-04T18:55:00Z",
    updatedAt: "2026-05-04T18:56:14Z",
  },
  {
    id: "run-3",
    cursorId: "cur-routines-1",
    workItemId: null,
    projectId: "prj-routines",
    projectName: "Routine engine",
    rootIssueId: null,
    rootIssueIdentifier: null,
    sourceWindowStart: "2026-05-04T11:00:00Z",
    sourceWindowEnd: "2026-05-04T18:00:00Z",
    sourceHash: "ab12dde98c3f0001",
    status: "running",
    costCents: 4,
    retryCount: 0,
    warnings: [],
    metadata: {},
    operationIssueId: "ii-op-3205",
    operationIssueIdentifier: "PAP-OP-3205",
    operationIssueTitle: "LLM Wiki distillation · Routine engine",
    affectedPagePaths: [],
    createdAt: "2026-05-04T18:58:00Z",
    updatedAt: "2026-05-04T18:58:00Z",
  },
  {
    id: "run-4",
    cursorId: "cur-export-1",
    workItemId: null,
    projectId: "prj-exports",
    projectName: "Exports",
    rootIssueId: null,
    rootIssueIdentifier: null,
    sourceWindowStart: "2026-05-03T20:00:00Z",
    sourceWindowEnd: "2026-05-04T03:00:00Z",
    sourceHash: "ee01acd482211110",
    status: "failed",
    costCents: 0,
    retryCount: 1,
    warnings: ["model error: 429", "Source bundle clipped: 6 issues over 48k chars."],
    metadata: {},
    operationIssueId: "ii-op-3198",
    operationIssueIdentifier: "PAP-OP-3198",
    operationIssueTitle: "LLM Wiki distillation · Exports",
    affectedPagePaths: [],
    createdAt: "2026-05-04T03:01:00Z",
    updatedAt: "2026-05-04T03:01:30Z",
  },
];

const DISTILLATION_PAGE_BINDINGS = [
  {
    id: "bind-control-plane",
    pagePath: "wiki/projects/control-plane/index.md",
    projectId: "prj-control-plane",
    projectName: "Control plane",
    rootIssueId: null,
    lastAppliedSourceHash: "7f3a92041b210def",
    lastDistillationRunId: "run-1",
    lastRunStatus: "succeeded",
    lastRunCompletedAt: "2026-05-04T15:02:14Z",
    lastRunSourceWindowEnd: "2026-05-04T15:01:00Z",
    lastRunSourceHash: "7f3a92041b210def",
    metadata: { sourceRefs: [{ id: "PAP-3416", kind: "issue", title: "Distillation kickoff" }, { id: "PAP-3416#c1", kind: "comment", title: "Comment" }] },
    updatedAt: "2026-05-04T15:02:14Z",
  },
  {
    id: "bind-billing",
    pagePath: "wiki/projects/billing/index.md",
    projectId: "prj-billing",
    projectName: "Billing",
    rootIssueId: null,
    lastAppliedSourceHash: "11abf991a081ddff",
    lastDistillationRunId: "run-2",
    lastRunStatus: "review_required",
    lastRunCompletedAt: "2026-05-04T18:56:14Z",
    lastRunSourceWindowEnd: "2026-05-04T18:55:00Z",
    lastRunSourceHash: "92d44102be7c08aa",
    metadata: {},
    updatedAt: "2026-05-04T18:56:14Z",
  },
];

const DISTILLATION_OVERVIEW = {
  cursors: [
    DISTILLATION_CURSOR,
    {
      ...DISTILLATION_CURSOR,
      id: "cur-billing-1",
      scopeKey: "prj-billing",
      projectId: "prj-billing",
      projectName: "Billing",
      lastProcessedAt: "2026-05-04T18:55:00Z",
      lastObservedAt: "2026-05-04T18:55:00Z",
      pendingEventCount: 0,
      lastSuccessfulRunId: "run-2",
    },
    {
      ...DISTILLATION_CURSOR,
      id: "cur-routines-1",
      scopeKey: "prj-routines",
      projectId: "prj-routines",
      projectName: "Routine engine",
      lastProcessedAt: null,
      lastObservedAt: "2026-05-04T18:00:00Z",
      pendingEventCount: 11,
      lastSuccessfulRunId: null,
    },
  ],
  runs: DISTILLATION_RUNS,
  workItems: [
    { id: "wi-1", workItemKind: "review", status: "review_required", priority: "high", projectId: "prj-billing", rootIssueId: null, metadata: {}, createdAt: "2026-05-04T18:56:00Z", updatedAt: "2026-05-04T18:56:00Z" },
  ],
  pageBindings: DISTILLATION_PAGE_BINDINGS,
  reviewWorkItems: [
    { id: "wi-1", workItemKind: "review", status: "review_required", priority: "high", projectId: "prj-billing", rootIssueId: null, metadata: {}, createdAt: "2026-05-04T18:56:00Z", updatedAt: "2026-05-04T18:56:00Z" },
  ],
  counts: { cursors: 3, runningRuns: 1, failedRuns24h: 1, reviewRequired: 1 },
};

const DISTILLATION_OVERVIEW_UNCONFIGURED = {
  cursors: [],
  runs: [],
  workItems: [],
  pageBindings: [],
  reviewWorkItems: [],
  counts: { cursors: 0, runningRuns: 0, failedRuns24h: 0, reviewRequired: 0 },
};

const DISTILLATION_PROVENANCE = {
  binding: DISTILLATION_PAGE_BINDINGS[0],
  runs: [DISTILLATION_RUNS[0]],
  snapshot: {
    id: "snap-1",
    distillationRunId: "run-1",
    sourceHash: "7f3a92041b210def",
    maxCharacters: 48000,
    clipped: false,
    sourceRefs: [
      { id: "PAP-3416", kind: "issue", title: "How should we distill?" },
      { id: "PAP-3416#c1", kind: "comment", title: "Approach: cursors" },
      { id: "PAP-3416#doc:plan", kind: "document", title: "Plan v3" },
    ],
    metadata: { issueCount: 12, commentCount: 8, documentCount: 4 },
    createdAt: "2026-05-04T15:01:00Z",
  },
  cursor: DISTILLATION_CURSOR,
};

const SPACES = {
  spaces: [
    {
      id: "space-default",
      companyId: HOST_CONTEXT.companyId,
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
      createdAt: "2026-04-12T08:00:00Z",
      updatedAt: "2026-05-01T12:00:00Z",
    },
    {
      id: "space-team-research",
      companyId: HOST_CONTEXT.companyId,
      wikiId: "default",
      slug: "team-research",
      displayName: "team-research",
      spaceType: "managed",
      folderMode: "managed_subfolder",
      rootFolderKey: "wiki-root",
      pathPrefix: "spaces/team-research",
      configuredRootPath: null,
      accessScope: "shared",
      ownerUserId: null,
      ownerAgentId: null,
      teamKey: null,
      settings: {},
      status: "active",
      createdAt: "2026-04-22T08:00:00Z",
      updatedAt: "2026-05-01T11:00:00Z",
    },
    {
      id: "space-customer-feedback",
      companyId: HOST_CONTEXT.companyId,
      wikiId: "default",
      slug: "customer-feedback",
      displayName: "customer-feedback",
      spaceType: "managed",
      folderMode: "managed_subfolder",
      rootFolderKey: "wiki-root",
      pathPrefix: "spaces/customer-feedback",
      configuredRootPath: null,
      accessScope: "shared",
      ownerUserId: null,
      ownerAgentId: null,
      teamKey: null,
      settings: {},
      status: "active",
      createdAt: "2026-04-25T08:00:00Z",
      updatedAt: "2026-05-01T10:00:00Z",
    },
  ],
};

function dataResolver(key: string, params?: Record<string, unknown>) {
  if (key === "overview") return fakeData(OVERVIEW);
  if (key === "settings") return fakeData(SETTINGS);
  if (key === "spaces") return fakeData(SPACES);
  if (key === "space") {
    const slug = typeof params?.spaceSlug === "string" ? params.spaceSlug : "default";
    const space = SPACES.spaces.find((s) => s.slug === slug) ?? SPACES.spaces[0];
    return fakeData({
      ...space,
      relativeRoot: space.pathPrefix ?? "",
      folder: FOLDER_HEALTHY,
    });
  }
  if (key === "pages") return fakeData(PAGES);
  if (key === "page-content") return fakeData(PAGE_CONTENT);
  if (key === "operations") {
    const opType = typeof params?.operationType === "string" ? params.operationType : null;
    const filtered = opType && opType !== "all"
      ? OPERATIONS.operations.filter((op) => op.operationType === opType)
      : OPERATIONS.operations;
    return fakeData({ operations: filtered });
  }
  if (key === "distillation-overview") {
    const flag = typeof window !== "undefined" ? window.location.search.includes("unconfigured=1") : false;
    return fakeData(flag ? DISTILLATION_OVERVIEW_UNCONFIGURED : DISTILLATION_OVERVIEW);
  }
  if (key === "distillation-page-provenance") {
    return fakeData(DISTILLATION_PROVENANCE);
  }
  if (key === "template" && params?.path === "IDEA.md") return fakeData(TEMPLATE_IDEA);
  if (key === "template" && params?.path === "AGENTS.md") return fakeData(TEMPLATE_AGENTS);
  return { data: null, loading: false, error: null, refresh: () => undefined };
}

function MockFileTree(props: FileTreeProps) {
  const expanded = new Set(props.expandedPaths ?? []);
  const badges = props.fileBadges ?? {};
  const renderNodes = (nodes: FileTreeNode[], depth: number) => (
    <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {nodes.map((node) => {
        const isExpanded = node.kind === "dir" && expanded.has(node.path);
        const isSelected = node.kind === "file" && node.path === props.selectedFile;
        const badge = badges[node.path] as FileTreeBadge | undefined;
        return (
          <li key={node.path}>
            <button
              type="button"
              onClick={() => {
                if (node.kind === "dir") props.onToggleDir?.(node.path);
                else props.onSelectFile?.(node.path);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                width: "100%",
                border: "none",
                background: isSelected ? "var(--accent, oklch(0.269 0 0))" : "transparent",
                color: "var(--foreground, oklch(0.985 0 0))",
                fontSize: 12,
                textAlign: "left",
                padding: `4px 8px 4px ${depth * 16 + 12}px`,
                cursor: "pointer",
                borderRadius: 4,
                fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
              }}
              aria-expanded={node.kind === "dir" ? isExpanded : undefined}
              aria-selected={isSelected || undefined}
            >
              <span style={{ width: 12, color: "var(--muted-foreground, oklch(0.708 0 0))" }} aria-hidden>
                {node.kind === "dir" ? (isExpanded ? "▾" : "▸") : ""}
              </span>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {node.kind === "dir" ? `📁 ${node.name}` : node.name}
              </span>
              {badge ? (
                <span
                  style={{
                    fontSize: 10,
                    padding: "1px 6px",
                    borderRadius: 999,
                    background: "color-mix(in oklab, var(--accent, oklch(0.4 0.04 250)) 50%, transparent)",
                    color: "var(--foreground, oklch(0.985 0 0))",
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                  }}
                  title={badge.tooltip}
                >
                  {badge.label}
                </span>
              ) : null}
            </button>
            {node.kind === "dir" && isExpanded ? renderNodes(node.children, depth + 1) : null}
          </li>
        );
      })}
    </ul>
  );

  if (props.loading) {
    return <div style={{ padding: 12, fontSize: 12, color: "var(--muted-foreground, oklch(0.708 0 0))" }}>Loading…</div>;
  }
  if (props.error) {
    return <div style={{ padding: 12, fontSize: 12, color: "var(--destructive, oklch(0.7 0.2 25))" }}>{props.error.message}</div>;
  }
  if (props.nodes.length === 0) {
    return (
      <div style={{ padding: 16, fontSize: 12, color: "var(--muted-foreground, oklch(0.708 0 0))" }}>
        <div style={{ fontWeight: 600, color: "var(--foreground, oklch(0.985 0 0))" }}>{props.empty?.title ?? "No files"}</div>
        <div>{props.empty?.description ?? "Nothing to show."}</div>
      </div>
    );
  }
  return <div role="tree" aria-label={props.ariaLabel ?? "Files"}>{renderNodes(props.nodes, 0)}</div>;
}

function MockIssuesList(props: IssuesListProps) {
  const isNarrow = typeof window !== "undefined" && window.innerWidth < 700;
  const rows = OPERATIONS.operations.map((op) => ({
    id: op.hiddenIssueId ?? op.id,
    identifier: op.hiddenIssueIdentifier ?? `op-${op.id.slice(0, 6)}`,
    title: op.hiddenIssueTitle ?? `LLM Wiki ${op.operationType}`,
    status: op.hiddenIssueStatus ?? op.status,
    priority: op.operationType === "query" ? "medium" : "low",
    updatedAt: op.updatedAt,
    operationType: op.operationType,
  }));
  return (
    <div style={{ display: "grid", gap: 10, padding: 18, fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 14 }}>Issues</strong>
        <span style={{ fontSize: 11, color: "var(--muted-foreground, oklch(0.708 0 0))" }}>
          {rows.length} loaded · {props.filters?.originKindPrefix ?? props.projectId ?? "all"}
        </span>
      </div>
      <div style={{ border: "1px solid var(--border, oklch(0.269 0 0))", borderRadius: 8, overflow: "hidden", background: "var(--card, oklch(0.205 0 0))" }}>
        {rows.map((issue) => (
          <div
            key={issue.id}
            style={{
              display: "grid",
              gridTemplateColumns: isNarrow ? "minmax(0, 1fr) auto" : "110px minmax(0, 1fr) 110px 90px",
              gap: isNarrow ? "6px 10px" : 12,
              alignItems: "center",
              padding: "10px 12px",
              borderBottom: "1px solid var(--border, oklch(0.269 0 0))",
              fontSize: 13,
            }}
          >
            <span style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12, color: "var(--muted-foreground, oklch(0.708 0 0))" }}>{issue.identifier}</span>
            {isNarrow ? null : <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{issue.title}</span>}
            {isNarrow ? null : <span style={{ fontSize: 11, color: "var(--muted-foreground, oklch(0.708 0 0))" }}>{issue.operationType}</span>}
            <span style={{ justifySelf: "end", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11, border: "1px solid var(--border, oklch(0.269 0 0))", borderRadius: 999, padding: "2px 8px" }}>{issue.status}</span>
            {isNarrow ? (
              <span style={{ gridColumn: "1 / -1", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{issue.title}</span>
            ) : null}
            {isNarrow ? (
              <span style={{ gridColumn: "1 / -1", fontSize: 11, color: "var(--muted-foreground, oklch(0.708 0 0))" }}>{issue.operationType}</span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function MockMarkdownBlock({ content, className }: { content: string; className?: string }) {
  return (
    <div
      className={className}
      style={{ whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.65 }}
    >
      {content}
    </div>
  );
}

function MockMarkdownEditor({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <textarea
      className={className}
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.currentTarget.value)}
      style={{
        width: "100%",
        minHeight: 260,
        boxSizing: "border-box",
        border: "1px solid var(--border, oklch(0.269 0 0))",
        borderRadius: 8,
        background: "var(--card, oklch(0.205 0 0))",
        color: "var(--foreground, oklch(0.985 0 0))",
        padding: 12,
        font: "13px ui-sans-serif, system-ui, -apple-system, sans-serif",
      }}
    />
  );
}

function MockAssigneePicker({
  value,
  placeholder,
  onChange,
}: {
  value: string;
  placeholder?: string;
  onChange: (value: string, selection: { assigneeAgentId: string | null; assigneeUserId: string | null }) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange("agent:agt-c14a-7b2f-4e90", { assigneeAgentId: "agt-c14a-7b2f-4e90", assigneeUserId: null })}
      style={{
        width: "100%",
        minHeight: 44,
        border: "1px solid var(--border, oklch(0.269 0 0))",
        borderRadius: 8,
        background: "var(--card, oklch(0.205 0 0))",
        color: "var(--foreground, oklch(0.985 0 0))",
        padding: "8px 12px",
        textAlign: "left",
        font: "13px ui-sans-serif, system-ui, -apple-system, sans-serif",
      }}
    >
      {value ? "Wiki Maintainer" : (placeholder ?? "Select maintainer")}
    </button>
  );
}

type MockManagedRoutinesListProps = {
  routines: Array<{
    key: string;
    title: string;
    status: string;
    cronExpression?: string | null;
    lastRunAt?: string | Date | null;
    lastRunStatus?: string | null;
    href?: string | null;
    managedByPluginDisplayName?: string | null;
    missingRefs?: Array<{ resourceKind: string; resourceKey: string }>;
    defaultDrift?: { changedFields: string[] } | null;
  }>;
  agents?: Array<{ id: string; name: string }>;
  projects?: Array<{ id: string; name: string }>;
  pluginDisplayName?: string | null;
  runningRoutineKey?: string | null;
  statusMutationRoutineKey?: string | null;
  resettingRoutineKey?: string | null;
  onRunNow?: (routine: { key: string }) => void;
  onToggleEnabled?: (routine: { key: string }, enabled: boolean) => void;
  onReset?: (routine: { key: string }) => void;
};

function MockManagedRoutinesList(props: MockManagedRoutinesListProps) {
  if (props.routines.length === 0) {
    return (
      <div style={{ padding: 16, fontSize: 12, color: "var(--muted-foreground, oklch(0.708 0 0))" }}>
        No managed routines.
      </div>
    );
  }
  return (
    <div
      style={{
        display: "grid",
        gap: 0,
        border: "1px solid var(--border, oklch(0.269 0 0))",
        borderRadius: 8,
        overflow: "hidden",
        background: "var(--card, oklch(0.205 0 0))",
        fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
      }}
    >
      {props.routines.map((routine, index) => (
        <div
          key={routine.key}
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) 110px 110px",
            gap: 12,
            alignItems: "center",
            padding: "10px 14px",
            borderTop: index === 0 ? "none" : "1px solid var(--border, oklch(0.269 0 0))",
            fontSize: 13,
          }}
        >
          <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
            <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {routine.title}
            </span>
            <span
              style={{
                fontSize: 11,
                color: "var(--muted-foreground, oklch(0.708 0 0))",
                fontFamily: "ui-monospace, SFMono-Regular, monospace",
              }}
            >
              {routine.cronExpression ?? "—"}
            </span>
          </div>
          <span
            style={{
              justifySelf: "start",
              fontSize: 11,
              border: "1px solid var(--border, oklch(0.269 0 0))",
              borderRadius: 999,
              padding: "2px 8px",
            }}
          >
            {routine.status}
          </span>
          <div style={{ justifySelf: "end", display: "flex", gap: 6 }}>
            <button
              type="button"
              style={{
                fontSize: 11,
                padding: "4px 8px",
                borderRadius: 6,
                border: "1px solid var(--border, oklch(0.269 0 0))",
                background: "transparent",
                color: "var(--foreground, oklch(0.985 0 0))",
                cursor: "pointer",
              }}
              onClick={() => props.onRunNow?.({ key: routine.key })}
            >
              Run now
            </button>
            <button
              type="button"
              style={{
                fontSize: 11,
                padding: "4px 8px",
                borderRadius: 6,
                border: "1px solid var(--border, oklch(0.269 0 0))",
                background: "transparent",
                color: "var(--foreground, oklch(0.985 0 0))",
                cursor: "pointer",
              }}
              onClick={() => props.onReset?.({ key: routine.key })}
            >
              Reset
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function MockProjectPicker({
  value,
  placeholder,
  onChange,
}: {
  value: string;
  placeholder?: string;
  onChange: (projectId: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange("prj-llmw-7e1a")}
      style={{
        width: "100%",
        minHeight: 44,
        border: "1px solid var(--border, oklch(0.269 0 0))",
        borderRadius: 8,
        background: "var(--card, oklch(0.205 0 0))",
        color: "var(--foreground, oklch(0.985 0 0))",
        padding: "8px 12px",
        textAlign: "left",
        font: "13px ui-sans-serif, system-ui, -apple-system, sans-serif",
      }}
    >
      {value ? "LLM Wiki Operations" : (placeholder ?? "Project")}
    </button>
  );
}

// Captured at module load so we can flip it before render and trigger
// re-renders via popstate when the hash/search changes.
function readHostLocation() {
  if (typeof window === "undefined") {
    return { pathname: "/PAP/wiki", search: "", hash: "" };
  }
  return { pathname: window.location.pathname, search: window.location.search, hash: window.location.hash };
}

const hostLocationListeners = new Set<() => void>();

function useHostLocationMock() {
  const [snapshot, setSnapshot] = useState(readHostLocation);
  useEffect(() => {
    const update = () => setSnapshot(readHostLocation());
    window.addEventListener("popstate", update);
    window.addEventListener("hashchange", update);
    hostLocationListeners.add(update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener("hashchange", update);
      hostLocationListeners.delete(update);
    };
  }, []);
  return snapshot;
}

const sdkUi: Record<string, unknown> = {
  usePluginData: dataResolver,
  usePluginAction: () => async () => ({ status: "ok" }),
  usePluginStream: () => ({ events: [], lastEvent: null, connecting: false, connected: false, error: null, close: () => undefined }),
  usePluginToast: () => () => null,
  useHostContext: () => HOST_CONTEXT,
  useHostNavigation: () => ({
    resolveHref: (to: string) => `/PAP${to.startsWith("/") ? to : `/${to}`}`,
    navigate: (to: string) => {
      const href = `/PAP${to.startsWith("/") ? to : `/${to}`}`;
      window.history.pushState({}, "", href);
      hostLocationListeners.forEach((fn) => fn());
    },
    linkProps: (to: string) => ({
      href: `/PAP${to.startsWith("/") ? to : `/${to}`}`,
      onClick: (event: { preventDefault: () => void }) => {
        event.preventDefault();
        const href = `/PAP${to.startsWith("/") ? to : `/${to}`}`;
        window.history.pushState({}, "", href);
        hostLocationListeners.forEach((fn) => fn());
      },
    }),
  }),
  useHostLocation: useHostLocationMock,
  MarkdownBlock: MockMarkdownBlock,
  MarkdownEditor: MockMarkdownEditor,
  FileTree: MockFileTree,
  IssuesList: MockIssuesList,
  AssigneePicker: MockAssigneePicker,
  ProjectPicker: MockProjectPicker,
  ManagedRoutinesList: MockManagedRoutinesList,
};

(globalThis as { __paperclipPluginBridge__?: { sdkUi?: Record<string, unknown> } }).__paperclipPluginBridge__ = { sdkUi };

// ---------------------------------------------------------------------------
// Harness app: chooses which view to render based on a global hash. Playwright
// flips the hash to switch views and path segments to drive Wiki sections.
// ---------------------------------------------------------------------------

type ViewKey = "wiki" | "wiki-sidebar" | "settings" | "sidebar";

function useView() {
  const [view, setView] = useState<ViewKey>(() => readView());
  useEffect(() => {
    const handler = () => setView(readView());
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);
  return view;
}

function readView(): ViewKey {
  if (typeof window === "undefined") return "wiki";
  const hash = window.location.hash.replace(/^#/, "");
  if (hash === "settings" || hash === "sidebar" || hash === "wiki-sidebar") return hash;
  return "wiki";
}

export function App() {
  const view = useView();
  return (
    <div style={{ height: "100vh", width: "100vw", overflow: "hidden", background: "var(--background, oklch(0.145 0 0))", color: "var(--foreground, oklch(0.985 0 0))" }}>
      {view === "wiki-sidebar" ? (
        <div style={{ display: "flex", height: "100vh" }}>
          <WikiRouteSidebar context={HOST_CONTEXT as never} />
          <div style={{ flex: 1 }}>
            <WikiPage context={HOST_CONTEXT as never} />
          </div>
        </div>
      ) : view === "sidebar" ? (
        <aside style={{ width: 240, background: "var(--sidebar, oklch(0.145 0 0))", padding: 12, height: "100vh", borderRight: "1px solid var(--border, oklch(0.269 0 0))" }}>
          <SidebarLink context={HOST_CONTEXT as never} />
        </aside>
      ) : view === "settings" ? (
        <SettingsPage context={HOST_CONTEXT as never} />
      ) : (
        <WikiPage context={HOST_CONTEXT as never} />
      )}
    </div>
  );
}
