/**
 * LET-505 — canned API fixtures for the EAOS screenshot runner.
 *
 * These fixtures are used ONLY by `scripts/evidence/eaos-screenshots.ts`
 * when run with `--mock-api`. They are NOT shipped to customers, NOT
 * loaded by the product code, and are NOT a substitute for real backend
 * data — they exist purely so the screenshot evidence package can render
 * the actual EAOS React shell + page chrome without needing a session
 * cookie or a second authenticated backend instance.
 *
 * Truthfulness contract:
 *   - `/api/health` is forced to `local_trusted` so the CloudAccessGate
 *     does not redirect to the sign-in wall. The product never serves
 *     this response by accident; the dev server's `/api/*` proxy is what
 *     would normally answer, and we replace it via Playwright route().
 *   - The single demo company exists so company-context auto-selection
 *     can resolve. Its name is intentionally generic so reviewers cannot
 *     mistake it for real customer data.
 *   - When the runner is in `empty` mode every list endpoint returns
 *     `[]` so the rendered surfaces show the authentic "no data yet"
 *     empty state — no fake agents, no fake missions, no decorative
 *     metrics. Reviewers can score: shell density, empty-state design,
 *     and light-theme contrast against the LET-502 contract.
 *   - When the runner is in `populated` mode the fixtures return a
 *     small, backend-shaped sample (six agents, ten issues, three
 *     projects, an org graph, a runs activity feed, etc.) so the
 *     reviewer can score populated density, table chrome, board /
 *     graph rendering, and scrolling without spinning up a real backend
 *     instance with real customer data.
 *
 * No secrets. No production identifiers. Safe to commit verbatim.
 */

export const SCREENSHOT_COMPANY_ID = "00000000-0000-0000-0000-000000000eaa";
const SCREENSHOT_USER_ID = "00000000-0000-0000-0000-0000000000a1";
const NOW = "2026-05-20T12:00:00.000Z";

export type ScreenshotFixtureMode = "empty" | "populated";

export type ScreenshotViewerRole = "operator-admin" | "customer-member";

export const SCREENSHOT_HEALTH = {
  status: "ok",
  deploymentMode: "local_trusted",
  bootstrapStatus: "ready",
  bootstrapInviteActive: false,
  devServer: { enabled: false },
};

export const SCREENSHOT_COMPANY = {
  id: SCREENSHOT_COMPANY_ID,
  name: "Acme AI Labs",
  description: "Screenshot evidence demo company. Not real customer data.",
  status: "active",
  issuePrefix: "ACME",
  brandColor: "#1f2937",
  logoAssetId: null,
  budgetMonthlyCents: 0,
  attachmentMaxBytes: 0,
  requireBoardApprovalForNewAgents: false,
  feedbackDataSharingEnabled: false,
  createdAt: NOW,
  updatedAt: NOW,
};

export const SCREENSHOT_SESSION = {
  user: {
    id: SCREENSHOT_USER_ID,
    email: "design-reviewer@example.invalid",
    name: "Design Reviewer",
    image: null,
  },
};

function boardAccessFor(role: ScreenshotViewerRole) {
  const isInstanceAdmin = role === "operator-admin";
  const membershipRole = role === "operator-admin" ? "owner" : "member";
  return {
    user: SCREENSHOT_SESSION.user,
    userId: SCREENSHOT_USER_ID,
    isInstanceAdmin,
    companyIds: [SCREENSHOT_COMPANY_ID],
    memberships: [
      {
        companyId: SCREENSHOT_COMPANY_ID,
        membershipRole,
        status: "active",
      },
    ],
    source: "screenshot-fixture",
    keyId: null,
  };
}

export const SCREENSHOT_INSTANCE_GENERAL = {
  keyboardShortcuts: true,
  copilotEnabled: false,
};

// ---- Populated sample data (backend-shaped) ----
// All identifiers and names are obviously generic; nothing here mirrors a
// real customer payload. Agents/Issues/Projects/Activity/Approvals are
// shaped to match `@paperclipai/shared` types as consumed by the EAOS UI.

const AGENT_IDS = {
  ceo: "00000000-0000-0000-0000-000000000a01",
  pm: "00000000-0000-0000-0000-000000000a02",
  engineer: "00000000-0000-0000-0000-000000000a03",
  designer: "00000000-0000-0000-0000-000000000a04",
  qa: "00000000-0000-0000-0000-000000000a05",
  researcher: "00000000-0000-0000-0000-000000000a06",
} as const;

