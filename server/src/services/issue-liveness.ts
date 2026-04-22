export type IssueLivenessSeverity = "warning" | "critical";

export type IssueLivenessState =
  | "blocked_by_unassigned_issue"
  | "blocked_by_uninvokable_assignee"
  | "blocked_by_cancelled_issue"
  | "invalid_review_participant";

export interface IssueLivenessIssueInput {
  id: string;
  companyId: string;
  identifier: string | null;
  title: string;
  status: string;
  projectId?: string | null;
  goalId?: string | null;
  parentId?: string | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
  executionState?: Record<string, unknown> | null;
}

export interface IssueLivenessRelationInput {
  companyId: string;
  blockerIssueId: string;
  blockedIssueId: string;
}

export interface IssueLivenessAgentInput {
  id: string;
  companyId: string;
  name: string;
  role: string;
  title?: string | null;
  status: string;
  reportsTo?: string | null;
}

export interface IssueLivenessExecutionPathInput {
  companyId: string;
  issueId: string | null;
  agentId?: string | null;
  status: string;
}

export interface IssueLivenessDependencyPathEntry {
  issueId: string;
  identifier: string | null;
  title: string;
  status: string;
}

export interface IssueLivenessFinding {
  issueId: string;
  companyId: string;
  identifier: string | null;
  state: IssueLivenessState;
  severity: IssueLivenessSeverity;
  reason: string;
  dependencyPath: IssueLivenessDependencyPathEntry[];
  recommendedOwnerAgentId: string | null;
  recommendedOwnerCandidateAgentIds: string[];
  recommendedAction: string;
  incidentKey: string;
}

export interface IssueGraphLivenessInput {
  issues: IssueLivenessIssueInput[];
  relations: IssueLivenessRelationInput[];
  agents: IssueLivenessAgentInput[];
  activeRuns?: IssueLivenessExecutionPathInput[];
  queuedWakeRequests?: IssueLivenessExecutionPathInput[];
}

const INVOKABLE_AGENT_STATUSES = new Set(["active", "idle", "running", "error"]);
const BLOCKING_AGENT_STATUSES = new Set(["paused", "terminated", "pending_approval"]);

function issueLabel(issue: IssueLivenessIssueInput) {
  return issue.identifier ?? issue.id;
}

function pathEntry(issue: IssueLivenessIssueInput): IssueLivenessDependencyPathEntry {
  return {
    issueId: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    status: issue.status,
  };
}

function isInvokableAgent(agent: IssueLivenessAgentInput | null | undefined) {
  return Boolean(agent && INVOKABLE_AGENT_STATUSES.has(agent.status));
}

function hasActiveExecutionPath(
  companyId: string,
  issueId: string,
  activeRuns: IssueLivenessExecutionPathInput[],
  queuedWakeRequests: IssueLivenessExecutionPathInput[],
) {
  return [...activeRuns, ...queuedWakeRequests].some(
    (entry) => entry.companyId === companyId && entry.issueId === issueId,
  );
}

function readPrincipalAgentId(principal: unknown): string | null {
  if (!principal || typeof principal !== "object") return null;
  const value = principal as Record<string, unknown>;
  return value.type === "agent" && typeof value.agentId === "string" && value.agentId.length > 0
    ? value.agentId
    : null;
}

function principalIsResolvableUser(principal: unknown): boolean {
  if (!principal || typeof principal !== "object") return false;
  const value = principal as Record<string, unknown>;
  return value.type === "user" && typeof value.userId === "string" && value.userId.length > 0;
}

function agentChainCandidates(
  startAgentId: string | null | undefined,
  agentsById: Map<string, IssueLivenessAgentInput>,
  companyId: string,
) {
  const candidates: string[] = [];
  const seen = new Set<string>();
  let current = startAgentId ? agentsById.get(startAgentId) : null;

  while (current?.reportsTo) {
    if (seen.has(current.reportsTo)) break;
    seen.add(current.reportsTo);
    const manager = agentsById.get(current.reportsTo);
    if (!manager || manager.companyId !== companyId) break;
    if (isInvokableAgent(manager)) candidates.push(manager.id);
    current = manager;
  }

  return candidates;
}

