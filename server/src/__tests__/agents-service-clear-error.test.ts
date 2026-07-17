import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  agentRuntimeState,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

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
    await db.delete(heartbeatRunEvents);
    await db.delete(agentRuntimeState);
    await db.delete(heartbeatRuns);
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
      pauseNote: null,
      pausedAt: null,
      pausedByUserId: null,
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
});

describeEmbeddedPostgres("agent service pause forensics", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-pause-forensics-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("records pause note and actor, then clears them on resume", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const userId = randomUUID();
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
      name: "Engineer",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const paused = await agentService(db).pause(agentId, "manual", {
      note: "Budget review — hold inbox",
      pausedByUserId: userId,
    });
    expect(paused).toMatchObject({
      status: "paused",
      pauseReason: "manual",
      pauseNote: "Budget review — hold inbox",
      pausedByUserId: userId,
    });
    expect(paused?.pausedAt).toBeTruthy();

    const resumed = await agentService(db).resume(agentId);
    expect(resumed).toMatchObject({
      status: "idle",
      pauseReason: null,
      pauseNote: null,
      pausedAt: null,
      pausedByUserId: null,
    });
  });

  it("clears stale pause forensics when update leaves paused status", async () => {
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
      name: "Engineer",
      role: "engineer",
      status: "paused",
      pauseReason: "manual",
      pauseNote: "stale note",
      pausedAt: new Date("2026-07-17T04:02:14.000Z"),
      pausedByUserId: "user-1",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const updated = await agentService(db).update(agentId, { status: "idle" });
    expect(updated).toMatchObject({
      status: "idle",
      pauseReason: null,
      pauseNote: null,
      pausedAt: null,
      pausedByUserId: null,
    });
  });
});
