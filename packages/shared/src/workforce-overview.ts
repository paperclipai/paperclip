import { AGENT_ROLE_LABELS, type AgentRole } from "./constants.js";
import { isAgentStatusInvokable } from "./agent-eligibility.js";

/**
 * Read-only board projection for the live workforce overview.
 * The function only reads the snapshot it is given. It does not check out,
 * resume, assign, or dispatch work.
 */
export const WORKFORCE_OVERVIEW_TIME_ZONE = "Asia/Dubai" as const;
export const WORKFORCE_OVERVIEW_POLL_MS = 12_000;
export const WORKFORCE_OVERVIEW_STALE_MS = 30_000;
export const WORKFORCE_RECENTLY_ACCEPTED_MS = 24 * 60 * 60 * 1000;

export const WORKFORCE_OVERVIEW_LIMITS = {
  issues: 1000,
  activity: 400,
  runs: 300,
  workProducts: 200,
  initiatives: 50,
  timeline: 80,
} as const;

const LIVE_RUN_STATUSES = new Set(["queued", "running", "scheduled_retry"]);
const OPEN_ISSUE_STATUSES = new Set(["backlog", "todo", "in_progress", "in_review", "blocked"]);
const ACTIVE_PROJECT_STATUSES = new Set(["planned", "in_progress"]);
const ACCEPTED_WORK_PRODUCT_STATES = new Set(["approved", "merged"]);

const PROJECT_STAGE_LABELS: Record<string, string> = {
  backlog: "Backlog",
  planned: "Planned",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

const ISSUE_STATUS_LABELS: Record<string, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
  blocked: "Blocked",
  cancelled: "Cancelled",
};

const CURRENT_TASK_RANK: Record<string, number> = {
  in_progress: 0,
  in_review: 1,
  blocked: 2,
  todo: 3,
  backlog: 4,
};

export type WorkforceConnection = "live" | "stale" | "disconnected";

export type WorkforceAgentDisposition =
  | "executing"
  | "paused"
  | "waiting"
  | "error"
  | "idle"
  | "terminated"
  | "pending_approval"
  | "unknown";

export interface WorkforceCount {
  value: number;
  label: string;
  detail: string;
}

export interface WorkforceOverviewSnapshot {
  companyId: string;
  now: string;
  truncated: boolean;
  initiativeQuery: string | null;
  agents: WorkforceAgentInput[];
  projects: WorkforceProjectInput[];
  issues: WorkforceIssueInput[];
  blockerEdges: Array<{ blockerIssueId: string; blockedIssueId: string }>;
  approvals: WorkforceApprovalInput[];
  runs: WorkforceRunInput[];
  activity: WorkforceActivityInput[];
  workProducts: WorkforceWorkProductInput[];
  members: Array<{ userId: string; name: string }>;
  environments: Array<{ id: string; name: string }>;
}

export interface WorkforceAgentInput {
  id: string;
  name: string;
  role: string;
  title: string | null;
  status: string;
  reportsTo: string | null;
  adapterType: string;
  model: string | null;
  environmentId: string | null;
  host: string | null;
  pauseReason: string | null;
  pausedAt: string | null;
  errorReason: string | null;
  lastHeartbeatAt: string | null;
}

export interface WorkforceProjectInput {
  id: string;
  name: string;
  status: string;
  leadAgentId: string | null;
  pauseReason: string | null;
  pausedAt: string | null;
  archivedAt: string | null;
  updatedAt: string;
}

export interface WorkforceIssueInput {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  projectId: string | null;
  parentId: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  priority: string;
  checkoutRunId: string | null;
  executionRunId: string | null;
  currentStageType: string | null;
  lastDecisionOutcome: string | null;
  executionParticipantUserId: string | null;
  unblockAction: string | null;
  unblockOwnerUserId: string | null;
  unblockOwnerBoard: boolean;
  completedAt: string | null;
  updatedAt: string;
  monitorNextCheckAt: string | null;
  labelNames: string[];
}

export interface WorkforceApprovalInput {
  id: string;
  type: string;
  status: string;
  title: string | null;
  security: boolean;
  createdAt: string;
}

export interface WorkforceRunInput {
  id: string;
  agentId: string;
  issueId: string | null;
  status: string;
  error: string | null;
  errorCode: string | null;
  livenessReason: string | null;
  nextAction: string | null;
  scheduledRetryReason: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  createdAt: string;
}

export interface WorkforceActivityInput {
  id: string;
  actorType: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  agentId: string | null;
  runId: string | null;
  createdAt: string;
  summary: string | null;
  mentionedAssignee: string | null;
}

export interface WorkforceWorkProductInput {
  id: string;
  issueId: string;
  projectId: string | null;
  type: string;
  title: string;
  url: string | null;
  openPath: string | null;
  status: string;
  reviewState: string;
  updatedAt: string;
}

