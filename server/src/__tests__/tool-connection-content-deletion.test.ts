import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  activityLog,
  connectionGrants,
  decisionTrainingExamples,
  documentRevisions,
  documents,
  issueDocuments,
  toolCatalogEntries,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  companies,
  completionContracts,
  nativeRunResults,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  issueThreadInteractions,
  toolAccessAuditEvents,
  toolActionRequests,
  toolApplications,
  toolCallEvents,
  toolConnectionContentDeletions,
  toolConnections,
  toolInvocations,
  toolMcpAppViews,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createConnectionContentDeletion, requestConnectionContentDeletion } from "../services/tool-access/connections/content-deletion.js";
import { forgetHandoffAfterDeletedRuns } from "../services/tool-access/connections/run-copies.js";
import {
  createGoogleTechnicalInformationRetention,
  GOOGLE_TECHNICAL_INFORMATION_TTL_MS,
  readIdleGoogleTechnicalInformationSchedule,
} from "../services/tool-access/connections/google-technical-information.js";
import { deleteGoogleContentWhenAccessEnds } from "../services/tool-access/connections/google-content-retention.js";
import { forgetSessionsOfDeletedRun, runContentDeleted } from "../services/tool-access/connections/run-session-reset.js";
import type { RunLogHandle, RunLogStore } from "../services/run-log-store.js";
import { toolAccessRoutes } from "../routes/tool-access.js";
import { hasAcceptedSemanticResult } from "../services/heartbeat-run-summary.js";
import { nativeSha256 } from "../services/native-runtime/canonical.js";
import { checkpointProfileForRun, DELETED_TEXT } from "../services/tool-access/connections/content-cleaning.js";
import { validatePrpStructuredRunResult } from "../vendor/paperclip-runner/index.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const SECRET = "Quarterly board notes from the shared drive";

function memoryRunLogs() {
  const logs = new Map<string, string>();
  let failuresLeft = 0;
  const store = {
    remove: async (handle: RunLogHandle) => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error("object storage unavailable");
      }
      logs.delete(handle.logRef);
    },
  } as unknown as RunLogStore;
  return { logs, store, failNext: (count: number) => { failuresLeft = count; } };
}

