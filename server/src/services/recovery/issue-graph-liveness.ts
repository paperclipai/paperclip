import { getAgentWorkEligibility, type AgentWorkEligibility } from "@paperclipai/shared";
import { buildIssueGraphLivenessIncidentKey } from "./origins.js";

export type IssueLivenessSeverity = "warning" | "critical";

export type IssueLivenessState =
  | "blocked_by_unassigned_issue"
  | "blocked_by_assigned_backlog_issue"
  | "blocked_by_uninvokable_assignee"
  | "blocked_by_cancelled_issue"
  | "invalid_review_participant"
  | "in_review_without_action_path";

export interface IssueLivenessIssueInput {
  conversationAgentId?: string | null;
  conversationUserId?: string | null;
  conversationState?: string | null;
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
  id?: string | null;
  companyId: string;
  issueId: string | null;
  agentId?: string | null;
  status: string;
  createdAt?: Date | string | null;
}

export interface IssueLivenessWaitingPathInput {
  id?: string | null;
  companyId: string;
  issueId: string;
  status: string;
  createdAt?: Date | string | null;
}

export type IssueReviewPathFactKind =
  | "execution_participant"
  | "interaction"
  | "approval"
  | "monitor"
  | "external_response"
  | "human_reviewer"
  | "active_run"
  | "queued_wake"
  | "recovery";

export interface IssueReviewPathFact {
  kind: IssueReviewPathFactKind;
  ref: string | null;
  agentId: string | null;
  userId: string | null;
  since: Date | string | null;
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
  externalResponseWaits?: IssueLivenessWaitingPathInput[];
  openRecoveryIssues?: IssueLivenessWaitingPathInput[];
  now?: Date | string;
}

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

/**
 * What one classification reads about a company, built once and shared by
 * every task it classifies: the agents by id, whether each can be invoked,
 * the invokable agents of each company in id order, and the execution and
 * waiting paths of each task. Classifying a task then costs its own paths,
 * not a pass over every agent and every path of the company.
 */
interface IssueGraphLivenessIndex {
  nowMs: number;
  agentsById: Map<string, IssueLivenessAgentInput>;
  eligibility(agent: IssueLivenessAgentInput): AgentWorkEligibility;
  isInvokable(agent: IssueLivenessAgentInput | null | undefined): boolean;
  invokableAgents(companyId: string): readonly IssueLivenessAgentInput[];
  activeRuns(issue: IssueLivenessIssueInput): readonly IssueLivenessExecutionPathInput[];
  queuedWakeRequests(issue: IssueLivenessIssueInput): readonly IssueLivenessExecutionPathInput[];
  pendingInteractions(issue: IssueLivenessIssueInput): readonly IssueLivenessWaitingPathInput[];
  pendingApprovals(issue: IssueLivenessIssueInput): readonly IssueLivenessWaitingPathInput[];
  externalResponseWaits(issue: IssueLivenessIssueInput): readonly IssueLivenessWaitingPathInput[];
  openRecoveryIssues(issue: IssueLivenessIssueInput): readonly IssueLivenessWaitingPathInput[];
}

const NO_PATHS: readonly never[] = Object.freeze([]);

/** The paths of one task, in the order the input lists them. */
function pathsByIssue<Path extends { companyId: string; issueId: string | null }>(
  paths: Path[] | undefined,
): (issue: IssueLivenessIssueInput) => readonly Path[] {
  let byIssueId: Map<string, Path[]> | null = null;
  return (issue) => {
    if (!paths || paths.length === 0) return NO_PATHS;
    if (!byIssueId) {
      byIssueId = new Map();
      for (const path of paths) {
        const issueId = path.issueId;
        if (issueId === null) continue;
        const list = byIssueId.get(issueId);
        if (list) list.push(path);
        else byIssueId.set(issueId, [path]);
      }
    }
    const ofIssue = byIssueId.get(issue.id);
    if (!ofIssue) return NO_PATHS;
    return ofIssue.every((path) => path.companyId === issue.companyId)
      ? ofIssue
      : ofIssue.filter((path) => path.companyId === issue.companyId);
  };
}