export interface WorkforceProjectCard {
  id: string;
  name: string;
  stage: string;
  paused: boolean;
  owner: string;
  ownerAgentId: string | null;
  projectHref: string;
  currentTask: {
    id: string;
    identifier: string | null;
    title: string;
    status: string;
    statusLabel: string;
    assignee: string;
    assigneePaused: boolean;
    href: string;
  } | null;
  lastAcceptedOutput: string;
  nextAction: string;
  blockers: Array<{
    id: string;
    identifier: string | null;
    title: string;
    releaseCondition: string;
    href: string;
    security: boolean;
  }>;
  links: Array<{ label: string; href: string }>;
}

export interface WorkforceReportingHop {
  id: string;
  name: string;
  role: string;
  title: string | null;
  xo: boolean;
  unknown: boolean;
}

export interface WorkforceAgentCard {
  id: string;
  name: string;
  role: string;
  roleLabel: string;
  title: string | null;
  disposition: WorkforceAgentDisposition;
  dispositionLabel: string;
  reporting: WorkforceReportingHop[];
  adapterType: string;
  model: string | null;
  host: string | null;
  currentIssue: {
    id: string;
    identifier: string | null;
    title: string;
    status: string;
    statusLabel: string;
    href: string;
  } | null;
  currentRun: { id: string; status: string; href: string } | null;
  taskStatus: string | null;
  runStatus: string | null;
  outcomeNote: string;
  lastActivityAt: string | null;
  lastActivitySource: string;
  reasons: string[];
  href: string;
}

export interface WorkforceTimelineEntry {
  id: string;
  at: string;
  action: string;
  summary: string;
  actorLabel: string;
  provenance: "run" | "actor" | "unknown";
  provenanceLabel: string;
  issueId: string | null;
  issueIdentifier: string | null;
  issueHref: string | null;
  runId: string | null;
  evidence: "activity_log";
}

export interface WorkforceDeliverable {
  id: string;
  title: string;
  type: string;
  issueId: string;
  issueIdentifier: string | null;
  issueHref: string;
  href: string | null;
  authenticated: boolean;
  linkLabel: string;
  updatedAt: string;
}

export interface WorkforceBlockerItem {
  id: string;
  identifier: string | null;
  title: string;
  href: string;
  releaseCondition: string;
  security: boolean;
  owner: string;
}

export interface WorkforceDecisionItem {
  id: string;
  kind: "approval" | "review";
  title: string;
  href: string | null;
  releaseCondition: string;
  security: boolean;
  owner: string;
  marc: boolean;
}

export interface WorkforceInitiativeOption {
  id: string;
  identifier: string | null;
  title: string;
}

export interface WorkforceOverview {
  companyId: string;
  generatedAt: string;
  timeZone: typeof WORKFORCE_OVERVIEW_TIME_ZONE;
  readOnly: true;
  limits: typeof WORKFORCE_OVERVIEW_LIMITS;
  truncated: boolean;
  counts: {
    activeProjects: WorkforceCount;
    executingAgents: WorkforceCount;
    waitingEligible: WorkforceCount;
    blocked: WorkforceCount;
    pendingReviews: WorkforceCount;
    marcDecisions: WorkforceCount & { attribution: "member" | "none" };
    recentlyAccepted: WorkforceCount;
    pausedAgents: WorkforceCount;
    security: WorkforceCount;
  };
  projects: WorkforceProjectCard[];
  agents: WorkforceAgentCard[];
  initiatives: WorkforceInitiativeOption[];
  selectedInitiativeId: string | null;
  timeline: WorkforceTimelineEntry[];
  timelineNote: string | null;
  deliverables: WorkforceDeliverable[];
  blockers: WorkforceBlockerItem[];
  decisions: WorkforceDecisionItem[];
}

export function formatWorkforceTimestamp(
  iso: string | null | undefined,
  timeZone: string = WORKFORCE_OVERVIEW_TIME_ZONE,
): string {
  if (!iso) return "Not recorded";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Not recorded";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).format(date);
}

export function workforceConnection(input: {
  hasSnapshot: boolean;
  lastSuccessAt: string | null;
  now: string;
  lastFetchFailed: boolean;
  visible: boolean;
}): { connection: WorkforceConnection; stale: boolean } {
  if (!input.hasSnapshot || input.lastFetchFailed || !input.lastSuccessAt) {
    return { connection: "disconnected", stale: true };
  }
  const age = Date.parse(input.now) - Date.parse(input.lastSuccessAt);
  if (!Number.isFinite(age) || !input.visible || age > WORKFORCE_OVERVIEW_STALE_MS) {
    return { connection: "stale", stale: true };
  }
  return { connection: "live", stale: false };
}

/**
 * A failed refresh keeps the last successful snapshot. Disconnect and staleness
 * must not be rendered as an empty company.
 */
export function retainWorkforceSnapshot<T>(
  previous: T | null,
  next: { ok: true; snapshot: T } | { ok: false },
): T | null {
  if (next.ok) return next.snapshot;
  return previous;
}

