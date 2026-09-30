import type {
  Agent,
  Issue,
  IssueAccessGrant,
  Project,
  ProjectAccessMember,
} from "@paperclipai/shared";
import type { CurrentBoardAccess } from "@/api/access";
import {
  storybookAgents,
  storybookAuthSession,
  storybookCompanies,
  storybookIssues,
  storybookProjects,
  storybookSidebarBadges,
  storybookDashboardSummary,
} from "./paperclipData";

export const privacyCompanyId = "company-storybook";
export const privacyOwnerId = "user-board";
export const privacyReaderId = "user-product";
const createdAt = new Date("2026-09-30T09:00:00Z");

export type PrivacyScenario = {
  role?: "owner" | "reader" | "admin";
  visibility?: "open" | "private";
  grants?: "all" | "empty" | "assignment" | "inherited" | "long";
  failure?:
    | "grants"
    | "directory"
    | "add"
    | "revoke"
    | "visibility"
    | "members"
    | "create"
    | "project-add"
    | "project-remove";
  loading?: "grants" | "members" | "mention";
  retryOnce?: boolean;
  childOnly?: boolean;
  personal?: boolean;
  draft?: boolean;
  classic?: boolean;
};

export const privacyUsers = [
  {
    id: privacyOwnerId,
    name: "Avery Chen",
    email: "avery@example.test",
    image: null,
  },
  {
    id: privacyReaderId,
    name: "Morgan Reed",
    email: "morgan@example.test",
    image: null,
  },
  {
    id: "user-finance",
    name: "Sam Rivera",
    email: "sam@example.test",
    image: null,
  },
  {
    id: "user-admin",
    name: "Jordan Ellis",
    email: "jordan@example.test",
    image: null,
  },
];

export const privacyAgents: Agent[] = [
  {
    ...storybookAgents[0]!,
    id: "agent-dedicated",
    name: "Executive assistant",
    urlKey: "executive-assistant",
    status: "idle",
    permissions: {
      canCreateAgents: false,
      authorizationPolicy: { agentVisibility: { mode: "private" } },
    },
  },
  {
    ...storybookAgents[1]!,
    id: "agent-shared",
    name: "Research team agent",
    urlKey: "research-team-agent",
    status: "idle",
    permissions: {
      canCreateAgents: false,
      authorizationPolicy: { agentVisibility: { mode: "discoverable" } },
    },
  },
  {
    ...storybookAgents[0]!,
    id: "agent-unspecified",
    name: "Legacy shared agent",
    urlKey: "legacy-shared-agent",
    status: "idle",
    permissions: { canCreateAgents: false },
  },
];

export function privacyProject(overrides: Partial<Project> = {}): Project {
  return {
    ...storybookProjects[0]!,
    id: "project-private",
    name: "Executive planning",
    urlKey: "executive-planning",
    description: "Plans shared with the executive team.",
    visibility: "private",
    privacyOwnerUserId: privacyOwnerId,
    personalOwnerUserId: null,
    workspaces: [],
    primaryWorkspace: null,
    ...overrides,
  };
}

