import { buildIssueGraphLivenessIncidentKey } from "./origins.js";

export type IssueLivenessSeverity = "warning" | "critical";

export type IssueLivenessState =
  | "blocked_by_unassigned_issue"
  | "blocked_by_uninvokable_assignee"
  | "blocked_by_cancelled_issue"
  | "invalid_review_participant"
  | "in_review_without_action_path";

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
  executionPolicy?: Record<string, unknown> | null;
  executionState?: Record<string, unknown> | null;
  monitorNextCheckAt?: Date | string | null;
  monitorAttemptCount?: number | null;
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

export interface IssueLivenessWaitingPathInput {
  companyId: string;
  issueId: string;
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
  pendingInteractions?: IssueLivenessWaitingPathInput[];
  pendingApprovals?: IssueLivenessWaitingPathInput[];
  openRecoveryIssues?: IssueLivenessWaitingPathInput[];
  now?: Date | string;
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

function hasWaitingPath(
  companyId: string,
  issueId: string,
  waitingPaths: IssueLivenessWaitingPathInput[],
) {
  return waitingPaths.some((entry) => entry.companyId === companyId && entry.issueId === issueId);
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function readDateMs(value: unknown): number | null {
  if (!(typeof value === "string" || value instanceof Date)) return null;
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  return Number.isNaN(time) ? null : time;
}

function monitorFromIssue(issue: IssueLivenessIssueInput) {
  const policyMonitor = readRecord(readRecord(issue.executionPolicy)?.monitor);
  const stateMonitor = readRecord(readRecord(issue.executionState)?.monitor);
  return { policyMonitor, stateMonitor };
}

function hasScheduledMonitor(issue: IssueLivenessIssueInput, nowMs: number) {
  const nextCheckAtMs = readDateMs(issue.monitorNextCheckAt);
  if (nextCheckAtMs === null || nextCheckAtMs <= nowMs) return false;

  const { policyMonitor, stateMonitor } = monitorFromIssue(issue);
  const timeoutAtMs = readDateMs(policyMonitor?.timeoutAt ?? stateMonitor?.timeoutAt);
  if (timeoutAtMs !== null && timeoutAtMs <= nowMs) return false;

  const maxAttempts = readPositiveInteger(policyMonitor?.maxAttempts ?? stateMonitor?.maxAttempts);
  const stateAttemptCount = readPositiveInteger(stateMonitor?.attemptCount) ?? 0;
  const attemptCount = issue.monitorAttemptCount ?? stateAttemptCount;
  if (maxAttempts !== null && attemptCount >= maxAttempts) return false;

  return true;
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
  const nowMs = readDateMs(input.now ?? new Date()) ?? Date.now();
  const issuesById = new Map(input.issues.map((issue) => [issue.id, issue]));
  const agentsById = new Map(input.agents.map((agent) => [agent.id, agent]));
  const blockersByBlockedIssueId = new Map<string, IssueLivenessRelationInput[]>();
  const unresolvedBlockers = new Set<string>();
  const findings: IssueLivenessFinding[] = [];
  const activeRuns = input.activeRuns ?? [];
  const queuedWakeRequests = input.queuedWakeRequests ?? [];
  const pendingInteractions = input.pendingInteractions ?? [];
  const pendingApprovals = input.pendingApprovals ?? [];
  const openRecoveryIssues = input.openRecoveryIssues ?? [];

  for (const relation of input.relations) {
    const list = blockersByBlockedIssueId.get(relation.blockedIssueId) ?? [];
    list.push(relation);
    blockersByBlockedIssueId.set(relation.blockedIssueId, list);

    const blocker = issuesById.get(relation.blockerIssueId);
    const blocked = issuesById.get(relation.blockedIssueId);
    if (
      blocker &&
      blocked &&
      blocker.companyId === relation.companyId &&
      blocked.companyId === relation.companyId &&
      blocker.status !== "done" &&
      blocker.status !== "cancelled" &&
      blocked.status === "blocked"
    ) {
      unresolvedBlockers.add(blocker.id);
    }
  }

  for (const relations of blockersByBlockedIssueId.values()) {
    relations.sort((left, right) => {
      const leftIssue = issuesById.get(left.blockerIssueId);
      const rightIssue = issuesById.get(right.blockerIssueId);
      const leftLabel = leftIssue ? issueLabel(leftIssue) : left.blockerIssueId;
      const rightLabel = rightIssue ? issueLabel(rightIssue) : right.blockerIssueId;
      return leftLabel.localeCompare(rightLabel);
    });
  }

  function hasExplicitWaitingPath(issue: IssueLivenessIssueInput) {
    return Boolean(issue.assigneeUserId) ||
      hasScheduledMonitor(issue, nowMs) ||
      hasActiveExecutionPath(issue.companyId, issue.id, activeRuns, queuedWakeRequests) ||
      hasWaitingPath(issue.companyId, issue.id, pendingInteractions) ||
      hasWaitingPath(issue.companyId, issue.id, pendingApprovals) ||
      hasWaitingPath(issue.companyId, issue.id, openRecoveryIssues);
  }

  function reviewFinding(
    source: IssueLivenessIssueInput,
    reviewIssue: IssueLivenessIssueInput,
    dependencyPath: IssueLivenessIssueInput[],
  ): IssueLivenessFinding | null {
    if (reviewIssue.status !== "in_review") return null;
    if (hasExplicitWaitingPath(reviewIssue)) return null;

    const ownerCandidates = ownerCandidatesForRecoveryIssue(reviewIssue, input.agents, agentsById, {
      includeStalledAssignee: true,
    });

    const participant = reviewIssue.executionState?.currentParticipant;
    const participantAgentId = readPrincipalAgentId(participant);
    if (participantAgentId) {
      const participantAgent = agentsById.get(participantAgentId);
      if (isInvokableAgent(participantAgent) && participantAgent?.companyId === reviewIssue.companyId) return null;

      return finding({
        issue: source,
        state: "invalid_review_participant",
        reason: participantAgent
          ? `${issueLabel(reviewIssue)} is in review, but current participant agent is ${participantAgent.status}.`
          : `${issueLabel(reviewIssue)} is in review, but current participant agent cannot be resolved.`,
        dependencyPath,
        recoveryIssue: reviewIssue,
        recommendedOwnerCandidateAgentIds: ownerCandidates.map((candidate) => candidate.agentId),
        recommendedOwnerCandidates: ownerCandidates,
        recommendedAction:
          `Repair ${issueLabel(reviewIssue)}'s review participant or return the issue to an active assignee with a clear change request.`,
        participantAgentId,
      });
    }

    if (principalIsResolvableUser(participant)) return null;

    if (reviewIssue.executionState) {
      return finding({
        issue: source,
        state: "invalid_review_participant",
        reason: `${issueLabel(reviewIssue)} is in review, but its current participant cannot be resolved.`,
        dependencyPath,
        recoveryIssue: reviewIssue,
        recommendedOwnerCandidateAgentIds: ownerCandidates.map((candidate) => candidate.agentId),
        recommendedOwnerCandidates: ownerCandidates,
        recommendedAction:
          `Repair ${issueLabel(reviewIssue)}'s review participant or return the issue to an active assignee with a clear change request.`,
      });
    }

    if (!reviewIssue.assigneeAgentId || reviewIssue.assigneeUserId) return null;

    return finding({
      issue: source,
      state: "in_review_without_action_path",
      reason: `${issueLabel(reviewIssue)} is in review with an agent assignee but no participant, interaction, approval, user owner, wake, active run, or recovery issue owning the next action.`,
      dependencyPath,
      recoveryIssue: reviewIssue,
      recommendedOwnerCandidateAgentIds: ownerCandidates.map((candidate) => candidate.agentId),
      recommendedOwnerCandidates: ownerCandidates,
      recommendedAction:
        `Review ${issueLabel(reviewIssue)} and make the next action explicit: add a reviewer/interaction, return it to active work with a change request, mark it done if accepted, or open a bounded recovery issue.`,
      blockerIssueId: reviewIssue.id,
    });
  }

  function blockedFindingForLeaf(
    source: IssueLivenessIssueInput,
    blocker: IssueLivenessIssueInput,
    dependencyPath: IssueLivenessIssueInput[],
  ): IssueLivenessFinding | null {
    const ownerCandidates = ownerCandidatesForRecoveryIssue(blocker, input.agents, agentsById, {
      includeStalledAssignee: true,
    });

    if (blocker.status === "cancelled") {
      return finding({
        issue: source,
        state: "blocked_by_cancelled_issue",
        reason: `${issueLabel(source)} is still blocked by cancelled issue ${issueLabel(blocker)}.`,
        dependencyPath,
        recoveryIssue: blocker,
        recommendedOwnerCandidateAgentIds: ownerCandidates.map((candidate) => candidate.agentId),
        recommendedOwnerCandidates: ownerCandidates,
        recommendedAction:
          `Inspect ${issueLabel(blocker)} and either remove it from ${issueLabel(source)}'s blockers or replace it with an actionable unblock issue.`,
        blockerIssueId: blocker.id,
      });
    }

    if (hasExplicitWaitingPath(blocker)) return null;

    if (blocker.status === "in_review") {
      return reviewFinding(source, blocker, dependencyPath);
    }

    if (!blocker.assigneeAgentId && !blocker.assigneeUserId) {
      return finding({
        issue: source,
        state: "blocked_by_unassigned_issue",
        reason: `${issueLabel(source)} is blocked by unassigned issue ${issueLabel(blocker)} with no user owner.`,
        dependencyPath,
        recoveryIssue: blocker,
        recommendedOwnerCandidateAgentIds: ownerCandidates.map((candidate) => candidate.agentId),
        recommendedOwnerCandidates: ownerCandidates,
        recommendedAction:
          `Assign ${issueLabel(blocker)} to an owner who can complete it, or remove it from ${issueLabel(source)}'s blockers if it is no longer required.`,
        blockerIssueId: blocker.id,
      });
    }

    if (!blocker.assigneeAgentId) return null;

    const blockerAgent = agentsById.get(blocker.assigneeAgentId);
    if (!blockerAgent || blockerAgent.companyId !== source.companyId || BLOCKING_AGENT_STATUSES.has(blockerAgent.status)) {
      return finding({
        issue: source,
        state: "blocked_by_uninvokable_assignee",
        reason: blockerAgent
          ? `${issueLabel(source)} is blocked by ${issueLabel(blocker)}, but its assignee is ${blockerAgent.status}.`
          : `${issueLabel(source)} is blocked by ${issueLabel(blocker)}, but its assignee no longer exists.`,
        dependencyPath,
        recoveryIssue: blocker,
        recommendedOwnerCandidateAgentIds: ownerCandidates.map((candidate) => candidate.agentId),
        recommendedOwnerCandidates: ownerCandidates,
        recommendedAction:
          `Review ${issueLabel(blocker)} and assign it to an active owner or replace the blocker with an actionable issue.`,
        blockerIssueId: blocker.id,
      });
    }

    return null;
  }

  function firstBlockedChainFinding(
    source: IssueLivenessIssueInput,
    current: IssueLivenessIssueInput,
    dependencyPath: IssueLivenessIssueInput[],
    seen: Set<string>,
  ): IssueLivenessFinding | null {
    if (seen.has(current.id)) return null;
    seen.add(current.id);

    const relations = blockersByBlockedIssueId.get(current.id) ?? [];
    for (const relation of relations) {
      if (relation.companyId !== current.companyId || relation.companyId !== source.companyId) continue;
      const blocker = issuesById.get(relation.blockerIssueId);
      if (!blocker || blocker.companyId !== source.companyId || blocker.status === "done") continue;
      const path = [...dependencyPath, blocker];

      if (blocker.status === "blocked") {
        const nested = firstBlockedChainFinding(source, blocker, path, new Set(seen));
        if (nested) return nested;
        if (hasExplicitWaitingPath(blocker)) continue;
      }

      const leafFinding = blockedFindingForLeaf(source, blocker, path);
      if (leafFinding) return leafFinding;
    }

    return null;
  }

  for (const issue of input.issues) {
    if (issue.status === "blocked") {
      if (unresolvedBlockers.has(issue.id)) continue;
      const chainFinding = firstBlockedChainFinding(issue, issue, [issue], new Set());
      if (chainFinding) findings.push(chainFinding);
    }

    if (issue.status === "in_review" && !unresolvedBlockers.has(issue.id)) {
      const review = reviewFinding(issue, issue, [issue]);
      if (review) findings.push(review);
    }
  }

  return findings;
}
