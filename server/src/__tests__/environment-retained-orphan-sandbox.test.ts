import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  environmentLeases,
  environments,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { currentProcessSpaceHash } from "../services/controller-process-identity.js";
import { nextEnvironmentCleanupAt } from "../services/environment-cleanup-state.js";
import { ENVIRONMENT_LEASE_CONTROLLER_KEY } from "../services/environment-lease-controller.js";
import { heartbeatService, type HeartbeatEnvironmentRuntime } from "../services/heartbeat.js";
import { createOwnershipReportState, runOwnershipReconciliationPass } from "../services/recovery/ownership-invariant-report.js";
import { ORPHANED_SANDBOX_RECOVERY_KEY } from "../services/sandbox-stop-and-retain.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
const KIND = "environment_retained_orphan_sandbox";

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise<void>(resolve => { child.once("exit", () => resolve()); child.kill("SIGKILL"); });
  return pid;
}

suite("retained orphan sandbox on the shared ownership path", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";
  let agentId = "";
  let environmentId = "";
  let issueId = "";

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-retained-orphan-sandbox-");
    db = createDb(temporary.connectionString);
    companyId = randomUUID(); agentId = randomUUID(); environmentId = randomUUID(); issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: "ROS",
      requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Coder", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(environments).values({ id: environmentId, name: "Fake Sandbox", driver: "sandbox",
      status: "active", config: { provider: "fake", image: "ubuntu:24.04" } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Orphaned work" });
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
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

  /** The end state of an orphaned run lease: the ownership settle stopped the
   * sandbox and kept it, and the stop was confirmed. */
  async function retainedOrphan(runId: string, extra: { expiresAt?: Date; metadata?: Record<string, unknown> } = {}) {
    const id = randomUUID(), providerLeaseId = `sandbox://fake/${id}`, now = new Date();
    await db.insert(environmentLeases).values({ id, companyId, environmentId, issueId, heartbeatRunId: runId,
      status: "released", cleanupStatus: "success", leasePolicy: "ephemeral", provider: "fake", providerLeaseId,
      acquiredAt: new Date(now.getTime() - 60_000), releasedAt: now, expiresAt: extra.expiresAt ?? null,
      metadata: {
        [ORPHANED_SANDBOX_RECOVERY_KEY]: { recoveredOrphanedRunLease: true, ownerProof: "pid_dead", runId },
        remoteExecutionTermination: { schema: "paperclip.remote-termination.v1", companyId, runId, leaseId: id,
          provider: "fake", providerLeaseId, state: "stopped", confirmedAt: now.toISOString() },
        sandboxStopAndRetainReceipt: { schema: "paperclip.sandbox-stop-and-retain-receipt.v1", requestId: randomUUID(),
          companyId, runId, leaseId: id, provider: "fake", providerLeaseId, builtinProvider: "fake",
          method: "builtin.stopLease", confirmedAt: now.toISOString() },
        ...extra.metadata,
      } });
    return id;
  }

  async function pass(record = true) {
    const report = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record });
    return { report, kind: report.kinds.find(entry => entry.kind === KIND)! };
  }

  it("marks the lease when the orphaned-run-lease settle stops and keeps its sandbox", async () => {
    const runId = await run("failed");
    const id = randomUUID();
    await db.insert(environmentLeases).values({ id, companyId, environmentId, heartbeatRunId: runId, status: "active",
      provider: "fake", providerLeaseId: `sandbox://fake/${id}`, metadata: { [ENVIRONMENT_LEASE_CONTROLLER_KEY]: {
        bootId: "earlier-boot", pid: await exitedPid(), hostHash: currentProcessSpaceHash(), processStartedAt: null } } });
    await pass();
    expect((await row(id)).metadata?.[ORPHANED_SANDBOX_RECOVERY_KEY]).toMatchObject({
      recoveredOrphanedRunLease: true, ownerProof: "pid_dead", runId });
  });

  it("destroys a retained orphan that nothing references, through the cleanup sweep", async () => {
    const leaseId = await retainedOrphan(await run("failed"));
    const { kind } = await pass();
    expect(kind).toMatchObject({ inProgress: 1, settled: 1 });
    const released = await row(leaseId);
    expect(released).toMatchObject({ status: "pending_cleanup", leasePolicy: "ephemeral",
      failureReason: "retained_orphan_sandbox_released" });
    expect(released.metadata?.remoteExecutionTermination).toBeUndefined();
    expect(released.metadata?.retainedOrphanRelease).toMatchObject({ ownerProof: "owner_run_terminal",
      stopReceipt: { state: "stopped" } });
    // Due now, and the sweep destroys it from the recorded lease.
    expect(await nextEnvironmentCleanupAt(db)).toBeLessThanOrEqual(Date.now());
    const teardown = vi.fn(async ({ lease }: { lease: { providerLeaseId: string | null } }) =>
      ({ providerLeaseId: lease.providerLeaseId, state: "destroyed" }));
    await heartbeatService(db, { environmentRuntime: { retryPendingSandboxTeardown: teardown } as unknown as HeartbeatEnvironmentRuntime })
      .sweepPendingCleanupLeases({ backoffMs: 5 * 60_000 });
    expect(teardown).toHaveBeenCalledOnce();
    expect((await row(leaseId)).status).toBe("expired");
  });

  it.each([
    ["an open recovery action on the issue", async (_runId: string) => {
      await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
        cause: "fixture", fingerprint: randomUUID(), nextAction: "Recover the workspace." });
      return {};
    }],
    ["a queued run on the issue", async (_runId: string) => { await run("queued"); return {}; }],
    ["a scheduled retry on the issue", async (_runId: string) => { await run("scheduled_retry"); return {}; }],
    ["a stop-and-retain intent", async () => ({ metadata: { sandboxStopAndRetain: { requestId: "pending" } } })],
    ["a native export resume", async () => ({ metadata: { nativeWorkspaceExportResume: { requestId: "pending" } } })],
    ["a workspace restore recovery", async () => ({ metadata: { workspaceRestoreRecovery: { runId: "fixture" } } })],
    ["an in-flight cleanup claim", async () => ({ metadata: { pendingCleanupInFlight: true, pendingCleanupAttemptId: "a" } })],
    ["a pending legacy shutdown fence", async () => ({ metadata: { legacyShutdownWorkspaceSettlement: { state: "pending" } } })],
  ] as const)("never destroys a sandbox recovery still wants: %s", async (_label, arrange) => {
    const runId = await run("failed");
    const extra = await arrange(runId);
    const leaseId = await retainedOrphan(runId, extra);
    const before = await row(leaseId);
    const { kind } = await pass();
    expect(kind).toMatchObject({ settled: 0 });
    expect(await row(leaseId)).toEqual(before);
  });

  it("never destroys a sandbox another live lease holds, or one whose run is still active", async () => {
    const live = await retainedOrphan(await run("running"));
    const sharedRun = await run("failed");
    const shared = await retainedOrphan(sharedRun);
    const sharedRow = await row(shared);
    await db.insert(environmentLeases).values({ companyId, environmentId, heartbeatRunId: await run("running"),
      status: "active", provider: "fake", providerLeaseId: sharedRow.providerLeaseId });
    await pass();
    expect((await row(live)).status).toBe("released");
    expect((await row(shared)).status).toBe("released");
  });

  it("keeps a softly referenced orphan only until its retention window ends, and wakes then", async () => {
    const runId = await run("failed");
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      cause: "fixture", fingerprint: randomUUID(), nextAction: "Recover the workspace." });
    const expiresAt = new Date(Date.now() + 60 * 60_000);
    const leaseId = await retainedOrphan(runId, { expiresAt });
    const first = await pass();
    expect(first.kind).toMatchObject({ inProgress: 0 });
    expect(first.report.nextDueAt?.getTime()).toBeLessThanOrEqual(expiresAt.getTime());
    expect((await row(leaseId)).status).toBe("released");
    // Past the window no recovery path accepts the stopped sandbox as a source.
    await db.update(environmentLeases).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(environmentLeases.id, leaseId));
    const second = await pass();
    expect(second.kind).toMatchObject({ settled: 1 });
    expect((await row(leaseId)).status).toBe("pending_cleanup");
  });

  it("never changes anything on a read-only pass", async () => {
    const leaseId = await retainedOrphan(await run("failed"));
    const before = await row(leaseId);
    const { kind } = await pass(false);
    expect(kind).toMatchObject({ inProgress: 1, settled: 0, verdicts: { gone: 1 } });
    expect(await row(leaseId)).toEqual(before);
  });

  it("leaves an ordinary retained sandbox (no orphan marker) alone", async () => {
    const leaseId = await retainedOrphan(await run("failed"));
    const { [ORPHANED_SANDBOX_RECOVERY_KEY]: _marker, ...metadata } = (await row(leaseId)).metadata!;
    await db.update(environmentLeases).set({ metadata }).where(eq(environmentLeases.id, leaseId));
    const { kind } = await pass();
    expect(kind).toMatchObject({ inProgress: 0 });
    expect((await row(leaseId)).status).toBe("released");
  });
});