export function projectWorkforceOverview(snapshot: WorkforceOverviewSnapshot): WorkforceOverview {
  const agentsById = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
  const issuesById = new Map(snapshot.issues.map((issue) => [issue.id, issue]));
  const membersById = new Map(snapshot.members.map((member) => [member.userId, member]));
  const environmentsById = new Map(snapshot.environments.map((environment) => [environment.id, environment]));
  const runsById = new Map(snapshot.runs.map((run) => [run.id, run]));
  const nowMs = Date.parse(snapshot.now);

  const blockersByIssue = new Map<string, WorkforceIssueInput[]>();
  const unresolvedBlockedIssueIds = new Set<string>();
  for (const edge of snapshot.blockerEdges) {
    const blocker = issuesById.get(edge.blockerIssueId);
    const blocked = issuesById.get(edge.blockedIssueId);
    if (!blocked) continue;
    // Only a done blocker releases the dependent. A cancelled blocker, or one
    // missing from the snapshot, stays unresolved.
    if (blocker?.status === "done") continue;
    unresolvedBlockedIssueIds.add(blocked.id);
    if (!blocker) continue;
    const list = blockersByIssue.get(blocked.id) ?? [];
    list.push(blocker);
    blockersByIssue.set(blocked.id, list);
  }

  const liveRuns = snapshot.runs.filter((run) => LIVE_RUN_STATUSES.has(run.status));
  const liveRunByIssue = new Map<string, WorkforceRunInput>();
  const liveRunsByAgent = new Map<string, WorkforceRunInput[]>();
  for (const run of liveRuns) {
    if (run.issueId && !liveRunByIssue.has(run.issueId)) liveRunByIssue.set(run.issueId, run);
    const list = liveRunsByAgent.get(run.agentId) ?? [];
    list.push(run);
    liveRunsByAgent.set(run.agentId, list);
  }

  const latestRunByAgent = new Map<string, WorkforceRunInput>();
  for (const run of [...snapshot.runs].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))) {
    if (!latestRunByAgent.has(run.agentId)) latestRunByAgent.set(run.agentId, run);
  }

  const marcMembers = snapshot.members.filter((member) => isMarcName(member.name));
  const marcIds = new Set(marcMembers.map((member) => member.userId));

  const agentCards = snapshot.agents
    .map((agent) =>
      toAgentCard(agent, {
        agentsById,
        issues: snapshot.issues,
        environmentsById,
        liveRuns: liveRunsByAgent.get(agent.id) ?? [],
        latestRun: latestRunByAgent.get(agent.id) ?? null,
        activity: snapshot.activity,
        membersById,
      }),
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  const executingAgents = agentCards.filter((agent) => agent.disposition === "executing");
  const pausedAgents = agentCards.filter((agent) => agent.disposition === "paused");

  const waitingEligible = snapshot.issues.filter((issue) =>
    isWaitingEligible(issue, agentsById, unresolvedBlockedIssueIds, liveRunByIssue, runsById),
  );
  const blockedIssues = snapshot.issues.filter((issue) => issue.status === "blocked");
  const pendingReviews = snapshot.issues.filter((issue) => issue.status === "in_review");
  const recentlyAccepted = snapshot.issues.filter((issue) => isRecentlyAccepted(issue, nowMs));

  const activeProjects = snapshot.projects.filter((project) => isActiveProject(project));
  const projectCards = snapshot.projects
    .filter((project) => !project.archivedAt)
    .map((project) =>
      toProjectCard(project, {
        agentsById,
        issues: snapshot.issues,
        blockersByIssue,
        workProducts: snapshot.workProducts,
        runsById,
        liveRunByIssue,
        membersById,
        now: snapshot.now,
      }),
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  const blockerItems = blockedIssues.map((issue) => toBlockerItem(issue, blockersByIssue, agentsById, membersById));
  const decisions = toDecisions(snapshot.approvals, pendingReviews, marcIds, marcMembers, membersById);
  const marcDecisionItems = decisions.filter((decision) => decision.marc);
  const securityItems = [...blockerItems, ...decisions].filter((item) => item.security);

  const initiatives = selectInitiatives(snapshot.issues);
  const selected = resolveInitiative(snapshot.initiativeQuery, snapshot.issues);
  const timeline = selected.issue
    ? buildTimeline(selected.issue, snapshot.issues, snapshot.activity, agentsById, membersById)
    : [];

  const deliverables = snapshot.workProducts
    .map((product) => toDeliverable(product, issuesById))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

  const marcNames = marcMembers.map((member) => member.name).join(", ");

  return {
    companyId: snapshot.companyId,
    generatedAt: snapshot.now,
    timeZone: WORKFORCE_OVERVIEW_TIME_ZONE,
    readOnly: true,
    limits: WORKFORCE_OVERVIEW_LIMITS,
    truncated: snapshot.truncated,
    counts: {
      activeProjects: {
        value: activeProjects.length,
        label: "Active projects",
        detail: "Planned or in progress, and not paused or archived.",
      },
      executingAgents: {
        value: executingAgents.length,
        label: "Executing agents",
        detail: "Status running, with no pause. A paused agent is never counted here.",
      },
      waitingEligible: {
        value: waitingEligible.length,
        label: "Waiting eligible",
        detail: "Todo tasks whose assignee can be invoked, with no open blocker and no live run.",
      },
      blocked: {
        value: blockedIssues.length,
        label: "Blocked",
        detail: "Tasks in blocked. Security items stay labeled in the blocker list.",
      },
      pendingReviews: {
        value: pendingReviews.length,
        label: "Pending reviews",
        detail: "Tasks in review.",
      },
      marcDecisions: {
        value: marcDecisionItems.length,
        label: "Marc decisions",
        attribution: marcMembers.length > 0 ? "member" : "none",
        detail:
          marcMembers.length > 0
            ? `Pending board approvals plus reviews owned by ${marcNames}.`
            : "No company member named Marc. Pending board approvals are listed separately and are not labeled as Marc decisions.",
      },
      recentlyAccepted: {
        value: recentlyAccepted.length,
        label: "Recently accepted",
        detail: "Done tasks with a recorded completion time in the last 24 hours.",
      },
      pausedAgents: {
        value: pausedAgents.length,
        label: "Paused",
        detail: "Paused agents stay visible here and are excluded from executing.",
      },
      security: {
        value: securityItems.length,
        label: "Security",
        detail: "Blocked tasks and open decisions labeled security by label, assignee role, or approval title.",
      },
    },
    projects: projectCards,
    agents: agentCards,
    initiatives,
    selectedInitiativeId: selected.issue?.id ?? null,
    timeline,
    timelineNote: selected.note,
    deliverables,
    blockers: blockerItems,
    decisions,
  };
}

function isMarcName(name: string): boolean {
  return /\bmarc\b/i.test(name.trim());
}

function isPausedAgent(agent: WorkforceAgentInput): boolean {
  return agent.status === "paused" || Boolean(agent.pauseReason) || Boolean(agent.pausedAt);
}

function dispositionFor(agent: WorkforceAgentInput): WorkforceAgentDisposition {
  if (isPausedAgent(agent)) return "paused";
  if (agent.status === "running") return "executing";
  if (agent.status === "error") return "error";
  if (agent.status === "terminated") return "terminated";
  if (agent.status === "pending_approval") return "pending_approval";
  if (agent.status === "idle" || agent.status === "active") return agent.status === "idle" ? "idle" : "waiting";
  return "unknown";
}

function dispositionLabel(disposition: WorkforceAgentDisposition): string {
  switch (disposition) {
    case "executing":
      return "Executing";
    case "paused":
      return "Paused";
    case "waiting":
      return "Waiting";
    case "error":
      return "Error";
    case "idle":
      return "Idle";
    case "terminated":
      return "Terminated";
    case "pending_approval":
      return "Pending approval";
    default:
      return "Unknown";
  }
}

function isSecurityIssue(issue: WorkforceIssueInput, agentsById: Map<string, WorkforceAgentInput>): boolean {
  if (issue.labelNames.some((label) => /security/i.test(label))) return true;
  const assignee = issue.assigneeAgentId ? agentsById.get(issue.assigneeAgentId) : undefined;
  return assignee?.role === "security";
}

function isActiveProject(project: WorkforceProjectInput): boolean {
  if (project.archivedAt || project.pausedAt || project.pauseReason) return false;
  return ACTIVE_PROJECT_STATUSES.has(project.status);
}

function isRecentlyAccepted(issue: WorkforceIssueInput, nowMs: number): boolean {
  if (issue.status !== "done" || !issue.completedAt) return false;
  const completed = Date.parse(issue.completedAt);
  if (!Number.isFinite(completed) || !Number.isFinite(nowMs)) return false;
  return nowMs - completed >= 0 && nowMs - completed <= WORKFORCE_RECENTLY_ACCEPTED_MS;
}

function isWaitingEligible(
  issue: WorkforceIssueInput,
  agentsById: Map<string, WorkforceAgentInput>,
  unresolvedBlockedIssueIds: Set<string>,
  liveRunByIssue: Map<string, WorkforceRunInput>,
  runsById: Map<string, WorkforceRunInput>,
): boolean {
  if (issue.status !== "todo") return false;
  if (unresolvedBlockedIssueIds.has(issue.id)) return false;
  if (liveRunByIssue.has(issue.id)) return false;
  const checkout = issue.checkoutRunId ? runsById.get(issue.checkoutRunId) : undefined;
  if (checkout && LIVE_RUN_STATUSES.has(checkout.status)) return false;
  if (!issue.assigneeAgentId) return false;
  const assignee = agentsById.get(issue.assigneeAgentId);
  if (!assignee || isPausedAgent(assignee)) return false;
  return isAgentStatusInvokable(assignee.status);
}

function issueHref(issue: { id: string; identifier: string | null }): string {
  return `/issues/${issue.identifier ?? issue.id}`;
}

function roleLabel(role: string): string {
  if (role in AGENT_ROLE_LABELS) return AGENT_ROLE_LABELS[role as AgentRole];
  return role || "Unknown role";
}

function isXo(agent: { name: string; title: string | null }): boolean {
  return /\bXO\b/i.test(agent.name) || /\bXO\b/i.test(agent.title ?? "");
}

function memberName(userId: string | null, membersById: Map<string, { userId: string; name: string }>): string | null {
  if (!userId) return null;
  return membersById.get(userId)?.name ?? null;
}

function assigneeLabel(
  issue: WorkforceIssueInput,
  agentsById: Map<string, WorkforceAgentInput>,
  membersById: Map<string, { userId: string; name: string }>,
): { label: string; paused: boolean } {
  if (issue.assigneeAgentId) {
    const agent = agentsById.get(issue.assigneeAgentId);
    if (!agent) return { label: "Unknown assignee", paused: false };
    return { label: agent.name, paused: isPausedAgent(agent) };
  }
  const user = memberName(issue.assigneeUserId, membersById);
  if (user) return { label: user, paused: false };
  if (issue.assigneeUserId) return { label: "Board user", paused: false };
  return { label: "Unassigned", paused: false };
}

function releaseCondition(issue: WorkforceIssueInput, blockers: WorkforceIssueInput[]): string {
  if (issue.unblockAction && issue.unblockAction.trim()) return issue.unblockAction.trim();
  if (blockers.length > 0) {
    return `Blocked by ${blockers.map((blocker) => blocker.identifier ?? blocker.title).join(", ")}`;
  }
  return "Release condition not recorded";
}

function toProjectCard(
  project: WorkforceProjectInput,
  ctx: {
    agentsById: Map<string, WorkforceAgentInput>;
    issues: WorkforceIssueInput[];
    blockersByIssue: Map<string, WorkforceIssueInput[]>;
    workProducts: WorkforceWorkProductInput[];
    runsById: Map<string, WorkforceRunInput>;
    liveRunByIssue: Map<string, WorkforceRunInput>;
    membersById: Map<string, { userId: string; name: string }>;
    now: string;
  },
): WorkforceProjectCard {
  const paused = Boolean(project.pausedAt || project.pauseReason);
  const owner = project.leadAgentId ? ctx.agentsById.get(project.leadAgentId) : undefined;
  const projectIssues = ctx.issues.filter((issue) => issue.projectId === project.id);
  const current = [...projectIssues]
    .filter((issue) => OPEN_ISSUE_STATUSES.has(issue.status))
    .sort((a, b) => {
      const rank = (CURRENT_TASK_RANK[a.status] ?? 9) - (CURRENT_TASK_RANK[b.status] ?? 9);
      if (rank !== 0) return rank;
      return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    })[0];
  const assignee = current ? assigneeLabel(current, ctx.agentsById, ctx.membersById) : null;
  const issueIds = new Set(projectIssues.map((issue) => issue.id));
  const acceptedProduct = [...ctx.workProducts]
    .filter(
      (product) =>
        issueIds.has(product.issueId) &&
        (ACCEPTED_WORK_PRODUCT_STATES.has(product.reviewState) || ACCEPTED_WORK_PRODUCT_STATES.has(product.status)),
    )
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  const acceptedIssue = [...projectIssues]
    .filter((issue) => issue.status === "done" && issue.completedAt)
    .sort((a, b) => Date.parse(b.completedAt ?? "") - Date.parse(a.completedAt ?? ""))[0];
  const blockers = projectIssues
    .filter((issue) => issue.status === "blocked")
    .map((issue) => {
      const blocking = ctx.blockersByIssue.get(issue.id) ?? [];
      return {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        releaseCondition: releaseCondition(issue, blocking),
        href: issueHref(issue),
        security: isSecurityIssue(issue, ctx.agentsById),
      };
    });

  const links = [{ label: "Project", href: `/projects/${project.id}` }];
  if (current) links.push({ label: "Current task", href: issueHref(current) });

  return {
    id: project.id,
    name: project.name,
    stage: `${PROJECT_STAGE_LABELS[project.status] ?? project.status}${paused ? " · Paused" : ""}`,
    paused,
    owner: owner?.name ?? "Unassigned",
    ownerAgentId: owner?.id ?? null,
    projectHref: `/projects/${project.id}`,
    currentTask: current
      ? {
          id: current.id,
          identifier: current.identifier,
          title: current.title,
          status: current.status,
          statusLabel: ISSUE_STATUS_LABELS[current.status] ?? current.status,
          assignee: assignee?.label ?? "Unassigned",
          assigneePaused: assignee?.paused ?? false,
          href: issueHref(current),
        }
      : null,
    lastAcceptedOutput: acceptedProduct
      ? acceptedProduct.title
      : acceptedIssue
        ? `Accepted task: ${acceptedIssue.title}`
        : "None recorded",
    nextAction: current ? nextActionFor(current, ctx.runsById, ctx.liveRunByIssue) : "Not recorded",
    blockers,
    links,
  };
}

function nextActionFor(
  issue: WorkforceIssueInput,
  runsById: Map<string, WorkforceRunInput>,
  liveRunByIssue: Map<string, WorkforceRunInput>,
): string {
  const run =
    liveRunByIssue.get(issue.id) ??
    (issue.executionRunId ? runsById.get(issue.executionRunId) : undefined) ??
    (issue.checkoutRunId ? runsById.get(issue.checkoutRunId) : undefined);
  if (run?.nextAction) return run.nextAction;
  if (run?.scheduledRetryReason) return run.scheduledRetryReason;
  if (issue.currentStageType) return `Stage: ${issue.currentStageType}`;
  if (issue.monitorNextCheckAt) {
    return `Monitor check at ${formatWorkforceTimestamp(issue.monitorNextCheckAt)}`;
  }
  return "Not recorded";
}

function reportingChain(agent: WorkforceAgentInput, agentsById: Map<string, WorkforceAgentInput>): WorkforceReportingHop[] {
  const hops: WorkforceReportingHop[] = [];
  const seen = new Set<string>([agent.id]);
  let cursor = agent.reportsTo;
  while (cursor) {
    if (seen.has(cursor)) {
      hops.push({
        id: cursor,
        name: "Reporting cycle",
        role: "unknown",
        title: null,
        xo: false,
        unknown: true,
      });
      break;
    }
    seen.add(cursor);
    const manager = agentsById.get(cursor);
    if (!manager) {
      hops.push({
        id: cursor,
        name: "Unknown manager",
        role: "unknown",
        title: null,
        xo: false,
        unknown: true,
      });
      break;
    }
    hops.push({
      id: manager.id,
      name: manager.name,
      role: roleLabel(manager.role),
      title: manager.title,
      xo: isXo(manager),
      unknown: false,
    });
    cursor = manager.reportsTo;
  }
  return hops;
}

function toAgentCard(
  agent: WorkforceAgentInput,
  ctx: {
    agentsById: Map<string, WorkforceAgentInput>;
    issues: WorkforceIssueInput[];
    environmentsById: Map<string, { id: string; name: string }>;
    liveRuns: WorkforceRunInput[];
    latestRun: WorkforceRunInput | null;
    activity: WorkforceActivityInput[];
    membersById: Map<string, { userId: string; name: string }>;
  },
): WorkforceAgentCard {
  const disposition = dispositionFor(agent);
  const assigned = [...ctx.issues]
    .filter((issue) => issue.assigneeAgentId === agent.id && OPEN_ISSUE_STATUSES.has(issue.status))
    .sort((a, b) => {
      const rank = (CURRENT_TASK_RANK[a.status] ?? 9) - (CURRENT_TASK_RANK[b.status] ?? 9);
      if (rank !== 0) return rank;
      return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    })[0];
  const liveRun = [...ctx.liveRuns].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  const runForCard = disposition === "executing" ? liveRun ?? ctx.latestRun : ctx.latestRun;
  const runIssue = runForCard?.issueId
    ? ctx.issues.find((issue) => issue.id === runForCard.issueId) ?? null
    : null;
  const currentIssue = disposition === "paused" ? assigned ?? runIssue : runIssue ?? assigned ?? null;
  const environmentName = agent.environmentId ? ctx.environmentsById.get(agent.environmentId)?.name ?? null : null;
  const lastActivity = latestActivity(agent, ctx.activity, ctx.latestRun);
  const reasons = agentReasons(agent, ctx.latestRun);
  const taskStatus = currentIssue ? (ISSUE_STATUS_LABELS[currentIssue.status] ?? currentIssue.status) : null;
  const runStatus = runForCard?.status ?? null;

  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    roleLabel: roleLabel(agent.role),
    title: agent.title,
    disposition,
    dispositionLabel: dispositionLabel(disposition),
    reporting: reportingChain(agent, ctx.agentsById),
    adapterType: agent.adapterType,
    model: agent.model,
    host: environmentName ?? agent.host,
    currentIssue: currentIssue
      ? {
          id: currentIssue.id,
          identifier: currentIssue.identifier,
          title: currentIssue.title,
          status: currentIssue.status,
          statusLabel: ISSUE_STATUS_LABELS[currentIssue.status] ?? currentIssue.status,
          href: issueHref(currentIssue),
        }
      : null,
    currentRun: runForCard
      ? { id: runForCard.id, status: runForCard.status, href: `/agents/${agent.id}/runs/${runForCard.id}` }
      : null,
    taskStatus,
    runStatus,
    outcomeNote: outcomeNote(disposition, taskStatus, runStatus),
    lastActivityAt: lastActivity.at,
    lastActivitySource: lastActivity.source,
    reasons,
    href: `/agents/${agent.id}`,
  };
}