function fallbackExecutiveCandidates(agents: IssueLivenessAgentInput[], companyId: string) {
  const active = agents.filter((agent) => agent.companyId === companyId && isInvokableAgent(agent));
  const executive = active.filter((agent) => {
    const haystack = `${agent.role} ${agent.title ?? ""} ${agent.name}`.toLowerCase();
    return /\b(cto|chief technology|ceo|chief executive)\b/.test(haystack);
  });
  const roots = active.filter((agent) => !agent.reportsTo);
  return [...executive, ...roots, ...active].map((agent) => agent.id);
}

function ownerCandidatesForIssue(
  issue: IssueLivenessIssueInput,
  agents: IssueLivenessAgentInput[],
  agentsById: Map<string, IssueLivenessAgentInput>,
) {
  const candidates = [
    ...agentChainCandidates(issue.assigneeAgentId, agentsById, issue.companyId),
    ...agentChainCandidates(issue.createdByAgentId, agentsById, issue.companyId),
    ...fallbackExecutiveCandidates(agents, issue.companyId),
  ];
  return [...new Set(candidates)];
}

function incidentKey(input: {
  companyId: string;
  issueId: string;
  state: IssueLivenessState;
  blockerIssueId?: string | null;
  participantAgentId?: string | null;
}) {
  return [
    "harness_liveness",
    input.companyId,
    input.issueId,
    input.state,
    input.blockerIssueId ?? input.participantAgentId ?? "none",
  ].join(":");
}

function finding(input: {
  issue: IssueLivenessIssueInput;
  state: IssueLivenessState;
  severity?: IssueLivenessSeverity;
  reason: string;
  dependencyPath: IssueLivenessIssueInput[];
  recommendedOwnerCandidateAgentIds: string[];
  recommendedAction: string;
  blockerIssueId?: string | null;
  participantAgentId?: string | null;
}): IssueLivenessFinding {
  return {
    issueId: input.issue.id,
    companyId: input.issue.companyId,
    identifier: input.issue.identifier,
    state: input.state,
    severity: input.severity ?? "critical",
    reason: input.reason,
    dependencyPath: input.dependencyPath.map(pathEntry),
    recommendedOwnerAgentId: input.recommendedOwnerCandidateAgentIds[0] ?? null,
    recommendedOwnerCandidateAgentIds: input.recommendedOwnerCandidateAgentIds,
    recommendedAction: input.recommendedAction,
    incidentKey: incidentKey({
      companyId: input.issue.companyId,
      issueId: input.issue.id,
      state: input.state,
      blockerIssueId: input.blockerIssueId,
      participantAgentId: input.participantAgentId,
    }),
  };
}

