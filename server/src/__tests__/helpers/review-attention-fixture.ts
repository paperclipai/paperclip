import { createHash, randomUUID } from "node:crypto";
import {
  agentWakeupRequests,
  agents,
  approvals,
  authUsers,
  chatActions,
  chatConversations,
  chatDeliveries,
  chatEndpointResources,
  chatEndpoints,
  chatExternalPrincipals,
  chatGitHubReviews,
  chatIdentityLinks,
  chatMessageLinks,
  companies,
  companyMemberships,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issues,
  runIdentityContexts,
  toolApplications,
  toolConnections,
  type Db,
} from "@paperclipai/db";
import { defaultGitHubReviewPolicy } from "@paperclipai/shared";
import { buildIssueGraphLivenessIncidentKey, RECOVERY_ORIGIN_KINDS } from "../../services/recovery/origins.js";

/**
 * A synthetic company for the review-attention read path: tasks of every
 * status with children, tasks in review that cover every review path and every
 * way a review stalls, blocked tasks behind chains, cycles and terminal
 * blockers, open recovery tasks, and reviews that wait for an external reply.
 * The shape depends only on the options, so two fixtures of the same options
 * differ only in their ids.
 */
export interface ReviewAttentionFixtureOptions {
  tasks: number;
  agents: number;
  prefix: string;
  /** Open recovery tasks whose origin names a task of this company. */
  recoveryTasks?: number;
  descriptionBytes?: number;
  /** Reviews that wait for a GitHub reply. Needs `tasks` >= 320 to seed any. */
  externalWaits?: boolean;
}

export type ReviewAttentionFixture = Awaited<ReturnType<typeof seedReviewAttentionFixture>>;

export const REVIEW_ATTENTION_FIXTURE_USER = "review-attention-board";
export const REVIEW_ATTENTION_FIXTURE_REVIEWER = "review-attention-reviewer";

const STATUS_BY_SLOT = [
  "in_review", "in_review", "blocked", "blocked", "cancelled", "backlog", "todo", "todo", "in_progress", "done",
  "done", "done", "done", "done", "done", "done", "done", "done", "done", "done",
] as const;

async function insertChunks<Row>(rows: Row[], write: (chunk: Row[]) => Promise<unknown>) {
  for (let start = 0; start < rows.length; start += 500) await write(rows.slice(start, start + 500));
}

