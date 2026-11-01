import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { recoveryService } from "../services/recovery/service.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// Pass-through wrapper so a test can land a competing Stop between the
// plugin's in-flight run lookup and its own cancel.
const cancelRace = vi.hoisted(() => ({ beforeCancel: null as null | ((runId: string) => Promise<void>) }));
vi.mock("../services/heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return {
    ...actual,
    heartbeatService: (...args: Parameters<typeof actual.heartbeatService>) => {
      const service = actual.heartbeatService(...args);
      return {
        ...service,
        cancelRun: async (...cancelArgs: Parameters<typeof service.cancelRun>) => {
          const hook = cancelRace.beforeCancel;
          cancelRace.beforeCancel = null;
          if (hook) await hook(cancelArgs[0]);
          return service.cancelRun(...cancelArgs);
        },
      };
    },
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres plugin session cancelRun tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const PLUGIN_ID = "plugin-record-id";
const PLUGIN_KEY = "paperclip.session-owner";

function createEventBusStub() {
  return {
    forPlugin() {
      return {
        emit: vi.fn(),
        subscribe: vi.fn(),
        clear: vi.fn(),
      };
    },
  } as any;
}

describeEmbeddedPostgres("plugin agent session cancelRun", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const openServices: Array<{ dispose(): void }> = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-session-cancel-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    cancelRace.beforeCancel = null;
    for (const services of openServices.splice(0)) services.dispose();
    await db.delete(issueRecoveryActions);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentTaskSessions);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function hostServicesFor(pluginId = PLUGIN_ID, pluginKey = PLUGIN_KEY) {
    const services = buildHostServices(db, pluginId, pluginKey, createEventBusStub());
    openServices.push(services);
    return services;
  }

  async function seedCompanyWithAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `SC${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Session Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId, issuePrefix };
  }

  async function seedSessionRun(input: {
    companyId: string;
    agentId: string;
    taskKey: string;
    status?: string;
    issueId?: string;
    resultJson?: Record<string, unknown>;
  }) {
    const runId = randomUUID();
    const status = input.status ?? "running";
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "automation",
      status,
      startedAt: status === "queued" ? null : new Date(),
      contextSnapshot: {
        taskKey: input.taskKey,
        ...(input.issueId ? { issueId: input.issueId } : {}),
      },
      ...(input.resultJson ? { resultJson: input.resultJson } : {}),
    });
    return runId;
  }

  async function readSessionTaskKey(sessionId: string) {
    const [row] = await db
      .select({ taskKey: agentTaskSessions.taskKey })
      .from(agentTaskSessions)
      .where(eq(agentTaskSessions.id, sessionId));
    return row!.taskKey;
  }

  async function readRun(runId: string) {
    const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    return row!;
  }

  it("cancels the running run of an owned session and returns its final status", async () => {
    const { companyId, agentId } = await seedCompanyWithAgent();
    const services = hostServicesFor();
    const session = await services.agentSessions.create({ agentId, companyId });
    const runId = await seedSessionRun({
      companyId,
      agentId,
      taskKey: await readSessionTaskKey(session.sessionId),
    });

    const status = await services.agentSessions.cancelRun({
      sessionId: session.sessionId,
      companyId,
      reason: "Operator pressed stop in the plugin UI",
    });

    expect(status).toBe("cancelled");
    const run = await readRun(runId);
    expect(run.status).toBe("cancelled");
    expect(run.resultJson).toMatchObject({
      cancelledByActorType: "plugin",
      cancelledByPluginId: PLUGIN_ID,
    });
  });

  it("also cancels a queued follow-up turn so it is not promoted after the stop", async () => {
    const { companyId, agentId } = await seedCompanyWithAgent();
    const services = hostServicesFor();
    const session = await services.agentSessions.create({ agentId, companyId });
    const taskKey = await readSessionTaskKey(session.sessionId);
    const runningRunId = await seedSessionRun({ companyId, agentId, taskKey });
    const queuedRunId = await seedSessionRun({ companyId, agentId, taskKey, status: "queued" });

    await expect(
      services.agentSessions.cancelRun({ sessionId: session.sessionId, companyId }),
    ).resolves.toBe("cancelled");

    expect((await readRun(runningRunId)).status).toBe("cancelled");
    expect((await readRun(queuedRunId)).status).toBe("cancelled");
    const entries = await db.select().from(activityLog).where(eq(activityLog.action, "heartbeat.cancelled"));
    expect(entries.map((entry) => entry.entityId).sort()).toEqual([runningRunId, queuedRunId].sort());
  });

  it("does not claim a run an operator stopped before the plugin's cancel landed", async () => {
    const { companyId, agentId } = await seedCompanyWithAgent();
    const services = hostServicesFor();
    const session = await services.agentSessions.create({ agentId, companyId });
    const runId = await seedSessionRun({
      companyId,
      agentId,
      taskKey: await readSessionTaskKey(session.sessionId),
    });
    cancelRace.beforeCancel = async (targetRunId) => {
      await heartbeatService(db).cancelRun(targetRunId, "Cancelled by a board operator", {
        resultJson: { cancelledByActorType: "user", cancelledByUserId: "board-user" },
      });
    };

    await expect(
      services.agentSessions.cancelRun({ sessionId: session.sessionId, companyId }),
    ).resolves.toBeNull();

    expect((await readRun(runId)).resultJson).toMatchObject({
      cancelledByActorType: "user",
      cancelledByUserId: "board-user",
    });
    expect(await db.select().from(activityLog).where(eq(activityLog.actorType, "plugin"))).toEqual([]);
  });

  it("logs one cancellation when two cancels from the same plugin overlap", async () => {
    const { companyId, agentId } = await seedCompanyWithAgent();
    const services = hostServicesFor();
    const session = await services.agentSessions.create({ agentId, companyId });
    const runId = await seedSessionRun({
      companyId,
      agentId,
      taskKey: await readSessionTaskKey(session.sessionId),
    });
    // Both calls read the run as running; the overlapping call lands its
    // cancel first, so the outer call's cancel returns the winner's row.
    let overlapping: Promise<string | null> | null = null;
    cancelRace.beforeCancel = async () => {
      overlapping = services.agentSessions.cancelRun({ sessionId: session.sessionId, companyId });
      await overlapping;
    };

    const outer = await services.agentSessions.cancelRun({ sessionId: session.sessionId, companyId });

    await expect(overlapping).resolves.toBe("cancelled");
    expect(outer).toBeNull();
    expect((await readRun(runId)).status).toBe("cancelled");
    const entries = await db.select().from(activityLog).where(eq(activityLog.action, "heartbeat.cancelled"));
    expect(entries.map((entry) => entry.entityId)).toEqual([runId]);
  });

  it("returns null when the session has nothing running", async () => {
    const { companyId, agentId } = await seedCompanyWithAgent();
    const services = hostServicesFor();
    const session = await services.agentSessions.create({ agentId, companyId });
    const finishedRunId = await seedSessionRun({
      companyId,
      agentId,
      taskKey: await readSessionTaskKey(session.sessionId),
      status: "succeeded",
    });

    await expect(
      services.agentSessions.cancelRun({ sessionId: session.sessionId, companyId }),
    ).resolves.toBeNull();
    expect((await readRun(finishedRunId)).status).toBe("succeeded");
    expect(await db.select().from(activityLog)).toEqual([]);
  });

  it("only cancels the run of the requested session", async () => {
    const { companyId, agentId } = await seedCompanyWithAgent();
    const services = hostServicesFor();
    const target = await services.agentSessions.create({ agentId, companyId });
    const sibling = await services.agentSessions.create({ agentId, companyId });
    const siblingRunId = await seedSessionRun({
      companyId,
      agentId,
      taskKey: await readSessionTaskKey(sibling.sessionId),
      status: "queued",
    });

    await expect(
      services.agentSessions.cancelRun({ sessionId: target.sessionId, companyId }),
    ).resolves.toBeNull();
    expect((await readRun(siblingRunId)).status).toBe("queued");
  });

  it("refuses to cancel a session owned by another plugin", async () => {
    const { companyId, agentId } = await seedCompanyWithAgent();
    const owner = hostServicesFor("other-plugin-record-id", "paperclip.other-plugin");
    const intruder = hostServicesFor();
    const session = await owner.agentSessions.create({ agentId, companyId });
    const runId = await seedSessionRun({
      companyId,
      agentId,
      taskKey: await readSessionTaskKey(session.sessionId),
    });

    await expect(
      intruder.agentSessions.cancelRun({ sessionId: session.sessionId, companyId }),
    ).rejects.toThrow(`Session not found: ${session.sessionId}`);
    expect((await readRun(runId)).status).toBe("running");
    expect(await db.select().from(activityLog)).toEqual([]);
  });

  it("does not treat an underscore in the plugin key as a wildcard", async () => {
    const { companyId, agentId } = await seedCompanyWithAgent();
    // `_` is a single-character LIKE wildcard, so an unescaped prefix
    // `plugin:paperclip.owner_x:session:%` would match this owner's sessions.
    const owner = hostServicesFor("owner-plugin-record-id", "paperclip.ownerAx");
    const intruder = hostServicesFor("intruder-plugin-record-id", "paperclip.owner_x");
    const session = await owner.agentSessions.create({ agentId, companyId });
    const runId = await seedSessionRun({
      companyId,
      agentId,
      taskKey: await readSessionTaskKey(session.sessionId),
    });

    await expect(
      intruder.agentSessions.cancelRun({ sessionId: session.sessionId, companyId }),
    ).rejects.toThrow(`Session not found: ${session.sessionId}`);
    await expect(intruder.agentSessions.list({ agentId, companyId })).resolves.toEqual([]);
    expect((await readRun(runId)).status).toBe("running");
  });

  it("refuses a cross-company request for an owned session", async () => {
    const { companyId, agentId } = await seedCompanyWithAgent();
    const { companyId: otherCompanyId } = await seedCompanyWithAgent();
    const services = hostServicesFor();
    const session = await services.agentSessions.create({ agentId, companyId });
    const runId = await seedSessionRun({
      companyId,
      agentId,
      taskKey: await readSessionTaskKey(session.sessionId),
    });

    await expect(
      services.agentSessions.cancelRun({ sessionId: session.sessionId, companyId: otherCompanyId }),
    ).rejects.toThrow(`Session not found: ${session.sessionId}`);
    expect((await readRun(runId)).status).toBe("running");
  });

  it("writes a heartbeat.cancelled activity entry with the plugin as the actor", async () => {
    const { companyId, agentId } = await seedCompanyWithAgent();
    const services = hostServicesFor();
    const session = await services.agentSessions.create({ agentId, companyId });
    const runId = await seedSessionRun({
      companyId,
      agentId,
      taskKey: await readSessionTaskKey(session.sessionId),
    });

    await services.agentSessions.cancelRun({ sessionId: session.sessionId, companyId, reason: "User stopped" });

    const entries = await db.select().from(activityLog).where(eq(activityLog.action, "heartbeat.cancelled"));
    expect(entries).toEqual([
      expect.objectContaining({
        companyId,
        actorType: "plugin",
        actorId: PLUGIN_ID,
        entityType: "heartbeat_run",
        entityId: runId,
        details: expect.objectContaining({ agentId, sessionId: session.sessionId, reason: "User stopped" }),
      }),
    ]);
  });

  it("keeps recovery from re-waking the agent after a plugin cancel", async () => {
    const { companyId, agentId, issuePrefix } = await seedCompanyWithAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Work driven from a plugin session",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    const services = hostServicesFor();
    const session = await services.agentSessions.create({ agentId, companyId });
    // Real session runs carry no issueId; the issue link is seeded only to exercise the recovery path.
    // The run also records an acknowledged provider stop, as a Stop of a live
    // provider does, so the release stands down exactly as after an operator
    // Stop and only the cancel attribution decides what periodic recovery does.
    await seedSessionRun({
      companyId,
      agentId,
      taskKey: await readSessionTaskKey(session.sessionId),
      issueId,
      status: "queued",
      resultJson: { executionCancellation: { state: "acknowledged" } },
    });

    await expect(
      services.agentSessions.cancelRun({ sessionId: session.sessionId, companyId }),
    ).resolves.toBe("cancelled");
    expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)).toHaveLength(1);

    const enqueueWakeup = vi.fn(async () => null);
    const result = await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();

    expect(result.operatorCancelExempted).toBe(1);
    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)).toHaveLength(1);
    expect(await db.select().from(issueRecoveryActions)).toEqual([]);
  });

  it("leaves the session open and owned after cancelling its run", async () => {
    const { companyId, agentId } = await seedCompanyWithAgent();
    const services = hostServicesFor();
    const session = await services.agentSessions.create({ agentId, companyId });
    await seedSessionRun({
      companyId,
      agentId,
      taskKey: await readSessionTaskKey(session.sessionId),
    });

    await services.agentSessions.cancelRun({ sessionId: session.sessionId, companyId });

    await expect(services.agentSessions.list({ agentId, companyId })).resolves.toEqual([
      expect.objectContaining({ sessionId: session.sessionId, status: "active" }),
    ]);
    await expect(
      services.agentSessions.close({ sessionId: session.sessionId, companyId }),
    ).resolves.toBeUndefined();
    await expect(services.agentSessions.list({ agentId, companyId })).resolves.toEqual([]);
  });
});