const PROJECT_IDS = {
  growth: "00000000-0000-0000-0000-000000000p01",
  platform: "00000000-0000-0000-0000-000000000p02",
  research: "00000000-0000-0000-0000-000000000p03",
} as const;

const ISSUE_IDS = {
  i01: "00000000-0000-0000-0000-000000000i01",
  i02: "00000000-0000-0000-0000-000000000i02",
  i03: "00000000-0000-0000-0000-000000000i03",
  i04: "00000000-0000-0000-0000-000000000i04",
  i05: "00000000-0000-0000-0000-000000000i05",
  i06: "00000000-0000-0000-0000-000000000i06",
  i07: "00000000-0000-0000-0000-000000000i07",
  i08: "00000000-0000-0000-0000-000000000i08",
  i09: "00000000-0000-0000-0000-000000000i09",
  i10: "00000000-0000-0000-0000-000000000i10",
} as const;

function ago(minutes: number): string {
  return new Date(new Date(NOW).getTime() - minutes * 60_000).toISOString();
}

function buildAgent(input: {
  id: string;
  name: string;
  urlKey: string;
  role: string;
  title: string;
  status: string;
  reportsTo: string | null;
  adapterType?: string;
  lastHeartbeatMinAgo: number;
  spentMonthlyCents?: number;
  budgetMonthlyCents?: number;
  pauseReason?: string | null;
  pausedAtMinAgo?: number | null;
}) {
  return {
    id: input.id,
    companyId: SCREENSHOT_COMPANY_ID,
    name: input.name,
    urlKey: input.urlKey,
    role: input.role,
    title: input.title,
    icon: null,
    status: input.status,
    reportsTo: input.reportsTo,
    capabilities: null,
    adapterType: input.adapterType ?? "claude_local",
    adapterConfig: { model: "claude-opus-4-7" },
    runtimeConfig: { heartbeatEnabled: true, intervalSec: 300 },
    defaultEnvironmentId: null,
    budgetMonthlyCents: input.budgetMonthlyCents ?? 5000,
    spentMonthlyCents: input.spentMonthlyCents ?? 0,
    pauseReason: input.pauseReason ?? null,
    pausedAt: input.pausedAtMinAgo != null ? ago(input.pausedAtMinAgo) : null,
    permissions: {},
    lastHeartbeatAt: ago(input.lastHeartbeatMinAgo),
    metadata: null,
    createdAt: ago(60 * 24 * 30),
    updatedAt: ago(input.lastHeartbeatMinAgo),
  };
}

const POPULATED_AGENTS = [
  buildAgent({
    id: AGENT_IDS.ceo,
    name: "Avery Chen",
    urlKey: "avery-chen",
    role: "ceo",
    title: "Chief Executive",
    status: "active",
    reportsTo: null,
    lastHeartbeatMinAgo: 7,
    spentMonthlyCents: 1240,
  }),
  buildAgent({
    id: AGENT_IDS.pm,
    name: "Priya Patel",
    urlKey: "priya-patel",
    role: "pm",
    title: "Lead Product Manager",
    status: "running",
    reportsTo: AGENT_IDS.ceo,
    lastHeartbeatMinAgo: 2,
    spentMonthlyCents: 870,
  }),
  buildAgent({
    id: AGENT_IDS.engineer,
    name: "Marcus Hall",
    urlKey: "marcus-hall",
    role: "engineer",
    title: "Staff Engineer",
    status: "running",
    reportsTo: AGENT_IDS.pm,
    lastHeartbeatMinAgo: 1,
    spentMonthlyCents: 3120,
    budgetMonthlyCents: 8000,
  }),
  buildAgent({
    id: AGENT_IDS.designer,
    name: "Lina Okafor",
    urlKey: "lina-okafor",
    role: "designer",
    title: "Senior Designer",
    status: "idle",
    reportsTo: AGENT_IDS.pm,
    lastHeartbeatMinAgo: 18,
    spentMonthlyCents: 420,
  }),
  buildAgent({
    id: AGENT_IDS.qa,
    name: "Sam Rivera",
    urlKey: "sam-rivera",
    role: "qa",
    title: "QA Engineer",
    status: "paused",
    reportsTo: AGENT_IDS.engineer,
    lastHeartbeatMinAgo: 60 * 6,
    pauseReason: "manual_pause",
    pausedAtMinAgo: 60 * 6,
    spentMonthlyCents: 90,
  }),
  buildAgent({
    id: AGENT_IDS.researcher,
    name: "Noor Hassan",
    urlKey: "noor-hassan",
    role: "researcher",
    title: "Research Analyst",
    status: "active",
    reportsTo: AGENT_IDS.ceo,
    lastHeartbeatMinAgo: 35,
    spentMonthlyCents: 540,
  }),
];

