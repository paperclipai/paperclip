import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, companies, createDb, environmentLeases, environments, executionWorkspaceSnapshots, executionWorkspaces,
  heartbeatRuns, issues, projects, type Db,
} from "@paperclipai/db";
import { readRemoteWorkspaceAuthority } from "@paperclipai/shared";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import { remoteTerminationReceipt } from "../services/remote-execution-termination.js";
import { registerTerminalWorkspaceWork, TERMINAL_WORKSPACE_RETRY_MS } from "../services/terminal-workspace-work.js";
import { meterDatabaseStatements } from "./helpers/database-statement-meter.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_TERMINAL_WORKSPACE_IDLE_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
const DAY = 86_400_000;
const realSetTimeout = globalThis.setTimeout;
const realSleep = (ms: number) => new Promise(resolve => realSetTimeout(resolve, ms));

(support.supported ? describe : describe.skip)("terminal workspace sweep at idle", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  let meter: ReturnType<typeof meterDatabaseStatements>;
  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("terminal-workspace-idle-");
    const url = external ?? temporary!.connectionString;
    db = createDb(url);
    db.$client.options.onnotice = () => {};
    meter = meterDatabaseStatements(db, url);
  }, 120_000);
  afterEach(() => { vi.useRealTimers(); });
  afterAll(async () => { meter?.uninstall(); await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });

  async function seedCompany() {
    const companyId = randomUUID(), projectId = randomUUID(), agentId = randomUUID(), environmentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Idle", issuePrefix: `I${companyId.slice(0, 6)}` });
    await db.insert(projects).values({ id: projectId, companyId, name: "Project", status: "in_progress" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", role: "engineer", status: "idle", adapterType: "process" });
    await db.insert(environments).values({ id: environmentId, name: `Sandbox ${environmentId}`, driver: "sandbox" });
    return { companyId, projectId, agentId, environmentId };
  }

  async function seedWorkspace(f: Awaited<ReturnType<typeof seedCompany>>, kind: "open" | "held" | "cooldown" | "done" | "remote" | "remote_unsaved") {
    const old = new Date(Date.now() - 10 * DAY);
    const id = randomUUID(), issueId = randomUUID(), snapshotId = randomUUID();
    const location = { environmentId: f.environmentId, leaseId: randomUUID(), providerLeaseId: `sandbox-${randomUUID()}`, remoteCwd: "/workspace" };
    const remote = kind === "remote" || kind === "remote_unsaved";
    let runId: string | null = null;
    if (kind === "held") {
      runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, status: "running" });
    }
    await db.insert(executionWorkspaces).values({ id, companyId: f.companyId, projectId: f.projectId,
      mode: remote ? "isolated_workspace" : "shared_workspace", strategyType: "project_primary", name: `${kind} ${id}`,
      status: remote ? "archived" : "active", closedAt: remote ? old : null, providerType: remote ? "remote" : "local_fs",
      cwd: `/missing/${id}`, createdAt: old, updatedAt: old,
      metadata: remote ? { remoteWorkspace: { schema: "paperclip.remote-workspace.v1", epoch: 1, snapshotId,
        source: { kind: "empty" }, location, writerRunId: null, dirty: false } } : null });
    await db.insert(issues).values({ id: issueId, companyId: f.companyId, projectId: f.projectId, title: kind,
      status: kind === "open" ? "in_progress" : "done", executionWorkspaceId: id, executionRunId: runId,
      completedAt: kind === "open" ? null : kind === "cooldown" ? new Date(Date.now() - 3_600_000) : old, updatedAt: old });
    await db.update(executionWorkspaces).set({ sourceIssueId: issueId, updatedAt: old }).where(eq(executionWorkspaces.id, id));
    if (kind === "remote") await db.insert(executionWorkspaceSnapshots).values({ id: snapshotId, companyId: f.companyId,
      executionWorkspaceId: id, sourceOperationId: randomUUID(), generation: 1, epoch: 1, status: "committed" });
    return { id, location };
  }

  function destroyedLease(input: { companyId: string; leaseId: string; providerLeaseId: string; environmentId: string }) {
    const lease = { id: input.leaseId, companyId: input.companyId, heartbeatRunId: randomUUID(), provider: "daytona",
      providerLeaseId: input.providerLeaseId, environmentId: input.environmentId };
    return { ...lease, status: "released", cleanupStatus: "success", releasedAt: new Date(),
      metadata: { remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId: input.providerLeaseId, state: "destroyed" }) } };
  }

  it("settles after one cleanup of each closed remote workspace and inspects nothing on its own writes", async () => {
    const f = await seedCompany();
    const remote: string[] = [];
    for (const kind of ["open", "open", "held", "cooldown", "done", "remote", "remote", "remote_unsaved"] as const) {
      for (let index = 0; index < 5; index++) {
        const workspace = await seedWorkspace(f, kind);
        if (kind === "remote") remote.push(workspace.id);
      }
    }
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const destroyCalls: string[] = [];
    const service = executionWorkspaceService(db, {
      destroyRemoteWorkspaceLease: async input => { destroyCalls.push(input.workspaceId); return destroyedLease(input) as never; },
      workspaceReaperCooldownDays: 1, workspaceCompactionDelayMs: 3_600_000,
      terminalWorkspaceInspectionBackoffMs: TERMINAL_WORKSPACE_RETRY_MS,
    });
    const sweeps: Array<{ targeted: boolean; checked: number }> = [];
    let inFlight = 0;
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: () => {} });
    const worker = registerTerminalWorkspaceWork(coordinator, { ...service,
      sweepTerminalWorkspaces: async (limit, signal, options) => {
        inFlight += 1;
        try {
          const result = await service.sweepTerminalWorkspaces(limit, signal, options);
          sweeps.push({ targeted: Boolean(options?.targets), checked: result.checked });
          return result;
        } finally { inFlight -= 1; }
      } }, () => true);
    const idle = async (seconds: number) => {
      for (let second = 0; second < seconds; second += 10) {
        await vi.advanceTimersByTimeAsync(10_000);
        do { await realSleep(10); await vi.advanceTimersByTimeAsync(1); } while (inFlight > 0);
      }
    };
    try {
      await idle(120);
      expect(new Set(destroyCalls)).toEqual(new Set(remote));
      expect(destroyCalls.length).toBe(remote.length);
      const before = { statements: meter.read().statements, sweeps: sweeps.length, destroys: destroyCalls.length };
      await idle(30 * 60);
      vi.useRealTimers();
      const window = sweeps.slice(before.sweeps);
      expect(destroyCalls.length).toBe(before.destroys);
      expect(window.filter(sweep => sweep.targeted)).toEqual([]);
      expect(meter.read().statements - before.statements).toBeLessThan(5_000);
      for (const id of remote) {
        const [row] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, id));
        expect(readRemoteWorkspaceAuthority(row!.metadata)?.location).toBeNull();
      }
    } finally {
      vi.useRealTimers();
      await worker.stop(); await coordinator.stop();
    }
  }, 600_000);

  it("clears the location of an already destroyed lease without calling the provider again", async () => {
    const f = await seedCompany();
    const workspace = await seedWorkspace(f, "remote");
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, status: "succeeded" });
    const lease = { id: workspace.location.leaseId, companyId: f.companyId, heartbeatRunId: runId, provider: "daytona",
      providerLeaseId: workspace.location.providerLeaseId };
    await db.insert(environmentLeases).values({ ...lease, environmentId: f.environmentId, executionWorkspaceId: workspace.id,
      status: "released", cleanupStatus: "success", releasedAt: new Date(),
      metadata: { remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "destroyed" }) } });
    const destroy = vi.fn();
    const service = executionWorkspaceService(db, { destroyRemoteWorkspaceLease: destroy as never, workspaceReaperCooldownDays: 1 });
    expect(await service.sweepTerminalWorkspaces(50, undefined, { targets: { workspaceIds: [workspace.id], issueIds: [] } }))
      .toMatchObject({ checked: 1, archived: 1 });
    expect(destroy).not.toHaveBeenCalled();
    const [row] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspace.id));
    expect(readRemoteWorkspaceAuthority(row!.metadata)?.location).toBeNull();
    expect(await service.sweepTerminalWorkspaces(50, undefined, { targets: { workspaceIds: [workspace.id], issueIds: [] } }))
      .toMatchObject({ checked: 0 });
  });
});