export function classifyIssueGraphLiveness(input: IssueGraphLivenessInput): IssueLivenessFinding[] {
  const issuesById = new Map(input.issues.map((issue) => [issue.id, issue]));
  const agentsById = new Map(input.agents.map((agent) => [agent.id, agent]));
  const blockersByBlockedIssueId = new Map<string, IssueLivenessRelationInput[]>();
  const findings: IssueLivenessFinding[] = [];
  const activeRuns = input.activeRuns ?? [];
  const queuedWakeRequests = input.queuedWakeRequests ?? [];

  for (const relation of input.relations) {
    const list = blockersByBlockedIssueId.get(relation.blockedIssueId) ?? [];
    list.push(relation);
    blockersByBlockedIssueId.set(relation.blockedIssueId, list);
  }

  for (const issue of input.issues) {
    const ownerCandidates = ownerCandidatesForIssue(issue, input.agents, agentsById);

    if (issue.status === "blocked") {
      const relations = blockersByBlockedIssueId.get(issue.id) ?? [];
      for (const relation of relations) {
        if (relation.companyId !== issue.companyId) continue;
        const blocker = issuesById.get(relation.blockerIssueId);
        if (!blocker || blocker.companyId !== issue.companyId || blocker.status === "done") continue;

        if (blocker.status === "cancelled") {
          findings.push(finding({
            issue,
            state: "blocked_by_cancelled_issue",
            reason: `${issueLabel(issue)} is still blocked by cancelled issue ${issueLabel(blocker)}.`,
            dependencyPath: [issue, blocker],
            recommendedOwnerCandidateAgentIds: ownerCandidates,
            recommendedAction:
              `Inspect ${issueLabel(blocker)} and either remove it from ${issueLabel(issue)}'s blockers or replace it with an actionable unblock issue.`,
            blockerIssueId: blocker.id,
          }));
          continue;
        }

        if (!blocker.assigneeAgentId && !blocker.assigneeUserId) {
          if (hasActiveExecutionPath(issue.companyId, blocker.id, activeRuns, queuedWakeRequests)) continue;
          findings.push(finding({
            issue,
            state: "blocked_by_unassigned_issue",
            reason: `${issueLabel(issue)} is blocked by unassigned issue ${issueLabel(blocker)} with no user owner.`,
            dependencyPath: [issue, blocker],
            recommendedOwnerCandidateAgentIds: ownerCandidates,
            recommendedAction:
              `Assign ${issueLabel(blocker)} to an owner who can complete it, or remove it from ${issueLabel(issue)}'s blockers if it is no longer required.`,
            blockerIssueId: blocker.id,
          }));
          continue;
        }

        if (!blocker.assigneeAgentId) continue;
        if (hasActiveExecutionPath(issue.companyId, blocker.id, activeRuns, queuedWakeRequests)) continue;

        const blockerAgent = agentsById.get(blocker.assigneeAgentId);
        if (!blockerAgent || blockerAgent.companyId !== issue.companyId || BLOCKING_AGENT_STATUSES.has(blockerAgent.status)) {
          findings.push(finding({
            issue,
            state: "blocked_by_uninvokable_assignee",
            reason: blockerAgent
              ? `${issueLabel(issue)} is blocked by ${issueLabel(blocker)}, but its assignee is ${blockerAgent.status}.`
              : `${issueLabel(issue)} is blocked by ${issueLabel(blocker)}, but its assignee no longer exists.`,
            dependencyPath: [issue, blocker],
            recommendedOwnerCandidateAgentIds: ownerCandidates,
            recommendedAction:
              `Review ${issueLabel(blocker)} and assign it to an active owner or replace the blocker with an actionable issue.`,
            blockerIssueId: blocker.id,
          }));
        }
      }
    }

    if (issue.status !== "in_review" || !issue.executionState) continue;
    const participant = issue.executionState.currentParticipant;
    const participantAgentId = readPrincipalAgentId(participant);
    if (participantAgentId) {
      const participantAgent = agentsById.get(participantAgentId);
      if (!isInvokableAgent(participantAgent) || participantAgent?.companyId !== issue.companyId) {
        findings.push(finding({
          issue,
          state: "invalid_review_participant",
          reason: participantAgent
            ? `${issueLabel(issue)} is in review, but current participant agent is ${participantAgent.status}.`
            : `${issueLabel(issue)} is in review, but current participant agent cannot be resolved.`,
          dependencyPath: [issue],
          recommendedOwnerCandidateAgentIds: ownerCandidates,
          recommendedAction:
            `Repair ${issueLabel(issue)}'s review participant or return the issue to an active assignee with a clear change request.`,
          participantAgentId,
        }));
      }
      continue;
    }

    if (!principalIsResolvableUser(participant)) {
      findings.push(finding({
        issue,
        state: "invalid_review_participant",
        reason: `${issueLabel(issue)} is in review, but its current participant cannot be resolved.`,
        dependencyPath: [issue],
        recommendedOwnerCandidateAgentIds: ownerCandidates,
        recommendedAction:
          `Repair ${issueLabel(issue)}'s review participant or return the issue to an active assignee with a clear change request.`,
      }));
    }
  }

  return findings;
}
