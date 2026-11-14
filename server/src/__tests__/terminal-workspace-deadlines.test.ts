import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, executionWorkspaces, heartbeatRuns, issues, projects, type Db } from "@paperclipai/db";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import { createHeartbeatLifecycle, type HeartbeatLifecycleDependencies } from "../services/heartbeat/run-lifecycle.js";
import { registerTerminalWorkspaceWork, TERMINAL_WORKSPACE_RETRY_MS } from "../services/terminal-workspace-work.js";
import { meterDatabaseStatements } from "./helpers/database-statement-meter.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_TERMINAL_WORKSPACE_DEADLINE_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
const HOUR = 3_600_000;
const realSetTimeout = globalThis.setTimeout;
const realSleep = (ms: number) => new Promise(resolve => realSetTimeout(resolve, ms));

(support.supported ? describe : describe.skip)("terminal workspace deadlines", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  let meter: ReturnType<typeof meterDatabaseStatements>;
  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("terminal-workspace-deadlines-");
    const url = external ?? temporary!.connectionString;
    db = createDb(url);
    db.$client.options.onnotice = () => {};
    meter = meterDatabaseStatements(db, url);
  }, 120_000);
  afterEach(async () => { vi.useRealTimers(); await db.execute(sql`truncate companies cascade`); });
  afterAll(async () => { meter?.uninstall(); await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });

  async function seed(input: { open: number; cooldownEndsInMs?: number; heldByRunningRun?: boolean }) {
    const companyId = randomUUID(), projectId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Deadlines", issuePrefix: `D${companyId.slice(0, 6)}` });
    await db.insert(projects).values({ id: projectId, companyId, name: "Project", status: "in_progress" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", role: "engineer", status: "idle", adapterType: "process" });
    const old = new Date(Date.now() - 48 * HOUR);
    const workspace = async (status: string, completedAt: Date | null, runId: string | null) => {
      const id = randomUUID(), issueId = randomUUID();
      await db.insert(executionWorkspaces).values({ id, companyId, projectId, mode: "shared_workspace", strategyType: "project_primary",
        name: id, status: "active", providerType: "local_fs", cwd: `/missing/${id}`, createdAt: old, updatedAt: old });
      await db.insert(issues).values({ id: issueId, companyId, projectId, title: status, status, executionWorkspaceId: id,
        executionRunId: runId, completedAt, updatedAt: old });
      await db.update(executionWorkspaces).set({ sourceIssueId: issueId, updatedAt: old }).where(eq(executionWorkspaces.id, id));
      return { id, issueId };
    };
    for (let index = 0; index < input.open; index++) await workspace("in_progress", null, null);
    let runId: string | null = null;
    if (input.heldByRunningRun) {
      runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running" });
    }
    const target = await workspace("done", new Date(Date.now() - 24 * HOUR + (input.cooldownEndsInMs ?? -HOUR)), runId);
    if (runId) await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: target.issueId } }).where(eq(heartbeatRuns.id, runId));
    return { companyId, runId, target };
  }

  function start() {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const service = executionWorkspaceService(db, { workspaceReaperCooldownDays: 1, workspaceCompactionDelayMs: HOUR,
      terminalWorkspaceInspectionBackoffMs: TERMINAL_WORKSPACE_RETRY_MS });
    const sweeps: Array<{ targets: string[] | null; checked: number; skippedCooldown: number; skippedActiveRun: number }> = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: () => {} });
    const worker = registerTerminalWorkspaceWork(coordinator, { ...service,
      sweepTerminalWorkspaces: async (limit, signal, options) => {
        const result = await service.sweepTerminalWorkspaces(limit, signal, options);
        sweeps.push({ targets: options?.targets ? [...options.targets.workspaceIds, ...options.targets.issueIds] : null,
          checked: result.checked, skippedCooldown: (result as { skippedCooldown: number }).skippedCooldown,
          skippedActiveRun: (result as { skippedActiveRun: number }).skippedActiveRun });
        return result;
      } }, () => true);
    const advance = async (ms: number) => {
      for (let elapsed = 0; elapsed < ms; elapsed += 10_000) { await vi.advanceTimersByTimeAsync(10_000); await realSleep(20); }
    };
    return { sweeps, coordinator, worker, advance, stop: async () => { vi.useRealTimers(); await worker.stop(); await coordinator.stop(); } };
  }

  it("inspects only the workspace whose cooldown ends, however many trees stay open", async () => {
    const f = await seed({ open: 60, cooldownEndsInMs: HOUR });
    const work = start();
    try {
      await work.advance(5 * 60_000);
      const startup = work.sweeps.length;
      expect(startup).toBeGreaterThan(0);
      expect(work.sweeps.at(-1)).toMatchObject({ targets: null });
      const before = meter.read().statements;
      await work.advance(2 * HOUR);
      const window = work.sweeps.slice(startup);
      expect(window.filter(sweep => sweep.targets === null)).toEqual([]);
      expect(window.some(sweep => sweep.targets?.includes(f.target.id) && sweep.checked === 1 && sweep.skippedCooldown === 0)).toBe(true);
      expect(window.reduce((sum, sweep) => sum + sweep.checked, 0)).toBeLessThanOrEqual(window.length);
      expect(meter.read().statements - before).toBeLessThan(200);
    } finally { await work.stop(); }
  }, 300_000);

  it("waits for the release of the run that holds a workspace instead of rechecking it", async () => {
    const f = await seed({ open: 10, heldByRunningRun: true });
    const work = start();
    try {
      await work.advance(5 * 60_000);
      expect(work.sweeps.at(-1)).toMatchObject({ targets: null, skippedActiveRun: 1 });
      const startup = work.sweeps.length;
      const before = meter.read().statements;
      await work.advance(2 * HOUR);
      expect(work.sweeps.slice(startup)).toEqual([]);
      expect(meter.read().statements - before).toBe(0);
      vi.useRealTimers();
      await createHeartbeatLifecycle(db, { emitTerminalAgentTaskRun: vi.fn() } as unknown as HeartbeatLifecycleDependencies)
        .setRunStatus(f.runId!, "succeeded", { finishedAt: new Date() });
      await vi.waitFor(() => expect(work.sweeps.slice(startup).some(sweep => sweep.targets?.includes(f.target.issueId)
        && sweep.checked === 1 && sweep.skippedActiveRun === 0)).toBe(true), { timeout: 20_000 });
    } finally { await work.stop(); }
  }, 300_000);
});