const POPULATED_ORG_TREE = [
  {
    id: AGENT_IDS.ceo,
    name: "Avery Chen",
    role: "ceo",
    status: "active",
    reports: [
      {
        id: AGENT_IDS.pm,
        name: "Priya Patel",
        role: "pm",
        status: "running",
        reports: [
          {
            id: AGENT_IDS.engineer,
            name: "Marcus Hall",
            role: "engineer",
            status: "running",
            reports: [
              {
                id: AGENT_IDS.qa,
                name: "Sam Rivera",
                role: "qa",
                status: "paused",
                reports: [],
              },
            ],
          },
          {
            id: AGENT_IDS.designer,
            name: "Lina Okafor",
            role: "designer",
            status: "idle",
            reports: [],
          },
        ],
      },
      {
        id: AGENT_IDS.researcher,
        name: "Noor Hassan",
        role: "researcher",
        status: "active",
        reports: [],
      },
    ],
  },
];

const PROJECT_LOOKUP: Record<string, { urlKey: string; name: string }> = {
  [PROJECT_IDS.growth]: { urlKey: "growth-q3", name: "Growth Q3" },
  [PROJECT_IDS.platform]: { urlKey: "platform-hardening", name: "Platform Hardening" },
  [PROJECT_IDS.research]: { urlKey: "research-q2", name: "Customer Research Q2" },
};

function buildIssue(input: {
  id: string;
  identifier: string;
  number: number;
  title: string;
  status: string;
  priority: string;
  projectId: string | null;
  assigneeAgentId: string | null;
  lastActivityMinAgo: number;
  createdMinAgo: number;
  workMode?: string;
  completedMinAgo?: number | null;
}) {
  const projectMeta = input.projectId ? PROJECT_LOOKUP[input.projectId] ?? null : null;
  return {
    id: input.id,
    companyId: SCREENSHOT_COMPANY_ID,
    projectId: input.projectId,
    project: projectMeta
      ? {
          id: input.projectId!,
          companyId: SCREENSHOT_COMPANY_ID,
          urlKey: projectMeta.urlKey,
          name: projectMeta.name,
          status: "active",
          color: null,
          goalId: null,
          goalIds: [],
          goals: [],
          description: null,
          leadAgentId: null,
          targetDate: null,
          env: null,
          pauseReason: null,
          pausedAt: null,
          executionWorkspacePolicy: null,
          codebase: { kind: "none" },
          workspaces: [],
          primaryWorkspace: null,
          archivedAt: null,
          createdAt: ago(60 * 24 * 30),
          updatedAt: ago(60 * 12),
        }
      : null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: input.title,
    description: null,
    status: input.status,
    workMode: input.workMode ?? "standard",
    priority: input.priority,
    assigneeAgentId: input.assigneeAgentId,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: AGENT_IDS.pm,
    createdByUserId: null,
    issueNumber: input.number,
    identifier: input.identifier,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: ago(input.createdMinAgo),
    completedAt: input.completedMinAgo != null ? ago(input.completedMinAgo) : null,
    cancelledAt: null,
    hiddenAt: null,
    labelIds: [],
    labels: [],
    blockedBy: [],
    blocks: [],
    referencedIssueIdentifiers: [],
    lastActivityAt: ago(input.lastActivityMinAgo),
    createdAt: ago(input.createdMinAgo),
    updatedAt: ago(input.lastActivityMinAgo),
  };
}

