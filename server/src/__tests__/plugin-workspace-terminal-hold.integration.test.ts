import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, executionWorkspaces, heartbeatRuns, issues } from "@paperclipai/db";
import { createPluginWorkspaceFixture } from "./helpers/plugin-workspaces.js";
import { preparePluginWorkspace, type WorkspaceWorkers } from "../services/plugin-workspaces.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

type Inspection = { headSha: string; hasDirtyTrackedFiles: boolean; hasUntrackedFiles: boolean; hasLocalOnlyData: boolean;
  isMergedIntoBase: boolean | null; remotelyRecoverable: boolean };
type Hold = { reason: string; checks: number; checkedAt: string; recheckAt: string | null; headSha: string | null };

(support.supported ? describe : describe.skip)("plugin workspace terminal inspection hold", () => {
  let db: ReturnType<typeof createDb>, stopDb: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("plugin-workspace-terminal-hold");
    db = createDb(started.connectionString, { maxConnections: 1 });
    stopDb = started.cleanup;
  });
  afterAll(async () => {
    await db?.$client.end();
    await stopDb?.();
  });

  async function setup(inspection: Partial<Inspection>) {
    const f = await createPluginWorkspaceFixture(db);
    const state = { inspection: { headSha: "a".repeat(40), hasDirtyTrackedFiles: false, hasUntrackedFiles: false, hasLocalOnlyData: false,
      isMergedIntoBase: true, remotelyRecoverable: true, ...inspection } as Inspection, failInspect: false };
    const workers = { ...f.workers, call: async (...args: Parameters<WorkspaceWorkers["call"]>) => {
      const params = args[2] as { operation: { kind: string } };
      if (params.operation.kind === "inspect" && state.failInspect) {
        f.calls.push(params);
        throw new Error("provider outage");
      }
      const result = await f.workers.call(...args);
      return params.operation.kind === "inspect" ? { ...(result as object), ...state.inspection } : result;
    } } as WorkspaceWorkers;
    const workspace = (await preparePluginWorkspace(db, workers, f.input))!;
    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, f.issueId));
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.runId));
    let clock = Date.now();
    const svc = executionWorkspaceService(db, { pluginWorkerManager: workers, workspaceReaperCooldownDays: 0, now: () => new Date(clock) });
    const read = async () => (await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspace.id)))[0]!;
    const hold = async () => (await read()).metadata?.terminalInspectionHold as Hold | undefined;
    const inspections = () => f.calls.filter(call => call.executionWorkspaceId === workspace.id && call.operation.kind === "inspect").length;
    const removals = () => f.calls.filter(call => call.executionWorkspaceId === workspace.id && call.operation.kind === "remove").length;
    const sweep = () => svc.sweepTerminalWorkspaces(100);
    const due = () => svc.takeDueTerminalWorkspaceTargets().workspaceIds.includes(workspace.id);
    return { f, state, svc, workspace, read, hold, inspections, removals, sweep, due,
      get clock() { return clock; }, set clock(value: number) { clock = value; } };
  }

  it("holds a workspace kept for local data until the workspace, its tasks, or a hint changes it", async () => {
    const s = await setup({ hasLocalOnlyData: true });
    await s.sweep();
    expect(s.inspections()).toBe(1);
    expect((await s.read()).status).toBe("active");
    expect(await s.hold()).toMatchObject({ reason: "local_data", checks: 1, recheckAt: null });
    expect(s.due()).toBe(false);

    s.clock += 30 * 24 * HOUR;
    expect((await s.sweep()).skippedBackoff).toBeGreaterThanOrEqual(1);
    expect(s.inspections()).toBe(1);
    expect(s.due()).toBe(false);

    s.svc.terminalWorkspaceWorkSettled(new Set([`workspace:${s.workspace.id}`]), { targeted: true });
    s.clock += 1;
    await s.sweep();
    expect(s.inspections()).toBe(2);
    await s.sweep();
    expect(s.inspections()).toBe(2);

    s.svc.terminalWorkspaceWorkSettled(new Set([`issue:${s.f.issueId}`]), { targeted: true });
    s.clock += 1;
    await s.sweep();
    expect(s.inspections()).toBe(3);

    await db.update(executionWorkspaces).set({ metadata: sql`jsonb_set(${executionWorkspaces.metadata}, '{lifecycleGeneration}',
      to_jsonb(coalesce((${executionWorkspaces.metadata}->>'lifecycleGeneration')::int, 0) + 1))` })
      .where(eq(executionWorkspaces.id, s.workspace.id));
    await s.sweep();
    expect(s.inspections()).toBe(4);

    await executionWorkspaceService(db).update(s.workspace.id, { metadata: { note: "operator edit" } });
    expect(await s.hold()).toMatchObject({ reason: "local_data" });
    await s.sweep();
    expect(s.inspections()).toBe(5);

    await db.update(issues).set({ completedAt: new Date(s.clock) }).where(eq(issues.id, s.f.issueId));
    await s.sweep();
    expect(s.inspections()).toBe(6);
    await s.sweep();
    expect(s.inspections()).toBe(6);

    s.svc.terminalWorkspaceWorkSettled(new Set(["plugin-workspaces"]), { targeted: true });
    s.clock += 1;
    await s.sweep();
    expect(s.inspections()).toBe(7);
    await s.sweep();
    expect(s.inspections()).toBe(7);
    expect(s.removals()).toBe(0);
  });

  it("re-checks a clean unmerged workspace on a doubling interval and resets it on a new head or a hint", async () => {
    const s = await setup({ isMergedIntoBase: false, remotelyRecoverable: false });
    const start = s.clock;
    await s.sweep();
    expect(await s.hold()).toMatchObject({ reason: "unmerged", checks: 1, recheckAt: new Date(start + HOUR).toISOString() });

    s.clock = start + 59 * MINUTE;
    await s.sweep();
    expect(s.inspections()).toBe(1);
    expect(s.due()).toBe(false);

    const delays: number[] = [];
    for (let check = 0; check < 7; check++) {
      const recheckAt = Date.parse((await s.hold())!.recheckAt!);
      delays.push((recheckAt - s.clock) / HOUR);
      s.clock = recheckAt;
      expect(s.due()).toBe(true);
      await s.sweep();
    }
    expect(s.inspections()).toBe(8);
    expect(delays.slice(1)).toEqual([2, 4, 8, 16, 24, 24]);
    expect(await s.hold()).toMatchObject({ checks: 8, recheckAt: new Date(s.clock + 24 * HOUR).toISOString() });

    s.state.inspection.headSha = "b".repeat(40);
    s.clock = Date.parse((await s.hold())!.recheckAt!);
    await s.sweep();
    expect(await s.hold()).toMatchObject({ checks: 1, headSha: "b".repeat(40), recheckAt: new Date(s.clock + HOUR).toISOString() });

    s.clock = Date.parse((await s.hold())!.recheckAt!);
    await s.sweep();
    expect(await s.hold()).toMatchObject({ checks: 2 });
    s.clock += 10 * MINUTE;
    s.svc.terminalWorkspaceWorkSettled(new Set([`workspace:${s.workspace.id}`]), { targeted: true });
    s.clock += 1;
    await s.sweep();
    expect(s.inspections()).toBe(11);
    expect(await s.hold()).toMatchObject({ checks: 1, recheckAt: new Date(s.clock + HOUR).toISOString() });
  });

  it("removes a workspace as soon as it is removable, including one that was held", async () => {
    const merged = await setup({});
    await merged.sweep();
    expect(merged.inspections()).toBe(2);
    expect(merged.removals()).toBe(1);
    expect(await merged.read()).toMatchObject({ status: "archived", metadata: { workspaceProviderRemoved: true } });

    const s = await setup({ hasDirtyTrackedFiles: true });
    await s.sweep();
    expect(await s.hold()).toMatchObject({ reason: "local_data" });
    s.state.inspection.hasDirtyTrackedFiles = false;
    s.svc.terminalWorkspaceWorkSettled(new Set([`workspace:${s.workspace.id}`]), { targeted: true });
    s.clock += 1;
    await s.sweep();
    expect(s.removals()).toBe(1);
    const removed = await s.read();
    expect(removed).toMatchObject({ status: "archived", metadata: { workspaceProviderRemoved: true } });
    expect(removed.metadata).not.toHaveProperty("terminalInspectionHold");
  });

  it("holds a closed workspace with local data and removes it after an unscoped change notice", async () => {
    const s = await setup({});
    await db.update(executionWorkspaces).set({ status: "archived", closedAt: new Date() }).where(eq(executionWorkspaces.id, s.workspace.id));
    s.state.inspection.hasUntrackedFiles = true;
    await s.sweep();
    expect(await s.hold()).toMatchObject({ reason: "local_data" });
    await s.sweep();
    expect(s.inspections()).toBe(1);
    s.state.inspection.hasUntrackedFiles = false;
    s.svc.terminalWorkspaceWorkSettled();
    s.clock += 1;
    await s.sweep();
    expect(s.removals()).toBe(1);
    expect(await s.read()).toMatchObject({ metadata: { workspaceProviderRemoved: true } });
  });

  it("keeps the inspection failure backoff and does not hold a workspace it could not inspect", async () => {
    const s = await setup({ hasLocalOnlyData: true });
    s.state.failInspect = true;
    await s.sweep();
    expect(await s.hold()).toBeUndefined();
    expect((await s.read()).metadata?.terminalCleanupRetry).toMatchObject({ failures: 1,
      retryAt: new Date(s.clock + 5 * MINUTE).toISOString() });
    s.clock += 5 * MINUTE;
    await s.sweep();
    expect((await s.read()).metadata?.terminalCleanupRetry).toMatchObject({ failures: 2,
      retryAt: new Date(s.clock + 10 * MINUTE).toISOString() });
    s.state.failInspect = false;
    s.clock += 10 * MINUTE;
    await s.sweep();
    expect(s.inspections()).toBe(3);
    expect((await s.read()).metadata).not.toHaveProperty("terminalCleanupRetry");
    expect(await s.hold()).toMatchObject({ reason: "local_data", checks: 1 });
  });
});