function outcomeNote(disposition: WorkforceAgentDisposition, taskStatus: string | null, runStatus: string | null): string {
  if (disposition === "paused") {
    return "Paused. A running or in-progress record does not make this agent active.";
  }
  if (taskStatus && runStatus && taskStatus.toLowerCase() !== runStatus.toLowerCase()) {
    return `Run outcome ${runStatus} is separate from task status ${taskStatus}.`;
  }
  if (runStatus && taskStatus) return `Run ${runStatus}; task ${taskStatus}.`;
  if (runStatus) return `Run ${runStatus}. Task status not recorded on this snapshot.`;
  if (taskStatus) return `Task ${taskStatus}. No run recorded on this snapshot.`;
  return "No current task or run recorded.";
}

function latestActivity(
  agent: WorkforceAgentInput,
  activity: WorkforceActivityInput[],
  latestRun: WorkforceRunInput | null,
): { at: string | null; source: string } {
  const events = activity
    .filter((entry) => entry.agentId === agent.id || entry.actorId === agent.id)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const candidates: Array<{ at: string; source: string }> = [];
  if (agent.lastHeartbeatAt) candidates.push({ at: agent.lastHeartbeatAt, source: "Last heartbeat" });
  if (events[0]) candidates.push({ at: events[0].createdAt, source: "Activity log" });
  if (latestRun) candidates.push({ at: latestRun.updatedAt, source: "Latest run" });
  candidates.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return candidates[0] ?? { at: null, source: "Not recorded" };
}

