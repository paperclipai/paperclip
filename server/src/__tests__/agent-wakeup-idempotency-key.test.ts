import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Idempotency key wake test run.",
    provider: "test",
    model: "test-model",
  })),
);

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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres wake idempotency tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent wakeup idempotency keys", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;

  const seedCompanyAndAgent = async () => {
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
  };

  const wake = (idempotencyKey: string) =>
    heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "wake_idempotency_test",
      idempotencyKey,
      requestedByActorType: "system",
      requestedByActorId: "test",
    });

  const wakeRowsWithKey = (idempotencyKey: string) =>
    db
      .select({
        id: agentWakeupRequests.id,
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        runId: agentWakeupRequests.runId,
      })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
        ),
      );

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wake-idempotency-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 30_000);

  afterEach(async () => {
    const runIds = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .then((runs) => runs.map((run) => run.id));
    await Promise.all(runIds.map((runId) => heartbeat.waitForRunExecutionDrain(runId)));
    runningProcesses.clear();
    mockAdapterExecute.mockClear();
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("queues one run when the same idempotency key is enqueued twice", async () => {
    await seedCompanyAndAgent();
    const idempotencyKey = `wake-idempotency:${randomUUID()}`;

    const first = await wake(idempotencyKey);
    expect(first).not.toBeNull();

    const second = await wake(idempotencyKey);
    expect(second?.id).toBe(first?.id);

    const runs = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);
    expect(runs).toHaveLength(1);

    const rows = await wakeRowsWithKey(idempotencyKey);
    expect(rows.filter((row) => row.status !== "skipped")).toHaveLength(1);
    expect(rows.some((row) => row.reason === "wake.duplicate_idempotency_key")).toBe(true);
  });

  it("queues one run when two enqueues with the same key race", async () => {
    await seedCompanyAndAgent();
    const idempotencyKey = `wake-idempotency-race:${randomUUID()}`;

    const [first, second] = await Promise.all([wake(idempotencyKey), wake(idempotencyKey)]);

    const runs = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);
    expect(runs).toHaveLength(1);
    expect([first?.id, second?.id].filter(Boolean)).toContain(runs[0]!.id);
  });

  it("does not wake again once a wake with the key has completed", async () => {
    await seedCompanyAndAgent();
    const idempotencyKey = `wake-idempotency-completed:${randomUUID()}`;
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "wake_idempotency_test",
      status: "completed",
      idempotencyKey,
      finishedAt: new Date(),
    });

    const run = await wake(idempotencyKey);

    expect(run).toBeNull();
    const runs = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);
    expect(runs).toHaveLength(0);
  });

  // The risk the unique index has to avoid: a key that was written on a wake
  // that never happened must stay reusable, or suppressed wakes would silently
  // become permanent.
  it("still wakes when the only row with the key was skipped", async () => {
    await seedCompanyAndAgent();
    const idempotencyKey = `wake-idempotency-skipped:${randomUUID()}`;
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "heartbeat.scheduling_suppressed",
      status: "skipped",
      idempotencyKey,
      finishedAt: new Date(),
    });

    const run = await wake(idempotencyKey);

    expect(run).not.toBeNull();
    const runs = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);
    expect(runs).toHaveLength(1);
  });

  it("rejects a second live wake row with the same key at the database level", async () => {
    await seedCompanyAndAgent();
    const idempotencyKey = `wake-idempotency-index:${randomUUID()}`;
    const row = {
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "wake_idempotency_test",
      status: "queued",
      idempotencyKey,
    };

    await db.insert(agentWakeupRequests).values(row);
    await expect(db.insert(agentWakeupRequests).values(row)).rejects.toMatchObject({ cause: { code: "23505" } });

    // …but a row whose status says the wake did not happen stays insertable.
    await db.insert(agentWakeupRequests).values({ ...row, status: "skipped", finishedAt: new Date() });
    const rows = await wakeRowsWithKey(idempotencyKey);
    expect(rows).toHaveLength(2);
  });
});
