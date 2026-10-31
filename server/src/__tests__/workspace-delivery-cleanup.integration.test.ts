import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, executionWorkspaces, heartbeatRuns, issues, plugins, projectWorkspaces, workspaceOperations } from "@paperclipai/db";
import { createPluginWorkspaceFixture } from "./helpers/plugin-workspaces.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { preparePluginWorkspace } from "../services/plugin-workspaces.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import type { GitHubWorkspaceDeliveryInput, GitHubWorkspaceDeliveryResult } from "../services/github-workspace-delivery.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("remote delivery cleanup", () => {
  let db: ReturnType<typeof createDb>;
  let stopDb: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    const database = await startEmbeddedPostgresTestDatabase("workspace-delivery-cleanup");
    db = createDb(database.connectionString, { maxConnections: 1 });
    stopDb = database.stop;
  });
  afterAll(async () => { await db?.$client.end(); await stopDb?.(); });
  afterEach(async () => { await db.update(issues).set({ status: "in_progress" }); });
  async function fixture() {
    const f = await createPluginWorkspaceFixture(db);
    await db.update(projectWorkspaces).set({ repoRef: "main" }).where(eq(projectWorkspaces.id, f.input.projectWorkspaceId));
    const [plugin] = await db.select().from(plugins).where(eq(plugins.id, f.pluginId));
    await db.update(plugins).set({ manifestJson: { ...plugin.manifestJson,
      workspaceProvider: { ...plugin.manifestJson.workspaceProvider!, supportsMergeAncestry: false, recoveryPullRequestVersion: 1 } } }).where(eq(plugins.id, f.pluginId));
    const workspace = (await preparePluginWorkspace(db, f.workers, f.input))!;
    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, f.issueId));
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.runId));
    const [receipt] = await db.insert(workspaceOperations).values({ companyId: f.companyId, executionWorkspaceId: workspace.id,
      heartbeatRunId: f.runId, issueId: f.issueId, phase: "workspace_finalize", status: "succeeded", finishedAt: new Date(),
      metadata: { pluginWorkspace: { providerType: "plugin", inspection: { kind: "finalized", headSha: "a".repeat(40), branchName: workspace.branchName } } } }).returning();
    let clock = new Date();
    let proof: GitHubWorkspaceDeliveryResult = { status: "not_delivered" };
    const resolve = vi.fn(async (_input: GitHubWorkspaceDeliveryInput) => proof);
    const original = f.workers.call.bind(f.workers);
    f.workers.call = async (...args) => {
      const result = await original(...args);
      return (args[2] as any).operation.kind === "inspect" ? { ...result as object, isMergedIntoBase: null } : result;
    };
    const service = executionWorkspaceService(db, { pluginWorkerManager: f.workers, workspaceReaperCooldownDays: 0,
      terminalWorkspaceInspectionBackoffMs: 300_000, now: () => clock, resolveWorkspaceDelivery: resolve });
    const delivered = (kind: "ancestry" | "merged_pr" = "ancestry"): GitHubWorkspaceDeliveryResult => ({ status: "delivered",
      headSha: "a".repeat(40), destinationRef: "refs/heads/main", destinationTipSha: "c".repeat(40),
      evidence: kind === "ancestry" ? { kind } : { kind, number: 42, mergeCommitSha: "b".repeat(40) } });
    return { ...f, workspace, receipt, resolve, service, delivered,
      setProof: (next: GitHubWorkspaceDeliveryResult) => { proof = next; },
      advance: () => { clock = new Date(clock.getTime() + 300_001); },
      inspections: () => f.calls.filter(call => call.operation.kind === "inspect"),
      removals: () => f.calls.filter(call => call.operation.kind === "remove") };
  }
  it("retries a known commit remotely and inspects only after delivery without a work product", async () => {
    const f = await fixture();
    await f.service.sweepTerminalWorkspaces();
    expect(f.resolve).toHaveBeenCalledWith(expect.objectContaining({ headSha: "a".repeat(40), destinationRef: "main", pullRequests: [] }));
    expect(f.inspections()).toHaveLength(0);
    expect(await f.service.nextTerminalWorkspaceSweepAt()).not.toBeNull();
    f.service.terminalWorkspaceWorkSettled(new Set([`issue:${randomUUID()}`]));
    await f.service.sweepTerminalWorkspaces();
    expect(f.resolve).toHaveBeenCalledTimes(1);
    f.setProof(f.delivered()); f.advance();
    await f.service.sweepTerminalWorkspaces();
    expect(f.removals()).toHaveLength(1);
  });
  it("parks unsupported destinations across unrelated wakes", async () => {
    const f = await fixture(); f.setProof({ status: "unknown", reason: "unsupported_destination_ref" });
    await f.service.sweepTerminalWorkspaces();
    expect(await f.service.nextTerminalWorkspaceSweepAt()).toBeNull();
    f.service.terminalWorkspaceWorkSettled(new Set([`issue:${randomUUID()}`]));
    await f.service.sweepTerminalWorkspaces();
    expect(await f.service.nextTerminalWorkspaceSweepAt()).toBeNull();
    expect(f.resolve).toHaveBeenCalledTimes(1);
    expect(f.inspections()).toHaveLength(0);
  });
  it("passes exact discovered PR recovery evidence through inspection and removal", async () => {
    const f = await fixture(); f.setProof(f.delivered("merged_pr"));
    await f.service.sweepTerminalWorkspaces();
    expect(f.removals()).toHaveLength(1);
    const expected = { number: 42, headSha: "a".repeat(40) };
    expect(f.inspections().every(call => JSON.stringify(call.operation.recoveryPullRequest) === JSON.stringify(expected))).toBe(true);
    expect(f.removals()[0].operation.recoveryPullRequest).toEqual(expected);
  });
  it.each(["running", "failed", "wrong_branch", "missing_head"])("retains storage when the latest receipt is %s", async (fault) => {
    const f = await fixture(); f.setProof(f.delivered());
    await db.insert(workspaceOperations).values({ companyId: f.companyId, executionWorkspaceId: f.workspace.id,
      phase: "workspace_finalize", status: fault === "running" || fault === "failed" ? fault : "succeeded",
      createdAt: new Date(f.receipt.createdAt.getTime() + 1000), finishedAt: fault === "running" ? null : new Date(),
      metadata: { pluginWorkspace: { inspection: { headSha: fault === "missing_head" ? null : "a".repeat(40), branchName: "different" } } } });
    await f.service.sweepTerminalWorkspaces();
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.inspections()).toHaveLength(0);
    expect(await f.service.nextTerminalWorkspaceSweepAt()).toBeNull();
  });
  it("retains storage when conflicting receipts have indistinguishable ordering", async () => {
    const f = await fixture(); f.setProof(f.delivered());
    await db.insert(workspaceOperations).values({ companyId: f.companyId, executionWorkspaceId: f.workspace.id,
      phase: "workspace_finalize", status: "failed", createdAt: f.receipt.createdAt, finishedAt: new Date() });
    await f.service.sweepTerminalWorkspaces();
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.inspections()).toHaveLength(0);
  });
  it.each([null, "HEAD"])("parks ambiguous explicit destination %s despite a source fallback", async destination => {
    const f = await fixture(); f.setProof(f.delivered());
    await db.update(executionWorkspaces).set({ metadata: { ...f.workspace.metadata,
      workspaceProviderDestinationRef: destination } }).where(eq(executionWorkspaces.id, f.workspace.id));
    await f.service.sweepTerminalWorkspaces();
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.inspections()).toHaveLength(0);
    expect(await f.service.nextTerminalWorkspaceSweepAt()).toBeNull();
  });
  it.each(["head", "branch", "dirty", "new_receipt"])("rejects %s changes during storage inspection", async fault => {
    const f = await fixture(); f.setProof(f.delivered());
    const original = f.workers.call.bind(f.workers);
    f.workers.call = async (...args) => {
      const result = await original(...args);
      if ((args[2] as any).operation.kind !== "inspect") return result;
      if (fault === "new_receipt") await db.insert(workspaceOperations).values({ companyId: f.companyId,
        executionWorkspaceId: f.workspace.id, phase: "workspace_finalize", status: "failed",
        createdAt: new Date(f.receipt.createdAt.getTime() + 1000), finishedAt: new Date() });
      return { ...result as object, ...(fault === "head" ? { headSha: "b".repeat(40) }
        : fault === "branch" ? { branchName: "changed" } : fault === "dirty" ? { hasDirtyTrackedFiles: true } : {}) };
    };
    await f.service.sweepTerminalWorkspaces();
    expect(f.removals()).toHaveLength(0);
    const [row] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspace.id));
    expect(row.closedAt).toBeNull();
  });
  it("retains storage when destination proof disappears after the final inspection", async () => {
    const f = await fixture();
    f.resolve.mockResolvedValueOnce(f.delivered("merged_pr")).mockResolvedValue({ status: "not_delivered" });
    await f.service.sweepTerminalWorkspaces();
    expect(f.inspections()).toHaveLength(2);
    expect(f.removals()).toHaveLength(0);
    expect(f.resolve).toHaveBeenCalledTimes(2);
    const [row] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspace.id));
    expect(row.status).toBe("cleanup_failed");
    expect(row.metadata?.workspaceProviderRemoval).toBeUndefined();
  });
  it("fences destination edits made during inspection before archiving", async () => {
    const f = await fixture(); f.setProof(f.delivered());
    const original = f.workers.call.bind(f.workers);
    f.workers.call = async (...args) => {
      const result = await original(...args);
      if ((args[2] as any).operation.kind === "inspect") await db.update(executionWorkspaces).set({
        metadata: { ...f.workspace.metadata, workspaceProviderDestinationRef: "refs/heads/other" },
      }).where(eq(executionWorkspaces.id, f.workspace.id));
      return result;
    };
    await f.service.sweepTerminalWorkspaces();
    expect(f.removals()).toHaveLength(0);
    const [row] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspace.id));
    expect(row.closedAt).toBeNull();
    expect(row.metadata?.workspaceProviderDestinationRef).toBe("refs/heads/other");
  });
  it("re-resolves delivery and recovery evidence for an archived cleanup retry", async () => {
    const f = await fixture(); f.setProof(f.delivered("merged_pr"));
    await db.update(executionWorkspaces).set({ status: "cleanup_failed", closedAt: new Date() }).where(eq(executionWorkspaces.id, f.workspace.id));
    await f.service.sweepTerminalWorkspaces();
    expect(f.resolve).toHaveBeenCalled();
    expect(f.removals()).toHaveLength(1);
  });
});