function agentReasons(agent: WorkforceAgentInput, latestRun: WorkforceRunInput | null): string[] {
  const reasons: string[] = [];
  if (isPausedAgent(agent)) {
    reasons.push(agent.pauseReason ? `Paused: ${agent.pauseReason}` : "Paused (reason not recorded)");
  }
  if (agent.errorReason) reasons.push(`Error: ${agent.errorReason}`);
  if (latestRun?.errorCode) reasons.push(`Run ${latestRun.errorCode}`);
  else if (latestRun?.error) reasons.push(`Run error: ${latestRun.error}`);
  if (latestRun?.livenessReason) reasons.push(latestRun.livenessReason);
  if (latestRun?.scheduledRetryReason) reasons.push(latestRun.scheduledRetryReason);
  return [...new Set(reasons)];
}

function toBlockerItem(
  issue: WorkforceIssueInput,
  blockersByIssue: Map<string, WorkforceIssueInput[]>,
  agentsById: Map<string, WorkforceAgentInput>,
  membersById: Map<string, { userId: string; name: string }>,
): WorkforceBlockerItem {
  const blocking = blockersByIssue.get(issue.id) ?? [];
  const assignee = assigneeLabel(issue, agentsById, membersById);
  let owner = assignee.label;
  if (issue.unblockOwnerBoard) owner = "Board";
  const ownerUser = memberName(issue.unblockOwnerUserId, membersById);
  if (ownerUser) owner = ownerUser;
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    href: issueHref(issue),
    releaseCondition: releaseCondition(issue, blocking),
    security: isSecurityIssue(issue, agentsById),
    owner,
  };
}

