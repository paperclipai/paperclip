import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
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
import { createConnectionContentDeletion } from "../services/tool-access/connections/content-deletion.js";
import type { RunLogHandle, RunLogStore } from "../services/run-log-store.js";
import { toolAccessRoutes } from "../routes/tool-access.js";
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
