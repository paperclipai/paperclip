import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { issueRelations, issues, workspaceOperations } from "@paperclipai/db";
import { issueService } from "./issues.js";
import { recoverRetainedWorkspace } from "./workspace-recovery.js";
import { readWorkspaceRecovery } from "./workspace-recovery-receipt.js";
import { useWorkspaceRecoveryFixture, acceptedRemoteExport, action, db } from "./__tests__/workspace-recovery-fixture.js";

const targets = vi.hoisted(() => new Map<string, AdapterSandboxExecutionTarget>());
vi.mock("./environment-execution-target.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./environment-execution-target.js")>();
  return { ...actual, resolveEnvironmentExecutionTarget: async (input: Parameters<typeof actual.resolveEnvironmentExecutionTarget>[0]) =>
    (input.leaseId ? targets.get(input.leaseId) : undefined) ?? actual.resolveEnvironmentExecutionTarget(input) };
});

/**
 * A done child whose retained work was saved by "Recover saved files" must stop
 * holding its parent's dependency wait. A legacy child can still share the
 * parent's execution workspace.
 */
describe("dependency readiness after a done child's work is recovered", () => {
  useWorkspaceRecoveryFixture(targets);

  async function recoveredDoneChildWithParent() {
    const f = await acceptedRemoteExport();
    await recoverRetainedWorkspace(f.input);
    expect(readWorkspaceRecovery((await action(f.actionId)).evidence)?.status).toBe("recovered");
    const [child] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
    // Legacy shape: the parent and the child share one execution workspace.
    const [parent] = await db.insert(issues).values({ companyId: f.companyId, title: "Parent",
      status: "blocked", priority: "medium", assigneeAgentId: child.assigneeAgentId,
      executionWorkspaceId: f.workspaceId }).returning();
    await db.insert(issueRelations).values({ companyId: f.companyId, issueId: f.issueId,
      relatedIssueId: parent.id, type: "blocks" });
    return { ...f, parentId: parent.id };
  }

  const recoveryFinalizes = (f: { companyId: string; runId: string }) => db.select().from(workspaceOperations).where(and(
    eq(workspaceOperations.companyId, f.companyId), eq(workspaceOperations.heartbeatRunId, f.runId),
    eq(workspaceOperations.phase, "workspace_finalize"), eq(workspaceOperations.status, "succeeded")));

  it("records the recovery finalize on the saved workspace and releases the parent", async () => {
    const f = await recoveredDoneChildWithParent();
    expect((await recoveryFinalizes(f)).map(row => row.executionWorkspaceId)).toEqual([f.workspaceId]);
    await expect(issueService(db).getDependencyReadiness(f.parentId)).resolves.toMatchObject({
      isDependencyReady: true, pendingFinalizeBlockerIssueIds: [], unresolvedBlockerIssueIds: [] });
  }, 30_000);

  it("settles a recovery finalize saved by the previous release without its workspace", async () => {
    const f = await recoveredDoneChildWithParent();
    // The previous release wrote the recovery's finalize with no workspace.
    await db.update(workspaceOperations).set({ executionWorkspaceId: null }).where(and(
      eq(workspaceOperations.companyId, f.companyId), eq(workspaceOperations.heartbeatRunId, f.runId),
      eq(workspaceOperations.phase, "workspace_finalize")));
    await expect(issueService(db).getDependencyReadiness(f.parentId)).resolves.toMatchObject({
      isDependencyReady: true, pendingFinalizeBlockerIssueIds: [], unresolvedBlockerIssueIds: [] });
    const listed = (await issueService(db).list(f.companyId, { status: "blocked" }) as Array<{ id: string;
      blockerAttention?: { pendingFinalizeBlockerIssueIds?: string[] } | null }>).find(issue => issue.id === f.parentId);
    expect(listed?.blockerAttention?.pendingFinalizeBlockerIssueIds ?? []).toEqual([]);
  }, 30_000);

  it("keeps the barrier for child workspace work started after the recovery", async () => {
    const f = await recoveredDoneChildWithParent();
    await db.update(workspaceOperations).set({ executionWorkspaceId: null }).where(and(
      eq(workspaceOperations.companyId, f.companyId), eq(workspaceOperations.heartbeatRunId, f.runId),
      eq(workspaceOperations.phase, "workspace_finalize")));
    await db.insert(workspaceOperations).values({ companyId: f.companyId, issueId: f.issueId,
      executionWorkspaceId: f.workspaceId, phase: "worktree_prepare",
      status: "succeeded", startedAt: new Date(Date.now() + 60_000), finishedAt: new Date(Date.now() + 61_000) });
    await expect(issueService(db).getDependencyReadiness(f.parentId)).resolves.toMatchObject({
      isDependencyReady: false, pendingFinalizeBlockerIssueIds: [f.issueId] });
  }, 30_000);
});
