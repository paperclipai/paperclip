import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb, executionWorkspaceSnapshots, executionWorkspaces, issues, projects, type Db } from "@paperclipai/db";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../services/delivery-work-notifications.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import {
  notifyTerminalWorkspaceWork, registerTerminalWorkspaceWork, TERMINAL_WORKSPACE_BACKSTOP_MS, TERMINAL_WORKSPACE_PLUGIN_HINT,
  TERMINAL_WORKSPACE_RETRY_MS,
} from "../services/terminal-workspace-work.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_TERMINAL_WORKSPACE_ROTATION_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
const HOUR = 3_600_000;
const realSetTimeout = globalThis.setTimeout;
const realSleep = (ms: number) => new Promise(resolve => realSetTimeout(resolve, ms));

(support.supported ? describe : describe.skip)("terminal workspace full rotation limits", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("terminal-workspace-rotation-");
    db = createDb(external ?? temporary!.connectionString);
    db.$client.options.onnotice = () => {};
  }, 120_000);
  afterEach(async () => { vi.useRealTimers(); await db.execute(sql`truncate companies cascade`); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });

  async function seed(input: { remote: number; plugin?: number }) {
    const companyId = randomUUID(), projectId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Rotation", issuePrefix: `R${companyId.slice(0, 6)}` });
    await db.insert(projects).values({ id: projectId, companyId, name: "Project", status: "in_progress" });
    const old = new Date(Date.now() - 5 * 24 * HOUR);
    const remote = Array.from({ length: input.remote }, () => ({ workspaceId: randomUUID(), issueId: randomUUID(), snapshotId: randomUUID() }));
    const plugin = Array.from({ length: input.plugin ?? 0 }, () => ({ workspaceId: randomUUID(), issueId: randomUUID() }));
    for (let index = 0; index < remote.length; index += 250) {
      const page = remote.slice(index, index + 250);
      await db.insert(executionWorkspaces).values(page.map(row => ({ id: row.workspaceId, companyId, projectId, mode: "isolated_workspace",
        strategyType: "git_worktree", name: row.workspaceId, status: "active", providerType: "remote", createdAt: old, updatedAt: old,
        metadata: { remoteWorkspace: { schema: "paperclip.remote-workspace.v1", epoch: 1, snapshotId: row.snapshotId, source: { kind: "empty" },
          writerRunId: null, dirty: false, location: { environmentId: randomUUID(), leaseId: randomUUID(),
            providerLeaseId: `sandbox-${row.workspaceId}`, remoteCwd: "/workspace" } } } })));
      await db.insert(executionWorkspaceSnapshots).values(page.map(row => ({ id: row.snapshotId, companyId, executionWorkspaceId: row.workspaceId,
        sourceOperationId: randomUUID(), generation: 1, epoch: 1, status: "committed" as const })));
    }
    if (plugin.length) await db.insert(executionWorkspaces).values(plugin.map(row => ({ id: row.workspaceId, companyId, projectId,
      mode: "isolated_workspace", strategyType: "git_worktree", name: row.workspaceId, status: "active", providerType: "plugin",
      createdAt: old, updatedAt: old })));
    const all = [...remote, ...plugin];
    for (let index = 0; index < all.length; index += 250) {
      const page = all.slice(index, index + 250);
      await db.insert(issues).values(page.map(row => ({ id: row.issueId, companyId, projectId, title: "done", status: "done",
        executionWorkspaceId: row.workspaceId, completedAt: old, updatedAt: old })));
    }
    await db.execute(sql`update execution_workspaces set source_issue_id = issues.id, updated_at = ${old.toISOString()}::timestamptz
      from issues where issues.execution_workspace_id = execution_workspaces.id and issues.company_id = ${companyId}::uuid`);
    return { companyId, remote, plugin };
  }

  function start(canRun: () => boolean = () => true) {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const service = executionWorkspaceService(db, { workspaceReaperCooldownDays: 1, terminalWorkspaceInspectionBackoffMs: TERMINAL_WORKSPACE_RETRY_MS });
    const sweeps: Array<{ targeted: boolean; checked: number; workspaceIds: number }> = [];
    let inFlight = 0;
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun, onError: () => {} });
    const worker = registerTerminalWorkspaceWork(coordinator, { ...service,
      sweepTerminalWorkspaces: async (limit, signal, options) => {
        inFlight += 1;
        const result = await service.sweepTerminalWorkspaces(limit, signal, options).finally(() => { inFlight -= 1; });
        sweeps.push({ targeted: Boolean(options?.targets), checked: result.checked,
          workspaceIds: (options?.targets?.workspaceIds.length ?? 0) + (options?.targets?.issueIds.length ?? 0) });
        return result;
      } }, canRun);
    const advance = async (ms: number) => {
      for (let elapsed = 0; elapsed < ms; elapsed += 10_000) {
        await vi.advanceTimersByTimeAsync(10_000);
        do { await realSleep(10); await vi.advanceTimersByTimeAsync(1); } while (inFlight > 0);
      }
    };
    const settle = async <T>(operation: Promise<T>) => {
      let done = false;
      const result = operation.finally(() => { done = true; });
      while (!done) { await realSleep(5); await vi.advanceTimersByTimeAsync(1); }
      return result;
    };
    const fullChecked = (from = 0) => sweeps.slice(from).filter(sweep => !sweep.targeted).reduce((sum, sweep) => sum + sweep.checked, 0);
    return { sweeps, advance, settle, fullChecked, stop: async () => { vi.useRealTimers(); await worker.stop(); await coordinator.stop(); } };
  }

  it("works through a burst of run-finish hints in targeted batches without a full pass", async () => {
    const f = await seed({ remote: 300 });
    const work = start();
    try {
      await work.advance(60_000);
      expect(work.fullChecked()).toBe(300);
      const mark = work.sweeps.length;
      const burst = f.remote.slice(0, 120);
      for (let index = 0; index < burst.length; index += 40) {
        await work.settle(db.transaction(async tx => {
          for (const row of burst.slice(index, index + 40)) await notifyTerminalWorkspaceWork(tx, `issue:${row.issueId}`);
        }));
      }
      await work.advance(5 * 60_000);
      const window = work.sweeps.slice(mark);
      expect(work.fullChecked(mark)).toBe(0);
      expect(window.every(sweep => sweep.targeted && sweep.workspaceIds <= 50)).toBe(true);
      expect(window.reduce((sum, sweep) => sum + sweep.checked, 0)).toBe(120);
    } finally { await work.stop(); }
  }, 300_000);

  it("arms the hourly backstop for a hint without a target instead of starting a pass", async () => {
    await seed({ remote: 120 });
    const work = start();
    try {
      await work.advance(60_000);
      const mark = work.sweeps.length;
      await work.settle(db.transaction(tx => notifyDeliveryWork(tx, DELIVERY_QUEUES.terminalWorkspaces)));
      await work.settle(db.transaction(tx => notifyDeliveryWork(tx, DELIVERY_QUEUES.terminalWorkspaces, "not-a-target")));
      await work.advance(30 * 60_000);
      expect(work.fullChecked(mark)).toBe(0);
      await work.advance(TERMINAL_WORKSPACE_BACKSTOP_MS);
      expect(work.fullChecked(mark)).toBe(120);
    } finally { await work.stop(); }
  }, 300_000);

  it("inspects plugin workspaces when a workspace provider becomes ready without a full pass", async () => {
    await seed({ remote: 120, plugin: 3 });
    const work = start();
    try {
      await work.advance(60_000);
      const mark = work.sweeps.length;
      await work.settle(db.transaction(tx => notifyTerminalWorkspaceWork(tx, TERMINAL_WORKSPACE_PLUGIN_HINT)));
      await work.advance(60_000);
      expect(work.fullChecked(mark)).toBe(0);
      expect(work.sweeps.slice(mark).reduce((sum, sweep) => sum + sweep.checked, 0)).toBe(3);
    } finally { await work.stop(); }
  }, 300_000);

  it("runs one full pass across a restart: none while the old instance drains and one at the new start", async () => {
    const f = await seed({ remote: 200, plugin: 2 });
    let draining = false;
    const old = start(() => !draining);
    try {
      await old.advance(60_000);
      const mark = old.sweeps.length;
      draining = true;
      for (let index = 0; index < 120; index += 40) {
        await old.settle(db.transaction(async tx => {
          for (const row of f.remote.slice(index, index + 40)) await notifyTerminalWorkspaceWork(tx, `issue:${row.issueId}`);
        }));
      }
      await old.settle(db.transaction(tx => notifyDeliveryWork(tx, DELIVERY_QUEUES.terminalWorkspaces)));
      await old.advance(5 * 60_000);
      expect(old.sweeps.slice(mark)).toEqual([]);
    } finally { await old.stop(); }
    const fresh = start();
    try {
      await fresh.advance(10_000);
      await fresh.settle(db.transaction(tx => notifyTerminalWorkspaceWork(tx, TERMINAL_WORKSPACE_PLUGIN_HINT)));
      for (let index = 0; index < 120; index += 40) {
        await fresh.settle(db.transaction(async tx => {
          for (const row of f.remote.slice(index, index + 40)) await notifyTerminalWorkspaceWork(tx, `issue:${row.issueId}`);
        }));
      }
      await fresh.advance(30 * 60_000);
      expect(fresh.fullChecked()).toBe(202);
    } finally { await fresh.stop(); }
  }, 300_000);
});
