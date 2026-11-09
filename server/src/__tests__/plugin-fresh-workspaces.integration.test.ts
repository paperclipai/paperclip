import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, executionWorkspaces, heartbeatRuns, issues, plugins } from "@paperclipai/db";
import { preparePluginWorkspace, removePluginWorkspace } from "../services/plugin-workspaces.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import { reserveFreshPluginTaskWorkspace } from "../services/provider-fresh-workspace.js";
import { createPluginWorkspaceFixture } from "./helpers/plugin-workspaces.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const cache = vi.hoisted(() => ({ release: vi.fn() }));
vi.mock("../services/provider-fresh-workspace.js", async importOriginal => ({
  ...await importOriginal<typeof import("../services/provider-fresh-workspace.js")>(),
  releaseProviderRecoveryTransfers: cache.release,
}));
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("provider-owned fresh retry reservations", () => {
  let db: ReturnType<typeof createDb>, stopDb: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("plugin-fresh-workspaces");
    db = createDb(started.connectionString); stopDb = started.stop;
  });
  afterAll(async () => { await db?.$client.end(); await stopDb?.(); });
  beforeEach(() => { cache.release.mockReset().mockResolvedValue(undefined); });
  async function fixture() {
    const f = await createPluginWorkspaceFixture(db);
    const previous = await preparePluginWorkspace(db, f.workers, f.input);
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, f.runId));
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.input.agentId,
      issueId: f.issueId, status: "running" }).returning();
    const fresh = { attemptId: randomUUID(), sourceRunId: f.runId, previousWorkspaceId: previous!.id, recoverySnapshots: [] };
    const input = { ...f.input, runId: run.id, existingWorkspaceId: previous!.id, fresh, expectedBindingRevision: 1 };
    return { ...f, previous: previous!, fresh, input };
  }
  const enable = async (id: string) => db.update(plugins).set({ manifestJson:
    sql`jsonb_set(${plugins.manifestJson}, '{workspaceProvider,freshWorkspaceVersion}', '1')` }).where(eq(plugins.id, id));
  it("fails closed for an older provider without replacing the old task binding", async () => {
    const f = await fixture();
    await expect(preparePluginWorkspace(db, f.workers, f.input)).rejects.toThrow("fresh attempt is unavailable");
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(task.executionWorkspaceId).toBe(f.previous.id);
    expect(f.calls).toHaveLength(1);
  });
  it("reserves a new binding once and reconciles the same operation after a lost provider reply", async () => {
    const f = await fixture(); await enable(f.pluginId);
    f.lose();
    await expect(preparePluginWorkspace(db, f.workers, f.input)).rejects.toThrow("incomplete");
    const ambiguous = f.calls.at(-1);
    const workspace = await preparePluginWorkspace(db, f.workers, f.input);
    expect(workspace!.id).not.toBe(f.previous.id);
    expect(f.calls.at(-1).executionWorkspaceId).toBe(ambiguous.executionWorkspaceId);
    expect(f.calls.at(-1).operationId).toBe(ambiguous.operationId);
    expect(f.calls.at(-1).operation).toMatchObject({ fresh: f.fresh, branchMode: "create", branchName: null, existing: null });
    const [retained] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.previous.id));
    expect(retained.providerRef).toBe(f.previous.providerRef);
    expect(retained.metadata).toEqual(f.previous.metadata);
    const rows = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.companyId, f.companyId));
    expect(rows).toHaveLength(2);
  });
  it("keeps fresh directory authority server-owned through metadata updates", async () => {
    const f = await fixture(); await enable(f.pluginId);
    const service = executionWorkspaceService(db);
    const original = await service.update(f.previous.id, { metadata: {
      note: "ordinary metadata", workspaceProviderFresh: f.fresh, runnerTaskFreshWorkspace: f.fresh,
      runnerTaskWorkspaceOwner: { pluginKey: "forged" },
    } });
    expect(original!.metadata).toMatchObject({ note: "ordinary metadata" });
    for (const key of ["workspaceProviderFresh", "runnerTaskFreshWorkspace", "runnerTaskWorkspaceOwner"]) {
      expect(original!.metadata?.[key]).toBeUndefined();
    }
    const prepared = await preparePluginWorkspace(db, f.workers, f.input);
    const updated = await service.update(prepared!.id, { metadata: { note: "caller edit", workspaceProviderFresh: null } });
    expect(updated!.metadata).toMatchObject({ note: "caller edit", workspaceProviderFresh: f.fresh });
    await db.update(issues).set({ projectId: null, projectWorkspaceId: null }).where(eq(issues.id, f.issueId));
    const owner = { agentId: f.input.agentId, environmentId: randomUUID(), pluginKey: "test.tasks", driverKey: "tasks" };
    const next = { ...f.fresh, attemptId: randomUUID(), previousWorkspaceId: prepared!.id };
    const id = await reserveFreshPluginTaskWorkspace({ db, companyId: f.companyId, issueId: f.issueId,
      runId: f.input.runId, agentId: f.input.agentId, responsibleUserId: null, fresh: next, owner,
      expectedBindingRevision: 2 });
    const directory = await service.update(id, { metadata: { runnerTaskFreshWorkspace: f.fresh,
      runnerTaskWorkspaceOwner: { pluginKey: "forged" } } });
    expect(directory!.metadata).toMatchObject({ runnerTaskFreshWorkspace: next, runnerTaskWorkspaceOwner: owner });
    const cleared = await service.update(id, { metadata: null });
    expect(cleared!.metadata).toMatchObject({ runnerTaskFreshWorkspace: next, runnerTaskWorkspaceOwner: owner });
  });
  it("retains the durable removal intent if transfer cache cleanup fails", async () => {
    const f = await fixture(); await enable(f.pluginId);
    const workspace = await preparePluginWorkspace(db, f.workers, f.input);
    const [closed] = await db.update(executionWorkspaces).set({ status: "archived" })
      .where(eq(executionWorkspaces.id, workspace!.id)).returning();
    cache.release.mockRejectedValueOnce(new Error("temporary cache cleanup failure"));
    await expect(removePluginWorkspace(db, f.workers, closed, "a".repeat(40))).rejects.toThrow("cache cleanup failure");
    const [pending] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspace!.id));
    expect(pending.metadata?.workspaceProviderRemoval).toBeTruthy();
    expect(pending.metadata?.workspaceProviderRemoved).not.toBe(true);
    await removePluginWorkspace(db, f.workers, pending, "a".repeat(40));
    const [settled] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspace!.id));
    expect(settled.metadata?.workspaceProviderRemoved).toBe(true);
    expect(cache.release).toHaveBeenCalledTimes(2);
  });
  it("rejects a changed task revision before calling the provider", async () => {
    const f = await fixture(); await enable(f.pluginId);
    await db.update(issues).set({ workspaceBindingRevision: 2 }).where(eq(issues.id, f.issueId));
    await expect(preparePluginWorkspace(db, f.workers, f.input)).rejects.toThrow("binding changed");
    expect(f.calls).toHaveLength(1);
  });
  it("keeps one projectless attempt directory identity across reconciliation and later reuse", async () => {
    const f = await fixture();
    await db.update(issues).set({ projectId: null, projectWorkspaceId: null }).where(eq(issues.id, f.issueId));
    const owner = { agentId: f.input.agentId, environmentId: randomUUID(), pluginKey: "test.tasks", driverKey: "tasks" };
    const input = { db, companyId: f.companyId, issueId: f.issueId, runId: f.input.runId,
      agentId: f.input.agentId, responsibleUserId: null, fresh: f.fresh, owner, expectedBindingRevision: 1 };
    const id = await reserveFreshPluginTaskWorkspace(input);
    expect(await reserveFreshPluginTaskWorkspace(input)).toBe(id);
    const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, id));
    expect(workspace.metadata).toMatchObject({ runnerTaskFreshWorkspace: f.fresh, runnerTaskWorkspaceOwner: owner });
    expect(workspace.cwd).toBe(`/workspaces/${f.fresh.attemptId}`);
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(task.executionWorkspaceId).toBe(id);
    expect(task.workspaceBindingRevision).toBe(2);
    await db.update(heartbeatRuns).set({ responsibleUserId: "changed-user" }).where(eq(heartbeatRuns.id, f.input.runId));
    await expect(reserveFreshPluginTaskWorkspace(input)).rejects.toThrow("responsible user changed");
  });
});