const POPULATED_ISSUES = [
  buildIssue({
    id: ISSUE_IDS.i01,
    identifier: "ACME-104",
    number: 104,
    title: "Ship Q3 growth dashboard",
    status: "in_progress",
    priority: "high",
    projectId: PROJECT_IDS.growth,
    assigneeAgentId: AGENT_IDS.engineer,
    createdMinAgo: 60 * 24 * 4,
    lastActivityMinAgo: 12,
  }),
  buildIssue({
    id: ISSUE_IDS.i02,
    identifier: "ACME-103",
    number: 103,
    title: "Redesign onboarding empty state",
    status: "in_review",
    priority: "medium",
    projectId: PROJECT_IDS.growth,
    assigneeAgentId: AGENT_IDS.designer,
    createdMinAgo: 60 * 24 * 6,
    lastActivityMinAgo: 45,
  }),
  buildIssue({
    id: ISSUE_IDS.i03,
    identifier: "ACME-102",
    number: 102,
    title: "Migrate billing service to v2 API",
    status: "blocked",
    priority: "critical",
    projectId: PROJECT_IDS.platform,
    assigneeAgentId: AGENT_IDS.engineer,
    createdMinAgo: 60 * 24 * 9,
    lastActivityMinAgo: 60 * 2,
  }),
  buildIssue({
    id: ISSUE_IDS.i04,
    identifier: "ACME-101",
    number: 101,
    title: "Audit access policies for the data warehouse",
    status: "todo",
    priority: "medium",
    projectId: PROJECT_IDS.platform,
    assigneeAgentId: null,
    createdMinAgo: 60 * 24 * 2,
    lastActivityMinAgo: 60 * 24,
  }),
  buildIssue({
    id: ISSUE_IDS.i05,
    identifier: "ACME-100",
    number: 100,
    title: "Customer churn analysis Q2",
    status: "in_progress",
    priority: "high",
    projectId: PROJECT_IDS.research,
    assigneeAgentId: AGENT_IDS.researcher,
    createdMinAgo: 60 * 24 * 3,
    lastActivityMinAgo: 35,
  }),
  buildIssue({
    id: ISSUE_IDS.i06,
    identifier: "ACME-099",
    number: 99,
    title: "Add SSO group sync to admin",
    status: "in_review",
    priority: "high",
    projectId: PROJECT_IDS.platform,
    assigneeAgentId: AGENT_IDS.engineer,
    createdMinAgo: 60 * 24 * 5,
    lastActivityMinAgo: 90,
  }),
  buildIssue({
    id: ISSUE_IDS.i07,
    identifier: "ACME-098",
    number: 98,
    title: "Quarterly compliance review",
    status: "backlog",
    priority: "low",
    projectId: null,
    assigneeAgentId: null,
    createdMinAgo: 60 * 24 * 8,
    lastActivityMinAgo: 60 * 24 * 7,
  }),
  buildIssue({
    id: ISSUE_IDS.i08,
    identifier: "ACME-097",
    number: 97,
    title: "Investigate slow dashboard load on mobile",
    status: "in_progress",
    priority: "high",
    projectId: PROJECT_IDS.growth,
    assigneeAgentId: AGENT_IDS.qa,
    createdMinAgo: 60 * 24,
    lastActivityMinAgo: 5,
  }),
  buildIssue({
    id: ISSUE_IDS.i09,
    identifier: "ACME-096",
    number: 96,
    title: "Update brand color tokens",
    status: "done",
    priority: "low",
    projectId: PROJECT_IDS.growth,
    assigneeAgentId: AGENT_IDS.designer,
    createdMinAgo: 60 * 24 * 12,
    lastActivityMinAgo: 60 * 24,
    completedMinAgo: 60 * 24,
  }),
  buildIssue({
    id: ISSUE_IDS.i10,
    identifier: "ACME-095",
    number: 95,
    title: "Document new agent permissions model",
    status: "done",
    priority: "medium",
    projectId: PROJECT_IDS.platform,
    assigneeAgentId: AGENT_IDS.pm,
    createdMinAgo: 60 * 24 * 14,
    lastActivityMinAgo: 60 * 24 * 2,
    completedMinAgo: 60 * 24 * 2,
  }),
];

function buildProject(input: {
  id: string;
  urlKey: string;
  name: string;
  description: string;
  status: string;
  leadAgentId: string;
  targetDate: string | null;
}) {
  return {
    id: input.id,
    companyId: SCREENSHOT_COMPANY_ID,
    urlKey: input.urlKey,
    goalId: null,
    goalIds: [],
    goals: [],
    name: input.name,
    description: input.description,
    status: input.status,
    leadAgentId: input.leadAgentId,
    targetDate: input.targetDate,
    color: null,
    env: null,
    pauseReason: null,
    pausedAt: null,
    executionWorkspacePolicy: null,
    codebase: { kind: "none" },
    workspaces: [],
    primaryWorkspace: null,
    archivedAt: null,
    createdAt: ago(60 * 24 * 30),
    updatedAt: ago(60 * 12),
  };
}

