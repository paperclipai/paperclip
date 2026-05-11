import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() => vi.fn(async () => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  errorMessage: null,
  summary: "ok",
  provider: "test",
  model: "test-model",
})));
const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentFirstHeartbeat = vi.hoisted(() => vi.fn());

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

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

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function waitForRunStatus(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  status: string,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run?.status === status) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heartbeat.getRun(runId);
}

async function seedQueuedRun(db: ReturnType<typeof createDb>, input?: {
  heartbeat?: Record<string, unknown>;
}) {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const runId = randomUUID();
  const wakeupRequestId = randomUUID();
  const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
  const now = new Date("2026-03-19T00:00:00.000Z");

  await db.insert(companies).values({
    id: companyId,
    name: "Paperclip",
    issuePrefix,
    requireBoardApprovalForNewAgents: false,
  });

  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "AffinityAgent",
    role: "engineer",
    status: "idle",
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {
      heartbeat: {
        wakeOnDemand: true,
        maxConcurrentRuns: 1,
        ...input?.heartbeat,
      },
    },
    permissions: {},
  });

  await db.insert(agentWakeupRequests).values({
    id: wakeupRequestId,
    companyId,
    agentId,
    source: "assignment",
    triggerDetail: "system",
    reason: "issue_assigned",
    payload: {},
    status: "queued",
    runId,
    requestedAt: now,
    updatedAt: now,
  });

  await db.insert(heartbeatRuns).values({
    id: runId,
    companyId,
    agentId,
    invocationSource: "assignment",
    triggerDetail: "system",
    status: "queued",
    wakeupRequestId,
    contextSnapshot: {},
    updatedAt: now,
    createdAt: now,
  });

  return { companyId, agentId, runId, wakeupRequestId };
}

describeEmbeddedPostgres("heartbeat instance affinity", () => {
  beforeEach(() => {
    mockAdapterExecute.mockClear();
  });
  it("runs queued work when no heartbeat instance affinity is configured", async () => {
    const started = await startEmbeddedPostgresTestDatabase("heartbeat-instance-affinity-default-");
    const db = createDb(started.connectionString);
    try {
      const { agentId, runId } = await seedQueuedRun(db);
      const heartbeat = heartbeatService(db, { instanceId: "macbook" });

      const claimed = await heartbeat.resumeQueuedRuns();
      expect(claimed.map((run) => run.id)).toEqual([runId]);

      const settled = await waitForRunStatus(heartbeat, runId, "succeeded");
      expect(settled?.status).toBe("succeeded");
      expect(mockAdapterExecute).toHaveBeenCalled();

      const agent = await db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]);
      expect(agent?.status).toBe("idle");
    } finally {
      await started.cleanup();
    }
  });

  it("runs queued work when heartbeat instance affinity matches this instance", async () => {
    const started = await startEmbeddedPostgresTestDatabase("heartbeat-instance-affinity-match-");
    const db = createDb(started.connectionString);
    try {
      const { runId } = await seedQueuedRun(db, { heartbeat: { instanceId: "gex44" } });
      const heartbeat = heartbeatService(db, { instanceId: "gex44" });

      const claimed = await heartbeat.resumeQueuedRuns();
      expect(claimed.map((run) => run.id)).toEqual([runId]);

      const settled = await waitForRunStatus(heartbeat, runId, "succeeded");
      expect(settled?.status).toBe("succeeded");
      expect(mockAdapterExecute).toHaveBeenCalled();
    } finally {
      await started.cleanup();
    }
  });

  it("leaves queued work untouched when heartbeat instance affinity targets another instance", async () => {
    const started = await startEmbeddedPostgresTestDatabase("heartbeat-instance-affinity-mismatch-");
    const db = createDb(started.connectionString);
    try {
      const { runId, wakeupRequestId } = await seedQueuedRun(db, { heartbeat: { instanceId: "gex44" } });
      const heartbeat = heartbeatService(db, { instanceId: "macbook" });

      const claimed = await heartbeat.resumeQueuedRuns();
      expect(claimed).toEqual([]);

      const run = await heartbeat.getRun(runId);
      expect(run?.status).toBe("queued");
      const wakeup = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null);
      expect(wakeup?.status).toBe("queued");
      expect(mockAdapterExecute).not.toHaveBeenCalled();
    } finally {
      await started.cleanup();
    }
  });
});