export async function seedReviewAttentionFixture(db: Db, options: ReviewAttentionFixtureOptions) {
  const companyId = randomUUID();
  const now = Date.now();
  const descriptionBytes = options.descriptionBytes ?? 2_000;
  await db.insert(companies).values({
    id: companyId, name: `${options.prefix} review attention`, issuePrefix: options.prefix,
    requireBoardApprovalForNewAgents: false,
  });
  for (const id of [REVIEW_ATTENTION_FIXTURE_USER, REVIEW_ATTENTION_FIXTURE_REVIEWER]) {
    await db.insert(authUsers).values({
      id, name: id === REVIEW_ATTENTION_FIXTURE_USER ? "Board Member" : "Reviewer", email: `${id}@example.test`,
      createdAt: new Date(now), updatedAt: new Date(now),
    }).onConflictDoNothing();
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: id, status: "active", membershipRole: "owner",
    });
  }

  // A reporting tree of five reports per manager. The root and the reviewer
  // (index 1) stay invokable; some of the others are paused, terminated or
  // waiting for approval, so reviews and blockers meet uninvokable owners.
  const agentStatus = (index: number) => index < 2 ? "idle"
    : index % 11 === 5 ? "paused"
      : index % 13 === 7 ? "terminated"
        : index % 17 === 9 ? "pending_approval"
          : index % 3 === 0 ? "running" : "idle";
  const agentRows = Array.from({ length: options.agents }, (_unused, index) => ({
    id: randomUUID(), companyId, name: `${options.prefix} agent ${index}`, role: index === 0 ? "ceo" : "engineer",
    status: agentStatus(index), adapterType: "process",
  }));
  const agentIds = agentRows.map(agent => agent.id);
  // Managers are inserted before their reports.
  await insertChunks(agentRows.map((agent, index) => ({
    ...agent, reportsTo: index === 0 ? null : agentIds[Math.floor((index - 1) / 5)]!,
  })), chunk => db.insert(agents).values(chunk));
  const invokableAgentIds = agentRows.filter((_agent, index) => {
    for (let current = index; ; current = Math.floor((current - 1) / 5)) {
      if (agentStatus(current) === "terminated") return false;
      if (current === index && !["idle", "running"].includes(agentStatus(current))) return false;
      if (current === 0) return true;
    }
  }).map(agent => agent.id);
  const pausedAgentIds = agentRows.filter((_agent, index) => agentStatus(index) === "paused").map(agent => agent.id);
  const pick = <Value>(values: Value[], index: number) => values[index % values.length]!;

  type Task = typeof issues.$inferInsert & { id: string; status: string };
  const tasks: Task[] = Array.from({ length: options.tasks }, (_unused, index) => ({
    id: randomUUID(), companyId, issueNumber: index + 1, identifier: `${options.prefix}-${index + 1}`,
    title: `${options.prefix} task ${index + 1}`,
    description: `Task ${index + 1}. ${"x".repeat(descriptionBytes)}`,
    status: STATUS_BY_SLOT[index % STATUS_BY_SLOT.length]!, priority: "medium",
    assigneeAgentId: pick(agentIds, index * 7), createdByAgentId: pick(agentIds, index * 3),
    createdAt: new Date(now - (options.tasks - index) * 60_000),
    updatedAt: new Date(now - (options.tasks - index) * 30_000),
  }));
  // Four of every five tasks are children of the first task of their group.
  for (const [index, task] of tasks.entries()) if (index % 5 !== 0) task.parentId = tasks[index - index % 5]!.id;
  const byStatus = (status: string) => tasks.filter(task => task.status === status);
  const reviews = byStatus("in_review"), blocked = byStatus("blocked");
  const todo = byStatus("todo"), backlog = byStatus("backlog"), cancelled = byStatus("cancelled");
  const done = byStatus("done"), inProgress = byStatus("in_progress");

  const reviewsOf = (...variants: number[]) => reviews.filter((_review, index) => variants.includes(index % 16));
  for (const review of reviewsOf(0, 1, 2, 3)) review.assigneeAgentId = pick(invokableAgentIds, tasks.indexOf(review));
  for (const review of reviewsOf(4)) {
    review.assigneeAgentId = null;
    review.assigneeUserId = REVIEW_ATTENTION_FIXTURE_REVIEWER;
  }
  // A review stage that waits for its participant.
  const waitingFor = (currentParticipant: Record<string, unknown> | null) => ({
    status: "pending", currentStageId: randomUUID(), currentStageIndex: 0, currentStageType: "review", currentParticipant,
    returnAssignee: null, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
  });
  for (const [index, review] of reviewsOf(5).entries()) {
    review.executionState = waitingFor({ type: "agent", agentId: pick(invokableAgentIds, index), userId: null });
  }
  for (const [index, review] of reviewsOf(6).entries()) {
    review.executionState = waitingFor({ type: "agent", agentId: pick(pausedAgentIds, index), userId: null });
  }
  for (const review of reviewsOf(7)) {
    review.executionState = waitingFor({ type: "user", userId: REVIEW_ATTENTION_FIXTURE_REVIEWER, agentId: null });
  }
  for (const review of reviewsOf(8)) {
    review.monitorNextCheckAt = new Date(now + 3_600_000);
    review.executionPolicy = { monitor: { maxAttempts: 3 } };
  }
  for (const review of reviewsOf(14)) review.executionState = waitingFor(null);
  const externalWaits = options.externalWaits === false ? [] : reviewsOf(15);
  // The endpoint that waits for the reply is assigned to the reviewer agent.
  for (const review of reviewsOf(15)) review.assigneeAgentId = agentIds[1]!;

  for (const [index, task] of blocked.entries()) {
    task.blockedTransitionAt = new Date(now - 3_600_000);
    if (index % 10 === 9) {
      task.unblockDescriptor = { owner: "board", action: "Choose how to continue this task." } as never;
    }
  }
  for (const [index, task] of todo.entries()) {
    if (index % 3 === 0) task.assigneeAgentId = null;
    if (index % 3 === 1) task.assigneeAgentId = pick(pausedAgentIds, index);
  }
  await insertChunks(tasks, chunk => db.insert(issues).values(chunk));

  const stalledReviews = reviewsOf(0, 1, 2, 3);
  const relations: Array<{ blocker: Task; blocked: Task }> = [];
  for (const [index, task] of blocked.entries()) {
    const variant = index % 10;
    const next = blocked[index + 1];
    if (variant === 0) relations.push({ blocker: pick(stalledReviews, index), blocked: task });
    if (variant === 1) relations.push({ blocker: pick(todo.filter((_task, at) => at % 3 === 0), index), blocked: task });
    if (variant === 2) relations.push({ blocker: pick(backlog, index), blocked: task });
    if (variant === 3) relations.push({ blocker: pick(cancelled, index), blocked: task });
    if (variant === 4) relations.push({ blocker: pick(done, index), blocked: task });
    // A chain: this task waits for the next blocked task, which waits for a
    // task whose assignee is paused.
    if (variant === 5 && next) relations.push({ blocker: next, blocked: task });
    if (variant === 6) relations.push({ blocker: pick(todo.filter((_task, at) => at % 3 === 1), index), blocked: task });
    // A cycle of two blocked tasks. The second also waits for running work.
    if (variant === 7 && next) relations.push({ blocker: next, blocked: task }, { blocker: task, blocked: next });
    if (variant === 8) relations.push({ blocker: pick(inProgress, index), blocked: task });
    if (variant === 9) relations.push({ blocker: pick(inProgress, index + 1), blocked: task });
  }
  await insertChunks(relations, chunk => db.insert(issueRelations).values(chunk.map(relation => ({
    companyId, issueId: relation.blocker.id, relatedIssueId: relation.blocked.id, type: "blocks" as const,
  }))));

  await insertChunks(reviewsOf(9), chunk => db.insert(issueThreadInteractions).values(chunk.map((review, index) => ({
    companyId, issueId: review.id, kind: "request_confirmation", status: "pending", continuationPolicy: "wake_assignee",
    ...(index % 2 === 0 ? {} : {
      requestedResolverPolicy: "human_only" as const, effectiveResolverPolicy: "human_only" as const,
      resolverPolicyProvenance: "explicit" as const, effectiveResolverPolicySource: "requested" as const,
    }),
    payload: { version: 1, prompt: "Accept this work?" } as never,
  }))));
  const approvalRows = reviewsOf(10).map(review => ({ id: randomUUID(), issueId: review.id }));
  await insertChunks(approvalRows, chunk => db.insert(approvals).values(chunk.map(row => ({
    id: row.id, companyId, type: "request_board_approval", status: "pending", payload: { title: "Review" },
  }))));
  await insertChunks(approvalRows, chunk => db.insert(issueApprovals).values(chunk.map(row => ({
    companyId, issueId: row.issueId, approvalId: row.id,
  }))));
  await insertChunks(reviewsOf(11), chunk => db.insert(agentWakeupRequests).values(chunk.map(review => ({
    companyId, agentId: review.assigneeAgentId!, source: "automation", reason: "issue_commented", status: "queued",
    payload: { issueId: review.id },
  }))));
  // Running work on a review, and on the tasks that block other tasks.
  await insertChunks([...reviewsOf(12), ...inProgress], chunk => db.insert(heartbeatRuns).values(chunk.map(task => ({
    companyId, agentId: task.assigneeAgentId!, status: "running", contextSnapshot: { issueId: task.id },
  }))));
  await insertChunks(reviewsOf(13), chunk => db.insert(issueRecoveryActions).values(chunk.map(review => ({
    companyId, sourceIssueId: review.id, kind: "missing_disposition", status: "active", ownerType: "agent",
    ownerAgentId: review.assigneeAgentId!, cause: "review_path_lost", fingerprint: `review-path:${review.id}`,
    evidence: {}, nextAction: "Restore the review path",
  }))));

  // Open recovery tasks. Their origin names a stalled review (which they then
  // cover), a blocked task, or a task that no longer waits.
  const recoveryTargets = [...stalledReviews.filter((_review, index) => index % 4 === 3), ...blocked, ...done];
  const recoveryTasks = Array.from({ length: options.recoveryTasks ?? Math.floor(options.tasks / 20) }, (_unused, index) => {
    const target = pick(recoveryTargets, index);
    const stranded = index % 2 === 0;
    return {
      id: randomUUID(), companyId, issueNumber: options.tasks + index + 1,
      identifier: `${options.prefix}-${options.tasks + index + 1}`, title: `Recover ${target.identifier}`,
      status: "todo", priority: "high", assigneeAgentId: pick(invokableAgentIds, index),
      originKind: stranded ? RECOVERY_ORIGIN_KINDS.strandedIssueRecovery : RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation,
      originId: stranded ? target.id : buildIssueGraphLivenessIncidentKey({
        companyId, issueId: target.id, state: "in_review_without_action_path", blockerIssueId: target.id,
      }),
      originFingerprint: `recovery:${index}`,
    };
  });
  await insertChunks(recoveryTasks, chunk => db.insert(issues).values(chunk));

  if (externalWaits.length > 0) await seedExternalReviewWaits(db, companyId, agentIds[1]!, externalWaits.map(review => review.id));

  // What the fixture is built to produce, stated without the classification:
  // the kinds of the paths that cover each review, or why it is stalled.
  const kindsByVariant: Record<number, string[]> = {
    4: ["human_reviewer"], 5: ["execution_participant"], 7: ["execution_participant"], 8: ["monitor"],
    9: ["interaction"], 10: ["approval"], 11: ["queued_wake"], 12: ["active_run"], 13: ["recovery"],
    15: externalWaits.length > 0 ? ["external_response"] : [],
  };
  const recoveredIds = recoveryTasks.map((_task, index) => pick(recoveryTargets, index).id);
  const expectedReviews = reviews.map((review, index) => {
    const variant = index % 16;
    const kinds = [...(kindsByVariant[variant] ?? []), ...recoveredIds.filter(id => id === review.id).map(() => "recovery")];
    return {
      id: review.id, identifier: review.identifier!, variant, kinds,
      stalledReason: kinds.length > 0 ? null
        : variant === 6 ? "current participant agent is paused"
          : variant === 14 ? "its current participant cannot be resolved"
            : "is in review with an agent assignee but no participant",
    };
  });

  return {
    companyId, userId: REVIEW_ATTENTION_FIXTURE_USER, agentIds, taskIds: tasks.map(task => task.id),
    reviewIds: reviews.map(review => review.id), blockedIds: blocked.map(task => task.id),
    externalWaitIds: externalWaits.map(review => review.id), expectedReviews,
    counts: {
      tasks: tasks.length, agents: agentRows.length, reviews: reviews.length, blocked: blocked.length,
      relations: relations.length, recoveryTasks: recoveryTasks.length, externalWaits: externalWaits.length,
    },
  };
}