export function privacyTask(overrides: Partial<Issue> = {}): Issue {
  return {
    ...storybookIssues[0]!,
    id: "privacy-root",
    identifier: "PAP-410",
    title: "Prepare my board briefing",
    description:
      "Draft a briefing from my personal inbox. Share only the research subtask with Morgan.",
    visibility: "private",
    privacyRootIssueId: "privacy-root",
    privacyParentIssueId: null,
    companyId: privacyCompanyId,
    responsibleUserId: privacyOwnerId,
    createdByUserId: privacyOwnerId,
    createdByAgentId: null,
    assigneeAgentId: "agent-dedicated",
    assigneeUserId: null,
    parentId: null,
    projectId: null,
    project: null,
    status: "todo",
    checkoutRunId: null,
    executionRunId: null,
    executionWorkspaceId: null,
    currentExecutionWorkspace: null,
    projectWorkspaceId: null,
    startedAt: null,
    executionLockedAt: null,
    executionAgentNameKey: null,
    executionWorkspaceSettings: null,
    executionState: null,
    executionPolicy: null,
    blockedBy: [],
    blocks: [],
    ancestors: [],
    labels: [],
    labelIds: [],
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

export function privacyGrant(
  overrides: Partial<IssueAccessGrant> = {},
): IssueAccessGrant {
  return {
    id: "grant-morgan",
    issueId: "privacy-root",
    subjectType: "user",
    subjectId: privacyReaderId,
    source: "explicit",
    inherited: false,
    grantedByUserId: privacyOwnerId,
    grantedByAgentId: null,
    createdAt,
    revokedAt: null,
    subjectDisplayName: "Morgan Reed",
    subjectAvatarUrl: null,
    subjectInitials: "MR",
    agentVisibility: null,
    ...overrides,
  };
}

export function createPrivacyState(options: PrivacyScenario = {}) {
  const role = options.role ?? "owner";
  const user = privacyUsers.find(
    (item) =>
      item.id ===
      (role === "reader"
        ? privacyReaderId
        : role === "admin"
          ? "user-admin"
          : privacyOwnerId),
  )!;
  const project = privacyProject(
    options.personal
      ? { name: "My private tasks", personalOwnerUserId: privacyOwnerId }
      : {},
  );
  const projects = [
    project,
    privacyProject({
      id: "project-open",
      name: "Company operations",
      urlKey: "company-operations",
      visibility: "open",
    }),
  ];
  const tasks = [
    privacyTask({ visibility: options.visibility ?? "private" }),
    privacyTask({
      id: "privacy-child",
      identifier: "PAP-411",
      title: "Research market benchmarks",
      description:
        "Research publicly available market benchmarks and summarize the sources.",
      parentId: "privacy-root",
      privacyParentIssueId: "privacy-root",
    }),
    privacyTask({
      id: "privacy-grandchild",
      identifier: "PAP-412",
      title: "Summarize public market reports",
      parentId: "privacy-child",
      privacyParentIssueId: "privacy-child",
    }),
    privacyTask({
      id: "privacy-sibling",
      identifier: "PAP-413",
      title: "Review compensation notes",
      parentId: "privacy-root",
      privacyParentIssueId: "privacy-root",
    }),
  ];
  if (options.childOnly)
    tasks[1]!.ancestors = [
      { id: "privacy-root", identifier: "PAP-410", locked: true },
    ] as unknown as Issue["ancestors"]; // Redacted wire shape; never invent a private title for the legacy ancestor type.
  let grants = [
    privacyGrant({
      id: "grant-owner",
      subjectId: privacyOwnerId,
      subjectDisplayName: "Avery Chen",
      subjectInitials: "AC",
      source: "owner",
    }),
    privacyGrant(),
    privacyGrant({
      id: "grant-assignment",
      subjectType: "agent",
      subjectId: "agent-dedicated",
      subjectDisplayName: "Executive assistant",
      subjectInitials: "EA",
      source: "assignment",
      agentVisibility: "private",
    }),
    privacyGrant({
      id: "grant-project",
      subjectId: "user-finance",
      subjectDisplayName: "Sam Rivera",
      subjectInitials: "SR",
      source: "project",
      inherited: true,
    }),
  ];
  if (options.grants === "empty") grants = [];
  if (options.grants === "assignment")
    grants = grants.filter((item) => item.source === "assignment");
  if (options.grants === "inherited")
    grants = grants
      .filter((item) => item.source !== "owner")
      .map((item) => ({ ...item, inherited: true, issueId: "privacy-root" }));
  if (options.grants === "long")
    grants = [
      privacyGrant({
        subjectDisplayName:
          "Morgan Reed — International market strategy and research",
        subjectInitials: "MR",
      }),
    ];
  const members: ProjectAccessMember[] = privacyUsers
    .slice(0, 2)
    .map((item) => ({
      id: "member-" + item.id,
      projectId: project.id,
      companyId: privacyCompanyId,
      subjectType: "user",
      subjectId: item.id,
      subjectDisplayName: item.name,
      subjectAvatarUrl: null,
      createdAt,
    }));
  const access: CurrentBoardAccess = {
    user,
    userId: user.id,
    isInstanceAdmin: false,
    companyIds: [privacyCompanyId],
    memberships: [
      {
        companyId: privacyCompanyId,
        membershipRole: role === "admin" ? "admin" : "member",
        status: "active",
      },
    ],
    source: "session",
    keyId: null,
  };
  return {
    options,
    user,
    access,
    session: {
      ...storybookAuthSession,
      user,
      session: { ...storybookAuthSession.session!, userId: user.id },
    },
    projects,
    tasks,
    grants,
    members,
    operations: [] as string[],
  };
}
export type PrivacyState = ReturnType<typeof createPrivacyState>;

/** Deterministic UX fixtures, not a second authorization implementation. All writes stay in this story. */
export function installPrivacyApi(state: PrivacyState) {
  const previous = window.fetch;
  const failed = new Set<string>();
  const oldDraft = localStorage.getItem("paperclip:issue-draft");
  localStorage.removeItem("paperclip:issue-draft");
  if (state.options.draft)
    localStorage.setItem(
      "paperclip:issue-draft",
      JSON.stringify({
        title: "Continue my private briefing",
        description: "Saved personal draft.",
        isPrivate: true,
        status: "todo",
        priority: "medium",
        companyId: privacyCompanyId,
      }),
    );
  const fail = (key: PrivacyScenario["failure"]) => {
    if (
      state.options.failure !== key ||
      (state.options.retryOnce && failed.has(key!))
    )
      return null;
    failed.add(key!);
    return Response.json(
      { error: "The request could not be completed. Try again." },
      { status: 503 },
    );
  };
  const pause = (signal?: AbortSignal | null) =>
    new Promise<Response>((_resolve, reject) => {
      if (signal?.aborted) reject(new DOMException("Aborted", "AbortError"));
      signal?.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    });
  window.fetch = async (input, init) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
      location.origin,
    );
    const path = url.pathname;
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const data = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const json = (value: unknown) => Response.json(value);
    if (!path.startsWith("/api/")) return previous(input, init);
    if (path === "/api/auth/get-session") return json(state.session);
    if (path === "/api/cli-auth/me") return json(state.access);
    if (path === "/api/companies") return json(storybookCompanies);
    if (path === "/api/health")
      return json({
        status: "ok",
        deploymentMode: "authenticated",
        authReady: true,
        bootstrapStatus: "ready",
      });
    if (path.endsWith("/user-directory") || path.endsWith("/members"))
      return (
        fail("directory") ??
        json({
          users: privacyUsers.map((user) => ({
            principalId: user.id,
            status: "active",
            user,
          })),
          agents: [],
        })
      );
    if (path.endsWith("/resource-memberships/me"))
      return json({
        projectMemberships: {},
        agentMemberships: {},
        starredProjectIds: [],
        starredAgentIds: [],
        starredDocumentIds: [],
        projectStarredAt: {},
        agentStarredAt: {},
        documentStarredAt: {},
        updatedAt: null,
      });
    if (path === "/api/companies/" + privacyCompanyId + "/agents")
      return json(privacyAgents);
    if (path === "/api/companies/" + privacyCompanyId + "/projects")
      return json(state.projects);
    if (path === "/api/companies/" + privacyCompanyId + "/issues") {
      if (method === "POST") {
        const error = fail("create");
        if (error) return error;
        const issue = privacyTask({
          ...data,
          id: "privacy-created",
          identifier: "PAP-414",
          responsibleUserId: privacyOwnerId,
        });
        state.tasks.push(issue);
        state.operations.push(
          "Created " + issue.identifier + " · " + issue.visibility,
        );
        return json(issue);
      }
      let rows = state.options.childOnly
        ? state.tasks.filter((item) =>
            ["privacy-child", "privacy-grandchild"].includes(item.id),
          )
        : state.tasks;
      const parent =
        url.searchParams.get("parentId") ??
        url.searchParams.get("descendantOf");
      if (parent) rows = rows.filter((item) => item.parentId === parent);
      const query = url.searchParams.get("q")?.toLowerCase();
      return json(
        query
          ? rows.filter((item) =>
              (item.title + item.identifier).toLowerCase().includes(query),
            )
          : rows,
      );
    }
    const issueMatch = path.match(/^\/api\/issues\/([^/]+)(?:\/(.*))?$/);
    if (issueMatch) {
      const item = state.tasks.find(
        (row) => row.id === issueMatch[1] || row.identifier === issueMatch[1],
      );
      const resource = issueMatch[2];
      if (issueMatch[1] === "PAP-499")
        return state.options.loading === "mention"
          ? pause(init?.signal)
          : json(
              privacyTask({
                identifier: "PAP-499",
                title: "Readable task",
                status: "in_progress",
              }),
            );
      if (
        !item ||
        (state.options.childOnly &&
          ["privacy-root", "privacy-sibling"].includes(item.id))
      )
        return jsonError404();
      if (!resource) {
        if (method === "PATCH") {
          const error = fail("visibility");
          if (error) return error;
          Object.assign(item, data);
          state.operations.push("Task audience: " + item.visibility);
        }
        return json(item);
      }
      if (resource === "access-grants") {
        if (method === "GET")
          return state.options.loading === "grants"
            ? pause(init?.signal)
            : (fail("grants") ?? json(state.grants));
        const error = fail("add");
        if (error) return error;
        const subject = [...privacyUsers, ...privacyAgents].find(
          (row) => row.id === data.subjectId,
        );
        const grant = privacyGrant({
          ...data,
          id: "grant-added-" + data.subjectId,
          issueId: item.id,
          subjectDisplayName: subject?.name ?? "Unknown",
        });
        state.grants.push(grant);
        state.operations.push(
          "Shared " + item.identifier + " with " + subject?.name,
        );
        return json(grant);
      }
      if (resource.match(/^access-grants\/.+\/revoke$/)) {
        const error = fail("revoke");
        if (error) return error;
        const grant = state.grants.find(
          (row) => row.id === resource.split("/")[1],
        );
        if (grant) grant.revokedAt = new Date();
        state.operations.push("Removed a saved task grant");
        return json(grant);
      }
      if (
        ["active-run", "runner-goal", "execution-workspace"].includes(resource)
      )
        return json(null);
      if (resource === "queued-comments")
        return json({ queues: [], items: [], revision: "privacy-story" });
      if (resource === "cost-summary")
        return json({
          costCents: 0,
          inputTokens: 0,
          outputTokens: 0,
          runCount: 0,
        });
      if (resource.startsWith("documents/")) return jsonError404();
      if (resource === "comments")
        return json([
          {
            id: "privacy-comment",
            issueId: item.id,
            companyId: privacyCompanyId,
            authorUserId: privacyOwnerId,
            authorAgentId: null,
            body: "Use the research in [PAP-411](/PAP/issues/PAP-411). Keep the briefing and compensation notes private.",
            createdAt,
            updatedAt: createdAt,
          },
        ]);
      return json([]);
    }
    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(?:\/(.*))?$/);
    if (projectMatch) {
      const project = state.projects.find(
        (row) => row.id === projectMatch[1] || row.urlKey === projectMatch[1],
      );
      if (!project) return jsonError404();
      if (!projectMatch[2]) {
        if (method === "PATCH") Object.assign(project, data);
        return json(project);
      }
      if (projectMatch[2] === "access-members") {
        if (method === "GET")
          return state.options.loading === "members"
            ? pause(init?.signal)
            : (fail("members") ?? json(state.members));
        const error = fail("project-add");
        if (error) return error;
        const subject = [...privacyUsers, ...privacyAgents].find(
          (row) => row.id === data.subjectId,
        );
        const member: ProjectAccessMember = {
          id: "member-added-" + data.subjectId,
          companyId: privacyCompanyId,
          projectId: project.id,
          createdAt,
          subjectAvatarUrl: null,
          subjectDisplayName: subject?.name ?? "Unknown",
          ...data,
        };
        state.members.push(member);
        return json(member);
      }
      if (projectMatch[2].startsWith("access-members/")) {
        const error = fail("project-remove");
        if (error) return error;
        const id = projectMatch[2].split("/")[1];
        state.members = state.members.filter((row) => row.id !== id);
        return json({ id });
      }
      return json([]);
    }
    if (path.startsWith("/api/agents/"))
      return json(
        path.split("/").length > 4
          ? []
          : (privacyAgents.find((agent) => path.split("/")[3] === agent.id) ??
              privacyAgents[0]),
      );
    if (path === "/api/instance/settings/experimental")
      return json({
        enableClassicTaskInterface: state.options.classic === true,
        enableIsolatedWorkspaces: false,
        enableManagedSandboxOnly: false,
      });
    if (path.includes("/adapters") || path === "/api/adapters")
      return previous(input, init);
    if (path.endsWith("/dashboard")) return json(storybookDashboardSummary);
    if (path.endsWith("/sidebar-badges")) return json(storybookSidebarBadges);
    if (path.endsWith("/budgets/overview"))
      return json({
        companyId: privacyCompanyId,
        policies: [],
        activeIncidents: [],
        pausedAgentCount: 0,
        pausedProjectCount: 0,
        pendingApprovalCount: 0,
      });
    if (path.endsWith("/budget-summary")) return json({});
    if (path.includes("/settings")) return json({});
    // These stories never contact a real company, connector, or backend.
    return json([]);
  };
  return () => {
    window.fetch = previous;
    if (oldDraft === null) localStorage.removeItem("paperclip:issue-draft");
    else localStorage.setItem("paperclip:issue-draft", oldDraft);
  };
}

function jsonError404() {
  return Response.json({ error: "Not found" }, { status: 404 });
}
