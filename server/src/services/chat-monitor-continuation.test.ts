import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, agentWakeupRequests, authUsers, chatConversations, chatEndpoints, chatMessageLinks,
  chatPublications, companies, companyMemberships, completionContracts, createDb, heartbeatRuns, issueComments, issues, nativeRunFinalizations, nativeRunResults,
  statusDecisions, statusDecisionEffects, toolApplications, toolConnections,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { enqueueChatRunMilestones, resolveChatRunPresentationAuthorizationReason } from "./chat-run-publications.js";
import { CHAT_RUN_PRESENTATION_AUTHORIZATION_REASON, isChatOriginPublicationCandidate, isExternalChatPresentationContext, resolveHeartbeatRunResponse } from "./heartbeat-run-summary.js";
import { resolveChatOriginPublicationBindings } from "./issues.js";
import { NativeRunCoordinatorStore } from "./native-runtime/native-run-coordinator-store.js";
import { finalizeNativeRun, repairCommittedNativeChatResponse } from "./native-runtime/native-run-finalizer.js";
import { createHeartbeatQueueTestDependencies } from "../__tests__/helpers/heartbeat-queue.js";
import { createHeartbeatQueue } from "./heartbeat/queue.js";
import { instanceSettingsService } from "./instance-settings.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Monitor publication database unavailable: ${support.reason}`);
(support.supported ? describe : describe.skip)("monitor conversation continuation", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-monitor-publications-");
    db = createDb(temporary.connectionString);
    await db.insert(authUsers).values({ id: "requester", name: "Requester", email: "requester@example.test", createdAt: new Date(), updatedAt: new Date() });
  });
  afterAll(async () => { await temporary?.cleanup(); });

  async function fixture() {
    const [company] = await db.insert(companies).values({ name: "Continuation", issuePrefix: randomUUID().slice(0, 8) }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: "requester", status: "active", membershipRole: "owner" });
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Worker", adapterType: "paperclip_runner" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Repository QA", status: "in_progress", assigneeAgentId: agent.id, responsibleUserId: "requester" }).returning();
    const [application] = await db.insert(toolApplications).values({ companyId: company.id, applicationKey: randomUUID(), name: "Slack", type: "chat" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId: company.id, applicationId: application.id, name: "Slack", uid: randomUUID(), connectionPurpose: "channel", transport: "chat_sdk" }).returning();
    const [endpoint] = await db.insert(chatEndpoints).values({ companyId: company.id, connectionId: connection.id, provider: "slack", publicId: randomUUID(), assignedAgentId: agent.id, status: "active" }).returning();
    const [conversation] = await db.insert(chatConversations).values({ companyId: company.id, endpointId: endpoint.id, issueId: issue.id, externalConversationId: "test-channel", externalThreadId: randomUUID(), externalLabel: "QA" }).returning();
    const [comment] = await db.insert(issueComments).values({ companyId: company.id, issueId: issue.id, authorType: "user", authorUserId: "requester", body: "QA the runner migration" }).returning();
    await db.insert(chatMessageLinks).values({ companyId: company.id, endpointId: endpoint.id, conversationId: conversation.id, commentId: comment.id, providerMessageId: randomUUID(), direction: "inbound" });
    const nextCheckAt = new Date(Date.now() + 60_000).toISOString();
    const receipt = { operationId: "set_task_monitor", result: { taskId: issue.id, monitor: { status: "scheduled", nextCheckAt } } };
    const [source] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, nativeIssueId: issue.id, runtimeMode: "native", status: "succeeded", responsibleUserId: "requester",
      contextSnapshot: { source: "chat:slack", issueId: issue.id, endpointId: endpoint.id, wakeCommentId: comment.id },
      resultJson: { semanticToolReceipts: { schedule: receipt } },
    }).returning();
    const [successor] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, nativeIssueId: issue.id, runtimeMode: "native", status: "running", responsibleUserId: "requester",
      contextSnapshot: { source: "issue.monitor", issueId: issue.id, wakeReason: "issue_monitor_due", nextCheckAt },
    }).returning();
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: company.id, agentId: agent.id, source: "automation", reason: "issue_monitor_due", status: "claimed", runId: successor.id,
      idempotencyKey: `issue-monitor:${issue.id}:${nextCheckAt}`, payload: { issueId: issue.id, nextCheckAt },
    }).returning();
    const bindings = (runId = successor.id) => resolveChatOriginPublicationBindings(db, company.id, issue.id, runId);
    return { company, agent, issue, endpoint, conversation, source, successor, wake, receipt, bindings };
  }

  it("retains the exact originating conversation through the admitted monitor receipt", async () => {
    const f = await fixture();
    expect(await f.bindings(f.source.id)).toHaveLength(1);
    expect(await f.bindings()).toEqual(await f.bindings(f.source.id));
    expect(await resolveChatRunPresentationAuthorizationReason(db, { companyId: f.company.id, issueId: f.issue.id, runId: f.successor.id }))
      .toBe(CHAT_RUN_PRESENTATION_AUTHORIZATION_REASON);
    expect(await enqueueChatRunMilestones(db)).toBe(1);
    expect(await enqueueChatRunMilestones(db)).toBe(0);
    const publications = await db.select().from(chatPublications).where(eq(chatPublications.issueId, f.issue.id));
    expect(publications).toHaveLength(1);
    expect(publications[0]).toMatchObject({ conversationId: f.conversation.id, payload: { progressState: "working" } });
  });

  it("retains the verified conversation after more than sixteen monitor admissions", async () => {
    const f = await fixture();
    let previous = f.successor;
    for (let index = 0; index < 20; index += 1) {
      const nextCheckAt = new Date(Date.now() + 120_000 + index * 1000).toISOString();
      await db.update(heartbeatRuns).set({ status: "succeeded", resultJson: { semanticToolReceipts: {
        schedule: { operationId: "set_task_monitor", result: { taskId: f.issue.id, monitor: { status: "scheduled", nextCheckAt } } },
      } } }).where(eq(heartbeatRuns.id, previous.id));
      const [next] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id,
        nativeIssueId: f.issue.id, runtimeMode: "native", status: "running", responsibleUserId: "requester",
        contextSnapshot: { source: "issue.monitor", issueId: f.issue.id, nextCheckAt },
      }).returning();
      await db.insert(agentWakeupRequests).values({ companyId: f.company.id, agentId: f.agent.id,
        source: "automation", reason: "issue_monitor_due", status: "claimed", runId: next.id,
        idempotencyKey: `issue-monitor:${f.issue.id}:${nextCheckAt}`, payload: { issueId: f.issue.id, nextCheckAt },
      });
      previous = next;
    }
    expect(await f.bindings(previous.id)).toEqual(await f.bindings(f.source.id));
    expect(await f.bindings(previous.id)).toHaveLength(1);
  });

  it.each(["receipt", "wake", "requester", "agent", "schedule", "task"])("rejects broken %s lineage even with a claimed source id", async fault => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ contextSnapshot: { ...f.successor.contextSnapshot, sourceRunId: f.source.id } }).where(eq(heartbeatRuns.id, f.successor.id));
    if (fault === "receipt") await db.update(heartbeatRuns).set({ resultJson: {} }).where(eq(heartbeatRuns.id, f.source.id));
    if (fault === "wake") await db.update(agentWakeupRequests).set({ runId: null }).where(eq(agentWakeupRequests.id, f.wake.id));
    if (fault === "requester") await db.update(heartbeatRuns).set({ responsibleUserId: "another-person" }).where(eq(heartbeatRuns.id, f.successor.id));
    if (fault === "agent") {
      const [other] = await db.insert(agents).values({ companyId: f.company.id, name: "Other", adapterType: "paperclip_runner" }).returning();
      await db.update(heartbeatRuns).set({ agentId: other.id }).where(eq(heartbeatRuns.id, f.source.id));
    }
    if (fault === "schedule") await db.update(agentWakeupRequests).set({ idempotencyKey: randomUUID() }).where(eq(agentWakeupRequests.id, f.wake.id));
    if (fault === "task") {
      const [other] = await db.insert(issues).values({ companyId: f.company.id, title: "Private task" }).returning();
      await db.update(heartbeatRuns).set({ resultJson: { semanticToolReceipts: { schedule: {
        ...f.receipt, result: { ...f.receipt.result, taskId: other.id },
      } } } }).where(eq(heartbeatRuns.id, f.source.id));
    }
    expect(await f.bindings()).toEqual([]);
  });

  it("rejects a cycle of otherwise matching monitor receipts", async () => {
    const f = await fixture();
    const createdAt = new Date(Date.now() - 1000);
    await db.update(heartbeatRuns).set({ createdAt }).where(eq(heartbeatRuns.companyId, f.company.id));
    const nextCheckAt = new Date(Date.now() + 120_000).toISOString();
    await db.update(heartbeatRuns).set({ contextSnapshot: { source: "issue.monitor", issueId: f.issue.id } })
      .where(eq(heartbeatRuns.id, f.source.id));
    await db.update(heartbeatRuns).set({ resultJson: { semanticToolReceipts: {
      schedule: { operationId: "set_task_monitor", result: { taskId: f.issue.id, monitor: { status: "scheduled", nextCheckAt } } },
    } } }).where(eq(heartbeatRuns.id, f.successor.id));
    await db.insert(agentWakeupRequests).values({ companyId: f.company.id, agentId: f.agent.id,
      source: "automation", reason: "issue_monitor_due", status: "claimed", runId: f.source.id,
      idempotencyKey: `issue-monitor:${f.issue.id}:${nextCheckAt}`, payload: { issueId: f.issue.id, nextCheckAt },
    });
    expect(await f.bindings()).toEqual([]);
  });

  it("does not turn a yielded successful provider run into a completion", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ status: "succeeded", resultJson: {
      presentationDecision: { commentAction: "none" },
      nativeResult: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "yielded", continuation: { kind: "monitor" } },
    } }).where(eq(heartbeatRuns.id, f.source.id));
    await enqueueChatRunMilestones(db);
    expect(await db.select().from(chatPublications).where(and(eq(chatPublications.issueId, f.issue.id), eq(chatPublications.idempotencyKey, `run:${f.source.id}:completed:${f.endpoint.id}`)))).toEqual([]);
  });

  async function continuedTaskFixture() {
    const f = await fixture();
    const [contract] = await db.insert(completionContracts).values({ companyId: f.company.id, issueId: f.issue.id,
      revision: 1, schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "test", objective: "Verify repository migration", criteria: [] }, canonicalSha256: "workspace-contract",
      createdByActorType: "system", createdByActorId: "test",
    }).returning();
    const sessionId = randomUUID(), runnerId = randomUUID();
    await db.update(heartbeatRuns).set({ status: "running", nativeSessionId: sessionId, runnerInstanceId: runnerId,
      completionContractId: contract.id, completionContractSha256: contract.canonicalSha256,
    }).where(eq(heartbeatRuns.id, f.source.id));
    await db.update(issues).set({ executionRunId: f.source.id }).where(eq(issues.id, f.issue.id));
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.successor.id));
    const port = new NativeRunCoordinatorStore(db, { companyId: f.company.id, issueId: f.issue.id,
      runId: f.source.id, agentId: f.agent.id, normalizedSessionId: sessionId, completionContractId: contract.id,
      completionContractSha256: contract.canonicalSha256, runnerSourceInstanceId: runnerId,
      completionContractRevision: "test", completionContractCriterionIds: [],
    });
    const summary = "The repository is staged. I will continue QA automatically when it is prepared.";
    await port.completeRun({ result: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "yielded", summary,
      completionClaim: { contractRevision: "test", objectiveSatisfied: false, criteria: [], remainingWork: [{ description: "Complete QA", blocksCompletion: true }] },
      continuation: { kind: "same_agent", summary: "Continue QA with the prepared checkout", idempotencyKey: "repository-admission" },
      evidence: [], verification: [], attentionRequests: [], artifacts: [],
    }, terminal: { schema: "paperclip.prp.terminal.v1", runTerminalState: "succeeded", turnTerminalState: "completed", reportedWorkDisposition: "yielded" }, turnId: "prepare-turn" });
    await finalizeNativeRun({ db, runId: f.source.id, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    const [wake] = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.company.id), eq(agentWakeupRequests.reason, "issue_status_changed")));
    expect(wake).toBeDefined();
    const deps = createHeartbeatQueueTestDependencies(db);
    deps.getAgent.mockImplementation(async id => (await db.select().from(agents).where(eq(agents.id, id)))[0] ?? null);
    deps.instanceSettings.getExperimental.mockImplementation(() => instanceSettingsService(db).getExperimental());
    await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: true } } }).where(eq(agents.id, f.agent.id));
    const queue = createHeartbeatQueue(db, deps);
    expect(await queue.dispatchPendingNativeStatusWakeups({ companyId: f.company.id })).toMatchObject({ dispatched: 1 });
    await queue.startNextQueuedRunForAgent(f.agent.id);
    await Promise.all([...deps.activeRunExecutionPromises]);
    const [delivered] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
    expect(delivered).toMatchObject({ status: "coalesced" });
    expect(delivered.runId).toBeTruthy();
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, delivered.runId!));
    expect(successor.responsibleUserId).toBe("requester");
    return { ...f, successor, continuationWake: delivered, summary,
      bindings: (runId = successor.id) => resolveChatOriginPublicationBindings(db, f.company.id, f.issue.id, runId) };
  }

  it("delivers the saved setup explanation and retains chat through the committed automatic continuation", async () => {
    const f = await continuedTaskFixture();
    expect(await db.select({ body: issueComments.body }).from(issueComments).where(eq(issueComments.createdByRunId, f.source.id)))
      .toEqual([{ body: f.summary }]);
    expect(await f.bindings()).toEqual(await f.bindings(f.source.id));
    expect(await f.bindings()).toHaveLength(1);
    await enqueueChatRunMilestones(db);
    const publications = await db.select().from(chatPublications).where(eq(chatPublications.issueId, f.issue.id));
    expect(publications.some(p => p.payload.text === f.summary && p.conversationId === f.conversation.id)).toBe(true);
    expect(publications.some(p => p.payload.progressState === "working" && p.conversationId === f.conversation.id)).toBe(true);
    expect(await repairCommittedNativeChatResponse(db, { companyId: f.company.id, issueId: f.issue.id, runId: f.source.id })).toBe(false);
    expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.source.id))).toHaveLength(1);
  });

  it("retains conversation provenance when the admitted dispatch owns the deferred outbox run binding", async () => {
    const f = await continuedTaskFixture();
    await db.update(agentWakeupRequests).set({ runId: null }).where(eq(agentWakeupRequests.id, f.continuationWake.id));
    expect(await f.bindings()).toEqual(await f.bindings(f.source.id));
    expect(await f.bindings()).toHaveLength(1);
    await db.update(agentWakeupRequests).set({ runId: f.source.id }).where(eq(agentWakeupRequests.id, f.continuationWake.id));
    expect(await f.bindings()).toEqual([]);
  });

  it("selects the continued chat run's completed answer over an earlier bookkeeping comment", async () => {
    const f = await continuedTaskFixture();
    const authorization = isChatOriginPublicationCandidate(f.successor.contextSnapshot)
      ? await resolveChatRunPresentationAuthorizationReason(db, { companyId: f.company.id, issueId: f.issue.id, runId: f.successor.id }) : null;
    const context = isExternalChatPresentationContext(f.successor.contextSnapshot, authorization === CHAT_RUN_PRESENTATION_AUTHORIZATION_REASON);
    const answer = "Migration QA is complete. The verified report is available at the attached result.";
    const resolved = resolveHeartbeatRunResponse({ resultJson: {},
      existingComment: { id: "earlier-comment", body: "The checkout is ready; QA is underway." },
      finalAgentMessage: { text: answer, channel: "final", sourceEventId: "completed-final" },
      preferFinalResponseOverExistingComment: context,
    });
    expect(resolved.text).toBe(answer);
    expect(resolved.decision).toMatchObject({ chosenSource: "final_agent_message", commentAction: "create" });
  });

  it.each(["effect", "decision", "wake", "dispatch", "requester", "agent"])("rejects automatic continuation when %s authority is no longer valid", async fault => {
    const f = await continuedTaskFixture();
    if (fault === "effect") await db.update(statusDecisionEffects).set({ targetId: randomUUID() }).where(eq(statusDecisionEffects.companyId, f.company.id));
    if (fault === "decision") await db.update(statusDecisions).set({ applicationState: "proposed" }).where(eq(statusDecisions.companyId, f.company.id));
    if (fault === "wake") await db.update(agentWakeupRequests).set({ idempotencyKey: randomUUID() }).where(eq(agentWakeupRequests.id, f.continuationWake.id));
    if (fault === "dispatch") await db.update(agentWakeupRequests).set({ requestedByActorId: "unrelated-dispatch" }).where(and(
      eq(agentWakeupRequests.companyId, f.company.id), eq(agentWakeupRequests.requestedByActorId, `native-status-wake-dispatch:${f.continuationWake.id}`)));
    if (fault === "requester") await db.update(heartbeatRuns).set({ responsibleUserId: "another-person" }).where(eq(heartbeatRuns.id, f.successor.id));
    if (fault === "agent") {
      const [other] = await db.insert(agents).values({ companyId: f.company.id, name: "Other", adapterType: "paperclip_runner" }).returning();
      await db.update(heartbeatRuns).set({ agentId: other.id }).where(eq(heartbeatRuns.id, f.source.id));
    }
    expect(await f.bindings()).toEqual([]);
  });

  it("recovers the accepted continuation explanation after interrupted finalization without another provider result", async () => {
    const f = await fixture();
    const executionPayload = randomBytes(128 * 1024).toString("base64");
    await db.update(heartbeatRuns).set({
      contextSnapshot: { ...f.source.contextSnapshot, largePrompt: executionPayload,
        paperclipWake: { prompt: executionPayload } },
      runnerProfileJson: { instructions: executionPayload }, stdoutExcerpt: executionPayload,
    }).where(eq(heartbeatRuns.id, f.source.id));
    const [contract] = await db.insert(completionContracts).values({ companyId: f.company.id, issueId: f.issue.id,
      revision: 1, schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "test", objective: "Verify repository migration", criteria: [] }, canonicalSha256: "monitor-contract",
      createdByActorType: "system", createdByActorId: "test",
    }).returning();
    const sessionId = randomUUID(), runnerId = randomUUID();
    await db.update(heartbeatRuns).set({ status: "running", nativeSessionId: sessionId, runnerInstanceId: runnerId,
      completionContractId: contract.id, completionContractSha256: contract.canonicalSha256,
    }).where(eq(heartbeatRuns.id, f.source.id));
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.successor.id));
    await db.update(issues).set({ executionRunId: f.source.id, monitorNextCheckAt: new Date(f.receipt.result.monitor.nextCheckAt),
      monitorScheduledBy: "assignee", executionPolicy: { monitor: { nextCheckAt: f.receipt.result.monitor.nextCheckAt, notes: "Continue QA" } },
    }).where(eq(issues.id, f.issue.id));
    const port = new NativeRunCoordinatorStore(db, { companyId: f.company.id, issueId: f.issue.id,
      runId: f.source.id, agentId: f.agent.id, normalizedSessionId: sessionId, completionContractId: contract.id,
      completionContractSha256: contract.canonicalSha256, runnerSourceInstanceId: runnerId,
      completionContractRevision: "test", completionContractCriterionIds: [],
    });
    const summary = "The repository is being prepared. I will continue QA automatically.";
    await port.completeRun({ result: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "yielded", summary,
      completionClaim: { contractRevision: "test", objectiveSatisfied: false, criteria: [], remainingWork: [{ description: "Complete QA", blocksCompletion: true }] },
      continuation: { kind: "monitor", summary: "Continue QA", idempotencyKey: "prepare-source" },
      evidence: [], verification: [], attentionRequests: [], artifacts: [],
    }, terminal: { schema: "paperclip.prp.terminal.v1", runTerminalState: "succeeded", turnTerminalState: "completed", reportedWorkDisposition: "yielded" }, turnId: "work-turn" });
    await finalizeNativeRun({ db, runId: f.source.id, workspaceFinalizeStatus: "failed", projectRunStatus: true });
    const repair = () => repairCommittedNativeChatResponse(db, { companyId: f.company.id, issueId: f.issue.id, runId: f.source.id });
    expect(await repair()).toBe(false);
    await finalizeNativeRun({ db, runId: f.source.id, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.source.id));
    expect(coordinator).toMatchObject({ phase: "committed" });
    const [settledRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.source.id));
    expect(settledRun).toMatchObject({ status: "succeeded", resultJson: { finalizationPhase: "committed" } });
    expect(settledRun.contextSnapshot?.largePrompt).toBe(executionPayload);
    expect(settledRun.runnerProfileJson?.instructions).toBe(executionPayload);
    expect(settledRun.stdoutExcerpt).toBe(executionPayload);
    const priorComments = await db.select({ body: issueComments.body }).from(issueComments).where(eq(issueComments.createdByRunId, f.source.id));
    expect(priorComments).toEqual([{ body: summary }]);
    expect(await repair()).toBe(false);
    expect(await repair()).toBe(false);
    const comments = await db.select().from(issueComments).where(eq(issueComments.createdByRunId, f.source.id));
    expect(comments.map(comment => comment.body)).toEqual([summary]);
    expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.source.id))).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.company.id))).toHaveLength(1);
    const publications = await db.select().from(chatPublications).where(eq(chatPublications.issueId, f.issue.id));
    expect(publications).toHaveLength(1);
    expect(publications[0]).toMatchObject({ conversationId: f.conversation.id, payload: { text: summary } });
  });
});