/**
 * Each task waits in review for the next GitHub reply to a published review:
 * its last status decision moved it there, and the run that made the decision
 * succeeded on a conversation of an endpoint assigned to the task's agent.
 */
async function seedExternalReviewWaits(db: Db, companyId: string, agentId: string, issueIds: string[]) {
  const sql = db.$client;
  const applicationId = randomUUID(), connectionId = randomUUID(), endpointId = randomUUID(), resourceId = randomUUID();
  const principalId = randomUUID(), user = REVIEW_ATTENTION_FIXTURE_REVIEWER;
  const repository = "synthetic/repository", repositoryId = "42", headSha = "1".repeat(40);
  await db.insert(toolApplications).values({ id: applicationId, companyId, name: "GitHub", type: "chat" });
  await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "GitHub",
    uid: connectionId, transport: "chat_sdk", connectionPurpose: "channel", enabled: true, status: "active" });
  await db.insert(chatEndpoints).values({ id: endpointId, companyId, connectionId, provider: "github",
    publicId: endpointId, assignedAgentId: agentId, status: "active", providerAccountId: `synthetic-${companyId}` });
  await db.insert(chatEndpointResources).values({ id: resourceId, companyId, endpointId, type: "repository",
    providerResourceId: repository, label: repository, metadata: { providerRepositoryId: repositoryId },
    availability: "available", enabled: true });
  await db.insert(chatExternalPrincipals).values({ id: principalId, companyId, provider: "github",
    providerAccountId: `synthetic-${companyId}`, externalId: "1", kind: "user" });
  await db.insert(chatIdentityLinks).values({ companyId, endpointId, principalId, paperclipUserId: user, status: "linked" });

  const waits = issueIds.map((issueId, index) => ({
    issueId, pullNumber: index + 1, runId: randomUUID(), reviewRunId: randomUUID(), reviewId: randomUUID(),
    decisionId: randomUUID(), conversationId: randomUUID(), commentId: randomUUID(), deliveryId: randomUUID(),
    contextId: randomUUID(),
  }));
  await sql.begin(async tx => {
    // Skip the work-assessment owner chain of the status decisions.
    await tx.unsafe("set local session_replication_role = replica");
    await tx.unsafe(`update issues set last_status_decision_id = w.decision_id
      from unnest($1::uuid[], $2::uuid[]) as w(issue_id, decision_id) where issues.id = w.issue_id`,
    [waits.map(wait => wait.issueId), waits.map(wait => wait.decisionId)]);
    await tx.unsafe(`insert into status_decisions (id, company_id, issue_id, run_id, assessment_id, decision_version, policy_version,
        from_status, to_status, reason_code, decision_json, decision_digest, application_state, applied_at)
      select w.decision_id, $1::uuid, w.issue_id, w.run_id, gen_random_uuid(), 1, 'v1', 'in_progress', 'in_review',
        'external_chat_response_waiting', '{}'::jsonb, w.decision_id::text, 'applied', now()
      from unnest($2::uuid[], $3::uuid[], $4::uuid[]) as w(decision_id, issue_id, run_id)`,
    [companyId, waits.map(wait => wait.decisionId), waits.map(wait => wait.issueId), waits.map(wait => wait.runId)]);
  });
  await insertChunks(waits, chunk => db.insert(heartbeatRuns).values(chunk.flatMap(wait => [
    { id: wait.runId, companyId, agentId, status: "succeeded", runtimeMode: "native", nativeIssueId: wait.issueId,
      responsibleUserId: user, activeIdentityContextId: wait.contextId, contextSnapshot: { prompt: "x".repeat(1024) } },
    { id: wait.reviewRunId, companyId, agentId, status: "succeeded", nativeIssueId: wait.issueId },
  ])));
  await insertChunks(waits, chunk => db.insert(issueComments).values(chunk.map(wait => ({ id: wait.commentId, companyId,
    issueId: wait.issueId, authorType: "user" as const, authorUserId: user, body: "Review" }))));
  await insertChunks(waits, chunk => db.insert(runIdentityContexts).values(chunk.map(wait => ({ id: wait.contextId,
    companyId, runId: wait.runId, revision: 1, responsibleUserId: user, messageId: wait.commentId, parentContextId: null,
    cause: "instruction", correlationId: "fixture", status: "accepted" }))));
  await insertChunks(waits, chunk => db.insert(chatConversations).values(chunk.map(wait => ({ id: wait.conversationId,
    companyId, endpointId, resourceId, issueId: wait.issueId, externalConversationId: repository,
    externalThreadId: `github:${repository}:${wait.pullNumber}`, externalLabel: "Review", state: "waiting" }))));
  await insertChunks(waits, chunk => db.insert(chatDeliveries).values(chunk.map(wait => ({ id: wait.deliveryId, companyId,
    endpointId, conversationId: wait.conversationId, principalId, providerEventId: wait.deliveryId,
    deduplicationKey: wait.deliveryId, eventKind: "message" as const, state: "processed" as const, normalizedEvent: {},
    processedAt: new Date() }))));
  await insertChunks(waits, chunk => db.insert(chatMessageLinks).values(chunk.map(wait => ({ companyId, endpointId,
    conversationId: wait.conversationId, deliveryId: wait.deliveryId, commentId: wait.commentId,
    providerMessageId: wait.commentId, direction: "inbound" }))));
  await insertChunks(waits, chunk => db.insert(chatGitHubReviews).values(chunk.map(wait => ({ id: wait.reviewId, companyId,
    endpointId, issueId: wait.issueId, runId: wait.reviewRunId, repositoryId, repository, pullNumber: wait.pullNumber,
    headSha, deliveryId: wait.reviewId, configurationRevision: 1, state: "completed" as const,
    policySnapshot: defaultGitHubReviewPolicy(),
    event: { event: "mention" as const, deliveryId: wait.reviewId, repositoryId, repository, pullNumber: wait.pullNumber,
      title: "Review", body: "", baseSha: "0".repeat(40), headSha, baseBranch: "main",
      author: { id: "1", login: "author", isBot: false }, sender: { id: "1", login: "author" }, draft: false, labels: [] },
    assessment: { reviewedCommit: headSha, score: 5 as const, complete: true, summary: "Reviewed", rationale: "Reviewed",
      coverage: { reviewedPaths: [], omittedPaths: [], limitations: [] }, findings: [] } }))));
  await insertChunks(waits, chunk => db.insert(chatActions).values(chunk.map(wait => ({ companyId, endpointId,
    kind: "github_review_publication", status: "processed",
    providerActionId: `github_publication:${wait.issueId}:assessment:${createHash("sha256").update(JSON.stringify(wait.reviewId)).digest("hex")}` }))));
}
