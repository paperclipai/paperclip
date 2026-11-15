import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  agents,
  approvals,
  budgetIncidents,
  budgetPolicies,
  companies,
  companyMemberships,
  decisionBundles,
  decisionRetention,
  decisionTriage,
  decisions,
  heartbeatRunEvents,
  heartbeatRuns,
  invites,
  issueApprovals,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issueWorkProducts,
  issues,
  joinRequests,
  projects,
  type Db,
} from "@paperclipai/db";
import { seedIssueReadVisibilityFixture } from "./issue-read-visibility-fixture.js";
import type { ReviewAttentionFixture } from "./review-attention-fixture.js";

const HOUR_MS = 3_600_000, DAY_MS = 24 * HOUR_MS;
const EXHAUSTED = "Bounded retry exhausted after 4 scheduled attempts; no further automatic retry will be queued";
const QUESTIONS = {
  version: 1,
  questions: [{ id: "q1", prompt: "Which option?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }],
};

/** The board actors of the visibility fixture: every membership role and every way a board user signs in. */
export const ATTENTION_SUMMARY_BOARD_ACTORS = [
  "board owner", "board admin", "board operator", "board viewer", "board member", "board key operator",
  "cloud tenant owner", "cloud tenant viewer", "instance admin", "local implicit board", "board without membership",
] as const;

export type AttentionSummaryFixture = Awaited<ReturnType<typeof seedAttentionSummaryFixture>>;

/**
 * One company with a card of every attention source on every kind of task a
 * reader may or may not see: open tasks, private tasks readable through
 * creation, a grant or an assignment, private tasks nobody in the fixture may
 * read, tasks of a private project, a hidden task and a chat container. It
 * adds cards that join into one obligation, cards for one person, cards with
 * no owner, old cards that move to an escalation owner, snoozed and archived
 * cards, and the same sources in a second company. A third company is empty.
 */
export async function seedAttentionSummaryFixture(db: Db) {
  const visibility = await seedIssueReadVisibilityFixture(db, { publicCount: 12 });
  const { companyId, foreignCompanyId, users, publicIds } = visibility;
  const now = Date.now();
  const at = (msAgo: number) => new Date(now - msAgo);

  const pausedAgentId = randomUUID(), erroredAgentId = randomUUID(), terminatedAgentId = randomUUID();
  const foreignErroredAgentId = randomUUID();
  await db.insert(agents).values([
    { id: pausedAgentId, companyId, name: "Paused", role: "engineer", adapterType: "process", status: "paused" },
    { id: erroredAgentId, companyId, name: "Errored", role: "engineer", adapterType: "process", status: "error", errorReason: "No credentials" },
    { id: terminatedAgentId, companyId, name: "Terminated", role: "engineer", adapterType: "process", status: "terminated" },
    { id: foreignErroredAgentId, companyId: foreignCompanyId, name: "Foreign errored", role: "engineer", adapterType: "process",
      status: "error", errorReason: "No credentials" },
  ]);
  // No default decision owner: a card without an owner waits in Unassigned.
  await db.update(companies).set({ budgetOwnerUserId: users.owner }).where(eq(companies.id, companyId));
  await db.update(projects).set({ decisionOwnerUserId: users.operator }).where(eq(projects.id, visibility.openProjectId));

  const approval = async (input: {
    company?: string; issueId?: string | null; type?: string; requestedByUserId?: string | null;
    requestedByAgentId?: string | null; updatedAt?: Date; title?: string;
  }) => {
    const id = randomUUID(), company = input.company ?? companyId;
    await db.insert(approvals).values({
      id, companyId: company, type: input.type ?? "request_board_approval", status: "pending",
      payload: { title: input.title ?? "Approve this" }, requestedByUserId: input.requestedByUserId ?? null,
      requestedByAgentId: input.requestedByAgentId ?? null,
      createdAt: input.updatedAt ?? at(2 * HOUR_MS), updatedAt: input.updatedAt ?? at(2 * HOUR_MS),
    });
    if (input.issueId) await db.insert(issueApprovals).values({ companyId: company, issueId: input.issueId, approvalId: id });
    return id;
  };
  const interaction = async (input: {
    company?: string; issueId: string; kind?: string; payload?: Record<string, unknown>; status?: string;
    addresseeUserId?: string | null; addresseeAgentId?: string | null; createdByAgentId?: string | null; createdAt?: Date;
  }) => {
    const id = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id, companyId: input.company ?? companyId, issueId: input.issueId, kind: input.kind ?? "ask_user_questions",
      status: input.status ?? "pending", continuationPolicy: "wake_assignee",
      payload: (input.payload ?? QUESTIONS) as never,
      addresseeUserId: input.addresseeUserId ?? null, addresseeAgentId: input.addresseeAgentId ?? null,
      createdByAgentId: input.createdByAgentId ?? null,
      createdAt: input.createdAt ?? at(3 * HOUR_MS), updatedAt: input.createdAt ?? at(3 * HOUR_MS),
    });
    return id;
  };
  const run = async (input: { company?: string; agentId: string; issueId?: string | null; status: string; createdAt: Date }) => {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id, companyId: input.company ?? companyId, agentId: input.agentId, status: input.status,
      contextSnapshot: input.issueId ? { issueId: input.issueId } : {},
      createdAt: input.createdAt, updatedAt: input.createdAt, finishedAt: input.createdAt,
    });
    return id;
  };
  const failedRun = async (input: { company?: string; agentId: string; issueId?: string | null; createdAt?: Date }) => {
    const id = await run({ ...input, status: "failed", createdAt: input.createdAt ?? at(HOUR_MS) });
    await db.insert(heartbeatRunEvents).values({
      companyId: input.company ?? companyId, runId: id, agentId: input.agentId, seq: 1, eventType: "lifecycle", message: EXHAUSTED,
    });
    return id;
  };
  const decision = async (input: { company?: string; agentId: string; issueId: string; bundle?: boolean }) => {
    const id = randomUUID(), company = input.company ?? companyId;
    // Older than every failed run, so it never counts as a newer run of the task.
    const originRunId = await run({ company, agentId: input.agentId, issueId: input.issueId, status: "succeeded", createdAt: at(2 * DAY_MS) });
    const origin = { companyId: company, originAgentId: input.agentId, originIssueId: input.issueId, originRunId };
    const bundleId = input.bundle
      ? (await db.insert(decisionBundles).values({ ...origin, title: "Bundle", summary: "Two decisions" }).returning())[0]!.id
      : null;
    await db.insert(decisions).values({
      id, ...origin, bundleId, title: "Choose", body: "Choose one option.", options: [], status: "open",
      signedSpec: "test", targetSnapshots: {}, expiresAt: new Date(now + 7 * DAY_MS),
      createdAt: at(4 * HOUR_MS), updatedAt: at(4 * HOUR_MS),
    });
    return id;
  };
  const recovery = async (input: { issueId: string; ownerType: "user" | "board"; ownerUserId?: string | null; status?: string }) => {
    const id = randomUUID();
    await db.insert(issueRecoveryActions).values({
      id, companyId, sourceIssueId: input.issueId, kind: "missing_disposition", status: input.status ?? "active",
      ownerType: input.ownerType, ownerUserId: input.ownerUserId ?? null, cause: "missing_disposition",
      fingerprint: `recovery:${id}`, evidence: {}, nextAction: "Choose the final disposition.",
    });
    return id;
  };
  /** One card of each source that hangs on a task. */
  const cardsOn = async (issueId: string, agentId = visibility.readerAgentId) => ({
    approvalId: await approval({ issueId, requestedByAgentId: agentId }),
    interactionId: await interaction({ issueId, createdByAgentId: agentId }),
    decisionId: await decision({ agentId, issueId }),
    recoveryId: await recovery({ issueId, ownerType: "user", ownerUserId: users.operator }),
    failedRunId: await failedRun({ agentId, issueId }),
  });

  // Cards on each kind of task. A reader gets the cards of the tasks they can read.
  const cards = {
    open: await cardsOn(publicIds[0]!),
    openInProject: await cardsOn(publicIds[2]!),
    ownedPrivate: await cardsOn(visibility.ownedPrivateIds[0]!),
    ownedPrivateChild: await cardsOn(visibility.ownedPrivateIds[1]!),
    grantedPrivate: await cardsOn(visibility.grantedPrivateIds[0]!),
    assignedPrivate: await cardsOn(visibility.assignedPrivateIds[1]!, visibility.assigneeAgentId),
    unreadablePrivate: await cardsOn(visibility.unreadablePrivateIds[0]!),
    privateProject: await cardsOn(visibility.privateProjectIssueIds[0]!),
    hidden: await cardsOn(visibility.hiddenId),
  };
  await db.insert(issueWorkProducts).values([publicIds[0]!, visibility.ownedPrivateIds[0]!].map((issueId) => ({
    companyId, issueId, type: "pull_request", provider: "github", title: "Pull request", status: "open",
  })));

  // Reviews: for a person, for a human participant, behind a pending approval,
  // and stalled; one of each on tasks that only some readers see.
  const reviewFor = (userId: string) => ({
    status: "pending", currentStageId: randomUUID(), currentStageIndex: 0, currentStageType: "review",
    currentParticipant: { type: "user", userId, agentId: null }, returnAssignee: null, completedStageIds: [],
    lastDecisionId: null, lastDecisionOutcome: null,
  });
  const review = (issueId: string, values: Partial<typeof issues.$inferInsert>) =>
    db.update(issues).set({ status: "in_review", updatedAt: at(5 * HOUR_MS), ...values }).where(eq(issues.id, issueId));
  await review(publicIds[4]!, { assigneeUserId: users.operator });
  await review(publicIds[5]!, { assigneeAgentId: visibility.readerAgentId, executionState: reviewFor(users.viewer) });
  await review(publicIds[6]!, { assigneeAgentId: visibility.readerAgentId });
  const reviewApprovalId = await approval({ issueId: publicIds[6]!, requestedByUserId: users.member });
  await review(publicIds[7]!, { assigneeAgentId: visibility.readerAgentId });
  await review(visibility.ownedPrivateIds[2]!, { assigneeUserId: users.owner });
  await review(visibility.grantedPrivateIds[2]!, { assigneeAgentId: visibility.readerAgentId });
  await review(visibility.unreadablePrivateIds[2]!, { assigneeUserId: visibility.strangerUserId });
  await review(visibility.privateProjectIssueIds[1]!, { assigneeAgentId: visibility.readerAgentId });

  // Blocked work: tasks a person must unblock, and tasks behind blockers that
  // nobody works on. Two tasks behind one blocker changed at the same instant,
  // so the order of the task list decides which one its card names.
  const blockedAt = at(6 * HOUR_MS), descriptorAt = at(HOUR_MS);
  const task = async (values: Partial<typeof issues.$inferInsert> & { title: string; status: string }) => {
    const id = randomUUID();
    await db.insert(issues).values({ id, companyId, createdByUserId: visibility.strangerUserId, ...values });
    return id;
  };
  const boardOwned = await task({ title: "Board must unblock", status: "blocked", blockedTransitionAt: descriptorAt,
    unblockDescriptor: { owner: "board", action: "Choose how to continue." } as never });
  const operatorOwned = await task({ title: "Operator must unblock", status: "blocked", blockedTransitionAt: descriptorAt,
    unblockDescriptor: { owner: { userId: users.operator }, action: "Send the contract." } as never });
  const privateBoardOwned = visibility.unreadablePrivateIds[1]!;
  await db.update(issues).set({ status: "blocked", blockedTransitionAt: descriptorAt,
    unblockDescriptor: { owner: "board", action: "Choose how to continue." } as never }).where(eq(issues.id, privateBoardOwned));
  const unownedBlocker = await task({ title: "Nobody works on this", status: "todo" });
  const pausedBlocker = await task({ title: "Paused agent works on this", status: "todo", assigneeAgentId: pausedAgentId });
  const cancelledBlocker = await task({ title: "Cancelled", status: "cancelled" });
  const sharedBlocker = await task({ title: "Two tasks wait for this", status: "todo" });
  const waiting = await Promise.all([unownedBlocker, pausedBlocker, cancelledBlocker, sharedBlocker, sharedBlocker,
    visibility.unreadablePrivateIds[0]!, visibility.ownedPrivateIds[1]!].map(async (blockerId, index) => {
    const id = await task({ title: `Waits ${index}`, status: "blocked", priority: index === 4 ? "high" : "medium",
      createdAt: blockedAt, updatedAt: blockedAt, blockedTransitionAt: blockedAt });
    await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: id, type: "blocks" });
    return id;
  }));
  // A chain: this task waits for a blocked task, which waits for nobody's task.
  const chained = await task({ title: "Waits behind a chain", status: "blocked", blockedTransitionAt: blockedAt });
  await db.insert(issueRelations).values({ companyId, issueId: waiting[0]!, relatedIssueId: chained, type: "blocks" });
  // A failed run on a task a person must unblock joins that card.
  await failedRun({ agentId: visibility.readerAgentId, issueId: boardOwned });
  await failedRun({ agentId: visibility.readerAgentId, issueId: sharedBlocker });

  // Failed runs that are not cards: a newer run of the same task, a terminated agent.
  const retried = await failedRun({ agentId: visibility.readerAgentId, issueId: publicIds[8]!, createdAt: at(3 * HOUR_MS) });
  await run({ agentId: visibility.readerAgentId, issueId: publicIds[8]!, status: "succeeded", createdAt: at(2 * HOUR_MS) });
  const terminated = await failedRun({ agentId: terminatedAgentId, issueId: publicIds[9]! });
  const withoutTask = await failedRun({ agentId: visibility.readerAgentId, issueId: null });

  // Requests with one recipient, with an agent recipient, replaced requests and a chat container.
  const forViewer = await interaction({ issueId: publicIds[1]!, addresseeUserId: users.viewer });
  const forWorkingAgent = await interaction({ issueId: publicIds[1]!, addresseeAgentId: visibility.readerAgentId });
  const forPausedAgent = await interaction({ issueId: publicIds[1]!, addresseeAgentId: pausedAgentId });
  const plan = { version: 1, prompt: "Accept the plan?", target: { type: "issue_document", key: "plan", revisionId: randomUUID() } };
  const replacedPlan = await interaction({ issueId: publicIds[3]!, kind: "request_confirmation", payload: plan, createdAt: at(9 * HOUR_MS) });
  const currentPlan = await interaction({ issueId: publicIds[3]!, kind: "request_confirmation", payload: plan, createdAt: at(8 * HOUR_MS) });
  const settledOver = await interaction({ issueId: publicIds[10]!, kind: "request_confirmation",
    payload: { version: 1, prompt: "Continue?" }, createdAt: at(9 * HOUR_MS) });
  await interaction({ issueId: publicIds[10]!, kind: "request_confirmation", status: "accepted",
    payload: { version: 1, prompt: "Continue?" }, createdAt: at(8 * HOUR_MS) });
  const governed = await interaction({ issueId: publicIds[10]!, kind: "request_confirmation", createdAt: at(10 * HOUR_MS),
    payload: { version: 1, prompt: "Run the tool?", toolAction: { tool: "deploy", arguments: {} } } });
  const chat = await task({ title: "Chat", status: "todo", conversationAgentId: visibility.readerAgentId,
    conversationUserId: users.member, conversationState: "active", assigneeAgentId: visibility.readerAgentId });
  const inChat = await interaction({ issueId: chat });
  const chatApproval = await approval({ issueId: chat, requestedByAgentId: visibility.readerAgentId });

  // Approvals without a task: from a person, from an agent, a hire, and an old one.
  const fromOwner = await approval({ requestedByUserId: users.owner });
  const fromAgent = await approval({ requestedByAgentId: visibility.readerAgentId });
  const hire = await approval({ type: "hire_agent", requestedByAgentId: visibility.readerAgentId });
  const oldFromViewer = await approval({ requestedByUserId: users.viewer, updatedAt: at(40 * DAY_MS) });
  const oldUnowned = await interaction({ issueId: publicIds[11]!, createdAt: at(10 * DAY_MS) });
  const bundled = await decision({ agentId: visibility.readerAgentId, issueId: publicIds[1]!, bundle: true });

  // Company alerts: join request, budget incidents, agents in error.
  const [invite] = await db.insert(invites).values({ companyId, tokenHash: `hash-${randomUUID()}`, allowedJoinTypes: "both",
    expiresAt: new Date(now + DAY_MS) }).returning();
  const joinRequestId = randomUUID();
  await db.insert(joinRequests).values({ id: joinRequestId, inviteId: invite!.id, companyId, requestType: "human",
    status: "pending_approval", requestIp: "127.0.0.1", requestEmailSnapshot: "new@example.test" });
  const policies = await db.insert(budgetPolicies).values([
    { companyId, scopeType: "company", scopeId: companyId, metric: "billed_cents", windowKind: "calendar_month_utc", amount: 100 },
    { companyId, scopeType: "company", scopeId: companyId, metric: "billed_cents", windowKind: "lifetime", amount: 100 },
    { companyId, scopeType: "agent", scopeId: visibility.readerAgentId, metric: "billed_cents", windowKind: "calendar_month_utc", amount: 100 },
  ]).returning();
  const overrideApprovalId = await approval({ type: "budget_override_required", requestedByAgentId: visibility.readerAgentId });
  const window = { windowStart: new Date(Date.UTC(2026, 10, 1)), windowEnd: new Date(Date.UTC(2026, 11, 1)) };
  const incidents = await db.insert(budgetIncidents).values([
    { ...window, companyId, policyId: policies[0]!.id, scopeType: "company", scopeId: companyId, metric: "billed_cents",
      windowKind: "calendar_month_utc", thresholdType: "soft", amountLimit: 100, amountObserved: 90, status: "open" },
    { ...window, companyId, policyId: policies[1]!.id, scopeType: "company", scopeId: companyId, metric: "billed_cents",
      windowKind: "lifetime", thresholdType: "soft", amountLimit: 100, amountObserved: 50, status: "open" },
    { ...window, companyId, policyId: policies[2]!.id, scopeType: "agent", scopeId: visibility.readerAgentId, metric: "billed_cents",
      windowKind: "calendar_month_utc", thresholdType: "hard", amountLimit: 100, amountObserved: 120, status: "open",
      approvalId: overrideApprovalId },
  ]).returning();

  // Cards that the company snoozed or archived for everybody.
  const snoozedForAll = await approval({ requestedByUserId: users.owner });
  await db.insert(decisionTriage).values({ companyId, sourceKind: "approval", sourceId: snoozedForAll, decideBy: "whenever",
    setByType: "user", setByUserId: users.owner, snoozedUntil: new Date(now + DAY_MS) });
  const archivedAt = at(12 * HOUR_MS);
  const archivedForAll = await interaction({ issueId: publicIds[11]!, createdAt: archivedAt });
  await db.insert(decisionRetention).values({ companyId, sourceKind: "issue_thread_interaction", sourceId: archivedForAll,
    sourceActivityAt: archivedAt, archivedAt: at(HOUR_MS), archivedReason: "retention", archivedByType: "system" });

  // The same sources in another company. No count of this company may read them.
  const foreignIssueId = visibility.foreignIds[0]!;
  const foreign = {
    approvalId: await approval({ company: foreignCompanyId, issueId: foreignIssueId, requestedByAgentId: visibility.foreignAgentId }),
    interactionId: await interaction({ company: foreignCompanyId, issueId: foreignIssueId }),
    decisionId: await decision({ company: foreignCompanyId, agentId: visibility.foreignAgentId, issueId: foreignIssueId }),
    failedRunId: await failedRun({ company: foreignCompanyId, agentId: visibility.foreignAgentId, issueId: foreignIssueId }),
  };
  await db.update(issues).set({ status: "in_review", assigneeUserId: visibility.outsiderUserId })
    .where(eq(issues.id, visibility.foreignIds[1]!));

  const emptyCompanyId = randomUUID();
  await db.insert(companies).values({ id: emptyCompanyId, name: `Empty ${emptyCompanyId}`,
    issuePrefix: `E${emptyCompanyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
  await db.insert(companyMemberships).values({ companyId: emptyCompanyId, principalType: "user", principalId: users.owner,
    status: "active", membershipRole: "owner" });

  return {
    ...visibility, emptyCompanyId, pausedAgentId, erroredAgentId, terminatedAgentId, foreignErroredAgentId,
    cards, foreign,
    reviewApprovalId, overrideApprovalId, joinRequestId, incidentIds: incidents.map((incident) => incident.id),
    blocked: { boardOwned, operatorOwned, privateBoardOwned, waiting, chained, unownedBlocker, pausedBlocker, cancelledBlocker, sharedBlocker },
    notCards: { retried, terminated, forWorkingAgent, replacedPlan, settledOver, chatApproval, snoozedForAll, archivedForAll },
    named: { forViewer, forPausedAgent, currentPlan, governed, inChat, fromOwner, fromAgent, hire, oldFromViewer, oldUnowned,
      bundled, withoutTask },
  };
}

/**
 * Sources that a real company has and the review fixture leaves out: budget
 * policies, pull requests, plans and questions that seed the decision queues,
 * open decisions and failed runs. They make one summary request read what the
 * request of a real company reads.
 */
export async function seedAttentionSummaryVolume(db: Db, fixture: ReviewAttentionFixture, options: {
  budgetPolicies?: number; pullRequests?: number; questions?: number; plans?: number; failedRuns?: number;
} = {}) {
  const { companyId, agentIds } = fixture;
  const count = (value: number | undefined, fallback: number) => value ?? fallback;
  const working = await db.select({ id: agents.id }).from(agents)
    .where(and(eq(agents.companyId, companyId), inArray(agents.status, ["idle", "running"])))
    .then((rows) => new Set(rows.map((row) => row.id)));
  const workingAgentIds = agentIds.filter((id) => working.has(id));
  const pick = <Value>(values: Value[], index: number) => values[index % values.length]!;
  const taskIds = fixture.taskIds;
  const chunked = async <Row>(rows: Row[], write: (chunk: Row[]) => Promise<unknown>) => {
    for (let start = 0; start < rows.length; start += 500) await write(rows.slice(start, start + 500));
  };

  const policyCount = count(options.budgetPolicies, Math.min(agentIds.length, 20));
  await chunked(Array.from({ length: policyCount }, (_unused, index) => index === 0
    ? { companyId, scopeType: "company", scopeId: companyId, metric: "billed_cents", windowKind: "calendar_month_utc", amount: 100_000 }
    : { companyId, scopeType: "agent", scopeId: agentIds[index % agentIds.length]!, metric: "billed_cents",
      windowKind: index < agentIds.length ? "calendar_month_utc" : "lifetime", amount: 10_000 }),
  (chunk) => db.insert(budgetPolicies).values(chunk).onConflictDoNothing());

  await chunked(Array.from({ length: count(options.pullRequests, Math.floor(fixture.reviewIds.length / 4)) }, (_unused, index) => ({
    companyId, issueId: fixture.reviewIds[index * 4]!, type: "pull_request", provider: "github", title: "Pull request", status: "open",
  })), (chunk) => db.insert(issueWorkProducts).values(chunk));

  const questions = count(options.questions, 20), plans = count(options.plans, 20);
  await chunked(Array.from({ length: questions + plans }, (_unused, index) => ({
    companyId, issueId: pick(taskIds, index * 17 + 3), status: "pending", continuationPolicy: "wake_assignee",
    kind: index < questions ? "ask_user_questions" : "request_confirmation",
    payload: (index < questions
      ? QUESTIONS
      : { version: 1, prompt: "Accept the plan?", target: { type: "issue_document", key: "plan", revisionId: randomUUID() } }) as never,
  })), (chunk) => db.insert(issueThreadInteractions).values(chunk));

  const failed = Array.from({ length: count(options.failedRuns, 20) }, (_unused, index) => ({
    id: randomUUID(), companyId, agentId: pick(workingAgentIds, index), status: "failed",
    contextSnapshot: { issueId: pick(taskIds, index * 29 + 11) },
  }));
  await chunked(failed, (chunk) => db.insert(heartbeatRuns).values(chunk));
  await chunked(failed, (chunk) => db.insert(heartbeatRunEvents).values(chunk.map((failedRun) => ({
    companyId, runId: failedRun.id, agentId: failedRun.agentId, seq: 1, eventType: "lifecycle", message: EXHAUSTED,
  }))));
  return { budgetPolicies: policyCount, questions, plans, failedRuns: failed.length };
}
