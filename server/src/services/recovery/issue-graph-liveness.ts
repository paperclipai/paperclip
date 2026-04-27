import { buildIssueGraphLivenessIncidentKey } from "./origins.js";

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

export type IssueLivenessOwnerCandidateReason =
  | "stalled_blocker_assignee"
  | "assignee_reporting_chain"
  | "creator_reporting_chain"
  | "root_agent"
  | "ordered_invokable_fallback";

export interface IssueLivenessOwnerCandidate {
  agentId: string;
  reason: IssueLivenessOwnerCandidateReason;
  sourceIssueId: string;
}

export interface IssueLivenessFinding {
  issueId: string;
  companyId: string;
  identifier: string | null;
  state: IssueLivenessState;
  severity: IssueLivenessSeverity;
  reason: string;
  dependencyPath: IssueLivenessDependencyPathEntry[];
  recoveryIssueId: string;
  recommendedOwnerAgentId: string | null;
  recommendedOwnerCandidateAgentIds: string[];
  recommendedOwnerCandidates: IssueLivenessOwnerCandidate[];
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

function addOwnerCandidate(
  candidates: IssueLivenessOwnerCandidate[],
  seen: Set<string>,
  agentsById: Map<string, IssueLivenessAgentInput>,
  companyId: string,
  agentId: string | null | undefined,
  reason: IssueLivenessOwnerCandidateReason,
  sourceIssueId: string,
) {
  if (!agentId || seen.has(agentId)) return;
  const agent = agentsById.get(agentId);
  if (!agent || agent.companyId !== companyId || !isInvokableAgent(agent)) return;
  seen.add(agentId);
  candidates.push({ agentId, reason, sourceIssueId });
}

function addAgentChainCandidates(
  candidates: IssueLivenessOwnerCandidate[],
  seen: Set<string>,
  startAgentId: string | null | undefined,
  agentsById: Map<string, IssueLivenessAgentInput>,
  companyId: string,
  reason: IssueLivenessOwnerCandidateReason,
  sourceIssueId: string,
) {
  const chainSeen = new Set<string>();
  let current = startAgentId ? agentsById.get(startAgentId) : null;

  while (current?.reportsTo) {
    if (chainSeen.has(current.reportsTo)) break;
    chainSeen.add(current.reportsTo);
    const manager = agentsById.get(current.reportsTo);
    if (!manager || manager.companyId !== companyId) break;
    addOwnerCandidate(candidates, seen, agentsById, companyId, manager.id, reason, sourceIssueId);
    current = manager;
  }
}

function orderedInvokableAgents(agents: IssueLivenessAgentInput[], companyId: string) {
  return agents
    .filter((agent) => agent.companyId === companyId && isInvokableAgent(agent))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function ownerCandidatesForRecoveryIssue(
  issue: IssueLivenessIssueInput,
  agents: IssueLivenessAgentInput[],
  agentsById: Map<string, IssueLivenessAgentInput>,
  options: {
    includeStalledAssignee?: boolean;
  } = {},
) {
  const candidates: IssueLivenessOwnerCandidate[] = [];
  const seen = new Set<string>();

  if (options.includeStalledAssignee && issue.status !== "cancelled" && issue.status !== "done") {
    addOwnerCandidate(
      candidates,
      seen,
      agentsById,
      issue.companyId,
      issue.assigneeAgentId,
      "stalled_blocker_assignee",
      issue.id,
    );
  }

  addAgentChainCandidates(
    candidates,
    seen,
    issue.assigneeAgentId,
    agentsById,
    issue.companyId,
    "assignee_reporting_chain",
    issue.id,
  );
  addAgentChainCandidates(
    candidates,
    seen,
    issue.createdByAgentId,
    agentsById,
    issue.companyId,
    "creator_reporting_chain",
    issue.id,
  );

  const invokableAgents = orderedInvokableAgents(agents, issue.companyId);
  for (const agent of invokableAgents) {
    if (!agent.reportsTo) {
      addOwnerCandidate(candidates, seen, agentsById, issue.companyId, agent.id, "root_agent", issue.id);
    }
  }
  for (const agent of invokableAgents) {
    addOwnerCandidate(
      candidates,
      seen,
      agentsById,
      issue.companyId,
      agent.id,
      "ordered_invokable_fallback",
      issue.id,
    );
  }

  return candidates;
}

function incidentKey(input: {
  companyId: string;
  issueId: string;
  state: IssueLivenessState;
  blockerIssueId?: string | null;
  participantAgentId?: string | null;
}) {
  return buildIssueGraphLivenessIncidentKey(input);
}

function finding(input: {
  issue: IssueLivenessIssueInput;
  state: IssueLivenessState;
  severity?: IssueLivenessSeverity;
  reason: string;
  dependencyPath: IssueLivenessIssueInput[];
  recoveryIssue: IssueLivenessIssueInput;
  recommendedOwnerCandidateAgentIds: string[];
  recommendedOwnerCandidates: IssueLivenessOwnerCandidate[];
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
    recoveryIssueId: input.recoveryIssue.id,
    recommendedOwnerAgentId: input.recommendedOwnerCandidateAgentIds[0] ?? null,
    recommendedOwnerCandidateAgentIds: input.recommendedOwnerCandidateAgentIds,
    recommendedOwnerCandidates: input.recommendedOwnerCandidates,
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
    if (issue.status === "blocked") {
      const relations = blockersByBlockedIssueId.get(issue.id) ?? [];
      for (const relation of relations) {
        if (relation.companyId !== issue.companyId) continue;
        const blocker = issuesById.get(relation.blockerIssueId);
        if (!blocker || blocker.companyId !== issue.companyId || blocker.status === "done") continue;
        const ownerCandidates = ownerCandidatesForRecoveryIssue(blocker, input.agents, agentsById, {
          includeStalledAssignee: true,
        });

        if (blocker.status === "cancelled") {
          findings.push(finding({
            issue,
            state: "blocked_by_cancelled_issue",
            reason: `${issueLabel(issue)} is still blocked by cancelled issue ${issueLabel(blocker)}.`,
            dependencyPath: [issue, blocker],
            recoveryIssue: blocker,
            recommendedOwnerCandidateAgentIds: ownerCandidates.map((candidate) => candidate.agentId),
            recommendedOwnerCandidates: ownerCandidates,
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
            recoveryIssue: blocker,
            recommendedOwnerCandidateAgentIds: ownerCandidates.map((candidate) => candidate.agentId),
            recommendedOwnerCandidates: ownerCandidates,
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
            recoveryIssue: blocker,
            recommendedOwnerCandidateAgentIds: ownerCandidates.map((candidate) => candidate.agentId),
            recommendedOwnerCandidates: ownerCandidates,
            recommendedAction:
              `Review ${issueLabel(blocker)} and assign it to an active owner or replace the blocker with an actionable issue.`,
            blockerIssueId: blocker.id,
          }));
        }
      }
    }

    if (issue.status !== "in_review" || !issue.executionState) continue;
    const ownerCandidates = ownerCandidatesForRecoveryIssue(issue, input.agents, agentsById);
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
          recoveryIssue: issue,
          recommendedOwnerCandidateAgentIds: ownerCandidates.map((candidate) => candidate.agentId),
          recommendedOwnerCandidates: ownerCandidates,
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
        recoveryIssue: issue,
        recommendedOwnerCandidateAgentIds: ownerCandidates.map((candidate) => candidate.agentId),
        recommendedOwnerCandidates: ownerCandidates,
        recommendedAction:
          `Repair ${issueLabel(issue)}'s review participant or return the issue to an active assignee with a clear change request.`,
      }));
    }
  }

  return findings;
}
