import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  approvals,
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

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat preflight tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat preflight check", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-preflight-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    delete process.env.HEARTBEAT_PREFLIGHT_ENABLED;
    await db.delete(issueComments);
    await db.delete(approvals);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(opts?: {
    preflightEnabled?: boolean;
    intervalSec?: number;
    lastHeartbeatAt?: Date | null;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "TestCompany",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    const heartbeatConfig: Record<string, unknown> = {
      enabled: true,
      intervalSec: opts?.intervalSec ?? 300,
      wakeOnDemand: true,
    };
    if (opts?.preflightEnabled !== undefined) {
      heartbeatConfig.preflightEnabled = opts.preflightEnabled;
    }

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "PreflightTestAgent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: heartbeatConfig },
      permissions: {},
      lastHeartbeatAt: opts?.lastHeartbeatAt ?? new Date("2026-04-07T00:00:00.000Z"),
    });

    return { companyId, agentId };
  }

  async function seedIssue(companyId: string, agentId: string, status = "todo") {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Test issue",
      status,
      priority: "medium",
      assigneeAgentId: agentId,
    });
    return issueId;
  }

  async function seedComment(
    companyId: string,
    issueId: string,
    opts?: { authorAgentId?: string | null; createdAt?: Date },
  ) {
    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId,
      body: "test comment",
      authorAgentId: opts?.authorAgentId ?? null,
      authorUserId: opts?.authorAgentId ? null : "user-1",
      createdAt: opts?.createdAt ?? new Date("2026-04-07T12:00:00.000Z"),
    });
  }

  async function seedApproval(companyId: string, agentId: string, status = "pending") {
    await db.insert(approvals).values({
      id: randomUUID(),
      companyId,
      type: "action",
      requestedByAgentId: agentId,
      status,
      payload: {},
    });
  }

  function getWakeupRequests() {
    return db.select().from(agentWakeupRequests);
  }

  // ---- Tests ----

  it("skips timer wakeup when preflight is enabled and agent has no pending work", async () => {
    process.env.HEARTBEAT_PREFLIGHT_ENABLED = "true";
    const { agentId } = await seedAgent({ preflightEnabled: true });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
    });

    expect(result).toBeNull();
    const requests = await getWakeupRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.status).toBe("skipped");
    expect(requests[0]!.reason).toBe("preflight.no_pending_work");
  });

  it("proceeds with timer wakeup when agent has active issue", async () => {
    process.env.HEARTBEAT_PREFLIGHT_ENABLED = "true";
    const { companyId, agentId } = await seedAgent({ preflightEnabled: true });
    await seedIssue(companyId, agentId, "todo");

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
    });

    // Should NOT be null — wakeup should proceed
    expect(result).not.toBeNull();
  });

  it("proceeds with timer wakeup when agent has in_progress issue", async () => {
    process.env.HEARTBEAT_PREFLIGHT_ENABLED = "true";
    const { companyId, agentId } = await seedAgent({ preflightEnabled: true });
    await seedIssue(companyId, agentId, "in_progress");

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
    });

    expect(result).not.toBeNull();
  });

  it("proceeds with timer wakeup when agent has blocked issue", async () => {
    process.env.HEARTBEAT_PREFLIGHT_ENABLED = "true";
    const { companyId, agentId } = await seedAgent({ preflightEnabled: true });
    await seedIssue(companyId, agentId, "blocked");

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
    });

    expect(result).not.toBeNull();
  });

  it("skips timer wakeup when all assigned issues are done", async () => {
    process.env.HEARTBEAT_PREFLIGHT_ENABLED = "true";
    const { companyId, agentId } = await seedAgent({ preflightEnabled: true });
    await seedIssue(companyId, agentId, "done");
    await seedIssue(companyId, agentId, "cancelled");

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
    });

    expect(result).toBeNull();
    const requests = await getWakeupRequests();
    expect(requests[0]!.reason).toBe("preflight.no_pending_work");
  });

  it("proceeds when new comment exists from another user", async () => {
    process.env.HEARTBEAT_PREFLIGHT_ENABLED = "true";
    const { companyId, agentId } = await seedAgent({
      preflightEnabled: true,
      lastHeartbeatAt: new Date("2026-04-07T00:00:00.000Z"),
    });
    // Issue is done, but there's a new comment
    const issueId = await seedIssue(companyId, agentId, "done");
    await seedComment(companyId, issueId, {
      authorAgentId: null,
      createdAt: new Date("2026-04-07T12:00:00.000Z"),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
    });

    expect(result).not.toBeNull();
  });

  it("skips when only the agent's own comments exist", async () => {
    process.env.HEARTBEAT_PREFLIGHT_ENABLED = "true";
    const { companyId, agentId } = await seedAgent({
      preflightEnabled: true,
      lastHeartbeatAt: new Date("2026-04-07T00:00:00.000Z"),
    });
    const issueId = await seedIssue(companyId, agentId, "done");
    // Comment authored by the agent itself — should not count
    await seedComment(companyId, issueId, {
      authorAgentId: agentId,
      createdAt: new Date("2026-04-07T12:00:00.000Z"),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
    });

    expect(result).toBeNull();
  });

  it("proceeds when pending approval exists", async () => {
    process.env.HEARTBEAT_PREFLIGHT_ENABLED = "true";
    const { companyId, agentId } = await seedAgent({ preflightEnabled: true });
    await seedApproval(companyId, agentId, "pending");

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
    });

    expect(result).not.toBeNull();
  });

  it("skips when approval is already decided", async () => {
    process.env.HEARTBEAT_PREFLIGHT_ENABLED = "true";
    const { companyId, agentId } = await seedAgent({ preflightEnabled: true });
    await seedApproval(companyId, agentId, "approved");

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
    });

    expect(result).toBeNull();
  });

  it("does not skip on_demand wakeups even with no pending work", async () => {
    process.env.HEARTBEAT_PREFLIGHT_ENABLED = "true";
    const { agentId } = await seedAgent({ preflightEnabled: true });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    // on_demand should always proceed regardless of preflight
    expect(result).not.toBeNull();
  });

  it("does not skip assignment wakeups even with no pending work", async () => {
    process.env.HEARTBEAT_PREFLIGHT_ENABLED = "true";
    const { companyId, agentId } = await seedAgent({ preflightEnabled: true });
    const issueId = await seedIssue(companyId, agentId, "todo");

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
    });

    expect(result).not.toBeNull();
  });

  it("skips automation wakeups when no pending work", async () => {
    process.env.HEARTBEAT_PREFLIGHT_ENABLED = "true";
    const { agentId } = await seedAgent({ preflightEnabled: true });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
    });

    expect(result).toBeNull();
    const requests = await getWakeupRequests();
    expect(requests[0]!.reason).toBe("preflight.no_pending_work");
  });

  it("bypasses preflight when wakeup carries an issueId in context", async () => {
    process.env.HEARTBEAT_PREFLIGHT_ENABLED = "true";
    const { companyId, agentId } = await seedAgent({ preflightEnabled: true });
    const issueId = await seedIssue(companyId, agentId, "todo");

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
      contextSnapshot: { issueId },
    });

    // Should proceed because issueId is an explicit target
    expect(result).not.toBeNull();
  });

  it("bypasses preflight when reason is issue_comment_mentioned", async () => {
    process.env.HEARTBEAT_PREFLIGHT_ENABLED = "true";
    const { agentId } = await seedAgent({ preflightEnabled: true });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "issue_comment_mentioned",
    });

    expect(result).not.toBeNull();
  });

  it("does not skip when preflight is disabled per-agent", async () => {
    process.env.HEARTBEAT_PREFLIGHT_ENABLED = "true";
    const { agentId } = await seedAgent({ preflightEnabled: false });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
    });

    // Preflight disabled per-agent — should proceed
    expect(result).not.toBeNull();
  });

  it("does not skip when preflight is disabled per-instance (env var)", async () => {
    // Do NOT set HEARTBEAT_PREFLIGHT_ENABLED — defaults to false
    const { agentId } = await seedAgent();

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
    });

    // Instance default is false — should proceed
    expect(result).not.toBeNull();
  });

  it("uses instance default when agent has no preflightEnabled override", async () => {
    process.env.HEARTBEAT_PREFLIGHT_ENABLED = "true";
    // No preflightEnabled set on agent — falls back to instance default (true)
    const { agentId } = await seedAgent();

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
    });

    // No work + instance default true → should skip
    expect(result).toBeNull();
  });
});
