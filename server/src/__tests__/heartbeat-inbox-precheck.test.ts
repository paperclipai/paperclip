import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companySkills,
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
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        provider: "test",
        model: "test-model",
      })),
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat inbox precheck tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat inbox precheck", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-inbox-precheck-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    // Wait for any in-flight runs to settle
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      if (runs.every((run) => run.status !== "queued" && run.status !== "running")) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await db.delete(agentRuntimeState);
    await db.delete(companySkills);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(agentRuntimeState);
      try {
        await db.delete(agents);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(opts?: {
    heartbeatMode?: "reactive" | "proactive";
    heartbeatEnabled?: boolean;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "TestCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    const heartbeatConfig: Record<string, unknown> = {
      enabled: opts?.heartbeatEnabled ?? true,
      intervalSec: 60,
    };
    if (opts?.heartbeatMode !== undefined) {
      heartbeatConfig.mode = opts.heartbeatMode;
    }

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: heartbeatConfig },
      permissions: {},
    });

    return { companyId, agentId, issuePrefix };
  }

  async function seedIssue(companyId: string, agentId: string, issuePrefix: string, opts?: {
    status?: string;
    issueNumber?: number;
  }) {
    const issueId = randomUUID();
    const issueNumber = opts?.issueNumber ?? 1;
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Test issue",
      status: opts?.status ?? "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber,
      identifier: `${issuePrefix}-${issueNumber}`,
    });
    return issueId;
  }

  it("skips timer heartbeat for reactive agent with empty inbox", async () => {
    const { agentId } = await seedAgent({ heartbeatMode: "reactive" });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.invoke(agentId, "timer", {}, "system");
    expect(result).toBeNull();

    // Verify a skipped wakeup request was recorded
    const requests = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(requests).toHaveLength(1);
    expect(requests[0].status).toBe("skipped");
    expect(requests[0].reason).toBe("heartbeat.empty_inbox");
  });

  it("executes timer heartbeat for reactive agent with assigned issues", async () => {
    const { companyId, agentId, issuePrefix } = await seedAgent({ heartbeatMode: "reactive" });
    await seedIssue(companyId, agentId, issuePrefix, { status: "todo" });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.invoke(agentId, "timer", {}, "system");
    // Should not be null — a run should be created
    expect(result).not.toBeNull();
  });

  it("executes timer heartbeat for proactive agent even with empty inbox", async () => {
    const { agentId } = await seedAgent({ heartbeatMode: "proactive" });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.invoke(agentId, "timer", {}, "system");
    // Should not be null — proactive agents always execute
    expect(result).not.toBeNull();
  });

  it("executes assignment-triggered heartbeat regardless of inbox state", async () => {
    const { agentId } = await seedAgent({ heartbeatMode: "reactive" });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.invoke(agentId, "assignment", {}, "system");
    // Assignment wakes should always proceed
    expect(result).not.toBeNull();
  });

  it("executes on_demand-triggered heartbeat regardless of inbox state", async () => {
    const { agentId } = await seedAgent({ heartbeatMode: "reactive" });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    // On-demand wakes should always proceed
    expect(result).not.toBeNull();
  });

  it("defaults to reactive when mode is not set", async () => {
    // Seed agent without explicit mode
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "TestCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60 } },
      permissions: {},
    });

    const heartbeat = heartbeatService(db);

    // No mode set, empty inbox — should skip (defaults to reactive)
    const result = await heartbeat.invoke(agentId, "timer", {}, "system");
    expect(result).toBeNull();

    const requests = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(requests).toHaveLength(1);
    expect(requests[0].reason).toBe("heartbeat.empty_inbox");
  });

  it("records skipped run with correct metadata", async () => {
    const { companyId, agentId } = await seedAgent({ heartbeatMode: "reactive" });
    const heartbeat = heartbeatService(db);

    await heartbeat.invoke(agentId, "timer", {}, "system");

    const requests = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(requests).toHaveLength(1);

    const req = requests[0];
    expect(req.agentId).toBe(agentId);
    expect(req.companyId).toBe(companyId);
    expect(req.source).toBe("timer");
    expect(req.reason).toBe("heartbeat.empty_inbox");
    expect(req.status).toBe("skipped");
    expect(req.finishedAt).not.toBeNull();
  });
});