function toDecisions(
  approvals: WorkforceApprovalInput[],
  reviews: WorkforceIssueInput[],
  marcIds: Set<string>,
  marcMembers: Array<{ userId: string; name: string }>,
  membersById: Map<string, { userId: string; name: string }>,
): WorkforceDecisionItem[] {
  const marcLabel = marcMembers.map((member) => member.name).join(", ");
  const openApprovals = approvals.filter((approval) => approval.status === "pending" || approval.status === "revision_requested");
  const approvalItems: WorkforceDecisionItem[] = openApprovals.map((approval) => ({
    id: approval.id,
    kind: "approval",
    title: approval.title ?? approval.type,
    href: `/approvals/${approval.id}`,
    releaseCondition: `Board approval required (${approval.type})`,
    security: approval.security,
    owner: marcMembers.length > 0 ? marcLabel : "Board",
    marc: marcMembers.length > 0,
  }));
  const reviewItems: WorkforceDecisionItem[] = reviews
    .filter((issue) => issueOwnedByMarc(issue, marcIds))
    .map((issue) => ({
      id: issue.id,
      kind: "review",
      title: issue.title,
      href: issueHref(issue),
      releaseCondition: issue.unblockAction?.trim() || "Review decision required",
      security: issue.labelNames.some((label) => /security/i.test(label)),
      owner: memberName(issue.assigneeUserId, membersById) ?? marcLabel,
      marc: true,
    }));
  return [...approvalItems, ...reviewItems];
}