function createIssueGraphLivenessIndex(input: IssueGraphLivenessInput): IssueGraphLivenessIndex {
  const agentsById = new Map(input.agents.map((agent) => [agent.id, agent]));
  const agentList = [...agentsById.values()];
  // Keyed by the agent record, not its id: the input may list an id twice.
  const eligibilityByAgent = new Map<IssueLivenessAgentInput, AgentWorkEligibility>();
  const invokableAgentsByCompanyId = new Map<string, IssueLivenessAgentInput[]>();

  function eligibility(agent: IssueLivenessAgentInput) {
    let result = eligibilityByAgent.get(agent);
    if (!result) {
      result = getAgentWorkEligibility({ agent, agents: agentList });
      eligibilityByAgent.set(agent, result);
    }
    return result;
  }

  function isInvokable(agent: IssueLivenessAgentInput | null | undefined) {
    return Boolean(agent && eligibility(agent).invokable);
  }

  return {
    nowMs: readDateMs(input.now ?? new Date()) ?? Date.now(),
    agentsById,
    eligibility,
    isInvokable,
    invokableAgents(companyId) {
      let result = invokableAgentsByCompanyId.get(companyId);
      if (!result) {
        result = input.agents
          .filter((agent) => agent.companyId === companyId && isInvokable(agent))
          .sort((left, right) => left.id.localeCompare(right.id));
        invokableAgentsByCompanyId.set(companyId, result);
      }
      return result;
    },
    activeRuns: pathsByIssue(input.activeRuns),
    queuedWakeRequests: pathsByIssue(input.queuedWakeRequests),
    pendingInteractions: pathsByIssue(input.pendingInteractions),
    pendingApprovals: pathsByIssue(input.pendingApprovals),
    externalResponseWaits: pathsByIssue(input.externalResponseWaits),
    openRecoveryIssues: pathsByIssue(input.openRecoveryIssues),
  };
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

/** A saved, unconsumed check remains dispatchable when its due time passes. */
export function hasUnconsumedIssueMonitorPath(issue: IssueLivenessIssueInput, now: Date | string | number) {
  const nowMs = typeof now === "number" ? now : readDateMs(now) ?? Date.now();
  const nextCheckAtMs = readDateMs(issue.monitorNextCheckAt);
  if (nextCheckAtMs === null) return false;

  const { policyMonitor, stateMonitor } = monitorFromIssue(issue);
  const timeoutAtMs = readDateMs(policyMonitor?.timeoutAt ?? stateMonitor?.timeoutAt);
  if (timeoutAtMs !== null && timeoutAtMs <= nowMs) return false;

  const maxAttempts = readPositiveInteger(policyMonitor?.maxAttempts ?? stateMonitor?.maxAttempts);
  const stateAttemptCount = readPositiveInteger(stateMonitor?.attemptCount) ?? 0;
  const attemptCount = issue.monitorAttemptCount ?? stateAttemptCount;
  if (maxAttempts !== null && attemptCount >= maxAttempts) return false;

  return true;
}

export function hasScheduledIssueMonitorPath(issue: IssueLivenessIssueInput, now: Date | string | number) {
  const nowMs = typeof now === "number" ? now : readDateMs(now) ?? Date.now();
  const nextCheckAtMs = readDateMs(issue.monitorNextCheckAt);
  return nextCheckAtMs !== null && nextCheckAtMs > nowMs && hasUnconsumedIssueMonitorPath(issue, nowMs);
}

export function classifyIssueReviewPaths(
  input: IssueGraphLivenessInput,
  issue: IssueLivenessIssueInput,
): IssueReviewPathFact[] {
  if (issue.status !== "in_review") return [];
  return reviewPaths(createIssueGraphLivenessIndex(input), issue);
}

/**
 * Review paths for many tasks of one input. The agents and paths of the input
 * are indexed once, so the cost of each task does not grow with the company.
 * Each task gets the paths `classifyIssueReviewPaths` returns for it. The
 * input must not change while the classifier is in use.
 */
export function createIssueReviewPathClassifier(
  input: IssueGraphLivenessInput,
): (issue: IssueLivenessIssueInput) => IssueReviewPathFact[] {
  const index = createIssueGraphLivenessIndex(input);
  return (issue) => reviewPaths(index, issue);
}

function reviewPaths(
  index: IssueGraphLivenessIndex,
  issue: IssueLivenessIssueInput,
): IssueReviewPathFact[] {
  if (issue.status !== "in_review") return [];
  const paths: IssueReviewPathFact[] = [];
  if (issue.conversationAgentId && issue.conversationUserId && issue.conversationState === "waiting") {
    return [{ kind: "human_reviewer", ref: issue.conversationUserId, userId: issue.conversationUserId, agentId: null, since: null }];
  }

  if (issue.assigneeUserId) {
    paths.push({
      kind: "human_reviewer",
      ref: issue.assigneeUserId,
      agentId: null,
      userId: issue.assigneeUserId,
      since: null,
    });
  }

  const participant = issue.executionState?.status === "pending"
    ? issue.executionState.currentParticipant
    : null;
  const participantAgentId = readPrincipalAgentId(participant);
  if (participantAgentId) {
    const participantAgent = index.agentsById.get(participantAgentId);
    if (participantAgent?.companyId === issue.companyId && index.isInvokable(participantAgent)) {
      paths.push({
        kind: "execution_participant",
        ref: participantAgentId,
        agentId: participantAgentId,
        userId: null,
        since: null,
      });
    }
  } else if (principalIsResolvableUser(participant)) {
    const userId = (participant as Record<string, unknown>).userId as string;
    paths.push({
      kind: "execution_participant",
      ref: userId,
      agentId: null,
      userId,
      since: null,
    });
  }

  if (hasScheduledIssueMonitorPath(issue, index.nowMs)) {
    paths.push({ kind: "monitor", ref: null, agentId: issue.assigneeAgentId ?? null, userId: null, since: null });
  }

  const appendExecutionPaths = (
    entries: readonly IssueLivenessExecutionPathInput[],
    kind: "active_run" | "queued_wake",
  ) => {
    for (const entry of entries) {
      paths.push({
        kind,
        ref: entry.id ?? null,
        agentId: entry.agentId ?? null,
        userId: null,
        since: entry.createdAt ?? null,
      });
    }
  };
  appendExecutionPaths(index.activeRuns(issue), "active_run");
  appendExecutionPaths(index.queuedWakeRequests(issue), "queued_wake");

  const appendWaitingPaths = (
    entries: readonly IssueLivenessWaitingPathInput[],
    kind: "interaction" | "approval" | "recovery" | "external_response",
  ) => {
    for (const entry of entries) {
      paths.push({
        kind,
        ref: entry.id ?? null,
        agentId: null,
        userId: null,
        since: entry.createdAt ?? null,
      });
    }
  };
  appendWaitingPaths(index.pendingInteractions(issue), "interaction");
  appendWaitingPaths(index.pendingApprovals(issue), "approval");
  appendWaitingPaths(index.externalResponseWaits(issue), "external_response");
  appendWaitingPaths(index.openRecoveryIssues(issue), "recovery");

  return paths;
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
  index: IssueGraphLivenessIndex,
  companyId: string,
  agentId: string | null | undefined,
  reason: IssueLivenessOwnerCandidateReason,
  sourceIssueId: string,
) {
  if (!agentId || seen.has(agentId)) return;
  const agent = index.agentsById.get(agentId);
  if (!agent || agent.companyId !== companyId || !index.isInvokable(agent)) return;
  seen.add(agentId);
  candidates.push({ agentId, reason, sourceIssueId });
}

function addAgentChainCandidates(
  candidates: IssueLivenessOwnerCandidate[],
  seen: Set<string>,
  startAgentId: string | null | undefined,
  index: IssueGraphLivenessIndex,
  companyId: string,
  reason: IssueLivenessOwnerCandidateReason,
  sourceIssueId: string,
) {
  const chainSeen = new Set<string>();
  let current = startAgentId ? index.agentsById.get(startAgentId) : null;

  while (current?.reportsTo) {
    if (chainSeen.has(current.reportsTo)) break;
    chainSeen.add(current.reportsTo);
    const manager = index.agentsById.get(current.reportsTo);
    if (!manager || manager.companyId !== companyId) break;
    addOwnerCandidate(candidates, seen, index, companyId, manager.id, reason, sourceIssueId);
    current = manager;
  }
}

function ownerCandidatesForRecoveryIssue(
  issue: IssueLivenessIssueInput,
  index: IssueGraphLivenessIndex,
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
      index,
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
    index,
    issue.companyId,
    "assignee_reporting_chain",
    issue.id,
  );
  addAgentChainCandidates(
    candidates,
    seen,
    issue.createdByAgentId,
    index,
    issue.companyId,
    "creator_reporting_chain",
    issue.id,
  );

  const invokableAgents = index.invokableAgents(issue.companyId);
  for (const agent of invokableAgents) {
    if (!agent.reportsTo) {
      addOwnerCandidate(candidates, seen, index, issue.companyId, agent.id, "root_agent", issue.id);
    }
  }
  for (const agent of invokableAgents) {
    addOwnerCandidate(
      candidates,
      seen,
      index,
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
  const index = createIssueGraphLivenessIndex(input);
  const { nowMs, agentsById } = index;
  const issuesById = new Map(input.issues.map((issue) => [issue.id, issue]));
  const blockersByBlockedIssueId = new Map<string, IssueLivenessRelationInput[]>();
  const unresolvedBlockers = new Set<string>();
  const findings: IssueLivenessFinding[] = [];

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
      hasScheduledIssueMonitorPath(issue, nowMs) ||
      index.activeRuns(issue).length > 0 ||
      index.queuedWakeRequests(issue).length > 0 ||
      index.pendingInteractions(issue).length > 0 ||
      index.pendingApprovals(issue).length > 0 ||
      index.openRecoveryIssues(issue).length > 0;
  }

  function reviewFinding(
    source: IssueLivenessIssueInput,
    reviewIssue: IssueLivenessIssueInput,
    dependencyPath: IssueLivenessIssueInput[],
  ): IssueLivenessFinding | null {
    if (reviewIssue.status !== "in_review") return null;
    if (reviewPaths(index, reviewIssue).length > 0) return null;

    const ownerCandidates = ownerCandidatesForRecoveryIssue(reviewIssue, index, {
      includeStalledAssignee: true,
    });

    const hasPendingExecutionState = reviewIssue.executionState?.status === "pending";
    const participant = hasPendingExecutionState
      ? reviewIssue.executionState?.currentParticipant
      : null;
    const participantAgentId = readPrincipalAgentId(participant);
    if (participantAgentId) {
      const participantAgent = agentsById.get(participantAgentId);
      if (index.isInvokable(participantAgent) && participantAgent?.companyId === reviewIssue.companyId) return null;

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

    if (hasPendingExecutionState) {
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
    const ownerCandidates = ownerCandidatesForRecoveryIssue(blocker, index, {
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

    if (blocker.status === "backlog" && blocker.assigneeAgentId) {
      return finding({
        issue: source,
        state: "blocked_by_assigned_backlog_issue",
        reason: `${issueLabel(source)} is blocked by assigned backlog issue ${issueLabel(blocker)} with no wake, active run, human owner, interaction, approval, monitor, or recovery issue owning the next action.`,
        dependencyPath,
        recoveryIssue: blocker,
        recommendedOwnerCandidateAgentIds: ownerCandidates.map((candidate) => candidate.agentId),
        recommendedOwnerCandidates: ownerCandidates,
        recommendedAction:
          `Review ${issueLabel(blocker)} and either move it to todo so the assignee wakes, assign a human owner or interaction if it is intentionally parked, or remove it from ${issueLabel(source)}'s blockers if it is no longer required.`,
        blockerIssueId: blocker.id,
      });
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
    const blockerEligibility = blockerAgent
      ? index.eligibility(blockerAgent)
      : null;
    if (!blockerAgent || blockerAgent.companyId !== source.companyId || !blockerEligibility?.invokable) {
      return finding({
        issue: source,
        state: "blocked_by_uninvokable_assignee",
        reason: blockerAgent
          ? `${issueLabel(source)} is blocked by ${issueLabel(blocker)}, but its assignee is ${blockerEligibility?.invokabilityReason === "invalid_org_chain" ? "in an invalid org chain" : blockerAgent.status}.`
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
    const hasUnresolvedBlockerEdge = (blockersByBlockedIssueId.get(issue.id) ?? []).some((relation) => {
      if (relation.companyId !== issue.companyId) return false;
      const blocker = issuesById.get(relation.blockerIssueId);
      return Boolean(blocker && blocker.companyId === issue.companyId && blocker.status !== "done");
    });
    const shouldInspectBlockedChain = issue.status === "blocked" || (
      issue.status !== "done" &&
      issue.status !== "cancelled" &&
      Boolean(issue.assigneeAgentId) &&
      hasUnresolvedBlockerEdge
    );

    let chainFinding: IssueLivenessFinding | null = null;
    if (shouldInspectBlockedChain) {
      if (unresolvedBlockers.has(issue.id)) continue;
      chainFinding = firstBlockedChainFinding(issue, issue, [issue], new Set());
      if (chainFinding) findings.push(chainFinding);
    }

    if (issue.status === "in_review" && !chainFinding && !unresolvedBlockers.has(issue.id)) {
      const review = reviewFinding(issue, issue, [issue]);
      if (review) findings.push(review);
    }
  }

  return findings;
}
