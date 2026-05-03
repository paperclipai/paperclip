import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companySkills,
  costEvents,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { registerServerAdapter, unregisterServerAdapter, type ServerAdapterModule } from "../adapters/index.ts";
import { setPluginEventBus } from "../services/activity-log.ts";
import { createPluginEventBus } from "../services/plugin-event-bus.ts";

const lifecycleTestAdapter: ServerAdapterModule = {
  type: "lifecycle_test",
  execute: async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    summary: "adapter complete",
    provider: "test",
    model: "test-model",
  }),
  testEnvironment: async () => ({
    adapterType: "lifecycle_test",
    status: "pass",
    checks: [],
    testedAt: new Date(0).toISOString(),
  }),
  supportsLocalAgentJwt: false,
};

const lifecycleTimeoutTestAdapter: ServerAdapterModule = {
  type: "lifecycle_timeout_test",
  execute: async () => ({
    exitCode: null,
    signal: null,
    timedOut: true,
    errorMessage: "Timed out",
    summary: "adapter timed out",
    provider: "test",
    model: "test-model",
  }),
  testEnvironment: async () => ({
    adapterType: "lifecycle_timeout_test",
    status: "pass",
    checks: [],
    testedAt: new Date(0).toISOString(),
  }),
  supportsLocalAgentJwt: false,
};

let releaseRaceAdapter: (() => void) | null = null;

function parseRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

const lifecycleRaceTestAdapter: ServerAdapterModule = {
  type: "lifecycle_race_test",
  execute: async () => {
    await new Promise<void>((resolve) => {
      releaseRaceAdapter = resolve;
    });
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "completed after cancel",
      usage: {
        inputTokens: 7,
        outputTokens: 11,
      },
      provider: "test",
      model: "test-model",
    };
  },
  testEnvironment: async () => ({
    adapterType: "lifecycle_race_test",
    status: "pass",
    checks: [],
    testedAt: new Date(0).toISOString(),
  }),
  supportsLocalAgentJwt: false,
};