const POPULATED_PROJECTS = [
  buildProject({
    id: PROJECT_IDS.growth,
    urlKey: "growth-q3",
    name: "Growth Q3",
    description: "Acquisition, activation, and dashboards for the third quarter.",
    status: "active",
    leadAgentId: AGENT_IDS.pm,
    targetDate: "2026-09-30",
  }),
  buildProject({
    id: PROJECT_IDS.platform,
    urlKey: "platform-hardening",
    name: "Platform Hardening",
    description: "Reliability, access policies, and service migrations.",
    status: "active",
    leadAgentId: AGENT_IDS.engineer,
    targetDate: "2026-07-15",
  }),
  buildProject({
    id: PROJECT_IDS.research,
    urlKey: "research-q2",
    name: "Customer Research Q2",
    description: "Interviews, retention analysis, and customer artifacts.",
    status: "active",
    leadAgentId: AGENT_IDS.researcher,
    targetDate: "2026-06-15",
  }),
];

function buildActivity(input: {
  id: string;
  runId: string;
  agentId: string;
  action: string;
  issueId: string;
  issueIdentifier: string;
  issueTitle: string;
  minAgo: number;
}) {
  return {
    id: input.id,
    companyId: SCREENSHOT_COMPANY_ID,
    actorType: "agent",
    actorId: input.agentId,
    action: input.action,
    entityType: "issue",
    entityId: input.issueId,
    agentId: input.agentId,
    runId: input.runId,
    details: {
      identifier: input.issueIdentifier,
      issueTitle: input.issueTitle,
    },
    createdAt: ago(input.minAgo),
  };
}

const POPULATED_ACTIVITY = [
  buildActivity({
    id: "00000000-0000-0000-0000-000000000e01",
    runId: "00000000-0000-0000-0000-000000000r01",
    agentId: AGENT_IDS.engineer,
    action: "comment_posted",
    issueId: ISSUE_IDS.i01,
    issueIdentifier: "ACME-104",
    issueTitle: "Ship Q3 growth dashboard",
    minAgo: 12,
  }),
  buildActivity({
    id: "00000000-0000-0000-0000-000000000e02",
    runId: "00000000-0000-0000-0000-000000000r02",
    agentId: AGENT_IDS.designer,
    action: "review_requested",
    issueId: ISSUE_IDS.i02,
    issueIdentifier: "ACME-103",
    issueTitle: "Redesign onboarding empty state",
    minAgo: 45,
  }),
  buildActivity({
    id: "00000000-0000-0000-0000-000000000e03",
    runId: "00000000-0000-0000-0000-000000000r03",
    agentId: AGENT_IDS.researcher,
    action: "document_updated",
    issueId: ISSUE_IDS.i05,
    issueIdentifier: "ACME-100",
    issueTitle: "Customer churn analysis Q2",
    minAgo: 35,
  }),
  buildActivity({
    id: "00000000-0000-0000-0000-000000000e04",
    runId: "00000000-0000-0000-0000-000000000r04",
    agentId: AGENT_IDS.qa,
    action: "test_completed",
    issueId: ISSUE_IDS.i08,
    issueIdentifier: "ACME-097",
    issueTitle: "Investigate slow dashboard load on mobile",
    minAgo: 5,
  }),
  buildActivity({
    id: "00000000-0000-0000-0000-000000000e05",
    runId: "00000000-0000-0000-0000-000000000r05",
    agentId: AGENT_IDS.engineer,
    action: "blocked_on_dependency",
    issueId: ISSUE_IDS.i03,
    issueIdentifier: "ACME-102",
    issueTitle: "Migrate billing service to v2 API",
    minAgo: 60 * 2,
  }),
  buildActivity({
    id: "00000000-0000-0000-0000-000000000e06",
    runId: "00000000-0000-0000-0000-000000000r06",
    agentId: AGENT_IDS.pm,
    action: "summary_posted",
    issueId: ISSUE_IDS.i10,
    issueIdentifier: "ACME-095",
    issueTitle: "Document new agent permissions model",
    minAgo: 60 * 24 * 2,
  }),
];

function buildApproval(input: {
  id: string;
  type: string;
  requestedByAgentId: string;
  status: string;
  minAgo: number;
  title: string;
}) {
  return {
    id: input.id,
    companyId: SCREENSHOT_COMPANY_ID,
    type: input.type,
    requestedByAgentId: input.requestedByAgentId,
    requestedByUserId: null,
    status: input.status,
    payload: { title: input.title },
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: ago(input.minAgo),
    updatedAt: ago(input.minAgo),
  };
}

