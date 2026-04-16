import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockExecute = vi.hoisted(() => vi.fn());
const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentFirstHeartbeat = vi.hoisted(() => vi.fn());

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: mockTrackAgentFirstHeartbeat,
  };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockExecute,
    })),
  };
});

import { type PluginEvent } from "@paperclipai/plugin-sdk";
import { setPluginEventBus } from "../services/activity-log.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat plugin event tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 5_000, intervalMs = 50) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition");
}

describeEmbeddedPostgres("heartbeat plugin events", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let emittedEvents: PluginEvent[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-plugin-events-");
    db = createDb(tempDb.connectionString);
    setPluginEventBus({
      emit: vi.fn(async (event: PluginEvent) => {
        emittedEvents.push(event);
        return { errors: [] };
      }),
      forPlugin: vi.fn(),
      clearPlugin: vi.fn(),
    } as never);
  }, 20_000);

  beforeEach(() => {
    emittedEvents = [];
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();

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
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    return { companyId, agentId };
  }

  it("emits started and finished plugin events for successful runs", async () => {
    const { agentId } = await seedAgent();
    const heartbeat = heartbeatService(db);

    mockExecute.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      provider: "test",
      model: "test-model",
      resultJson: { summary: "done" },
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      reason: "manual_test",
      requestedByActorType: "system",
      requestedByActorId: "test",
    });

    expect(run).not.toBeNull();

    await waitFor(async () => {
      const latest = await heartbeat.getRun(run!.id);
      return latest?.status === "succeeded";
    });

    expect(emittedEvents.map((event) => event.eventType)).toEqual([
      "agent.run.started",
      "agent.run.finished",
    ]);
    expect(emittedEvents[1]?.payload).toMatchObject({
      runId: run!.id,
      agentId,
      status: "succeeded",
    });
  });

  it("emits started and failed plugin events for failed runs", async () => {
    const { agentId } = await seedAgent();
    const heartbeat = heartbeatService(db);

    mockExecute.mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "adapter exploded",
      errorCode: "adapter_failed",
      provider: "test",
      model: "test-model",
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      reason: "manual_test",
      requestedByActorType: "system",
      requestedByActorId: "test",
    });

    expect(run).not.toBeNull();

    await waitFor(async () => {
      const latest = await heartbeat.getRun(run!.id);
      return latest?.status === "failed";
    });

    expect(emittedEvents.map((event) => event.eventType)).toEqual([
      "agent.run.started",
      "agent.run.failed",
    ]);
    expect(emittedEvents[1]?.payload).toMatchObject({
      runId: run!.id,
      agentId,
      status: "failed",
      error: "adapter exploded",
    });
  });

  it("emits cancelled plugin events when queued runs are cancelled", async () => {
    const { companyId, agentId } = await seedAgent();
    const heartbeat = heartbeatService(db);
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      reason: "manual_test",
      status: "queued",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: {},
    });

    await heartbeat.cancelRun(runId);

    expect(emittedEvents.map((event) => event.eventType)).toEqual([
      "agent.run.cancelled",
    ]);
    expect(emittedEvents[0]?.payload).toMatchObject({
      runId,
      agentId,
      status: "cancelled",
    });
  });
});