const lifecycleFailureRaceTestAdapter: ServerAdapterModule = {
  type: "lifecycle_failure_race_test",
  execute: async ({ onLog }) => {
    await new Promise<void>((resolve) => {
      releaseRaceAdapter = resolve;
    });
    await onLog("stdout", "adapter reached failure race\n");
    throw new Error("failed after cancel");
  },
  testEnvironment: async () => ({
    adapterType: "lifecycle_failure_race_test",
    status: "pass",
    checks: [],
    testedAt: new Date(0).toISOString(),
  }),
  supportsLocalAgentJwt: false,
};

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat lifecycle event tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat run lifecycle events", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const observedEvents: PluginEvent[] = [];

  beforeAll(async () => {
    registerServerAdapter(lifecycleTestAdapter);
    registerServerAdapter(lifecycleTimeoutTestAdapter);
    registerServerAdapter(lifecycleRaceTestAdapter);
    registerServerAdapter(lifecycleFailureRaceTestAdapter);
    const eventBus = createPluginEventBus();
    const scopedBus = eventBus.forPlugin("heartbeat-run-lifecycle-events-test");
    for (const eventType of [
      "agent.run.started",
      "agent.run.finished",
      "agent.run.failed",
      "agent.run.cancelled",
    ] as const) {
      scopedBus.subscribe(eventType, async (event) => {
        observedEvents.push(event);
      });
    }
    setPluginEventBus(eventBus);
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-run-events-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    releaseRaceAdapter?.();
    releaseRaceAdapter = null;
    observedEvents.length = 0;
    await db.delete(costEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(companySkills);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    unregisterServerAdapter("lifecycle_test");
    unregisterServerAdapter("lifecycle_timeout_test");
    unregisterServerAdapter("lifecycle_race_test");
    unregisterServerAdapter("lifecycle_failure_race_test");
    await tempDb?.cleanup();
  });

  async function waitForRunToSettle(runId: string, timeoutMs = 10_000) {
    const heartbeat = heartbeatService(db);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = await heartbeat.getRun(runId);
      if (!run || (run.status !== "queued" && run.status !== "running")) return run;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return heartbeat.getRun(runId);
  }

  function runLifecycleEvents(runId: string, eventType?: string) {
    return observedEvents.filter((event) => {
      const payload = event.payload as Record<string, unknown> | null;
      return payload?.runId === runId && (!eventType || event.eventType === eventType);
    });
  }

  async function waitForLifecycleEvent(eventType: string, runId: string, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const event = runLifecycleEvents(runId, eventType)[0];
      if (event) return event;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${eventType} plugin event for run ${runId}`);
  }

  async function waitForRunLogLifecycleEvent(runId: string, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rows = await db
        .select({ id: heartbeatRunEvents.id })
        .from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, runId))
        .limit(1);
      if (rows.length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for run-log lifecycle event for run ${runId}`);
  }

  async function waitForAgentStatus(agentId: string, status: string, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const [agent] = await db
        .select({ status: agents.status })
        .from(agents)
        .where(eq(agents.id, agentId));
      if (agent?.status === status) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for agent ${agentId} status ${status}`);
  }

  async function waitForRunResult(
    runId: string,
    predicate: (run: Awaited<ReturnType<ReturnType<typeof heartbeatService>["getRun"]>>) => boolean = (run) => Boolean(run?.resultJson),
    timeoutMs = 10_000,
  ) {
    const heartbeat = heartbeatService(db);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = await heartbeat.getRun(runId);
      if (predicate(run)) return run;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return heartbeat.getRun(runId);
  }

  async function waitForRaceAdapterReady(timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (releaseRaceAdapter) return releaseRaceAdapter;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Timed out waiting for race adapter to start");
  }

  async function waitForRuntimeState(agentId: string, expectedRunId: string, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const [runtime] = await db
        .select()
        .from(agentRuntimeState)
        .where(eq(agentRuntimeState.agentId, agentId));
      if (runtime?.lastRunId === expectedRunId) return runtime;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const [runtime] = await db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId));
    return runtime ?? null;
  }

  it("publishes started and finished run lifecycle events for plugin subscribers", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "lifecycle_test",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "manual",
      status: "queued",
      contextSnapshot: {},
    });

    await heartbeatService(db).resumeQueuedRuns();

    const started = await waitForLifecycleEvent("agent.run.started", runId);
    expect(started).toMatchObject({
      eventType: "agent.run.started",
      companyId,
      actorType: "system",
      actorId: "heartbeat",
      entityType: "run",
      entityId: runId,
    });
    expect(started.payload).toMatchObject({
      runId,
      agentId,
      status: "running",
      previousStatus: "queued",
      invocationSource: "assignment",
      triggerDetail: "manual",
    });

    const settled = await waitForRunToSettle(runId);
    expect(settled?.status).toBe("succeeded");
    const finished = await waitForLifecycleEvent("agent.run.finished", runId);
    await waitForRunLogLifecycleEvent(runId);
    await waitForAgentStatus(agentId, "idle");
    expect(finished.payload).toMatchObject({
      runId,
      agentId,
      status: "succeeded",
      previousStatus: "running",
      result: {
        summary: "adapter complete",
      },
    });
  });

  it("publishes timed out runs as failed events with timeout details", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TimeoutAgent",
      role: "engineer",
      status: "running",
      adapterType: "lifecycle_timeout_test",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "manual",
      status: "queued",
      contextSnapshot: {},
    });

    await heartbeatService(db).resumeQueuedRuns();
    const settled = await waitForRunToSettle(runId);

    expect(settled?.status).toBe("timed_out");
    const failed = await waitForLifecycleEvent("agent.run.failed", runId);
    await waitForRunLogLifecycleEvent(runId);
    await waitForAgentStatus(agentId, "error");
    expect(failed.payload).toMatchObject({
      runId,
      agentId,
      status: "timed_out",
      previousStatus: "running",
      error: "Timed out",
      errorCode: "timeout",
    });
  });

  it("publishes cancelled run lifecycle events for plugin subscribers", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "lifecycle_test",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "test",
      triggerDetail: "manual",
      status: "claimed",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "manual",
      status: "running",
      startedAt: new Date("2026-04-28T00:00:00.000Z"),
      wakeupRequestId,
      contextSnapshot: {},
      usageJson: {
        input_tokens: 10,
        outputTokens: 20,
        total_cost_usd: 0.12,
        rawPayload: "x".repeat(10_000),
      },
      resultJson: {
        summary: "run summary",
        nestedHuge: { ignored: true },
      },
    });

    const heartbeat = heartbeatService(db);
    await Promise.all([
      heartbeat.cancelRun(runId),
      heartbeat.cancelRun(runId),
    ]);

    const cancelled = await waitForLifecycleEvent("agent.run.cancelled", runId);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(runLifecycleEvents(runId, "agent.run.cancelled")).toHaveLength(1);
    expect(cancelled).toMatchObject({
      eventType: "agent.run.cancelled",
      companyId,
      actorType: "system",
      actorId: "heartbeat",
      entityType: "run",
      entityId: runId,
    });
    expect(cancelled.payload).toMatchObject({
      runId,
      agentId,
      status: "cancelled",
      previousStatus: "running",
      invocationSource: "assignment",
      triggerDetail: "manual",
      errorCode: "cancelled",
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        costUsd: 0.12,
      },
      result: {
        summary: "run summary",
      },
    });
    const payload = cancelled.payload as Record<string, Record<string, unknown>>;
    expect(payload.usage).not.toHaveProperty("rawPayload");
    expect(payload.result).not.toHaveProperty("nestedHuge");

    const [wakeup] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    expect(wakeup?.status).toBe("cancelled");
  });

  it("preserves adapter artifacts when cancellation wins the finalization race", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "RaceAgent",
      role: "engineer",
      status: "running",
      adapterType: "lifecycle_race_test",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "manual",
      status: "queued",
      contextSnapshot: {},
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    await waitForLifecycleEvent("agent.run.started", runId);
    const release = await waitForRaceAdapterReady();

    await heartbeat.cancelRun(runId);
    release();
    releaseRaceAdapter = null;

    const run = await waitForRunResult(runId, (candidate) =>
      parseRecord(candidate?.resultJson)?.summary === "completed after cancel"
    );
    expect(run?.status).toBe("cancelled");
    expect(run?.resultJson).toMatchObject({ summary: "completed after cancel" });
    expect(runLifecycleEvents(runId, "agent.run.cancelled")).toHaveLength(1);
    expect(runLifecycleEvents(runId, "agent.run.finished")).toHaveLength(0);
    expect(runLifecycleEvents(runId, "agent.run.failed")).toHaveLength(0);

    const [runtime] = await db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId));
    expect(runtime).toMatchObject({
      lastRunId: runId,
      lastRunStatus: "cancelled",
      totalInputTokens: 7,
      totalOutputTokens: 11,
    });
  }, 15_000);

  it("updates runtime bookkeeping when cancellation wins an adapter failure race", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "FailureRaceAgent",
      role: "engineer",
      status: "running",
      adapterType: "lifecycle_failure_race_test",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "manual",
      status: "queued",
      contextSnapshot: {},
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    await waitForLifecycleEvent("agent.run.started", runId);
    const release = await waitForRaceAdapterReady();

    await heartbeat.cancelRun(runId);
    release();
    releaseRaceAdapter = null;

    const runtime = await waitForRuntimeState(agentId, runId);
    expect(runtime).toMatchObject({
      lastRunId: runId,
      lastRunStatus: "cancelled",
      lastError: "failed after cancel",
    });

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("cancelled");
    expect(run?.stdoutExcerpt).toContain("adapter reached failure race");
    expect(runLifecycleEvents(runId, "agent.run.cancelled")).toHaveLength(1);
    expect(runLifecycleEvents(runId, "agent.run.finished")).toHaveLength(0);
    expect(runLifecycleEvents(runId, "agent.run.failed")).toHaveLength(0);

    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId));
    expect(agent?.status).toBe("idle");
  }, 15_000);
});