function issueOwnedByMarc(issue: WorkforceIssueInput, marcIds: Set<string>): boolean {
  if (marcIds.size === 0) return false;
  return [issue.assigneeUserId, issue.unblockOwnerUserId, issue.executionParticipantUserId].some(
    (id) => id != null && marcIds.has(id),
  );
}

function initiativeParents(issues: WorkforceIssueInput[]): WorkforceIssueInput[] {
  const parentIds = new Set(issues.map((issue) => issue.parentId).filter((id): id is string => Boolean(id)));
  return issues
    .filter((issue) => parentIds.has(issue.id))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

function selectInitiatives(issues: WorkforceIssueInput[]): WorkforceInitiativeOption[] {
  return initiativeParents(issues)
    .slice(0, WORKFORCE_OVERVIEW_LIMITS.initiatives)
    .map((issue) => ({ id: issue.id, identifier: issue.identifier, title: issue.title }));
}

/** Most recently updated parent with child tasks. Done parents stay eligible. */
export function defaultWorkforceInitiative(issues: WorkforceIssueInput[]): WorkforceIssueInput | null {
  return initiativeParents(issues)[0] ?? null;
}

function resolveInitiative(
  query: string | null,
  issues: WorkforceIssueInput[],
): { issue: WorkforceIssueInput | null; note: string | null } {
  if (!query) {
    const issue = defaultWorkforceInitiative(issues);
    return {
      issue,
      note: issue ? null : "No initiative with child tasks is in this snapshot. The timeline stays empty.",
    };
  }
  const issue =
    issues.find((candidate) => candidate.id === query || candidate.identifier === query) ?? null;
  if (!issue) {
    return { issue: null, note: "Selected initiative was not found in this snapshot. No handoff events were invented." };
  }
  return { issue, note: null };
}

function subtreeIds(root: WorkforceIssueInput, issues: WorkforceIssueInput[]): Set<string> {
  const children = new Map<string, WorkforceIssueInput[]>();
  for (const issue of issues) {
    if (!issue.parentId) continue;
    const list = children.get(issue.parentId) ?? [];
    list.push(issue);
    children.set(issue.parentId, list);
  }
  const ids = new Set<string>();
  const stack = [root.id];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (ids.has(id)) continue;
    ids.add(id);
    for (const child of children.get(id) ?? []) stack.push(child.id);
  }
  return ids;
}

