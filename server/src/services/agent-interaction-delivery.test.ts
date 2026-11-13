import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, agentWakeupRequests, companies, createDb, heartbeatRunEvents, heartbeatRuns, issueComments, issueThreadInteractions, issues, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { filterRunMessageInteractionDelivery, hasAutomaticInteractionDeliveryHold, preparedRunInteractionDeliveryDenied, recheckQueuedCommentInteractionDelivery,
  recheckQueuedRunInteractions, withInteractionDeliveryOrigin } from "./agent-interaction-delivery.js";
import { createHeartbeatQueue } from "./heartbeat/queue.js";
import { createHeartbeatQueueTestDependencies } from "../__tests__/helpers/heartbeat-queue.js";
import { withPluginInteractionOrigin } from "./plugin-interaction-context.js";
import { recoveryService } from "./recovery/service.js";
import { createAdmissionTransactionScope, createWakeAdmissionWriter } from "../modules/wake-queue/adapters/postgres.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("pending agent interaction delivery", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("interaction-delivery-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed() {
    const [company] = await db.insert(companies).values({ name: "Delivery", issuePrefix: `D${randomUUID().slice(0, 5)}` }).returning();
    const [sender, recipient] = await db.insert(agents).values([
      { companyId: company!.id, name: "Sender", adapterType: "process" },
      { companyId: company!.id, name: "Recipient", adapterType: "process" },
    ]).returning();
    const [issue] = await db.insert(issues).values({ companyId: company!.id, title: "Work", status: "todo", assigneeAgentId: recipient!.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company!.id, agentId: recipient!.id, status: "queued",
      invocationSource: "assignment", contextSnapshot: { issueId: issue!.id }, nativeIssueId: issue!.id }).returning();
    return { companyId: company!.id, sender: sender!.id, recipient: recipient!.id, issueId: issue!.id, run: run! };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;
  const restriction = (id: string, interactions: Record<string, boolean>) => db.update(agents)
    .set({ permissions: { interactions } }).where(eq(agents.id, id));
  const readRun = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;
  async function wake(f: Fixture, input: { commentIds?: string[]; actorType?: string | null; actorId?: string | null } = {}) {
    const context = { issueId: f.issueId, ...(input.commentIds ? { wakeCommentIds: input.commentIds, wakeCommentId: input.commentIds.at(-1) } : {}) };
    const [receipt] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.recipient,
      source: "assignment", reason: input.commentIds ? "issue_commented" : "issue_assigned", runId: f.run.id,
      requestedByActorType: input.actorType === undefined ? "agent" : input.actorType,
      requestedByActorId: input.actorId === undefined ? f.sender : input.actorId,
      payload: { issueId: f.issueId, _paperclipWakeContext: context },
    }).returning();
    await db.update(heartbeatRuns).set({ wakeupRequestId: receipt!.id, contextSnapshot: context }).where(eq(heartbeatRuns.id, f.run.id));
    return receipt!;
  }
  async function comment(f: Fixture, kind: "agent" | "user") {
    const [value] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, body: `${kind} input`,
      authorType: kind, ...(kind === "agent" ? { authorAgentId: f.sender } : { authorUserId: "human" }),
    }).returning();
    return value!.id;
  }

  it("keeps old queues unchanged when settings are absent", async () => {
    const f = await seed(); await wake(f, { actorType: null, actorId: null });
    const before = await readRun(f.run.id);
    expect(await recheckQueuedRunInteractions(db, before)).toEqual({ run: before, denied: false, denials: {} });
    expect(await readRun(f.run.id)).toEqual(before);
  });

  it("preserves an unrestricted old queue's rendered continuation and timestamps", async () => {
    const f = await seed(); const message = await comment(f, "agent"); const receipt = await wake(f, { commentIds: [message] });
    const run = await readRun(f.run.id);
    await db.update(heartbeatRuns).set({ contextSnapshot: { ...run.contextSnapshot,
      executionContinuation: { messages: [{ id: message, body: "saved input" }] }, paperclipWake: { retained: true },
    } }).where(eq(heartbeatRuns.id, run.id));
    const before = await readRun(run.id);
    const wakeBefore = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.id)))[0];
    expect((await recheckQueuedRunInteractions(db, before)).denied).toBe(false);
    expect(await readRun(run.id)).toEqual(before);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.id)))[0]).toEqual(wakeBefore);
  });

  it.each(["incoming", "outgoing"])("refuses a previously accepted assignment after %s revocation", async direction => {
    const f = await seed(); const receipt = await wake(f);
    await restriction(direction === "incoming" ? f.recipient : f.sender,
      direction === "incoming" ? { canReceiveAssignmentsFromAgents: false } : { canAssignTasksToAgents: false });
    const result = await recheckQueuedRunInteractions(db, await readRun(f.run.id));
    expect(result.denied).toBe(true);
    expect(result.denials.assignment).toMatchObject({ code: "agent_interaction_denied", direction });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.id)))[0]!.status).toBe("skipped");
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]!.assigneeAgentId).toBe(f.recipient);
    await restriction(f.sender, {}); await restriction(f.recipient, {});
    expect((await recheckQueuedRunInteractions(db, await readRun(f.run.id))).denied).toBe(true);
  });

  it("checks each author's permissions inside a mixed human and agent batch", async () => {
    const f = await seed(); const agentComment = await comment(f, "agent"), humanComment = await comment(f, "user");
    const receipt = await wake(f, { commentIds: [agentComment, humanComment], actorType: "user", actorId: "human" });
    await restriction(f.recipient, { canReceiveCommentsFromAgents: false });
    const result = await recheckQueuedRunInteractions(db, await readRun(f.run.id));
    expect(result.denied).toBe(false);
    expect(result.run.contextSnapshot?.wakeCommentIds).toEqual([humanComment]);
    expect(result.denials[agentComment]).toMatchObject({ permission: "canReceiveCommentsFromAgents" });
    const savedWake = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.id)))[0]!;
    expect(savedWake.status).toBe("queued");
    expect((savedWake.payload?._paperclipWakeContext as Record<string, unknown>).wakeCommentIds).toEqual([humanComment]);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toHaveLength(2);
  });

  it.each(["queued", "prepared"] as const)("rechecks every assignment in a %s run with an allowed coalesced comment", async boundary => {
    for (const assignmentFirst of [true, false]) for (const direction of ["outgoing", "incoming"]) {
      const f = await seed();
      const messageId = await comment(f, "user");
      const primary = await wake(f, assignmentFirst ? {} : { commentIds: [messageId], actorType: "user", actorId: "human" });
      const primaryOrigin = { actorType: primary.requestedByActorType, actorId: primary.requestedByActorId };
      await db.update(agentWakeupRequests).set({ payload: { ...primary.payload, interactionOrigin: primaryOrigin } })
        .where(eq(agentWakeupRequests.id, primary.id));
      const reason = assignmentFirst ? "issue_commented" : "issue_assigned";
      const context = { issueId: f.issueId, wakeReason: reason, ...(assignmentFirst ? { wakeCommentId: messageId, wakeCommentIds: [messageId] } : {}) };
      const actorType = assignmentFirst ? "user" : "agent", actorId = assignmentFirst ? "human" : f.sender;
      const payload = withInteractionDeliveryOrigin({ issueId: f.issueId, _paperclipWakeContext: context }, actorType, actorId);
      await db.transaction(tx => createWakeAdmissionWriter().coalesceIntoActiveExecutionRun(
        createAdmissionTransactionScope(f.companyId, tx as unknown as Db), {
          companyId: f.companyId, agentId: f.recipient, activeExecutionRunId: f.run.id, activeExecutionRunStatus: "queued",
          mergedContextSnapshot: { ...context, wakeCommentId: messageId, wakeCommentIds: [messageId] },
          source: "assignment", triggerDetail: "system", payload, requestedByActorType: actorType,
          requestedByActorId: actorId, idempotencyKey: null,
        },
      ));
      const receipts = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.runId, f.run.id));
      expect(receipts).toHaveLength(2);
      expect(receipts.find(row => row.id === primary.id)?.payload?.interactionOrigin).toEqual(primaryOrigin);
      const assignment = receipts.find(row => row.requestedByActorType === "agent")!;
      expect(assignment.payload?.interactionOrigin).toEqual({ actorType: "agent", actorId: f.sender });
      if (boundary === "queued") expect((await recheckQueuedRunInteractions(db, await readRun(f.run.id))).denied).toBe(false);
      else expect(await preparedRunInteractionDeliveryDenied(db, await readRun(f.run.id))).toBe(false);
      const permission = direction === "outgoing" ? "canAssignTasksToAgents" : "canReceiveAssignmentsFromAgents";
      await restriction(direction === "outgoing" ? f.sender : f.recipient, { [permission]: false });
      if (boundary === "queued") expect((await recheckQueuedRunInteractions(db, await readRun(f.run.id))).denied).toBe(true);
      else expect(await preparedRunInteractionDeliveryDenied(db, await readRun(f.run.id))).toBe(true);
      const denied = await readRun(f.run.id);
      expect(denied.resultJson?.interactionDeliveryDenied).toBe(true);
      expect((denied.resultJson?.interactionPermissionDenials as Record<string, unknown>).assignment)
        .toMatchObject({ actorAgentId: f.sender, permission });
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, assignment.id)))[0])
        .toMatchObject({ status: "skipped", error: "agent_interaction_delivery_denied", requestedByActorId: f.sender });
      expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]?.assigneeAgentId).toBe(f.recipient);
      expect(await db.select().from(issueComments).where(eq(issueComments.id, messageId))).toHaveLength(1);
      const retained = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)))
        .filter(row => row.status === "deferred_issue_execution");
      expect(retained).toHaveLength(1);
      expect(retained[0]).toMatchObject({ requestedByActorType: "user", requestedByActorId: "human", runId: null });
      await restriction(f.sender, {}); await restriction(f.recipient, {});
      if (boundary === "queued") expect((await recheckQueuedRunInteractions(db, await readRun(f.run.id))).denied).toBe(true);
      else expect(await preparedRunInteractionDeliveryDenied(db, await readRun(f.run.id))).toBe(true);
    }
  });

  it("does not apply assignment restrictions to a comment-only pending run", async () => {
    const f = await seed(); const message = await comment(f, "agent"); const receipt = await wake(f, { commentIds: [message] });
    await restriction(f.sender, { canAssignTasksToAgents: false });
    await restriction(f.recipient, { canReceiveAssignmentsFromAgents: false });
    expect((await recheckQueuedRunInteractions(db, await readRun(f.run.id))).denied).toBe(false);
    expect(await preparedRunInteractionDeliveryDenied(db, await readRun(f.run.id))).toBe(false);
    await db.update(heartbeatRuns).set({ wakeupRequestId: null, contextSnapshot: {
      issueId: f.issueId, wakeReason: "issue_execution_same_name", wakeCommentId: message, wakeCommentIds: [message],
    } }).where(eq(heartbeatRuns.id, f.run.id));
    await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.id));
    expect((await recheckQueuedRunInteractions(db, await readRun(f.run.id))).denied).toBe(false);
    expect(await preparedRunInteractionDeliveryDenied(db, await readRun(f.run.id))).toBe(false);
  });

  it.each(["queued", "prepared"] as const)("recovers an older %s assignment's audit origin when its wake is missing and comments were added", async boundary => {
    const f = await seed(); const messageId = await comment(f, "user");
    await db.insert(activityLog).values({ companyId: f.companyId, entityType: "issue", entityId: f.issueId,
      actorType: "agent", actorId: f.sender, agentId: f.sender, action: "issue.updated",
      createdAt: new Date(f.run.createdAt.getTime() - 1), details: { assigneeAgentId: f.recipient } });
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, wakeReason: "issue_assigned",
      wakeCommentId: messageId, wakeCommentIds: [messageId] } }).where(eq(heartbeatRuns.id, f.run.id));
    await restriction(f.sender, { canAssignTasksToAgents: false });
    if (boundary === "queued") expect((await recheckQueuedRunInteractions(db, await readRun(f.run.id))).denied).toBe(true);
    else expect(await preparedRunInteractionDeliveryDenied(db, await readRun(f.run.id))).toBe(true);
    expect(((await readRun(f.run.id)).resultJson?.interactionPermissionDenials as Record<string, unknown>).assignment)
      .toMatchObject({ actorAgentId: f.sender, permission: "canAssignTasksToAgents" });
    await restriction(f.sender, {});
    if (boundary === "queued") expect((await recheckQueuedRunInteractions(db, await readRun(f.run.id))).denied).toBe(true);
    else expect(await preparedRunInteractionDeliveryDenied(db, await readRun(f.run.id))).toBe(true);
  });

  it("makes refused steering permanent while leaving a running task running", async () => {
    const f = await seed(); const message = await comment(f, "agent"); const receipt = await wake(f, { commentIds: [message] });
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, f.run.id));
    await restriction(f.sender, { canCommentOnOtherTasks: false });
    const input = { companyId: f.companyId, issueId: f.issueId, agentId: f.recipient, commentId: message, queueId: receipt.id };
    await expect(withPluginInteractionOrigin({ companyId: f.companyId, agentId: f.recipient }, () =>
      recheckQueuedCommentInteractionDelivery(db, input))).rejects.toMatchObject({ status: 403 });
    expect((await readRun(f.run.id)).status).toBe("running");
    await restriction(f.sender, {});
    await expect(recheckQueuedCommentInteractionDelivery(db, input)).rejects.toMatchObject({ status: 403 });
  });

  it("refuses unknown older assignment provenance only for an explicitly restricted recipient", async () => {
    const f = await seed(); await wake(f, { actorType: null, actorId: null });
    await restriction(f.recipient, { canReceiveAssignmentsFromAgents: false });
    const result = await recheckQueuedRunInteractions(db, await readRun(f.run.id));
    expect(result.denials.assignment).toMatchObject({ code: "agent_interaction_provenance_unavailable" });
    const human = await seed(); await wake(human, { actorType: "user", actorId: "human" });
    await restriction(human.recipient, { canReceiveAssignmentsFromAgents: false });
    expect((await recheckQueuedRunInteractions(db, await readRun(human.run.id))).denied).toBe(false);
  });

  it.each(["wake", "run"])("recovers old assignment provenance within the same millisecond as its %s receipt", async source => {
    const f = await seed();
    await db.insert(activityLog).values({ companyId: f.companyId, entityType: "issue", entityId: f.issueId,
      actorType: "agent", actorId: f.sender, agentId: f.sender, action: "issue.updated",
      details: { assigneeAgentId: f.recipient }, createdAt: sql`'2026-11-09T12:00:00.000100Z'::timestamptz` });
    if (source === "wake") {
      const receipt = await wake(f, { actorType: null, actorId: null });
      await db.update(agentWakeupRequests).set({ requestedAt: sql`'2026-11-09T12:00:00.000900Z'::timestamptz` })
        .where(eq(agentWakeupRequests.id, receipt.id));
    } else {
      await db.update(heartbeatRuns).set({ createdAt: sql`'2026-11-09T12:00:00.000900Z'::timestamptz` })
        .where(eq(heartbeatRuns.id, f.run.id));
    }
    await restriction(f.sender, { canAssignTasksToAgents: false });
    const result = await recheckQueuedRunInteractions(db, await readRun(f.run.id));
    expect(result.denials.assignment).toMatchObject({ actorAgentId: f.sender, permission: "canAssignTasksToAgents" });
  });

  it.each(["canCommentOnOtherTasks", "canMentionAgents"])("checks %s for saved parent reports through a system dispatch envelope", async permission => {
    const f = await seed(); const receipt = await wake(f, { actorType: "system", actorId: "native-status-committer" });
    const payload = withInteractionDeliveryOrigin(receipt.payload, "system", "native-status-wake-dispatch", {
      actorType: "agent", actorId: f.sender, operation: "comment",
    });
    payload.childIssueSummaries = [{ summary: `Report for [@recipient](agent://${f.recipient})` }];
    await db.update(agentWakeupRequests).set({ payload, reason: "issue_children_completed" }).where(eq(agentWakeupRequests.id, receipt.id));
    await restriction(f.sender, { [permission]: false });
    expect((await recheckQueuedRunInteractions(db, await readRun(f.run.id))).denials.assignment)
      .toMatchObject({ actorAgentId: f.sender, operation: permission === "canMentionAgents" ? "mention" : "comment", permission });
  });

  it.each(["dismissed", "pending", "other_agent"])("delivers a dismissal wake only for a person's dismissal of the recipient's question (%s)", async mode => {
    const f = await seed();
    const [question] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId,
      createdByAgentId: mode === "other_agent" ? f.sender : f.recipient, kind: "ask_user_questions", status: "pending",
      title: "Codename", payload: { version: 1, questions: [] },
      ...(mode === "pending" ? {} : { dismissedAt: new Date(), dismissedByUserId: "human" }) }).returning();
    const receipt = await wake(f, { actorType: "system", actorId: "native-status-committer" });
    await db.update(agentWakeupRequests).set({ reason: "issue_question_dismissed",
      payload: { ...receipt.payload as Record<string, unknown>, dismissedInteractionId: question!.id } })
      .where(eq(agentWakeupRequests.id, receipt.id));
    await restriction(f.recipient, { canReceiveAssignmentsFromAgents: false });
    const result = await recheckQueuedRunInteractions(db, await readRun(f.run.id));
    expect(result.denied).toBe(mode !== "dismissed");
  });

  it("recovers an older automatic retry's initiating agent from its predecessor", async () => {
    const f = await seed(); await wake(f);
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "controller_lease_lost" }).where(eq(heartbeatRuns.id, f.run.id));
    const [retry] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.recipient, status: "queued",
      retryOfRunId: f.run.id, invocationSource: "automation", contextSnapshot: { issueId: f.issueId }, nativeIssueId: f.issueId }).returning();
    await restriction(f.sender, { canAssignTasksToAgents: false });
    expect((await recheckQueuedRunInteractions(db, retry!)).denials.assignment)
      .toMatchObject({ actorAgentId: f.sender, permission: "canAssignTasksToAgents" });
  });

  it("preserves a server-authorized import routine's source company at delivery", async () => {
    const source = await seed(), target = await seed();
    const receipt = await wake(target, { actorType: "agent", actorId: source.sender });
    await db.update(agentWakeupRequests).set({ payload: withInteractionDeliveryOrigin(receipt.payload,
      "agent", source.sender, undefined, source.companyId) }).where(eq(agentWakeupRequests.id, receipt.id));
    expect((await recheckQueuedRunInteractions(db, await readRun(target.run.id))).denied).toBe(false);
    await restriction(source.sender, { canAssignTasksToAgents: false });
    expect((await recheckQueuedRunInteractions(db, await readRun(target.run.id))).denials.assignment)
      .toMatchObject({ actorAgentId: source.sender, permission: "canAssignTasksToAgents" });
  });

  it("uses an originating agent run even when a decision effect is presented as a human comment", async () => {
    const f = await seed();
    const [origin] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.sender, status: "succeeded" }).returning();
    const [message] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorUserId: "human", authorType: "user", createdByRunId: origin!.id, body: "Agent-originated effect" }).returning();
    await wake(f, { commentIds: [message!.id], actorType: "user", actorId: "human" });
    await restriction(f.sender, { canCommentOnOtherTasks: false });
    const result = await recheckQueuedRunInteractions(db, await readRun(f.run.id));
    expect(result.denied).toBe(true);
    expect(result.denials[message!.id]).toMatchObject({ actorAgentId: f.sender, permission: "canCommentOnOtherTasks" });
  });

  it("rechecks rendered pending input after preparation and persists unread restart denial", async () => {
    const f = await seed(); const message = await comment(f, "agent"); await wake(f, { commentIds: [message] });
    expect(await preparedRunInteractionDeliveryDenied(db, await readRun(f.run.id))).toBe(false);
    await restriction(f.recipient, { canReceiveCommentsFromAgents: false });
    expect(await preparedRunInteractionDeliveryDenied(db, await readRun(f.run.id))).toBe(true);
    await restriction(f.recipient, {});
    expect(await filterRunMessageInteractionDelivery(db, { companyId: f.companyId, runId: f.run.id, issueId: f.issueId, commentIds: [message] })).toEqual(new Set());
  });

  it("retains allowed human input once when a mixed rendered startup must be refused", async () => {
    const f = await seed(); const agentComment = await comment(f, "agent"), humanComment = await comment(f, "user");
    await wake(f, { commentIds: [agentComment, humanComment] });
    await restriction(f.recipient, { canReceiveCommentsFromAgents: false });
    expect(await preparedRunInteractionDeliveryDenied(db, await readRun(f.run.id))).toBe(true);
    expect(await preparedRunInteractionDeliveryDenied(db, await readRun(f.run.id))).toBe(true);
    const retained = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)))
      .filter(row => row.status === "deferred_issue_execution");
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({ requestedByActorType: "user", requestedByActorId: "human", runId: null });
    expect((retained[0]!.payload?._paperclipWakeContext as Record<string, unknown>).wakeCommentIds).toEqual([humanComment]);
  });

  it("does not revoke recovery of an already accepted provider turn", async () => {
    const f = await seed(); await wake(f);
    await db.update(heartbeatRuns).set({ status: "running", startedAt: new Date() }).where(eq(heartbeatRuns.id, f.run.id));
    await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, agentId: f.recipient, runId: f.run.id,
      seq: 1, eventType: "turn.accepted", stream: "system", level: "info" });
    await restriction(f.recipient, { canReceiveAssignmentsFromAgents: false });
    expect(await preparedRunInteractionDeliveryDenied(db, await readRun(f.run.id))).toBe(false);
    expect((await readRun(f.run.id)).status).toBe("running");
  });

  it("cancels refused queued runs through the public queue claim without dispatch", async () => {
    const f = await seed(); await wake(f);
    await restriction(f.recipient, { canReceiveAssignmentsFromAgents: false });
    const callbacks = createHeartbeatQueueTestDependencies(db);
    callbacks.setRunStatus.mockImplementation(async (id, status, values) =>
      (await db.update(heartbeatRuns).set({ ...values, status }).where(eq(heartbeatRuns.id, id)).returning())[0] ?? null);
    callbacks.setWakeupStatus.mockImplementation(async (id, status, values) => {
      if (id) await db.update(agentWakeupRequests).set({ ...values, status }).where(eq(agentWakeupRequests.id, id));
    });
    const queue = createHeartbeatQueue(db, callbacks);
    expect(await queue.claimQueuedRun(await readRun(f.run.id))).toBeNull();
    expect(callbacks.setRunStatus).toHaveBeenCalledWith(f.run.id, "cancelled", expect.objectContaining({ errorCode: "agent_interaction_delivery_denied" }));
    expect(callbacks.executeRun).not.toHaveBeenCalled();
    expect((await readRun(f.run.id)).status).toBe("cancelled");
    expect(callbacks.releaseIssueExecutionAndPromote).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }),
      expect.objectContaining({ suppressImmediateRecovery: true }));
  });

  it.each(["todo", "in_progress"])("leaves a refused %s assignment held across recovery and permission resets", async status => {
    const f = await seed(); await wake(f);
    await restriction(f.recipient, { canReceiveAssignmentsFromAgents: false });
    await recheckQueuedRunInteractions(db, await readRun(f.run.id));
    await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "agent_interaction_delivery_denied", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, f.run.id));
    await db.update(issues).set({ status }).where(eq(issues.id, f.issueId));
    const [before] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const enqueueWakeup = vi.fn(async () => { throw new Error("Policy denial must not be automatically retried"); });
    const recovery = recoveryService(db, { enqueueWakeup });
    await restriction(f.recipient, {});
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await recovery.reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issueId }))
        .toMatchObject({ skipped: 1, dispatchRequeued: 0, continuationRequeued: 0, escalated: 0 });
    }
    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toEqual(before);
    const callbacks = createHeartbeatQueueTestDependencies(db);
    callbacks.getAgent.mockImplementation(async id => (await db.select().from(agents).where(eq(agents.id, id)))[0] ?? null);
    expect(await createHeartbeatQueue(db, callbacks).enqueueWakeup(f.recipient, {
      source: "assignment", reason: "issue_assignment_recovery", requestedByActorType: "system",
      requestedByActorId: "recovery", contextSnapshot: { issueId: f.issueId },
    })).toBeNull();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(1);
    expect(await hasAutomaticInteractionDeliveryHold(db, {
      companyId: f.companyId, issueId: f.issueId, agentId: f.recipient, payload: {}, context: {}, actorType: "user", actorId: "human",
    })).toBe(false);
    const humanMessage = await comment(f, "user");
    expect(await hasAutomaticInteractionDeliveryHold(db, {
      companyId: f.companyId, issueId: f.issueId, agentId: f.recipient, payload: {}, context: { wakeCommentId: humanMessage }, actorType: "system",
    })).toBe(false);
  });
});

describe("wake provenance", () => {
  it("replaces any payload origin with the authenticated server actor", () => {
    expect(withInteractionDeliveryOrigin({ interactionOrigin: { actorType: "user", actorId: "spoof" } }, "agent", "sender"))
      .toEqual({ interactionOrigin: { actorType: "agent", actorId: "sender" } });
    expect(withInteractionDeliveryOrigin({ interactionOrigin: { actorType: "user" } })).toEqual({});
  });
  it("captures the host's invoking agent despite a plugin's user presentation", () => {
    expect(withPluginInteractionOrigin({ companyId: "company", agentId: "invoker" }, () =>
      withInteractionDeliveryOrigin({}, "user", "human")))
      .toEqual({ interactionOrigin: { actorType: "agent", actorId: "invoker", actorCompanyId: "company" } });
  });
});
