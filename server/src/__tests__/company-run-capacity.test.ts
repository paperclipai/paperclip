import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, createDb, heartbeatRuns } from "@paperclipai/db";
import { createCompanySchema, updateCompanySchema } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { companyService } from "../services/companies.js";
import { heartbeatService } from "../services/heartbeat.ts";

const adapterResult = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  errorMessage: null,
  summary: "Company capacity fixture.",
  provider: "test",
  model: "test-model",
};
const mockAdapterExecute = vi.hoisted(() => vi.fn());

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

describe("company run capacity", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let holdAdapters = true;
  const adapterReleases = new Map<string, () => void>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-capacity-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, {
      runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" },
    });
  }, 30_000);

  beforeEach(() => {
    holdAdapters = true;
    adapterReleases.clear();
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async (context: { runId: string }) => {
      if (holdAdapters) {
        await new Promise<void>((resolve) => adapterReleases.set(context.runId, resolve));
      }
      return adapterResult;
    });
  });

  afterEach(async () => {
    // Only this disposable test database is touched. Stop queued fixtures before
    // releasing adapters, so cleanup cannot dispatch another held test adapter.
    holdAdapters = false;
    await db.update(heartbeatRuns).set({
      status: "cancelled",
      finishedAt: new Date(),
    }).where(eq(heartbeatRuns.status, "queued"));
    for (const release of adapterReleases.values()) release();
    await heartbeat.drainActiveRunExecutions();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createWorker(companyId: string, name: string) {
    const [agent] = await db.insert(agents).values({
      companyId,
      name,
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { enabled: false, intervalSec: 0, wakeOnDemand: true, maxConcurrentRuns: 1 },
      },
      permissions: {},
    }).returning();
    return agent;
  }

  async function invokeWorker(agentId: string, service = heartbeat) {
    const run = await service.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      requestedByActorType: "user",
      requestedByActorId: "responsible-user",
    });
    expect(run).not.toBeNull();
    return run!;
  }

  it("persists the validated company-wide run limit", async () => {
    const service = companyService(db);
    const created = await service.create(createCompanySchema.parse({
      name: "Serial execution fixture",
      maxConcurrentRuns: 1,
    }));

    expect(await service.getById(created.id)).toMatchObject({ maxConcurrentRuns: 1 });
    await service.update(created.id, updateCompanySchema.parse({ maxConcurrentRuns: null }));
    expect(await service.getById(created.id)).toMatchObject({ maxConcurrentRuns: null });
  });

  it.each([0, -1, 1.5, 2_147_483_648, "1"])("rejects invalid company capacity %s", (value) => {
    expect(createCompanySchema.safeParse({ name: "Invalid capacity", maxConcurrentRuns: value }).success)
      .toBe(false);
    expect(updateCompanySchema.safeParse({ maxConcurrentRuns: value }).success).toBe(false);
  });

  it("atomically admits one of two simultaneous agents across service instances", async () => {
    const company = await companyService(db).create({
      name: "Concurrent admission fixture",
      defaultResponsibleUserId: "responsible-user",
      maxConcurrentRuns: 1,
    });
    const firstAgent = await createWorker(company.id, "First worker");
    const secondAgent = await createWorker(company.id, "Second worker");
    const secondService = heartbeatService(db, {
      runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" },
    });

    const runs = await Promise.all([
      invokeWorker(firstAgent.id),
      invokeWorker(secondAgent.id, secondService),
    ]);
    await vi.waitFor(() => expect(adapterReleases.size).toBe(1));
    const persisted = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, company.id));
    expect(persisted.map((run) => run.status).sort()).toEqual(["queued", "running"]);
    expect(new Set(persisted.map((run) => run.id))).toEqual(new Set(runs.map((run) => run.id)));
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
  });

  it("promotes the next agent after an owned adapter acknowledges cancellation under the company cap", async () => {
    let registered = false;
    let cancelledAdapterStopped = false;
    mockAdapterExecute.mockImplementationOnce(async (context: {
      runId: string; signal?: AbortSignal; onCancellationReady?: () => Promise<void>;
    }) => {
      await context.onCancellationReady?.();
      registered = true;
      await new Promise<void>((resolve) => {
        adapterReleases.set(context.runId, resolve);
        context.signal?.addEventListener("abort", () => {
          cancelledAdapterStopped = true;
          resolve();
        }, { once: true });
      });
      return {
        ...adapterResult,
        resultJson: { executionCancellation: { state: "acknowledged", forced: false } },
      };
    });
    const company = await companyService(db).create({
      name: "Cancelled company run", defaultResponsibleUserId: "responsible-user", maxConcurrentRuns: 1,
    });
    const firstAgent = await createWorker(company.id, "Cancelled worker");
    const secondAgent = await createWorker(company.id, "Next worker");
    const first = await invokeWorker(firstAgent.id);
    await vi.waitFor(() => expect(registered).toBe(true));
    const second = await invokeWorker(secondAgent.id);
    expect(second).toMatchObject({ status: "queued" });
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    await heartbeat.cancelRun(first.id, "Synthetic owned-adapter cancellation");
    await heartbeat.waitForRunExecutionDrain(first.id);
    expect(cancelledAdapterStopped).toBe(true);
    expect(await heartbeat.getRun(first.id)).toMatchObject({
      status: "cancelled", resultJson: { executionCancellation: { state: "acknowledged" } },
    });
    await vi.waitFor(() => expect(adapterReleases.has(second.id)).toBe(true));
    expect(mockAdapterExecute).toHaveBeenCalledTimes(2);
    expect(await heartbeat.getRun(second.id)).toMatchObject({ status: "running" });
    adapterReleases.get(second.id)!();
    await heartbeat.waitForRunExecutionDrain(second.id);
  });

  it("preserves uncapped company behavior by default", async () => {
    const company = await companyService(db).create({
      name: "Uncapped fixture",
      defaultResponsibleUserId: "responsible-user",
    });
    expect(await companyService(db).getById(company.id)).toMatchObject({ maxConcurrentRuns: null });
    const firstAgent = await createWorker(company.id, "First worker");
    const secondAgent = await createWorker(company.id, "Second worker");

    await Promise.all([invokeWorker(firstAgent.id), invokeWorker(secondAgent.id)]);

    await vi.waitFor(() => expect(adapterReleases.size).toBe(2));
    const persisted = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, company.id));
    expect(persisted.map((run) => run.status)).toEqual(["running", "running"]);
  });

  it("does not consume another company's run capacity", async () => {
    const companyA = await companyService(db).create({
      name: "Tenant A", defaultResponsibleUserId: "responsible-user", maxConcurrentRuns: 1,
    });
    const companyB = await companyService(db).create({
      name: "Tenant B", defaultResponsibleUserId: "responsible-user", maxConcurrentRuns: 1,
    });
    const agentA = await createWorker(companyA.id, "Worker A");
    const agentB = await createWorker(companyB.id, "Worker B");

    const runA = await invokeWorker(agentA.id);
    await vi.waitFor(() => expect(adapterReleases.has(runA.id)).toBe(true));
    const runB = await invokeWorker(agentB.id);

    await vi.waitFor(() => expect(adapterReleases.has(runB.id)).toBe(true));
    expect(mockAdapterExecute).toHaveBeenCalledTimes(2);
    const [persistedB] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runB.id));
    expect(persistedB).toMatchObject({ companyId: companyB.id, status: "running" });
  });

  it("keeps a different agent queued while the company run slot is occupied", async () => {
    const company = await companyService(db).create({
      name: "Company admission fixture",
      defaultResponsibleUserId: "responsible-user",
      maxConcurrentRuns: 1,
    });
    const firstAgent = await createWorker(company.id, "First worker");
    const secondAgent = await createWorker(company.id, "Second worker");
    const firstRun = await invokeWorker(firstAgent.id);
    await vi.waitFor(() => expect(adapterReleases.has(firstRun.id)).toBe(true));

    const secondRun = await invokeWorker(secondAgent.id);

    const [persistedSecondRun] = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, secondRun.id));
    expect(persistedSecondRun.status).toBe("queued");
    expect(adapterReleases.has(secondRun.id)).toBe(false);
  });

  it("starts a queued company peer after the occupying run completes", async () => {
    const company = await companyService(db).create({
      name: "Company handoff fixture",
      defaultResponsibleUserId: "responsible-user",
      maxConcurrentRuns: 1,
    });
    const firstAgent = await createWorker(company.id, "First worker");
    const secondAgent = await createWorker(company.id, "Second worker");
    const firstRun = await invokeWorker(firstAgent.id);
    await vi.waitFor(() => expect(adapterReleases.has(firstRun.id)).toBe(true));
    const secondRun = await invokeWorker(secondAgent.id);

    adapterReleases.get(firstRun.id)!();

    // No second wake, timer, resume call, or synthetic terminal-state write.
    await vi.waitFor(() => expect(adapterReleases.has(secondRun.id)).toBe(true), { timeout: 3_000 });
    const [completed] = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, firstRun.id));
    expect(completed.status).toBe("succeeded");
    expect(mockAdapterExecute.mock.calls.filter(([context]) => context.runId === secondRun.id))
      .toHaveLength(1);
  });

  it("releases company capacity when the occupying adapter fails", async () => {
    mockAdapterExecute.mockImplementationOnce(async (context: { runId: string }) => {
      await new Promise<void>((resolve) => adapterReleases.set(context.runId, resolve));
      return { ...adapterResult, exitCode: 1, errorMessage: "Intentional adapter failure fixture" };
    });
    const company = await companyService(db).create({
      name: "Failed run release fixture", defaultResponsibleUserId: "responsible-user", maxConcurrentRuns: 1,
    });
    const firstAgent = await createWorker(company.id, "Failing worker");
    const secondAgent = await createWorker(company.id, "Next worker");
    const firstRun = await invokeWorker(firstAgent.id);
    await vi.waitFor(() => expect(adapterReleases.has(firstRun.id)).toBe(true));
    const secondRun = await invokeWorker(secondAgent.id);

    adapterReleases.get(firstRun.id)!();

    await vi.waitFor(() => expect(adapterReleases.has(secondRun.id)).toBe(true), { timeout: 3_000 });
    const [failed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, firstRun.id));
    expect(failed.status).toBe("failed");
    expect(mockAdapterExecute.mock.calls.filter(([context]) => context.runId === secondRun.id))
      .toHaveLength(1);
  });
});