const POPULATED_APPROVALS = [
  buildApproval({
    id: "00000000-0000-0000-0000-000000000ap1",
    type: "spend",
    requestedByAgentId: AGENT_IDS.engineer,
    status: "pending",
    minAgo: 15,
    title: "Enable warehouse read access for Marcus Hall",
  }),
  buildApproval({
    id: "00000000-0000-0000-0000-000000000ap2",
    type: "publish",
    requestedByAgentId: AGENT_IDS.designer,
    status: "pending",
    minAgo: 60,
    title: "Publish updated brand tokens to the design library",
  }),
];

/**
 * Pattern → JSON-body matcher. The runner iterates these in order and
 * serves the first match. The value can be a function so we can sniff
 * the URL/method when needed.
 *
 * The catch-all at the end returns `[]` for any list-shaped path the
 * runner does not explicitly cover. Anything else falls through to a
 * 200 `{}` reply — preferable to a 5xx that would derail the React
 * Query retries and trigger error UI we did not mean to capture.
 */
export interface MockRouteSpec {
  readonly methodPattern?: RegExp;
  readonly pathPattern: RegExp;
  readonly response:
    | { status: number; body: unknown }
    | ((url: URL, method: string) => { status: number; body: unknown });
}

export interface ScreenshotFixtureOptions {
  readonly mode: ScreenshotFixtureMode;
  readonly viewerRole: ScreenshotViewerRole;
}