function buildTimeline(
  root: WorkforceIssueInput,
  issues: WorkforceIssueInput[],
  activity: WorkforceActivityInput[],
  agentsById: Map<string, WorkforceAgentInput>,
  membersById: Map<string, { userId: string; name: string }>,
): WorkforceTimelineEntry[] {
  const ids = subtreeIds(root, issues);
  const issuesById = new Map(issues.map((issue) => [issue.id, issue]));
  return activity
    .filter((entry) => entry.entityType === "issue" && ids.has(entry.entityId))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, WORKFORCE_OVERVIEW_LIMITS.timeline)
    .map((entry) => {
      const issue = issuesById.get(entry.entityId) ?? null;
      const provenance = provenanceFor(entry);
      return {
        id: entry.id,
        at: entry.createdAt,
        action: entry.action,
        summary: entry.summary ?? entry.mentionedAssignee ?? entry.action,
        actorLabel: actorLabel(entry, agentsById, membersById, provenance),
        provenance: provenance.kind,
        provenanceLabel: provenance.label,
        issueId: issue?.id ?? entry.entityId,
        issueIdentifier: issue?.identifier ?? null,
        issueHref: issue ? issueHref(issue) : null,
        runId: entry.runId,
        evidence: "activity_log" as const,
      };
    });
}

function provenanceFor(entry: WorkforceActivityInput): { kind: "run" | "actor" | "unknown"; label: string } {
  if (entry.runId) return { kind: "run", label: "Recorded on a run" };
  if ((entry.actorType === "agent" || entry.actorType === "user") && entry.actorId.trim()) {
    return { kind: "actor", label: "Recorded actor" };
  }
  return { kind: "unknown", label: "Unknown provenance" };
}

function actorLabel(
  entry: WorkforceActivityInput,
  agentsById: Map<string, WorkforceAgentInput>,
  membersById: Map<string, { userId: string; name: string }>,
  provenance: { kind: "run" | "actor" | "unknown"; label: string },
): string {
  if (entry.actorType === "agent") {
    return agentsById.get(entry.actorId)?.name ?? agentsById.get(entry.agentId ?? "")?.name ?? "Unknown agent";
  }
  if (entry.actorType === "user") return memberName(entry.actorId, membersById) ?? "Board user";
  if (provenance.kind === "unknown") return "Unknown provenance";
  return "System";
}

function toDeliverable(
  product: WorkforceWorkProductInput,
  issuesById: Map<string, WorkforceIssueInput>,
): WorkforceDeliverable {
  const issue = issuesById.get(product.issueId);
  const link = deliverableLink(product);
  return {
    id: product.id,
    title: product.title,
    type: product.type,
    issueId: product.issueId,
    issueIdentifier: issue?.identifier ?? null,
    issueHref: issue ? issueHref(issue) : `/issues/${product.issueId}`,
    href: link.href,
    authenticated: link.authenticated,
    linkLabel: link.linkLabel,
    updatedAt: product.updatedAt,
  };
}

function deliverableLink(product: WorkforceWorkProductInput): {
  href: string | null;
  authenticated: boolean;
  linkLabel: string;
} {
  const openPath = safeRelativePath(product.openPath);
  if (openPath) return { href: openPath, authenticated: true, linkLabel: "Open" };
  const url = product.url?.trim() || null;
  if (url && safeRelativePath(url)) return { href: url, authenticated: true, linkLabel: "Open" };
  if (url && /^https:\/\//i.test(url)) return { href: url, authenticated: false, linkLabel: "External link" };
  return { href: null, authenticated: false, linkLabel: "No authenticated link recorded" };
}

function safeRelativePath(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return null;
  return trimmed;
}
