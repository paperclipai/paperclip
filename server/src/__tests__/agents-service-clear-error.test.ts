import { randomUUID } from "node:crypto";
import express from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import request from "supertest";
import {
  agents,
  agentRuntimeState,
  activityLog,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

vi.mock("../services/issue-assignment-wakeup.js", () => ({ queueIssueAssignmentWakeup: vi.fn() }));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function issuePatchApp(db: ReturnType<typeof createDb>, companyId: string, agentId: string, runId: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "agent", agentId, companyId, runId, source: "agent_jwt" };
    next();
  });
  app.use("/api", issueRoutes(db, {} as any));
  app.use(errorHandler);
  return app;
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent service clearError", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-clear-error-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(heartbeatRunEvents);
    await db.delete(agentRuntimeState);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("moves an error agent to idle without deleting run history or runtime diagnostics", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "error",
      pauseReason: "system",
      pausedAt: new Date("2026-06-07T00:00:00.000Z"),
      errorReason: "Secret is not bound to agent at env.ANTHROPIC_API_KEY",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "failed",
      error: "Adapter exited with code 1",
      stdoutExcerpt: "stdout stays inspectable",
      stderrExcerpt: "stderr stays inspectable",
      logStore: "local_disk",
      logRef: "runs/failed.log",
      resultJson: { sessionId: "codex-session-1" },
      finishedAt: new Date("2026-06-07T00:01:00.000Z"),
    });

    await db.insert(heartbeatRunEvents).values({
      companyId,
      runId,
      agentId,
      seq: 1,
      eventType: "transcript",
      stream: "stderr",
      message: "transcript stays inspectable",
      payload: { itemType: "error" },
    });

    await db.insert(agentRuntimeState).values({
      agentId,
      companyId,
      adapterType: "codex_local",
      sessionId: "codex-session-1",
      stateJson: { taskKey: "issue:test" },
      lastRunId: runId,
      lastRunStatus: "failed",
      lastError: "Adapter exited with code 1",
    });

    const cleared = await agentService(db).clearError(agentId);

    expect(cleared).toMatchObject({
      id: agentId,
      status: "idle",
      pauseReason: null,
      pausedAt: null,
      errorReason: null,
    });

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run).toMatchObject({
      id: runId,
      status: "failed",
      error: "Adapter exited with code 1",
      stdoutExcerpt: "stdout stays inspectable",
      stderrExcerpt: "stderr stays inspectable",
      logStore: "local_disk",
      logRef: "runs/failed.log",
    });

    const transcriptEvents = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId));
    expect(transcriptEvents).toHaveLength(1);
    expect(transcriptEvents[0]).toMatchObject({
      runId,
      eventType: "transcript",
      stream: "stderr",
      message: "transcript stays inspectable",
      payload: { itemType: "error" },
    });

    const [runtimeState] = await db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId));
    expect(runtimeState).toMatchObject({
      agentId,
      sessionId: "codex-session-1",
      stateJson: { taskKey: "issue:test" },
      lastRunId: runId,
      lastRunStatus: "failed",
      lastError: "Adapter exited with code 1",
    });
  });

  it("rejects non-error agents with a 409 conflict", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await expect(agentService(db).clearError(agentId)).rejects.toMatchObject({
      status: 409,
      message: "Only agents in error status can have their error cleared",
    });
  });

  it("keeps resume-style terminal and pending-approval protections", async () => {
    const companyId = randomUUID();
    const terminatedAgentId = randomUUID();
    const pendingAgentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: terminatedAgentId,
        companyId,
        name: "Terminated",
        role: "engineer",
        status: "terminated",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: pendingAgentId,
        companyId,
        name: "Pending",
        role: "engineer",
        status: "pending_approval",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await expect(agentService(db).clearError(terminatedAgentId)).rejects.toMatchObject({
      status: 409,
      message: "Cannot clear error on terminated agent",
    });
    await expect(agentService(db).clearError(pendingAgentId)).rejects.toMatchObject({
      status: 409,
      message: "Pending approval agents cannot have errors cleared",
    });
  });

  it("releases open work to an assignable manager and detaches direct reports", async () => {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const terminatedAgentId = randomUUID();
    const directReportId = randomUUID();
    const openIssueId = randomUUID();
    const terminalIssueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: managerId, companyId, name: "Manager", role: "manager", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: terminatedAgentId, companyId, name: "Leaving", role: "engineer", reportsTo: managerId, adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: directReportId, companyId, name: "Report", role: "engineer", reportsTo: terminatedAgentId, adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(issues).values([
      { id: openIssueId, companyId, title: "Open work", status: "in_progress", priority: "high", assigneeAgentId: terminatedAgentId },
      { id: terminalIssueId, companyId, title: "Done work", status: "done", priority: "high", assigneeAgentId: terminatedAgentId },
    ]);

    await agentService(db).terminate(terminatedAgentId);

    const [openIssue] = await db.select().from(issues).where(eq(issues.id, openIssueId));
    const [terminalIssue] = await db.select().from(issues).where(eq(issues.id, terminalIssueId));
    const [directReport] = await db.select().from(agents).where(eq(agents.id, directReportId));
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, openIssueId));
    expect(openIssue?.assigneeAgentId).toBe(managerId);
    expect(terminalIssue?.assigneeAgentId).toBe(terminatedAgentId);
    expect(directReport?.reportsTo).toBe(managerId);
    expect(comments[0]).toMatchObject({ authorType: "system", body: `System: assignment released from source agent ${terminatedAgentId}; reason: agent was terminated; reassigned to its manager.` });
  });

  it("lets the manager PATCH work released by termination", async () => {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const terminatedAgentId = randomUUID();
    const openIssueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: managerId, companyId, name: "Manager", role: "manager", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: terminatedAgentId, companyId, name: "Leaving", role: "engineer", reportsTo: managerId, adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(issues).values({ id: openIssueId, companyId, title: "Open work", status: "in_progress", priority: "high", assigneeAgentId: terminatedAgentId });
    await agentService(db).terminate(terminatedAgentId);
    const [managerRun] = await db.insert(heartbeatRuns).values({ companyId, agentId: managerId, status: "running", contextSnapshot: { issueId: openIssueId } }).returning();
    const res = await request(issuePatchApp(db, companyId, managerId, managerRun!.id)).patch(`/api/issues/${openIssueId}`).send({ title: "Manager resumed released work" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ id: openIssueId, assigneeAgentId: managerId, title: "Manager resumed released work" });
  });

  it("revalidates a manager terminated concurrently before releasing work", async () => {
    const companyId = randomUUID();
    const replacementManagerId = randomUUID();
    const managerId = randomUUID();
    const terminatedAgentId = randomUUID();
    const openIssueId = randomUUID();
    const managerLocked = deferred<void>();
    const allowManagerTermination = deferred<void>();
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: replacementManagerId, companyId, name: "Replacement manager", role: "manager", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: managerId, companyId, name: "Manager", role: "manager", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: terminatedAgentId, companyId, name: "Leaving", role: "engineer", reportsTo: managerId, adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(issues).values({ id: openIssueId, companyId, title: "Open work", status: "in_progress", priority: "high", assigneeAgentId: terminatedAgentId });

    const concurrentManagerTermination = db.transaction(async (tx) => {
      await tx.execute(sql`select ${agents.id} from ${agents} where ${agents.id} = ${managerId} for update`);
      managerLocked.resolve();
      await allowManagerTermination.promise;
      await tx.update(agents).set({ status: "terminated", updatedAt: new Date() }).where(eq(agents.id, managerId));
      await tx.update(agents).set({ reportsTo: replacementManagerId, updatedAt: new Date() }).where(eq(agents.reportsTo, managerId));
    });
    await managerLocked.promise;
    const terminateSource = agentService(db).terminate(terminatedAgentId);
    allowManagerTermination.resolve();
    await Promise.all([concurrentManagerTermination, terminateSource]);

    const [openIssue] = await db.select().from(issues).where(eq(issues.id, openIssueId));
    expect(openIssue?.assigneeAgentId).toBe(replacementManagerId);
  });

  it("releases open work to the unassigned queue when no assignable manager exists", async () => {
    const companyId = randomUUID();
    const pendingManagerId = randomUUID();
    const terminatedAgentId = randomUUID();
    const openIssueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: pendingManagerId, companyId, name: "Pending manager", role: "manager", status: "pending_approval", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: terminatedAgentId, companyId, name: "Leaving", role: "engineer", reportsTo: pendingManagerId, adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(issues).values({ id: openIssueId, companyId, title: "Open work", status: "blocked", priority: "high", assigneeAgentId: terminatedAgentId });
    await agentService(db).terminate(terminatedAgentId);
    const [openIssue] = await db.select().from(issues).where(eq(issues.id, openIssueId));
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, openIssueId));
    expect(openIssue?.assigneeAgentId).toBeNull();
    expect(comments[0]).toMatchObject({ authorType: "system", body: `System: assignment released from source agent ${terminatedAgentId}; reason: agent was terminated; moved to the unassigned queue.` });
  });

  it("moves work to the unassigned queue when the manager has an invalid reporting chain", async () => {
    const companyId = randomUUID();
    const terminatedAncestorId = randomUUID();
    const invalidManagerId = randomUUID();
    const terminatedAgentId = randomUUID();
    const directReportId = randomUUID();
    const openIssueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: terminatedAncestorId, companyId, name: "Terminated ancestor", role: "manager", status: "terminated", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: invalidManagerId, companyId, name: "Invalid manager", role: "manager", reportsTo: terminatedAncestorId, adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: terminatedAgentId, companyId, name: "Leaving", role: "engineer", reportsTo: invalidManagerId, adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: directReportId, companyId, name: "Report", role: "engineer", reportsTo: terminatedAgentId, adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(issues).values({ id: openIssueId, companyId, title: "Open work", status: "in_progress", priority: "high", assigneeAgentId: terminatedAgentId });

    await agentService(db).terminate(terminatedAgentId);

    const [openIssue] = await db.select().from(issues).where(eq(issues.id, openIssueId));
    const [directReport] = await db.select().from(agents).where(eq(agents.id, directReportId));
    expect(openIssue?.assigneeAgentId).toBeNull();
    expect(directReport?.reportsTo).toBeNull();
  });
});