export function buildScreenshotApiRoutes(
  options: ScreenshotFixtureOptions,
): ReadonlyArray<MockRouteSpec> {
  const populated = options.mode === "populated";
  const boardAccess = boardAccessFor(options.viewerRole);
  const issueListBody = populated ? POPULATED_ISSUES : [];
  const agentListBody = populated ? POPULATED_AGENTS : [];
  const projectListBody = populated ? POPULATED_PROJECTS : [];
  const activityListBody = populated ? POPULATED_ACTIVITY : [];
  const approvalsListBody = populated ? POPULATED_APPROVALS : [];
  const orgTreeBody = populated ? POPULATED_ORG_TREE : [];

  return [
    { pathPattern: /^\/api\/health$/, response: { status: 200, body: SCREENSHOT_HEALTH } },
    { pathPattern: /^\/api\/auth\/get-session$/, response: { status: 200, body: SCREENSHOT_SESSION } },
    { pathPattern: /^\/api\/auth\/profile$/, response: { status: 200, body: SCREENSHOT_SESSION } },
    { pathPattern: /^\/api\/cli-auth\/me$/, response: { status: 200, body: boardAccess } },
    { pathPattern: /^\/api\/instance\/settings\/general$/, response: { status: 200, body: SCREENSHOT_INSTANCE_GENERAL } },
    { pathPattern: /^\/api\/companies$/, response: { status: 200, body: [SCREENSHOT_COMPANY] } },
    {
      pathPattern: /^\/api\/companies\/stats$/,
      response: {
        status: 200,
        body: {
          [SCREENSHOT_COMPANY_ID]: populated
            ? { agentCount: POPULATED_AGENTS.length, issueCount: POPULATED_ISSUES.length }
            : { agentCount: 0, issueCount: 0 },
        },
      },
    },
    { pathPattern: new RegExp(`^/api/companies/${SCREENSHOT_COMPANY_ID}$`), response: { status: 200, body: SCREENSHOT_COMPANY } },
    {
      pathPattern: new RegExp(`^/api/companies/${SCREENSHOT_COMPANY_ID}/org$`),
      response: { status: 200, body: orgTreeBody },
    },
    {
      pathPattern: new RegExp(`^/api/companies/${SCREENSHOT_COMPANY_ID}/members$`),
      response: {
        status: 200,
        body: {
          members: [],
          access: {
            currentUserRole: options.viewerRole === "operator-admin" ? "owner" : "member",
            canManageMembers: options.viewerRole === "operator-admin",
            canInviteUsers: options.viewerRole === "operator-admin",
            canApproveJoinRequests: options.viewerRole === "operator-admin",
          },
        },
      },
    },
    { pathPattern: new RegExp(`^/api/companies/${SCREENSHOT_COMPANY_ID}/capabilities$`), response: { status: 200, body: { config: {}, providerStatus: {} } } },
    { pathPattern: new RegExp(`^/api/companies/${SCREENSHOT_COMPANY_ID}/skills(?:\\b|/)`), response: { status: 200, body: [] } },
    { pathPattern: new RegExp(`^/api/companies/${SCREENSHOT_COMPANY_ID}/blueprints(?:\\b|/)`), response: { status: 200, body: [] } },
    {
      pathPattern: new RegExp(`^/api/companies/${SCREENSHOT_COMPANY_ID}/agents(?:\\b|/|\\?)`),
      response: { status: 200, body: agentListBody },
    },
    {
      pathPattern: new RegExp(`^/api/companies/${SCREENSHOT_COMPANY_ID}/issues(?:\\b|/|\\?)`),
      response: { status: 200, body: issueListBody },
    },
    {
      // LET-503 round-5: support `/api/issues/:idOrIdentifier` for the
      // Mission detail page. Match against either the `id` UUID or the
      // human `identifier` (ACME-104, etc) used in the targeted captures.
      pathPattern: /^\/api\/issues\/[^/]+$/,
      response: (url: URL) => {
        const ref = decodeURIComponent(url.pathname.split("/").pop() ?? "");
        const list = issueListBody as ReadonlyArray<{ id: string; identifier: string | null }>;
        const match = list.find(
          (issue) => issue.id === ref || issue.identifier === ref || issue.identifier?.toUpperCase() === ref.toUpperCase(),
        );
        if (!match) return { status: 404, body: { error: { code: "not_found", message: "Issue not found" } } };
        return { status: 200, body: match };
      },
    },
    {
      // Validation history returns an object with `entries`, not a list.
      // The detail page calls `history.entries.map` so it must be shaped
      // as an object.
      pathPattern: /^\/api\/issues\/[^/]+\/validation-history$/,
      response: { status: 200, body: { entries: [] } },
    },
    {
      // Tree observability returns an object with `timeline`, not a list.
      pathPattern: /^\/api\/issues\/[^/]+\/tree-observability(?:\?.*)?$/,
      response: { status: 200, body: { timeline: [], rootIssueId: null } },
    },
    {
      // Active-run is a singleton or null.
      pathPattern: /^\/api\/issues\/[^/]+\/active-run$/,
      response: { status: 200, body: null },
    },
    {
      // Comments, runs, activity, etc. for a single issue — all empty so
      // the detail page renders its truthful empty states.
      pathPattern: /^\/api\/issues\/[^/]+\/(comments|interactions|documents|approvals|runs|activity|work-products|live-runs|feedback-votes|attachments|labels)/,
      response: { status: 200, body: [] },
    },
    {
      pathPattern: new RegExp(`^/api/companies/${SCREENSHOT_COMPANY_ID}/projects(?:\\b|/|\\?)`),
      response: { status: 200, body: projectListBody },
    },
    {
      pathPattern: new RegExp(`^/api/companies/${SCREENSHOT_COMPANY_ID}/activity(?:\\b|/|\\?)`),
      response: { status: 200, body: activityListBody },
    },
    {
      pathPattern: new RegExp(`^/api/companies/${SCREENSHOT_COMPANY_ID}/approvals(?:\\b|/|\\?)`),
      response: { status: 200, body: approvalsListBody },
    },
    // Goals/inbox/search/secrets/etc. — empty in both modes; the EAOS
    // surfaces don't yet read them as a primary signal.
    {
      pathPattern: new RegExp(`^/api/companies/${SCREENSHOT_COMPANY_ID}/(goals|inbox|search|join-requests|invites|secrets|user-directory|environments)(?:\\b|/|\\?)`),
      response: { status: 200, body: [] },
    },
  ];
}

/**
 * Fallback for any /api path the explicit list misses. Defaults to
 * `200 []` because most uncovered EAOS endpoints are list-shaped (the
 * UI calls `.filter`/`.map` on them); the few singleton endpoints we
 * care about are pinned explicitly.
 */
export function screenshotApiFallback(url: URL): { status: number; body: unknown } {
  if (url.pathname.startsWith("/api/")) {
    const looksLikeSingleton = /\/(health|settings|profile|session|me|config|stats|status|capabilities)$/.test(
      url.pathname,
    );
    return { status: 200, body: looksLikeSingleton ? {} : [] };
  }
  return { status: 200, body: {} };
}
