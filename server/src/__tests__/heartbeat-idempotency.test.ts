import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  agentRuntimeState,
  companies,
  companySkills,
  createDb,
  heartbeatRuns,
  heartbeatRunEvents,
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
    `Skipping embedded Postgres heartbeat idempotency tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat enqueueWakeup idempotency", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-idempotency-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    // Use raw SQL with CASCADE to handle all foreign key constraints
    await db.execute("TRUNCATE TABLE heartbeat_run_events, heartbeat_runs, agent_wakeup_requests, agent_runtime_state, issues, company_skills, agents, companies CASCADE");
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Test Company",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    return { companyId, agentId, issuePrefix };
  }

  it("returns existing run when duplicate idempotencyKey is provided", async () => {
    const { companyId, agentId, issuePrefix } = await seedCompanyAndAgent();
    const heartbeat = heartbeatService(db);
    const idempotencyKey = "unique-key-123";

    // Create an issue to avoid coalescing logic interference
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Test Issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    // First call - creates new run
    const firstRun = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      idempotencyKey,
      payload: { issueId },
    });

    expect(firstRun).not.toBeNull();
    expect(firstRun?.id).toBeTypeOf("string");

    // Second call with same key - should return existing run
    const secondRun = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      idempotencyKey,
      payload: { issueId },
    });

    expect(secondRun?.id).toBe(firstRun?.id);

    // Verify only one wakeup request was created
    const wakeupRequests = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, agentId),
          eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
        ),
      );
    expect(wakeupRequests.length).toBe(1);
  });

  it("returns null for pending request with same idempotencyKey", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const heartbeat = heartbeatService(db);
    const idempotencyKey = "pending-key-456";

    // Manually insert a pending wakeup request (no runId)
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "on_demand",
      status: "queued",
      idempotencyKey,
    });

    // Call with same idempotency key - should return null (deduplication)
    const result = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      idempotencyKey,
    });

    expect(result).toBeNull();
  });

  it("creates new run when existing request's runId points to missing run", async () => {
    const { companyId, agentId, issuePrefix } = await seedCompanyAndAgent();
    const heartbeat = heartbeatService(db);
    const idempotencyKey = "missing-run-key-789";

    // Create an issue
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Test Issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    // Manually insert a wakeup request with runId pointing to non-existent run
    const fakeRunId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "on_demand",
      status: "claimed",
      idempotencyKey,
      runId: fakeRunId,
    });

    // Call with same idempotency key - should create new run (data inconsistency recovery)
    const result = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      idempotencyKey,
      payload: { issueId },
    });

    expect(result).not.toBeNull();
    expect(result?.id).not.toBe(fakeRunId);
  });

  it("allows retry after skipped request with same idempotencyKey", async () => {
    const { companyId, agentId, issuePrefix } = await seedCompanyAndAgent();
    const heartbeat = heartbeatService(db);
    const idempotencyKey = "skipped-key-101";

    // Create an issue
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Test Issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    // Manually insert a skipped wakeup request
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "on_demand",
      status: "skipped",
      idempotencyKey,
      reason: "budget.blocked",
      finishedAt: new Date(),
    });

    // Call with same idempotency key - should create new run (skipped requests don't block)
    const result = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      idempotencyKey,
      payload: { issueId },
    });

    expect(result).not.toBeNull();
  });

  it("allows different idempotencyKeys to create separate runs", async () => {
    const { companyId, agentId, issuePrefix } = await seedCompanyAndAgent();
    const heartbeat = heartbeatService(db);

    // Create two different issues to avoid coalescing
    const issueId1 = randomUUID();
    const issueId2 = randomUUID();
    await db.insert(issues).values({
      id: issueId1,
      companyId,
      title: "Test Issue 1",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    await db.insert(issues).values({
      id: issueId2,
      companyId,
      title: "Test Issue 2",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });

    // First call
    const firstRun = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      idempotencyKey: "key-1",
      payload: { issueId: issueId1 },
    });

    // Second call with different key and different issue
    const secondRun = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      idempotencyKey: "key-2",
      payload: { issueId: issueId2 },
    });

    expect(firstRun?.id).not.toBe(secondRun?.id);

    // Verify both wakeup requests were created
    const wakeupRequests = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeupRequests.length).toBe(2);
  });

  it("allows same idempotencyKey for different agents", async () => {
    const { companyId, agentId: agentId1, issuePrefix } = await seedCompanyAndAgent();
    
    // Create second agent
    const agentId2 = randomUUID();
    await db.insert(agents).values({
      id: agentId2,
      companyId,
      name: "TestAgent2",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    // Create separate issues for each agent to avoid coalescing
    const issueId1 = randomUUID();
    const issueId2 = randomUUID();
    await db.insert(issues).values({
      id: issueId1,
      companyId,
      title: "Test Issue 1",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId1,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    await db.insert(issues).values({
      id: issueId2,
      companyId,
      title: "Test Issue 2",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId2,
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });

    const heartbeat = heartbeatService(db);
    const idempotencyKey = "same-key-different-agents";

    // First agent call
    const firstRun = await heartbeat.wakeup(agentId1, {
      source: "on_demand",
      idempotencyKey,
      payload: { issueId: issueId1 },
    });

    // Second agent call with same key - should create new run
    const secondRun = await heartbeat.wakeup(agentId2, {
      source: "on_demand",
      idempotencyKey,
      payload: { issueId: issueId2 },
    });

    expect(firstRun?.id).not.toBe(secondRun?.id);
  });

  it("creates new run when no idempotencyKey is provided (backwards compatibility)", async () => {
    const { companyId, agentId, issuePrefix } = await seedCompanyAndAgent();
    const heartbeat = heartbeatService(db);

    // Create two different issues to avoid coalescing
    const issueId1 = randomUUID();
    const issueId2 = randomUUID();
    await db.insert(issues).values({
      id: issueId1,
      companyId,
      title: "Test Issue 1",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    await db.insert(issues).values({
      id: issueId2,
      companyId,
      title: "Test Issue 2",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });

    // First call without idempotency key
    const firstRun = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      payload: { issueId: issueId1 },
    });

    // Second call without idempotency key - should create new run
    const secondRun = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      payload: { issueId: issueId2 },
    });

    expect(firstRun?.id).not.toBe(secondRun?.id);

    // Verify both wakeup requests were created
    const wakeupRequests = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeupRequests.length).toBe(2);
  });
});