describeEmbeddedPostgres("deleting content stored from a connection's tool calls", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-content-deletion-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(runLogs: ReturnType<typeof memoryRunLogs>) {
    const [company] = await db.insert(companies).values({
      name: `Deletion ${randomUUID()}`,
      issuePrefix: `DL${randomUUID().slice(0, 6).toUpperCase()}`,
    }).returning();
    const [agent] = await db.insert(agents).values({
      companyId: company!.id,
      name: `Agent ${randomUUID().slice(0, 6)}`,
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    }).returning();
    const [application] = await db.insert(toolApplications).values({
      companyId: company!.id,
      name: `Docs ${randomUUID().slice(0, 6)}`,
      type: "mcp_http",
    }).returning();
    const [connection, other] = await db.insert(toolConnections).values([
      { companyId: company!.id, applicationId: application!.id, name: "Docs", uid: randomUUID(), transport: "mcp_remote", status: "active" },
      { companyId: company!.id, applicationId: application!.id, name: "Other", uid: randomUUID(), transport: "mcp_remote", status: "active" },
    ]).returning();
    const [issue] = await db.insert(issues).values({ companyId: company!.id, title: "Read the notes" }).returning();
    const finishedAt = new Date(Date.now() - 60_000);
    const [settledRun, liveRun, otherRun] = await db.insert(heartbeatRuns).values([
      { companyId: company!.id, agentId: agent!.id, status: "succeeded", finishedAt, logStore: "local_file", logRef: `${company!.id}/settled.ndjson`, logBytes: 120, logSha256: "abc", stdoutExcerpt: SECRET, resultJson: { summary: SECRET, executionRecovery: { kind: "none" }, nativeResult: { schema: "paperclip.run_result.v1", summary: SECRET, continuation: { kind: "response_wake", summary: SECRET } } } },
      { companyId: company!.id, agentId: agent!.id, status: "running", logStore: "local_file", logRef: `${company!.id}/live.ndjson`, stdoutExcerpt: SECRET },
      { companyId: company!.id, agentId: agent!.id, status: "succeeded", finishedAt, logStore: "local_file", logRef: `${company!.id}/other.ndjson`, stdoutExcerpt: SECRET },
    ]).returning();
    for (const run of [settledRun!, liveRun!, otherRun!]) runLogs.logs.set(run.logRef!, SECRET);
    const summary = { summary: SECRET, sizeBytes: 42, sha256: "hash-42", redactedFields: [] };
    const created = new Date(Date.now() - 30_000);
    const [settledCall, liveCall, otherCall] = await db.insert(toolInvocations).values([
      { companyId: company!.id, connectionId: connection!.id, runId: settledRun!.id, toolName: "read_doc", status: "succeeded", argumentsSummary: summary, resultSummary: summary, resultHash: "hash-42", resultSizeBytes: 42, createdAt: created },
      { companyId: company!.id, connectionId: connection!.id, runId: liveRun!.id, toolName: "read_doc", status: "succeeded", argumentsSummary: summary, resultSummary: summary, createdAt: created },
      { companyId: company!.id, connectionId: other!.id, runId: otherRun!.id, toolName: "read_doc", status: "succeeded", argumentsSummary: summary, resultSummary: summary, createdAt: created },
    ]).returning();
    await db.insert(toolCallEvents).values([
      { companyId: company!.id, connectionId: connection!.id, runId: settledRun!.id, invocationId: settledCall!.id, eventType: "call_completed", requestSummary: summary, resultSummary: summary, resultHash: "hash-42", createdAt: created },
      { companyId: company!.id, connectionId: connection!.id, runId: liveRun!.id, invocationId: liveCall!.id, eventType: "call_completed", resultSummary: summary, createdAt: created },
      { companyId: company!.id, connectionId: other!.id, runId: otherRun!.id, invocationId: otherCall!.id, eventType: "call_completed", resultSummary: summary, createdAt: created },
    ]);
    const [interaction] = await db.insert(issueThreadInteractions).values({
      companyId: company!.id,
      issueId: issue!.id,
      kind: "request_confirmation",
      status: "resolved",
      payload: { version: 1, prompt: "Approve?", detailsMarkdown: SECRET, toolAction: { version: 1, previewMarkdown: SECRET, argumentsSummaryJson: SECRET } } as never,
      result: { version: 1, toolAction: { version: 1, status: "executed", resultSummary: SECRET } } as never,
    }).returning();
    const [actionRequest] = await db.insert(toolActionRequests).values({
      companyId: company!.id,
      issueId: issue!.id,
      invocationId: settledCall!.id,
      interactionId: interaction!.id,
      status: "executed",
      canonicalArgumentsHash: "args-hash",
      canonicalArgumentsSummary: summary,
      signedArguments: "signed",
      previewMarkdown: SECRET,
    }).returning();
    const delivered = { actionRequestId: actionRequest!.id, toolName: "read_doc", resultSummary: SECRET };
    const deliveryContext = { issueId: issue!.id, toolAction: delivered, toolActions: [delivered], toolActionRequestIds: [actionRequest!.id], paperclipAgentMessage: { untrustedToolResults: [delivered] } };
    const [deliveryRun] = await db.insert(heartbeatRuns).values({
      companyId: company!.id, agentId: agent!.id, issueId: issue!.id, status: "succeeded", finishedAt, contextSnapshot: deliveryContext,
      logStore: "local_file", logRef: `${company!.id}/delivery.ndjson`, stdoutExcerpt: SECRET,
    }).returning();
    runLogs.logs.set(deliveryRun!.logRef!, SECRET);
    const [deliveryWake] = await db.insert(agentWakeupRequests).values({
      companyId: company!.id, agentId: agent!.id, source: "automation", status: "completed",
      payload: { issueId: issue!.id, _paperclipWakeContext: deliveryContext },
    }).returning();
    const [accessAudit] = await db.insert(toolAccessAuditEvents).values({
      companyId: company!.id, connectionId: connection!.id, action: "tool_access.policy_decision", outcome: "success",
      details: { decision: "allow", runId: settledRun!.id, toolName: "read_doc", argumentsSummary: summary },
      createdAt: created,
    }).returning();
    await db.insert(toolMcpAppViews).values({
      companyId: company!.id,
      connectionId: connection!.id,
      runId: settledRun!.id,
      invocationId: settledCall!.id,
      applicationName: "Docs",
      toolName: "read_doc",
      upstreamToolName: "read_doc",
      resourceUri: "ui://docs/view",
      toolInput: { id: "doc-1" },
      toolResult: { text: SECRET },
      createdAt: created,
    });
    await db.insert(heartbeatRunEvents).values([
      { companyId: company!.id, runId: settledRun!.id, agentId: agent!.id, seq: 1, eventType: "lifecycle", message: "run started", payload: { phase: "start" } },
      { companyId: company!.id, runId: settledRun!.id, agentId: agent!.id, seq: 2, eventType: "tool.execution.completed", message: SECRET, payload: { output: SECRET } },
      { companyId: company!.id, runId: liveRun!.id, agentId: agent!.id, seq: 1, eventType: "tool.execution.completed", message: SECRET, payload: { output: SECRET } },
      { companyId: company!.id, runId: otherRun!.id, agentId: agent!.id, seq: 1, eventType: "tool.execution.completed", message: SECRET, payload: { output: SECRET } },
    ]);
    return { deliveryRun: deliveryRun!, deliveryWake: deliveryWake!, accessAudit: accessAudit!, interaction: interaction!, company: company!, agent: agent!, connection: connection!, other: other!, settledRun: settledRun!, liveRun: liveRun!, otherRun: otherRun!, settledCall: settledCall!, liveCall: liveCall!, otherCall: otherCall! };
  }

  async function drain(service: ReturnType<typeof createConnectionContentDeletion>) {
    for (let i = 0; i < 20 && await service.nextDeadline() !== null; i++) {
      await service.processPending(new AbortController().signal);
    }
  }

  it("removes content from every store, keeps rows and hashes, and leaves other connections and companies alone", async () => {
    const runLogs = memoryRunLogs();
    const service = createConnectionContentDeletion(db, { runLogStore: () => runLogs.store });
    const seed = await seedCompany(runLogs);
    const foreign = await seedCompany(runLogs);

    const before = await service.storedContent(seed.connection);
    expect(before.stored).toEqual({ toolCalls: 2, approvals: 1, appViews: 1, runs: 3, runsInProgress: 1 });

    const { created } = await service.request(seed.connection, { actorType: "user", actorId: "board-user" });
    expect(created).toBe(true);
    await drain(service);

    const [call] = await db.select().from(toolInvocations).where(eq(toolInvocations.id, seed.settledCall.id));
    expect(call!.resultSummary).toMatchObject({ summary: "", sizeBytes: 42, sha256: "hash-42" });
    expect(call!.resultSummary?.contentDeletedAt).toBeTruthy();
    expect(call!.argumentsSummary?.summary).toBe("");
    expect(call!.resultHash).toBe("hash-42");
    expect(call!.status).toBe("succeeded");

    const events = await db.select().from(toolCallEvents).where(eq(toolCallEvents.invocationId, seed.settledCall.id));
    expect(events).toHaveLength(1);
    expect(events[0]!.resultSummary?.summary).toBe("");
    expect(events[0]!.requestSummary?.summary).toBe("");
    expect(events[0]!.resultHash).toBe("hash-42");

    const [actionRequest] = await db.select().from(toolActionRequests).where(eq(toolActionRequests.invocationId, seed.settledCall.id));
    expect(actionRequest!.previewMarkdown).toBeNull();
    expect(actionRequest!.signedArguments).toBeNull();
    expect(actionRequest!.canonicalArgumentsSummary.summary).toBe("");
    expect(actionRequest!.canonicalArgumentsHash).toBe("args-hash");
    const [interaction] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, actionRequest!.interactionId!));
    expect(JSON.stringify(interaction!.payload)).not.toContain(SECRET);
    expect(JSON.stringify(interaction!.result)).not.toContain(SECRET);

    expect(await db.select().from(toolMcpAppViews).where(eq(toolMcpAppViews.connectionId, seed.connection.id))).toEqual([]);

    const [settledRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.settledRun.id));
    expect(settledRun).toMatchObject({ logStore: null, logRef: null, stdoutExcerpt: null, logBytes: 120, logSha256: "abc", resultJson: { executionRecovery: { kind: "none" }, nativeResult: { schema: "paperclip.run_result.v1", continuation: { kind: "response_wake" } } } });
    expect(JSON.stringify(settledRun!.resultJson)).not.toContain(SECRET);
    const [audit] = await db.select().from(toolAccessAuditEvents).where(eq(toolAccessAuditEvents.id, seed.accessAudit.id));
    expect(audit!.details).toMatchObject({ decision: "allow", toolName: "read_doc", argumentsSummary: { summary: "", sha256: "hash-42", sizeBytes: 42 } });
    const [deliveryRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.deliveryRun.id));
    expect(JSON.stringify(deliveryRun!.contextSnapshot)).not.toContain(SECRET);
    expect(deliveryRun!.contextSnapshot).toMatchObject({ toolActionRequestIds: [expect.any(String)] });
    expect(deliveryRun).toMatchObject({ logRef: null, stdoutExcerpt: null });
    expect(runLogs.logs.has(seed.deliveryRun.logRef!)).toBe(false);
    const [deliveryWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seed.deliveryWake.id));
    expect(JSON.stringify(deliveryWake!.payload)).not.toContain(SECRET);
    expect(runLogs.logs.has(seed.settledRun.logRef!)).toBe(false);
    const settledEvents = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, seed.settledRun.id));
    expect(settledEvents).toHaveLength(2);
    expect(JSON.stringify(settledEvents)).not.toContain(SECRET);
    expect(settledEvents.find((event) => event.eventType === "lifecycle")!.message).toBe("run started");

    const [liveRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.liveRun.id));
    expect(liveRun!.logRef).toBe(seed.liveRun.logRef);
    expect(liveRun!.stdoutExcerpt).toBe(SECRET);
    expect(runLogs.logs.get(seed.liveRun.logRef!)).toBe(SECRET);
    const [liveCall] = await db.select().from(toolInvocations).where(eq(toolInvocations.id, seed.liveCall.id));
    expect(liveCall!.resultSummary?.summary).toBe(SECRET);
    const liveEvents = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, seed.liveRun.id));
    expect(liveEvents[0]!.message).toBe(SECRET);

    for (const untouched of [seed.otherCall.id, foreign.settledCall.id]) {
      const [row] = await db.select().from(toolInvocations).where(eq(toolInvocations.id, untouched));
      expect(row!.resultSummary?.summary).toBe(SECRET);
    }
    for (const run of [seed.otherRun, foreign.settledRun]) {
      const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
      expect(row!.logRef).toBe(run.logRef);
      expect(runLogs.logs.get(run.logRef!)).toBe(SECRET);
    }
    expect(await db.select().from(toolMcpAppViews).where(eq(toolMcpAppViews.connectionId, foreign.connection.id))).toHaveLength(1);

    const after = await service.storedContent(seed.connection);
    expect(after.stored).toEqual({ toolCalls: 1, approvals: 0, appViews: 0, runs: 1, runsInProgress: 1 });
    expect(after.deletion).toMatchObject({
      status: "completed",
      counts: { toolCalls: 1, approvals: 1, auditEvents: 2, appViews: 1, runs: 2, runsInProgress: 1 },
    });
    const [activity] = await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, seed.company.id),
      eq(activityLog.action, "tool_connection.content_deleted"),
    ));
    expect(activity!.entityId).toBe(seed.connection.id);
    expect(JSON.stringify(activity!.details)).not.toContain(SECRET);

    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, seed.liveRun.id));
    await service.request(seed.connection, { actorType: "user", actorId: "board-user" });
    await drain(service);
    expect(runLogs.logs.has(seed.liveRun.logRef!)).toBe(false);
    expect((await service.storedContent(seed.connection)).stored).toEqual({ toolCalls: 0, approvals: 0, appViews: 0, runs: 0, runsInProgress: 0 });
  });

  it("resumes an interrupted deletion to completion on the next pass", async () => {
    const runLogs = memoryRunLogs();
    const service = createConnectionContentDeletion(db, { runLogStore: () => runLogs.store });
    const seed = await seedCompany(runLogs);
    await service.request(seed.connection, { actorType: "user", actorId: "board-user" });
    runLogs.failNext(1);
    await expect(service.processPending(new AbortController().signal)).rejects.toThrow("object storage unavailable");

    const [interrupted] = await db.select().from(toolConnectionContentDeletions)
      .where(eq(toolConnectionContentDeletions.connectionId, seed.connection.id));
    expect(interrupted).toMatchObject({ status: "pending", attempts: 1, lastError: "object storage unavailable" });
    expect((await service.storedContent(seed.connection)).deletion).toMatchObject({ status: "pending", retrying: true });
    expect(await service.nextDeadline()).not.toBeNull();

    await drain(service);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.settledRun.id));
    expect(run!.logRef).toBeNull();
    expect(runLogs.logs.has(seed.settledRun.logRef!)).toBe(false);
    const finished = await service.storedContent(seed.connection);
    expect(finished.deletion).toMatchObject({ status: "completed", retrying: false, counts: { toolCalls: 1, runs: 2 } });
  });

  it("waits for work still running when access ends, then deletes its content too, also after a restart", async () => {
    const runLogs = memoryRunLogs();
    const service = createConnectionContentDeletion(db, { runLogStore: () => runLogs.store });
    const seed = await seedCompany(runLogs);
    await db.update(toolInvocations).set({ status: "failed", errorMessage: SECRET }).where(eq(toolInvocations.id, seed.settledCall.id));
    await db.update(toolCallEvents).set({ errorMessage: SECRET }).where(eq(toolCallEvents.invocationId, seed.settledCall.id));
    await db.update(heartbeatRuns).set({ sessionIdAfter: "harness-session-1" }).where(eq(heartbeatRuns.id, seed.settledRun.id));
    const [laterRun] = await db.insert(heartbeatRuns).values({ companyId: seed.company.id, agentId: seed.agent.id, status: "succeeded", finishedAt: new Date(),
      sessionIdBefore: "harness-session-1", sessionIdAfter: "harness-session-1", resultJson: { sessionId: "harness-session-1" } }).returning();
    await db.insert(agentTaskSessions).values({
      companyId: seed.company.id, agentId: seed.agent.id, adapterType: "process", taskKey: "task-1",
      sessionParamsJson: { sessionId: "harness-session-1" }, sessionDisplayId: "harness-session-1", lastRunId: laterRun!.id,
    });
    await db.insert(agentRuntimeState).values({ agentId: seed.agent.id, companyId: seed.company.id, adapterType: "process", sessionId: "harness-session-1" });

    const { deletion } = await requestConnectionContentDeletion(db, seed.connection, { actorType: "system", actorId: null }, "access_revoked");
    expect(deletion).toMatchObject({ status: "pending", reason: "access_revoked" });
    const [lateEvent] = await db.insert(toolCallEvents).values({
      companyId: seed.company.id, connectionId: seed.connection.id, runId: seed.liveRun.id, invocationId: seed.liveCall.id,
      eventType: "call_completed", resultSummary: { summary: SECRET, sizeBytes: 42, sha256: "hash-42", redactedFields: [] },
    }).returning();
    const [lateAudit] = await db.insert(toolAccessAuditEvents).values({
      companyId: seed.company.id, connectionId: seed.connection.id, action: "tool_access.policy_decision", outcome: "success",
      details: { invocationId: seed.liveCall.id, argumentsSummary: { summary: SECRET, sizeBytes: 42, sha256: "hash-42" } },
    }).returning();
    const [lateView] = await db.insert(toolMcpAppViews).values({
      companyId: seed.company.id, connectionId: seed.connection.id, runId: seed.liveRun.id, invocationId: seed.liveCall.id,
      applicationName: "Docs", toolName: "read_doc", upstreamToolName: "read_doc", resourceUri: "ui://docs/view",
      toolInput: { id: "doc-1" }, toolResult: { text: SECRET },
    }).returning();
    await drain(service);

    const [waiting] = await db.select().from(toolConnectionContentDeletions).where(eq(toolConnectionContentDeletions.id, deletion.id));
    expect(waiting!.status).toBe("pending");
    expect(waiting!.notBefore!.getTime()).toBeGreaterThan(Date.now());
    expect(await service.nextDeadline()).toBeGreaterThan(Date.now());
    const [settledCall] = await db.select().from(toolInvocations).where(eq(toolInvocations.id, seed.settledCall.id));
    expect(settledCall!.errorMessage).toBeNull();
    const settledEvents = await db.select().from(toolCallEvents).where(eq(toolCallEvents.invocationId, seed.settledCall.id));
    expect(settledEvents.map((event) => event.errorMessage)).toEqual([null]);
    expect(await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, seed.agent.id))).toEqual([]);
    const [runtime] = await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, seed.agent.id));
    expect(runtime!.sessionId).toBeNull();
    const [laterAfter] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, laterRun!.id));
    expect(laterAfter).toMatchObject({ sessionIdBefore: null, sessionIdAfter: null, resultJson: {} });
    const [settledAfter] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.settledRun.id));
    expect(settledAfter!.sessionIdAfter).toBeNull();
    expect(runLogs.logs.get(seed.liveRun.logRef!)).toBe(SECRET);

    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, seed.liveRun.id));
    await db.update(toolConnectionContentDeletions).set({ notBefore: new Date(Date.now() - 1_000) }).where(eq(toolConnectionContentDeletions.id, deletion.id));
    const restarted = createConnectionContentDeletion(db, { runLogStore: () => runLogs.store });
    await drain(restarted);

    expect(runLogs.logs.has(seed.liveRun.logRef!)).toBe(false);
    const [liveCall] = await db.select().from(toolInvocations).where(eq(toolInvocations.id, seed.liveCall.id));
    expect(liveCall!.resultSummary?.summary).toBe("");
    const [late] = await db.select().from(toolCallEvents).where(eq(toolCallEvents.id, lateEvent!.id));
    expect(late!.resultSummary?.summary).toBe("");
    const [audited] = await db.select().from(toolAccessAuditEvents).where(eq(toolAccessAuditEvents.id, lateAudit!.id));
    expect(JSON.stringify(audited!.details)).not.toContain(SECRET);
    expect(await db.select().from(toolMcpAppViews).where(eq(toolMcpAppViews.id, lateView!.id))).toEqual([]);
    const finished = await restarted.storedContent(seed.connection);
    expect(finished.stored).toEqual({ toolCalls: 0, approvals: 0, appViews: 0, runs: 0, runsInProgress: 0 });
    expect(finished.deletion).toMatchObject({ id: deletion.id, status: "completed", reason: "access_revoked" });
    expect(await restarted.nextDeadline()).toBeNull();

    await db.insert(agentTaskSessions).values({
      companyId: seed.company.id, agentId: seed.agent.id, adapterType: "process", taskKey: "task-2",
      sessionParamsJson: { sessionId: "harness-session-2" }, lastRunId: seed.liveRun.id,
    });
    await db.update(agentRuntimeState).set({ sessionId: "harness-session-2", lastRunId: seed.liveRun.id }).where(eq(agentRuntimeState.agentId, seed.agent.id));
    expect(await forgetSessionsOfDeletedRun(db, { id: seed.liveRun.id, companyId: seed.company.id })).toBe(true);
    expect(await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, seed.agent.id))).toEqual([]);
    const [restored] = await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, seed.agent.id));
    expect(restored!.sessionId).toBeNull();
    expect(await forgetSessionsOfDeletedRun(db, { id: seed.otherRun.id, companyId: seed.company.id })).toBe(false);
    expect(await runContentDeleted(db, seed.company.id, seed.liveRun.id)).toBe(true);
    expect(await runContentDeleted(db, seed.company.id, seed.otherRun.id)).toBe(false);
  });

  it("extends a pending deletion to everything saved before access ended, and keeps content saved after reconnecting", async () => {
    const runLogs = memoryRunLogs();
    const service = createConnectionContentDeletion(db, { runLogStore: () => runLogs.store });
    const seed = await seedCompany(runLogs);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, seed.liveRun.id));
    const manual = await service.request(seed.connection, { actorType: "user", actorId: "board-user" });
    await db.update(toolConnectionContentDeletions).set({ requestedAt: new Date(Date.now() - 60_000) })
      .where(eq(toolConnectionContentDeletions.id, manual.deletion.id));
    const summary = { summary: SECRET, sizeBytes: 42, sha256: "hash-42", redactedFields: [] };
    const [lateCall] = await db.insert(toolInvocations).values({
      companyId: seed.company.id, connectionId: seed.connection.id, toolName: "read_doc", status: "succeeded",
      argumentsSummary: summary, resultSummary: summary, createdAt: new Date(Date.now() - 1_000),
    }).returning();

    const automatic = await requestConnectionContentDeletion(db, seed.connection, { actorType: "system", actorId: null }, "provider_access_ended");
    expect(automatic).toMatchObject({ created: false, deletion: { id: manual.deletion.id, reason: "provider_access_ended" } });
    await drain(service);

    const [late] = await db.select().from(toolInvocations).where(eq(toolInvocations.id, lateCall!.id));
    expect(late!.resultSummary?.summary).toBe("");
    expect((await service.storedContent(seed.connection)).deletion).toMatchObject({ status: "completed" });

    const [afterReconnect] = await db.insert(toolInvocations).values({
      companyId: seed.company.id, connectionId: seed.connection.id, toolName: "read_doc", status: "succeeded",
      argumentsSummary: summary, resultSummary: summary,
    }).returning();
    await drain(service);
    const after = await service.storedContent(seed.connection);
    expect(after.stored.toolCalls).toBe(1);
    const [kept] = await db.select().from(toolInvocations).where(eq(toolInvocations.id, afterReconnect!.id));
    expect(kept!.resultSummary?.summary).toBe(SECRET);
    const [old] = await db.select().from(toolInvocations).where(eq(toolInvocations.id, seed.settledCall.id));
    expect(old!.resultSummary?.summary).toBe("");
  });

  it("also removes the run's copies: error text, continuation summary, handoff and training snapshot", async () => {
    const runLogs = memoryRunLogs();
    const service = createConnectionContentDeletion(db, { runLogStore: () => runLogs.store });
    const seed = await seedCompany(runLogs);
    const [issue] = await db.insert(issues).values({ companyId: seed.company.id, title: "Summaries" }).returning();
    await db.update(heartbeatRuns).set({ issueId: issue!.id, error: SECRET }).where(eq(heartbeatRuns.id, seed.settledRun.id));
    const [laterRun] = await db.insert(heartbeatRuns).values({
      companyId: seed.company.id, agentId: seed.agent.id, issueId: issue!.id, status: "running",
      contextSnapshot: { issueId: issue!.id, paperclipSessionHandoffMarkdown: SECRET },
    }).returning();
    const [document] = await db.insert(documents).values({ companyId: seed.company.id, title: "Continuation summary", latestBody: SECRET }).returning();
    const [revision] = await db.insert(documentRevisions).values({
      companyId: seed.company.id, documentId: document!.id, revisionNumber: 1, body: SECRET, createdByRunId: seed.settledRun.id,
    }).returning();
    await db.update(documents).set({ latestRevisionId: revision!.id }).where(eq(documents.id, document!.id));
    await db.insert(issueDocuments).values({ companyId: seed.company.id, issueId: issue!.id, documentId: document!.id, key: "continuation-summary" });
    const [example] = await db.insert(decisionTrainingExamples).values({
      companyId: seed.company.id, sourceKind: "interaction", sourceId: seed.interaction.id, issueId: issue!.id, cutoffAt: new Date(),
      createdByUserId: "board-user",
      snapshot: { version: 1, runs: [{ id: seed.settledRun.id, status: "succeeded", stdoutExcerpt: SECRET }, { id: laterRun!.id, status: "succeeded" }] } as never,
    }).returning();

    await service.request(seed.connection, { actorType: "user", actorId: "board-user" });
    await drain(service);

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.settledRun.id));
    expect(run!.error).toBeNull();
    const [stillRunning] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, laterRun!.id));
    expect(stillRunning!.contextSnapshot).toMatchObject({ paperclipSessionHandoffMarkdown: SECRET });
    expect(await forgetHandoffAfterDeletedRuns(db, laterRun!)).toBe(true);
    const [later] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, laterRun!.id));
    expect(later!.contextSnapshot).toEqual({ issueId: issue!.id });
    const [summary] = await db.select().from(documents).where(eq(documents.id, document!.id));
    expect(summary!.latestBody).toBe("");
    const [summaryRevision] = await db.select().from(documentRevisions).where(eq(documentRevisions.id, revision!.id));
    expect(summaryRevision!.body).toBe("");
    const [kept] = await db.select().from(decisionTrainingExamples).where(eq(decisionTrainingExamples.id, example!.id));
    expect(JSON.stringify(kept!.snapshot)).not.toContain(SECRET);
    expect((kept!.snapshot as unknown as { runs: unknown[] }).runs).toEqual([
      { id: seed.settledRun.id, agentId: null, status: "succeeded", startedAt: null, finishedAt: null, contentDeleted: true },
      { id: laterRun!.id, status: "succeeded" },
    ]);

    await db.update(heartbeatRuns).set({ error: SECRET }).where(eq(heartbeatRuns.id, seed.settledRun.id));
    await db.update(documentRevisions).set({ body: SECRET }).where(eq(documentRevisions.id, revision!.id));
    await service.request(seed.connection, { actorType: "user", actorId: "board-user" });
    await drain(service);
    const [again] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.settledRun.id));
    expect(again!.error).toBeNull();
    const [revisionAgain] = await db.select().from(documentRevisions).where(eq(documentRevisions.id, revision!.id));
    expect(revisionAgain!.body).toBe("");
  });

  it("removes the run's final answer and evidence from its result and session checkpoint, and keeps the task text", async () => {
    const runLogs = memoryRunLogs();
    const service = createConnectionContentDeletion(db, { runLogStore: () => runLogs.store });
    const seed = await seedCompany(runLogs);
    const link = "https://docs.google.com/document/d/board-notes/edit";
    const answer = {
      schema: "paperclip.run_result.v1",
      reportedWorkDisposition: "done",
      summary: SECRET,
      evidence: [{ kind: "url", ref: link }],
      verification: [{ commandOrCheck: `Read ${link}`, status: "passed", detail: SECRET }],
      completionClaim: { contractRevision: "rev-1", objectiveSatisfied: true, criteria: [{ criterionId: "c1", status: "satisfied", evidenceRefs: [link], explanation: SECRET }], remainingWork: [] },
      artifacts: [{ kind: `${SECRET} kind`, ref: link, title: SECRET }],
      continuation: { kind: "response_wake", summary: SECRET, idempotencyKey: "wake-1" },
    };
    expect(validatePrpStructuredRunResult(answer).issues).toEqual([]);
    const fingerprint = JSON.stringify({ terminalState: "completed", result: answer });
    const checkpoint = {
      backendKind: "harness", driverKind: "codex_app_server", sessionId: "session-1", activeTurnId: null,
      identity: { runId: seed.settledRun.id },
      semanticResult: answer,
      governedWait: { sourceEvent: { type: "tool.execution.completed", payload: { toolName: "read_doc", output: SECRET } }, result: answer },
      terminalTurns: [{ turnId: "turn-1", fingerprint }],
    };
    const task = { description: "Summarise the board notes in the shared drive" };
    const profile = { nativeExecutionInput: { task }, sessionCheckpoint: checkpoint, nativeControllerRecovery: { schema: "paperclip.native-controller-recovery.v1", snapshotSha256: nativeSha256(checkpoint) } };
    await db.update(heartbeatRuns).set({
      resultJson: { executionRecovery: { kind: "none" }, nativeResult: answer, nativeTerminal: { schema: "paperclip.prp.terminal.v1", runTerminalState: "succeeded" } },
      runnerProfileJson: profile,
      contextSnapshot: { paperclipIssue: { description: task.description } },
    }).where(eq(heartbeatRuns.id, seed.settledRun.id));

    const [issue] = await db.insert(issues).values({ companyId: seed.company.id, title: "Native answer" }).returning();
    const [contract] = await db.insert(completionContracts).values({
      companyId: seed.company.id, issueId: issue!.id, revision: 1, schemaVersion: "v1", policyVersion: "v1", risk: "low",
      completionAuthority: "agent", incompleteCriteriaPolicy: "block", contractJson: {}, canonicalSha256: "contract-hash",
      createdByActorType: "user", createdByActorId: "board-user",
    }).returning();
    await db.update(heartbeatRuns).set({ issueId: issue!.id, nativeIssueId: issue!.id, completionContractId: contract!.id })
      .where(eq(heartbeatRuns.id, seed.settledRun.id));
    const terminal = { schema: "paperclip.prp.terminal.v1", runTerminalState: "succeeded", turnTerminalState: "completed", reportedWorkDisposition: "done" };
    const [nativeResult] = await db.insert(nativeRunResults).values({
      companyId: seed.company.id, issueId: issue!.id, runId: seed.settledRun.id, completionContractId: contract!.id,
      serverFingerprint: "server-fingerprint", schemaStatus: "accepted", canonicalSha256: "result-hash",
      resultJson: { result: answer, terminal, normalizationDiagnostics: { ignoredAttentionRequests: [] } },
    }).returning();

    await service.request(seed.connection, { actorType: "user", actorId: "board-user" });
    await drain(service);

    const [storedResult] = await db.select().from(nativeRunResults).where(eq(nativeRunResults.id, nativeResult!.id));
    expect(JSON.stringify(storedResult!.resultJson)).not.toContain(SECRET);
    expect(JSON.stringify(storedResult!.resultJson)).not.toContain("board-notes");
    expect(storedResult!.resultJson).toMatchObject({ terminal, result: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: DELETED_TEXT } });
    expect(validatePrpStructuredRunResult((storedResult!.resultJson as { result: unknown }).result)).toMatchObject({ ok: true });

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.settledRun.id));
    for (const value of [run!.resultJson, run!.runnerProfileJson]) {
      expect(JSON.stringify(value)).not.toContain(SECRET);
      expect(JSON.stringify(value)).not.toContain("board-notes");
    }
    expect(run!.status).toBe("succeeded");
    expect(run!.resultJson).toMatchObject({
      executionRecovery: { kind: "none" },
      nativeTerminal: { schema: "paperclip.prp.terminal.v1", runTerminalState: "succeeded" },
      nativeResult: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done",
        verification: [{ status: "passed" }], completionClaim: { contractRevision: "rev-1", objectiveSatisfied: true, criteria: [{ criterionId: expect.stringMatching(/^sha256:[a-f0-9]{64}$/), status: "satisfied" }] },
        continuation: { kind: "response_wake", idempotencyKey: expect.stringMatching(/^sha256:[a-f0-9]{64}$/), summary: DELETED_TEXT } },
    });
    expect(hasAcceptedSemanticResult(run!.resultJson)).toBe(true);
    const cleanedAnswer = (run!.resultJson as { nativeResult: unknown }).nativeResult;
    expect(validatePrpStructuredRunResult(cleanedAnswer)).toMatchObject({ ok: true });
    expect(cleanedAnswer).toMatchObject({ summary: DELETED_TEXT, evidence: [{ kind: DELETED_TEXT, ref: DELETED_TEXT }],
      verification: [{ commandOrCheck: DELETED_TEXT, detail: DELETED_TEXT }], artifacts: [{ kind: DELETED_TEXT, ref: DELETED_TEXT, title: DELETED_TEXT }] });
    const saved = run!.runnerProfileJson as typeof profile;
    expect(saved.nativeExecutionInput).toEqual({ task });
    expect(run!.contextSnapshot).toEqual({ paperclipIssue: { description: task.description } });
    expect(saved.sessionCheckpoint).toMatchObject({
      driverKind: "codex_app_server", identity: { runId: seed.settledRun.id },
      semanticResult: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: DELETED_TEXT, completionClaim: { contractRevision: "rev-1" },
        evidence: [{ kind: DELETED_TEXT, ref: DELETED_TEXT }], verification: [{ status: "passed", detail: DELETED_TEXT }] },
      governedWait: { sourceEvent: { type: "tool.execution.completed", payload: { output: DELETED_TEXT } }, result: { schema: "paperclip.run_result.v1", summary: DELETED_TEXT } },
      terminalTurns: [{ turnId: "turn-1" }],
      contentDeletedAt: expect.any(String),
    });
    expect(validatePrpStructuredRunResult(saved.sessionCheckpoint.semanticResult)).toMatchObject({ ok: true });
    expect(saved.sessionCheckpoint.terminalTurns[0]!.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(saved.nativeControllerRecovery.snapshotSha256).toBe(nativeSha256(saved.sessionCheckpoint));

    const before = { resultJson: run!.resultJson, runnerProfileJson: run!.runnerProfileJson };
    const { answerCopiesDeletedAt: _cleanedAt, ...legacyResult } = run!.resultJson as Record<string, unknown>;
    const legacyAnswer = { ...(legacyResult.nativeResult as Record<string, unknown>), evidence: [{ kind: "url", ref: link }] };
    const legacyCheckpoint = { ...checkpoint, terminalTurns: saved.sessionCheckpoint.terminalTurns, semanticResult: legacyAnswer,
      governedWait: { ...checkpoint.governedWait, result: legacyAnswer } };
    await db.update(heartbeatRuns).set({
      resultJson: { ...legacyResult, nativeResult: legacyAnswer },
      runnerProfileJson: { ...profile, sessionCheckpoint: legacyCheckpoint, nativeControllerRecovery: { ...profile.nativeControllerRecovery, snapshotSha256: nativeSha256(legacyCheckpoint) } },
    }).where(eq(heartbeatRuns.id, seed.settledRun.id));
    await service.request(seed.connection, { actorType: "user", actorId: "board-user" });
    await drain(service);
    const [again] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.settledRun.id));
    expect(JSON.stringify(again!.resultJson)).not.toContain(SECRET);
    expect(JSON.stringify(again!.runnerProfileJson)).not.toContain(SECRET);
    expect(JSON.stringify(again!.resultJson)).not.toContain("board-notes");
    expect(JSON.stringify(again!.runnerProfileJson)).not.toContain("board-notes");
    const withoutMark = (value: unknown) => {
      const copy = structuredClone(value) as { sessionCheckpoint: Record<string, unknown>; nativeControllerRecovery: unknown };
      delete copy.sessionCheckpoint.contentDeletedAt;
      delete (copy as Record<string, unknown>).nativeControllerRecovery;
      return copy;
    };
    expect(withoutMark(again!.runnerProfileJson)).toEqual(withoutMark(before.runnerProfileJson));
    expect(again!.resultJson).toMatchObject({ answerCopiesDeletedAt: expect.any(String) });

    const rewritten = { ...checkpoint };
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...profile, sessionCheckpoint: rewritten } }).where(eq(heartbeatRuns.id, seed.settledRun.id));
    await service.request(seed.connection, { actorType: "user", actorId: "board-user" });
    await drain(service);
    const [afterRewrite] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.settledRun.id));
    expect(JSON.stringify(afterRewrite!.runnerProfileJson)).not.toContain(SECRET);
    expect(JSON.stringify(afterRewrite!.runnerProfileJson)).not.toContain("board-notes");

    const written = checkpointProfileForRun((afterRewrite!.resultJson as Record<string, string>).contentDeletedAt, { ...profile, sessionCheckpoint: rewritten });
    expect(JSON.stringify(written)).not.toContain(SECRET);
    expect(checkpointProfileForRun(null, profile)).toBe(profile);
  });

  describe("Google Technical Information", () => {
    const DAY = 24 * 60 * 60_000;

    it("schedules nothing while no Google connection exists", async () => {
      expect(await createGoogleTechnicalInformationRetention(db).nextDeadline()).toBeNull();
      expect(await readIdleGoogleTechnicalInformationSchedule(db, Date.now())).toMatchObject({ blocked: false, deadlines: [] });
    });

    it("strips it after 30 days, right away once access ended, and keeps the bare activity row", async () => {
      const now = Date.now();
      const old = new Date(now - 31 * DAY);
      const recent = new Date(now - DAY);
      const [company] = await db.insert(companies).values({ name: `GTI ${randomUUID()}`, issuePrefix: `GT${randomUUID().slice(0, 6).toUpperCase()}` }).returning();
      const [application] = await db.insert(toolApplications).values({ companyId: company!.id, name: "Google Workspace", type: "mcp_http" }).returning();
      const failure = "Google: quota exceeded for project 12345";
      const [google, removed, other] = await db.insert(toolConnections).values([
        { companyId: company!.id, applicationId: application!.id, name: "Google", uid: randomUUID(), transport: "mcp_remote", status: "active",
          config: { sourceTemplateKey: "google-workspace" }, healthMessage: failure, lastError: failure, healthCheckedAt: old, lastCatalogRefreshAt: old },
        { companyId: company!.id, applicationId: application!.id, name: "Removed Google", uid: randomUUID(), transport: "mcp_remote", status: "archived",
          config: { oauth: { connectorProfile: "gmail.draft" } }, healthMessage: failure, healthCheckedAt: recent },
        { companyId: company!.id, applicationId: application!.id, name: "Docs", uid: randomUUID(), transport: "mcp_remote", status: "active",
          healthMessage: failure, healthCheckedAt: old },
      ]).returning();
      const [googleOld, googleRecent, otherOld] = await db.insert(toolInvocations).values([
        { companyId: company!.id, connectionId: google!.id, toolName: "get_message", status: "failed", errorMessage: failure, createdAt: old },
        { companyId: company!.id, connectionId: google!.id, toolName: "get_message", status: "failed", errorMessage: failure, createdAt: recent },
        { companyId: company!.id, connectionId: other!.id, toolName: "read_doc", status: "failed", errorMessage: failure, createdAt: old },
      ]).returning();
      await db.insert(toolCallEvents).values({ companyId: company!.id, connectionId: google!.id, invocationId: googleOld!.id, eventType: "call_failed", errorMessage: failure, createdAt: old });
      const catalog = { description: "Reads one Gmail message", inputSchema: { type: "object" }, versionHash: "v1" };
      const [staleEntry, freshEntry, removedEntry] = await db.insert(toolCatalogEntries).values([
        { companyId: company!.id, connectionId: google!.id, name: "get_message", toolName: "get_message", lastSeenAt: old, ...catalog },
        { companyId: company!.id, connectionId: google!.id, name: "list_threads", toolName: "list_threads", lastSeenAt: new Date(now), ...catalog },
        { companyId: company!.id, connectionId: removed!.id, name: "get_message", toolName: "get_message", lastSeenAt: recent, status: "removed", ...catalog },
      ]).returning();
      const [grant] = await db.insert(connectionGrants).values({
        companyId: company!.id, connectionId: removed!.id, kind: "organization", status: "revoked",
        providerTenant: { externalId: "subject-1", oauth: { scopes: ["https://www.googleapis.com/auth/gmail.readonly"] } } as never,
      }).returning();
      const [activity] = await db.insert(activityLog).values({
        companyId: company!.id, actorType: "agent", actorId: "agent-1", action: "tool.invoked", entityType: "tool_invocation",
        entityId: googleOld!.id, details: { toolName: "get_message", status: "failed" },
      }).returning();
      const retention = createGoogleTechnicalInformationRetention(db);
      expect(await retention.nextDeadline(now)).toBe(now);

      await retention.sweep(new AbortController().signal, new Date(now));

      const calls = new Map((await db.select().from(toolInvocations).where(eq(toolInvocations.companyId, company!.id))).map((row) => [row.id, row]));
      expect(calls.get(googleOld!.id)).toMatchObject({ errorMessage: null, status: "failed", toolName: "get_message" });
      expect(calls.get(googleRecent!.id)!.errorMessage).toBe(failure);
      expect(calls.get(otherOld!.id)!.errorMessage).toBe(failure);
      const [event] = await db.select().from(toolCallEvents).where(eq(toolCallEvents.invocationId, googleOld!.id));
      expect(event!.errorMessage).toBeNull();
      const connections = new Map((await db.select().from(toolConnections).where(eq(toolConnections.companyId, company!.id))).map((row) => [row.id, row]));
      expect(connections.get(google!.id)).toMatchObject({ healthMessage: null, lastError: null, lastCatalogRefreshAt: null });
      expect(connections.get(removed!.id)!.healthMessage).toBeNull();
      expect(connections.get(other!.id)!.healthMessage).toBe(failure);
      const entries = new Map((await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.companyId, company!.id))).map((row) => [row.id, row]));
      expect(entries.get(staleEntry!.id)).toMatchObject({ name: "get_message", description: null, inputSchema: {} });
      expect(entries.get(removedEntry!.id)).toMatchObject({ name: "get_message", description: null, inputSchema: {} });
      expect(entries.get(freshEntry!.id)!.description).toBe(catalog.description);
      const [revoked] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant!.id));
      expect(revoked!.providerTenant).toEqual({ externalId: "subject-1" });
      const [keptActivity] = await db.select().from(activityLog).where(eq(activityLog.id, activity!.id));
      expect(keptActivity).toMatchObject({ action: "tool.invoked", entityId: googleOld!.id, details: { toolName: "get_message", status: "failed" } });

      expect(await retention.nextDeadline(now)).toBe(googleRecent!.createdAt.getTime() + GOOGLE_TECHNICAL_INFORMATION_TTL_MS);
      expect(await readIdleGoogleTechnicalInformationSchedule(db, now)).toMatchObject({
        blocked: false, deadlines: [googleRecent!.createdAt.getTime() + GOOGLE_TECHNICAL_INFORMATION_TTL_MS],
      });
      await db.delete(activityLog).where(eq(activityLog.companyId, company!.id));
      await db.delete(companies).where(eq(companies.id, company!.id));
    });
  });

  it("keeps waiting for work that is still running after a day, then rechecks hourly", async () => {
    const runLogs = memoryRunLogs();
    const service = createConnectionContentDeletion(db, { runLogStore: () => runLogs.store });
    const seed = await seedCompany(runLogs);
    const { deletion } = await requestConnectionContentDeletion(db, seed.connection, { actorType: "system", actorId: null }, "member_removed");
    const dayAgo = new Date(Date.now() - 26 * 60 * 60_000);
    await db.update(toolInvocations).set({ createdAt: dayAgo }).where(eq(toolInvocations.companyId, seed.company.id));
    await db.update(toolCallEvents).set({ createdAt: dayAgo }).where(eq(toolCallEvents.companyId, seed.company.id));
    await db.update(toolConnectionContentDeletions).set({ requestedAt: new Date(Date.now() - 25 * 60 * 60_000) })
      .where(eq(toolConnectionContentDeletions.id, deletion.id));
    await drain(service);

    const [waiting] = await db.select().from(toolConnectionContentDeletions).where(eq(toolConnectionContentDeletions.id, deletion.id));
    expect(waiting!.status).toBe("pending");
    expect(waiting!.notBefore!.getTime()).toBeGreaterThan(Date.now() + 30 * 60_000);
    expect(runLogs.logs.get(seed.liveRun.logRef!)).toBe(SECRET);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, seed.liveRun.id));
    await db.update(toolConnectionContentDeletions).set({ notBefore: new Date(Date.now() - 1_000) }).where(eq(toolConnectionContentDeletions.id, deletion.id));
    await drain(service);
    expect(runLogs.logs.has(seed.liveRun.logRef!)).toBe(false);
    expect((await service.storedContent(seed.connection)).deletion).toMatchObject({ id: deletion.id, status: "completed" });
  });

  it.each([
    ["its app template", { config: { sourceTemplateKey: "google-workspace" } }, {}, true],
    ["its transport settings", { transportConfig: { sourceTemplateKey: "gmail" } }, {}, true],
    ["the app's source", {}, { source: "google-drive" }, true],
    ["its Google broker profile", { config: { oauth: { connectorProfile: "calendar.read" } } }, {}, true],
    ["another app", { config: { sourceTemplateKey: "slack" } }, { source: "slack" }, false],
  ] as const)("recognises a Google connection by %s", async (_label, connectionFields, metadata, google) => {
    const [company] = await db.insert(companies).values({ name: `Shape ${randomUUID()}`, issuePrefix: `SH${randomUUID().slice(0, 6).toUpperCase()}` }).returning();
    const [application] = await db.insert(toolApplications).values({ companyId: company!.id, name: "App", type: "mcp_http", metadata }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: company!.id, applicationId: application!.id, name: "App", uid: randomUUID(), transport: "mcp_remote", status: "active", ...connectionFields,
    }).returning();
    const started = await db.transaction(async (tx) => deleteGoogleContentWhenAccessEnds(tx as never, connection!, "connection_removed"));
    expect(Boolean(started)).toBe(google);
  });

  it("finishes once earlier work settles, even while the connection keeps making new calls", async () => {
    const runLogs = memoryRunLogs();
    const service = createConnectionContentDeletion(db, { runLogStore: () => runLogs.store });
    const seed = await seedCompany(runLogs);
    const { deletion } = await requestConnectionContentDeletion(db, seed.connection, { actorType: "system", actorId: null }, "access_revoked");
    await db.insert(toolInvocations).values({
      companyId: seed.company.id, connectionId: seed.connection.id, toolName: "read_doc", status: "executing", createdAt: new Date(Date.now() + 60_000),
    });
    await drain(service);
    expect((await service.storedContent(seed.connection)).deletion).toMatchObject({ id: deletion.id, status: "pending" });
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, seed.liveRun.id));
    await db.update(toolConnectionContentDeletions).set({ notBefore: new Date(Date.now() - 1_000) }).where(eq(toolConnectionContentDeletions.id, deletion.id));
    await drain(service);
    expect((await service.storedContent(seed.connection)).deletion).toMatchObject({ id: deletion.id, status: "completed" });
  });

  it("moves an automatic deletion's cutoff when Delete data is selected later, and keeps waiting for running work", async () => {
    const runLogs = memoryRunLogs();
    const service = createConnectionContentDeletion(db, { runLogStore: () => runLogs.store });
    const seed = await seedCompany(runLogs);
    const automatic = await requestConnectionContentDeletion(db, seed.connection, { actorType: "system", actorId: null }, "provider_access_ended");
    await db.update(toolConnectionContentDeletions).set({ requestedAt: new Date(Date.now() - 60_000) })
      .where(eq(toolConnectionContentDeletions.id, automatic.deletion.id));
    const manual = await service.request(seed.connection, { actorType: "user", actorId: "board-user" });
    expect(manual).toMatchObject({ created: false, deletion: { id: automatic.deletion.id, reason: "provider_access_ended" } });
    expect(Date.parse(manual.deletion.requestedAt)).toBeGreaterThan(Date.now() - 10_000);
    await drain(service);
  });

  it("returns the pending deletion instead of starting a second one", async () => {
    const runLogs = memoryRunLogs();
    const service = createConnectionContentDeletion(db, { runLogStore: () => runLogs.store });
    const seed = await seedCompany(runLogs);
    const first = await service.request(seed.connection, { actorType: "user", actorId: "board-user" });
    const second = await service.request(seed.connection, { actorType: "user", actorId: "board-user" });
    expect(second).toEqual({ deletion: first.deletion, created: false });
    await drain(service);
  });

  it("clears the approval card on the retry after the card update failed once", async () => {
    const runLogs = memoryRunLogs();
    const service = createConnectionContentDeletion(db, { runLogStore: () => runLogs.store });
    const seed = await seedCompany(runLogs);
    await db.execute(sql`create table if not exists content_deletion_card_failures (remaining int not null)`);
    await db.execute(sql`delete from content_deletion_card_failures`);
    await db.execute(sql`insert into content_deletion_card_failures values (1)`);
    await db.execute(sql`create or replace function content_deletion_fail_card() returns trigger language plpgsql as $$
      begin
        if exists (select 1 from content_deletion_card_failures where remaining > 0) then
          raise exception 'card update failed';
        end if;
        return new;
      end $$`);
    await db.execute(sql`create trigger content_deletion_fail_card before update on issue_thread_interactions
      for each row execute function content_deletion_fail_card()`);
    try {
      await service.request(seed.connection, { actorType: "user", actorId: "board-user" });
      await expect(service.processPending(new AbortController().signal)).rejects.toThrow();
      const [pending] = await db.select().from(toolConnectionContentDeletions)
        .where(eq(toolConnectionContentDeletions.connectionId, seed.connection.id));
      expect(pending!.status).toBe("pending");
      await db.execute(sql`delete from content_deletion_card_failures`);
      await drain(service);
    } finally {
      await db.execute(sql`drop trigger if exists content_deletion_fail_card on issue_thread_interactions`);
    }
    const [card] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, seed.interaction.id));
    expect(JSON.stringify(card!.payload)).not.toContain(SECRET);
    expect(JSON.stringify(card!.result)).not.toContain(SECRET);
    expect((await service.storedContent(seed.connection)).deletion).toMatchObject({ status: "completed", counts: { approvals: 1, toolCalls: 1 } });
  });

  it("keeps the job pending and the run log reference when the log backend is not recognised", async () => {
    const runLogs = memoryRunLogs();
    const service = createConnectionContentDeletion(db, { runLogStore: () => runLogs.store });
    const seed = await seedCompany(runLogs);
    await db.update(heartbeatRuns).set({ logStore: "tape_archive" }).where(eq(heartbeatRuns.id, seed.settledRun.id));
    await service.request(seed.connection, { actorType: "user", actorId: "board-user" });
    for (let i = 0; i < 5; i++) await service.processPending(new AbortController().signal).catch(() => undefined);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.settledRun.id));
    expect(run).toMatchObject({ logStore: "tape_archive", logRef: seed.settledRun.logRef });
    const state = await service.storedContent(seed.connection);
    expect(state.deletion).toMatchObject({ status: "pending", retrying: true });
    expect(await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, seed.company.id),
      eq(activityLog.action, "tool_connection.content_deleted"),
    ))).toEqual([]);
  });

  it("yields after every step when the time budget is spent and finishes over later passes", async () => {
    const runLogs = memoryRunLogs();
    const service = createConnectionContentDeletion(db, { runLogStore: () => runLogs.store });
    const seed = await seedCompany(runLogs);
    const { deletion } = await service.request(seed.connection, { actorType: "user", actorId: "board-user" });
    const phases: string[] = [];
    for (let i = 0; i < 40; i++) {
      const job = await service.process(deletion.id, new AbortController().signal, 0);
      if (!job || job.status === "completed") break;
      phases.push(String((job.progress as { phase: string }).phase));
    }
    expect(phases.length).toBeGreaterThan(5);
    expect(new Set(phases)).toEqual(new Set(["events", "auditEvents", "appViews", "deliveredResults", "runs", "done"]));
    expect((await service.storedContent(seed.connection)).deletion).toMatchObject({ status: "completed", counts: { runs: 2 } });
  });

  describe("routes", () => {
    function app(actor: Express.Request["actor"]) {
      const server = express();
      server.use(express.json());
      server.use((req, _res, next) => { req.actor = actor; next(); });
      server.use("/api", toolAccessRoutes(db));
      server.use(errorHandler);
      return server;
    }

    it("lets a board user see counts and request deletion, and refuses an agent and another company", async () => {
      const runLogs = memoryRunLogs();
      const seed = await seedCompany(runLogs);
      const board = app({ type: "board", userId: "board-user", userName: "Board", userEmail: null, isInstanceAdmin: true, source: "local_implicit" } as never);

      const counts = await request(board).get(`/api/tool-connections/${seed.connection.id}/stored-content`).expect(200);
      expect(counts.body.stored).toEqual({ toolCalls: 2, approvals: 1, appViews: 1, runs: 3, runsInProgress: 1 });

      const requested = await request(board).post(`/api/tool-connections/${seed.connection.id}/stored-content/deletion`).expect(202);
      expect(requested.body.deletion).toMatchObject({ status: "pending" });
      const [activity] = await db.select().from(activityLog).where(and(
        eq(activityLog.companyId, seed.company.id),
        eq(activityLog.action, "tool_connection.content_deletion_requested"),
      ));
      expect(activity!.details).toMatchObject({ toolCalls: 2, runs: 3, runsInProgress: 1 });
      const status = await request(board).get(`/api/tool-connections/${seed.connection.id}/stored-content/deletion`).expect(200);
      expect(status.body.deletion).toMatchObject({ status: "pending" });

      const outsider = app({
        type: "board",
        userId: "outsider",
        userName: "Outsider",
        userEmail: null,
        isInstanceAdmin: false,
        source: "session",
        companyIds: [randomUUID()],
        memberships: [],
      } as never);
      const refused = await request(outsider).post(`/api/tool-connections/${seed.connection.id}/stored-content/deletion`);
      expect([403, 404]).toContain(refused.status);

      const agent = app({ type: "agent", agentId: seed.agent.id, companyId: seed.company.id, runId: null, source: "agent_key" } as never);
      const agentRefused = await request(agent).post(`/api/tool-connections/${seed.connection.id}/stored-content/deletion`);
      expect([401, 403]).toContain(agentRefused.status);
    });

    it("queues the deletion when a board user removes the connection with it", async () => {
      const runLogs = memoryRunLogs();
      const seed = await seedCompany(runLogs);
      const board = app({ type: "board", userId: "board-user", userName: "Board", userEmail: null, isInstanceAdmin: true, source: "local_implicit" } as never);
      const removed = await request(board).delete(`/api/tool-connections/${seed.other.id}?deleteStoredContent=true`).expect(200);
      expect(removed.body.contentDeletion).toMatchObject({ status: "pending" });
      const [pending] = await db.select().from(toolConnectionContentDeletions)
        .where(eq(toolConnectionContentDeletions.connectionId, seed.other.id));
      expect(pending!.status).toBe("pending");
    });
  });
});
