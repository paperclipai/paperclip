import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { nextEnvironmentCleanupAt } from "../services/environment-cleanup-state.js";
import { heartbeatService, type HeartbeatEnvironmentRuntime } from "../services/heartbeat.js";
import {
  nextWarmSandboxStopAt,
  stopWarmSandboxesPastWindow,
  WARM_SANDBOX_IDLE_CLOSE_MARGIN_MS,
  WARM_SANDBOX_IDLE_TIMEOUT_KEY,
  warmSandboxWindowMetadata,
} from "../services/warm-sandbox-expiry.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

suite("warm sandbox expiry", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";
  let agentId = "";
  let environmentId = "";
  let issueId = "";

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-warm-sandbox-expiry-");
    db = createDb(temporary.connectionString);
    companyId = randomUUID(); agentId = randomUUID(); environmentId = randomUUID(); issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: "WSE",
      requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Coder", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(environments).values({ id: environmentId, name: "Fake Sandbox", driver: "sandbox",
      status: "active", config: { provider: "fake", image: "ubuntu:24.04", reuseLease: true } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Warm work" });
  }, 30_000);

  afterEach(async () => {
    await db.delete(environmentLeases);
    await db.delete(heartbeatRuns);
  });

  afterAll(async () => {
    await temporary?.cleanup();
  });

  async function run(status: string) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({ id, companyId, agentId, issueId, invocationSource: "on_demand", status, nextEventSeq: 1 });
    return id;
  }

  async function row(id: string) {
    const [found] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, id));
    return found!;
  }

  /** The end state of a warm run: its reusable lease is retained and the
   * sandbox kept running for the next turn. */
  async function warmRetained(input: { releasedAgoMs: number; windowMs?: number | null; runStatus?: string;
    providerLeaseId?: string }) {
    const id = randomUUID(), now = Date.now();
    const runId = await run(input.runStatus ?? "succeeded");
    await db.insert(environmentLeases).values({ id, companyId, environmentId, issueId, heartbeatRunId: runId,
      status: "retained", cleanupStatus: "success", leasePolicy: "reuse_by_environment", provider: "fake",
      providerLeaseId: input.providerLeaseId ?? `sandbox://fake/${id}`,
      acquiredAt: new Date(now - input.releasedAgoMs - MINUTE), lastUsedAt: new Date(now - input.releasedAgoMs),
      metadata: { provider: "fake", reuseLease: true,
        ...(input.windowMs === null ? {} : warmSandboxWindowMetadata(input.windowMs ?? 5 * MINUTE)) } });
    return id;
  }

  it("keeps a sandbox still inside its warm window, and wakes when the window ends", async () => {
    const leaseId = await warmRetained({ releasedAgoMs: 2 * MINUTE, windowMs: 5 * MINUTE });
    const before = await row(leaseId);

    expect(await stopWarmSandboxesPastWindow(db)).toEqual({ stopping: 0 });
    expect(await row(leaseId)).toEqual(before);

    const windowEnd = before.lastUsedAt.getTime() + 5 * MINUTE + WARM_SANDBOX_IDLE_CLOSE_MARGIN_MS;
    expect(await nextWarmSandboxStopAt(db)).toBe(windowEnd);
    // The cleanup worker sleeps until exactly that deadline: no interval scan.
    expect(await nextEnvironmentCleanupAt(db)).toBe(windowEnd);
  });

  it("stops a sandbox once its warm window has passed and keeps it for the next turn", async () => {
    const leaseId = await warmRetained({ releasedAgoMs: 8 * MINUTE, windowMs: 5 * MINUTE });

    expect(await stopWarmSandboxesPastWindow(db)).toEqual({ stopping: 1 });
    const stopping = await row(leaseId);
    expect(stopping).toMatchObject({ status: "pending_cleanup", failureReason: "sandbox_stop_pending" });
    expect(stopping.metadata?.sandboxStopAndRetain).toMatchObject({ warmWindowExpired: true, leaseId });
    // Its first stop is due now, not after the retry backoff.
    expect(await nextEnvironmentCleanupAt(db)).toBeLessThanOrEqual(Date.now());
    expect(await nextWarmSandboxStopAt(db)).toBeNull();
  });

  it("leaves the host's idle close of the warm runner time to finish before stopping its sandbox", async () => {
    const closing = await warmRetained({ releasedAgoMs: 5 * MINUTE + 3_000, windowMs: 5 * MINUTE });
    const before = await row(closing);

    expect(await stopWarmSandboxesPastWindow(db)).toEqual({ stopping: 0 });
    expect(await row(closing)).toEqual(before);
    expect(await nextWarmSandboxStopAt(db)).toBeGreaterThanOrEqual(before.lastUsedAt.getTime() + 5 * MINUTE + 90_000);

    await db.update(environmentLeases).set({ lastUsedAt: new Date(Date.now() - 5 * MINUTE - WARM_SANDBOX_IDLE_CLOSE_MARGIN_MS - 1_000) })
      .where(eq(environmentLeases.id, closing));
    expect(await stopWarmSandboxesPastWindow(db)).toEqual({ stopping: 1 });
  });

  it("stops the sandbox at the provider through the cleanup sweep", async () => {
    const leaseId = await warmRetained({ releasedAgoMs: 8 * MINUTE, windowMs: 5 * MINUTE });
    const teardown = vi.fn(async ({ lease }: { lease: { providerLeaseId: string | null } }) =>
      ({ providerLeaseId: lease.providerLeaseId, state: "stopped" }));

    await heartbeatService(db, { environmentRuntime: { retryPendingSandboxTeardown: teardown } as unknown as HeartbeatEnvironmentRuntime })
      .sweepPendingCleanupLeases({ backoffMs: 5 * MINUTE });

    expect(teardown).toHaveBeenCalledOnce();
    const stopped = await row(leaseId);
    // Stopped and kept: a reusable lease the next run on the task resumes.
    expect(stopped).toMatchObject({ status: "released", cleanupStatus: "success", leasePolicy: "reuse_by_environment" });
    expect(stopped.metadata?.remoteExecutionTermination).toMatchObject({ state: "stopped" });
    expect(stopped.metadata?.sandboxStopAndRetain).toBeUndefined();
    expect(await nextEnvironmentCleanupAt(db)).toBeNull();
  });

  it("keeps a sandbox past its window while a live run holds it", async () => {
    const providerLeaseId = `sandbox://fake/${randomUUID()}`;
    const leaseId = await warmRetained({ releasedAgoMs: 8 * MINUTE, providerLeaseId });
    const liveRun = await run("running");
    await db.insert(environmentLeases).values({ companyId, environmentId, issueId, heartbeatRunId: liveRun,
      status: "active", leasePolicy: "reuse_by_environment", provider: "fake", providerLeaseId,
      metadata: { provider: "fake", reuseLease: true } });
    const before = await row(leaseId);

    expect(await stopWarmSandboxesPastWindow(db)).toEqual({ stopping: 0 });
    expect(await row(leaseId)).toEqual(before);
    // A held sandbox is no deadline; the live run's release wakes the worker.
    expect(await nextWarmSandboxStopAt(db)).toBeNull();
  });

  it("keeps a sandbox past its window while a run on the task is starting", async () => {
    const leaseId = await warmRetained({ releasedAgoMs: 8 * MINUTE });
    await run("running");
    const before = await row(leaseId);

    expect(await stopWarmSandboxesPastWindow(db)).toEqual({ stopping: 0 });
    expect(await row(leaseId)).toEqual(before);
  });

  it("keeps a sandbox whose own run has not ended", async () => {
    const leaseId = await warmRetained({ releasedAgoMs: 8 * MINUTE, runStatus: "running" });

    expect(await stopWarmSandboxesPastWindow(db)).toEqual({ stopping: 0 });
    expect((await row(leaseId)).status).toBe("retained");
  });

  it("leaves a plugin Runner task lease to its own cleanup", async () => {
    // Its release path does not use the stop-only contract, so expiry must not
    // hand it over: the plugin could free the allocation and the task's files.
    const leaseId = await warmRetained({ releasedAgoMs: 8 * MINUTE });
    await db.update(environmentLeases).set({ metadata: { driver: "plugin", pluginId: "fake-plugin",
      runnerTaskLease: true, [WARM_SANDBOX_IDLE_TIMEOUT_KEY]: 5 * MINUTE } }).where(eq(environmentLeases.id, leaseId));
    const before = await row(leaseId);

    expect(await stopWarmSandboxesPastWindow(db)).toEqual({ stopping: 0 });
    expect(await row(leaseId)).toEqual(before);
    expect(await nextWarmSandboxStopAt(db)).toBeNull();
  });

  it("reconciles a warm sandbox left running across a restart", async () => {
    // Retained before the warm window was recorded, 35 hours ago: past the
    // longest window any run can configure.
    const leaked = await warmRetained({ releasedAgoMs: 35 * HOUR, windowMs: null });
    // Retained an hour ago with no recorded window: it could still be warm.
    const recent = await warmRetained({ releasedAgoMs: HOUR, windowMs: null });

    // At boot the cleanup worker's first pass finds the leak due now.
    expect(await nextEnvironmentCleanupAt(db)).toBeLessThanOrEqual(Date.now());
    const teardown = vi.fn(async ({ lease }: { lease: { providerLeaseId: string | null } }) =>
      ({ providerLeaseId: lease.providerLeaseId, state: "stopped" }));
    await heartbeatService(db, { environmentRuntime: { retryPendingSandboxTeardown: teardown } as unknown as HeartbeatEnvironmentRuntime })
      .sweepPendingCleanupLeases({ backoffMs: 0 });

    expect(teardown).toHaveBeenCalledOnce();
    expect(await row(leaked)).toMatchObject({ status: "released", cleanupStatus: "success" });
    expect((await row(recent)).status).toBe("retained");
    const recentRow = await row(recent);
    expect(await nextWarmSandboxStopAt(db)).toBe(recentRow.lastUsedAt.getTime() + 24 * HOUR + WARM_SANDBOX_IDLE_CLOSE_MARGIN_MS);
  });

  it("records the run's warm window on the lease only for a warm run", () => {
    expect(warmSandboxWindowMetadata(7 * MINUTE)).toEqual({ [WARM_SANDBOX_IDLE_TIMEOUT_KEY]: 7 * MINUTE });
    expect(warmSandboxWindowMetadata(undefined)).toEqual({});
    expect(warmSandboxWindowMetadata(0)).toEqual({});
  });
});
