import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, executionWorkspaces, heartbeatRuns, issues } from "@paperclipai/db";
import { JsonRpcCallError, PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import { createPluginWorkspaceFixture } from "./helpers/plugin-workspaces.js";
import { inspectPluginWorkspace, preparePluginWorkspace, removePluginWorkspace, type WorkspaceWorkers } from "../services/plugin-workspaces.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const MINUTE = 60_000;

function providerRefusal() {
  return new JsonRpcCallError({ code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR, message: "private provider text",
    data: { schema: "paperclip/workspace-operation-error/v1", reason: "unsupported_operation" } });
}

(support.supported ? describe : describe.skip)("plugin workspace terminal cleanup retry", () => {
  let db: ReturnType<typeof createDb>, stopDb: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("plugin-workspace-terminal-retry");
    db = createDb(started.connectionString, { maxConnections: 1 });
    stopDb = started.cleanup;
  });
  afterAll(async () => {
    await db?.$client.end();
    await stopDb?.();
  });

  async function setup() {
    const f = await createPluginWorkspaceFixture(db);
    const failures = { inspect: false, remove: false, unboundRemove: false, reopenFirst: false };
    const workers = { ...f.workers, call: async (...args: Parameters<WorkspaceWorkers["call"]>) => {
      const params = args[2] as { agentId: string | null; operation: { kind: string; binding?: unknown } };
      if (params.operation.kind === "prepare" && params.agentId === null) {
        f.calls.push(params);
        throw providerRefusal();
      }
      if (params.operation.kind === "remove" && params.operation.binding === null) {
        f.calls.push(params);
        if (failures.unboundRemove) throw providerRefusal();
        if (failures.remove) throw new Error("lost removal");
        return { kind: "removed" };
      }
      if ((params.operation.kind === "inspect" && failures.inspect) || (params.operation.kind === "remove" && failures.remove)) {
        f.calls.push(params);
        if (failures.reopenFirst) await db.update(executionWorkspaces).set({ metadata: sql`jsonb_set(${executionWorkspaces.metadata},
          '{lifecycleGeneration}', to_jsonb(coalesce((${executionWorkspaces.metadata}->>'lifecycleGeneration')::int, 0) + 1))` })
          .where(eq(executionWorkspaces.id, (params as unknown as { executionWorkspaceId: string }).executionWorkspaceId));
        throw new Error("provider outage");
      }
      return f.workers.call(...args);
    } } as WorkspaceWorkers;
    const read = async (id: string) => (await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, id)))[0]!;
    const finishTask = async () => {
      await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, f.issueId));
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.runId));
    };
    const abandonReservation = async () => {
      f.lose();
      await expect(preparePluginWorkspace(db, workers, f.input)).rejects.toThrow("incomplete");
      const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      const reservation = await read(task.executionWorkspaceId!);
      expect(reservation.providerRef).toBeNull();
      await db.update(issues).set({ executionWorkspaceId: null }).where(eq(issues.id, f.issueId));
      const replacement = await preparePluginWorkspace(db, workers, f.input);
      expect(replacement!.id).not.toBe(reservation.id);
      return reservation;
    };
    const callsFor = (id: string, kind: string) => f.calls.filter(call => call.executionWorkspaceId === id && call.operation.kind === kind);
    return { f, workers, failures, read, finishTask, abandonReservation, callsFor };
  }

  it("retires an unbound reservation of a finished task through an agent-free remove and archives it", async () => {
    const s = await setup();
    const reservation = await s.abandonReservation();
    await s.finishTask();
    s.f.dirty();
    await executionWorkspaceService(db, { pluginWorkerManager: s.workers, workspaceReaperCooldownDays: 0 }).sweepTerminalWorkspaces(100);
    expect(s.callsFor(reservation.id, "prepare")).toHaveLength(1);
    expect(s.callsFor(reservation.id, "remove")).toEqual([expect.objectContaining({ agentId: null, runId: null,
      operation: { kind: "remove", binding: null, expectedHeadSha: null } })]);
    const retired = await s.read(reservation.id);
    expect(retired).toMatchObject({ status: "archived", cleanupReason: "issue_terminal",
      metadata: { workspaceProviderRemoved: true, workspaceProviderRemoval: null } });
    expect(retired.closedAt).not.toBeNull();
    expect(retired.metadata?.lifecycleGeneration).toBe(((reservation.metadata?.lifecycleGeneration as number) ?? 0) + 1);
  });

  it("replays a failed reservation removal with the same identity and backs it off", async () => {
    const s = await setup();
    const reservation = await s.abandonReservation();
    await s.finishTask();
    s.f.dirty();
    s.failures.remove = true;
    let clock = Date.now();
    const svc = executionWorkspaceService(db, { pluginWorkerManager: s.workers, workspaceReaperCooldownDays: 0, now: () => new Date(clock) });
    await svc.sweepTerminalWorkspaces(100);
    const pending = await s.read(reservation.id);
    expect(pending).toMatchObject({ status: "archived",
      metadata: { workspaceProviderRemoval: { operation: { kind: "remove", binding: null } } } });
    expect(pending.metadata?.terminalCleanupRetry).toMatchObject({ failures: 1, generation: pending.metadata?.lifecycleGeneration,
      retryAt: new Date(clock + 5 * MINUTE).toISOString(), failure: { kind: "transport" } });
    const retryAt = Date.parse((pending.metadata?.terminalCleanupRetry as { retryAt: string }).retryAt);
    clock = Date.now() + 1;
    await svc.sweepTerminalWorkspaces(100);
    expect(s.callsFor(reservation.id, "remove")).toHaveLength(1);
    s.failures.remove = false;
    clock = retryAt;
    await svc.sweepTerminalWorkspaces(100);
    const removes = s.callsFor(reservation.id, "remove");
    expect(removes).toHaveLength(2);
    expect(new Set(removes.map(call => call.operationId)).size).toBe(1);
    expect(s.callsFor(reservation.id, "prepare")).toHaveLength(1);
    const retired = await s.read(reservation.id);
    expect(retired).toMatchObject({ status: "archived", metadata: { workspaceProviderRemoved: true } });
    expect(retired.metadata).not.toHaveProperty("terminalCleanupRetry");
  });

  it("keeps the reservation a task still points at and records why its reconciliation failed", async () => {
    const s = await setup();
    s.f.lose();
    await expect(preparePluginWorkspace(db, s.workers, s.f.input)).rejects.toThrow("incomplete");
    const [task] = await db.select().from(issues).where(eq(issues.id, s.f.issueId));
    await s.finishTask();
    const clock = Date.now();
    await executionWorkspaceService(db, { pluginWorkerManager: s.workers, workspaceReaperCooldownDays: 0, now: () => new Date(clock) })
      .sweepTerminalWorkspaces(100);
    expect(s.callsFor(task.executionWorkspaceId!, "remove")).toHaveLength(0);
    expect(s.callsFor(task.executionWorkspaceId!, "prepare")).toHaveLength(2);
    const kept = await s.read(task.executionWorkspaceId!);
    expect(kept.status).not.toBe("archived");
    expect(kept.providerRef).toBeNull();
    expect(kept.metadata?.terminalCleanupRetry).toMatchObject({ failures: 1, retryAt: new Date(clock + 5 * MINUTE).toISOString(),
      failure: { kind: "provider", reason: "unsupported_operation", message: expect.not.stringContaining("private") } });
  });

  it("does not retire a reservation whose task is still open", async () => {
    const s = await setup();
    const reservation = await s.abandonReservation();
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, s.f.runId));
    await expect(inspectPluginWorkspace(db, s.workers, reservation)).rejects.toThrow();
    expect(s.callsFor(reservation.id, "remove")).toHaveLength(0);
    expect(s.callsFor(reservation.id, "prepare")).toHaveLength(2);
    const kept = await s.read(reservation.id);
    expect(kept.status).toBe(reservation.status);
    expect(kept.metadata?.workspaceProviderRemoval).toBeUndefined();
  });

  it("backs off and keeps the reason when the provider rejects an unbound removal", async () => {
    const s = await setup();
    const reservation = await s.abandonReservation();
    await s.finishTask();
    s.f.dirty();
    s.failures.unboundRemove = true;
    let clock = Date.now();
    const svc = executionWorkspaceService(db, { pluginWorkerManager: s.workers, workspaceReaperCooldownDays: 0, now: () => new Date(clock) });
    await svc.sweepTerminalWorkspaces(100);
    const refused = await s.read(reservation.id);
    expect(refused).toMatchObject({ status: "archived", metadata: { workspaceProviderRemoval: { operation: { binding: null } } } });
    expect(refused.metadata?.workspaceProviderRemoved).not.toBe(true);
    expect(refused.metadata?.terminalCleanupRetry).toMatchObject({ failures: 1, retryAt: new Date(clock + 5 * MINUTE).toISOString(),
      generation: refused.metadata?.lifecycleGeneration,
      failure: { kind: "provider", reason: "unsupported_operation", message: expect.not.stringContaining("private") } });
    clock = Date.now() + 1;
    await svc.sweepTerminalWorkspaces(100);
    expect(s.callsFor(reservation.id, "remove")).toHaveLength(1);
    expect(s.callsFor(reservation.id, "prepare")).toHaveLength(1);
  });

  it("backs off repeated inspection failures, records the reason, and resets after a success", async () => {
    const s = await setup();
    const workspace = (await preparePluginWorkspace(db, s.workers, s.f.input))!;
    await s.finishTask();
    s.f.dirty();
    s.failures.inspect = true;
    let clock = Date.now();
    const svc = executionWorkspaceService(db, { pluginWorkerManager: s.workers, workspaceReaperCooldownDays: 0, now: () => new Date(clock) });
    const retryAfter = async () => {
      const retry = (await s.read(workspace.id)).metadata?.terminalCleanupRetry as { failures: number; retryAt: string } | undefined;
      return retry && { failures: retry.failures, delay: Date.parse(retry.retryAt) - clock };
    };
    await svc.sweepTerminalWorkspaces(100);
    expect(await retryAfter()).toEqual({ failures: 1, delay: 5 * MINUTE });
    expect((await s.read(workspace.id)).metadata?.terminalCleanupRetry).toMatchObject({
      failure: { kind: "transport", reason: null, message: "Workspace storage operation is incomplete; retry the same workspace" } });
    expect((await svc.sweepTerminalWorkspaces(100)).skippedBackoff).toBeGreaterThanOrEqual(1);
    expect(s.callsFor(workspace.id, "inspect")).toHaveLength(1);
    clock += 5 * MINUTE;
    await svc.sweepTerminalWorkspaces(100);
    expect(await retryAfter()).toEqual({ failures: 2, delay: 10 * MINUTE });
    clock += 10 * MINUTE;
    await svc.sweepTerminalWorkspaces(100);
    expect(await retryAfter()).toEqual({ failures: 3, delay: 20 * MINUTE });
    svc.terminalWorkspaceWorkSettled();
    await svc.sweepTerminalWorkspaces(100);
    expect(s.callsFor(workspace.id, "inspect")).toHaveLength(3);
    const edited = await executionWorkspaceService(db).update(workspace.id, { metadata: { note: "operator edit" } });
    expect(edited!.metadata).toMatchObject({ note: "operator edit", terminalCleanupRetry: { failures: 3 } });
    clock += 20 * MINUTE;
    s.failures.inspect = false;
    await svc.sweepTerminalWorkspaces(100);
    expect(s.callsFor(workspace.id, "inspect")).toHaveLength(4);
    expect(await retryAfter()).toBeUndefined();
    s.failures.inspect = true;
    clock += MINUTE;
    await svc.sweepTerminalWorkspaces(100);
    expect(await retryAfter()).toEqual({ failures: 1, delay: 5 * MINUTE });
  });

  it("drops a cleanup failure when the workspace moves to a new lifecycle before it is recorded", async () => {
    const s = await setup();
    const workspace = (await preparePluginWorkspace(db, s.workers, s.f.input))!;
    await s.finishTask();
    s.f.dirty();
    s.failures.inspect = true;
    s.failures.reopenFirst = true;
    await executionWorkspaceService(db, { pluginWorkerManager: s.workers, workspaceReaperCooldownDays: 0 }).sweepTerminalWorkspaces(100);
    expect(s.callsFor(workspace.id, "inspect")).toHaveLength(1);
    const moved = await s.read(workspace.id);
    expect(moved.metadata?.lifecycleGeneration).toBe(((workspace.metadata?.lifecycleGeneration as number) ?? 0) + 1);
    expect(moved.metadata).not.toHaveProperty("terminalCleanupRetry");
  });

  it("backs off a pending storage removal that keeps failing", async () => {
    const s = await setup();
    const workspace = (await preparePluginWorkspace(db, s.workers, s.f.input))!;
    await s.finishTask();
    s.failures.remove = true;
    await expect(removePluginWorkspace(db, s.workers, workspace, "a".repeat(40))).rejects.toThrow();
    await db.update(executionWorkspaces).set({ status: "cleanup_failed", closedAt: new Date() }).where(eq(executionWorkspaces.id, workspace.id));
    let clock = Date.now();
    const svc = executionWorkspaceService(db, { pluginWorkerManager: s.workers, workspaceReaperCooldownDays: 0, now: () => new Date(clock) });
    const delays: number[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      await svc.sweepTerminalWorkspaces(100);
      const retry = (await s.read(workspace.id)).metadata?.terminalCleanupRetry as { failures: number; retryAt: string };
      expect(retry.failures).toBe(attempt + 1);
      delays.push(Date.parse(retry.retryAt) - clock);
      clock = Date.parse(retry.retryAt);
    }
    expect(delays).toEqual([5 * MINUTE, 10 * MINUTE, 20 * MINUTE]);
    expect(s.callsFor(workspace.id, "remove")).toHaveLength(4);
    s.failures.remove = false;
    await svc.sweepTerminalWorkspaces(100);
    const removed = await s.read(workspace.id);
    expect(removed).toMatchObject({ status: "archived", metadata: { workspaceProviderRemoved: true } });
    expect(removed.metadata).not.toHaveProperty("terminalCleanupRetry");
  });
});
