import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { authUsers, companyMemberships, activityLog, agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { documentService } from "../documents.js";
import { issueService } from "../issues.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";

describe("runner backlog task creation", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("runner-backlog-");
    db = createDb(temporary.connectionString);
  });
  afterAll(async () => { await temporary?.cleanup(); });

  async function fixture(conversation: boolean) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Backlog", issuePrefix: `B${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Planner", role: "ceo", status: "active", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Coordinate", status: "in_progress", assigneeAgentId: agentId, conversationAgentId: conversation ? agentId : null, conversationUserId: conversation ? "operator" : null, conversationState: conversation ? "active" : null });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: issueId, invocationSource: "assignment", triggerDetail: "system", contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const enqueueWakeup = vi.fn().mockResolvedValue(null);
    const binding = { companyId, agentId, issueId, runId, enqueueWakeup };
    return { companyId, agentId, issueId, runId, binding, enqueueWakeup, authority: new PaperclipRunnerToolAuthority(db, binding) };
  }

  it("never repeats a completed or uncertain workspace mutation and fences replay", async () => {
    const f = await fixture(false);
    const root = await mkdtemp(join(tmpdir(), "dot-workspace-receipt-"));
    await db.update(agents).set({ adapterConfig: { provider: "openai_dot", dotWorkspaceAccess: true } }).where(eq(agents.id, f.agentId));
    const authority = new PaperclipRunnerToolAuthority(db, { ...f.binding, workspaceRoot: root, workspaceBridge: true });
    try {
      const call = { tool: "workspace_write", callId: "write-once", arguments: { path: "report.txt", text: "first", expectedSha256: null } };
      const receipt = await authority.execute(call);
      await writeFile(join(root, "report.txt"), "later edit");
      expect(await authority.execute(call)).toEqual(receipt);
      expect(await readFile(join(root, "report.txt"), "utf8")).toBe("later edit");
      await expect(authority.execute({ ...call, arguments: { ...call.arguments, text: "changed" } })).rejects.toThrow("reused");

      const uncertain = { tool: "workspace_write", callId: "lost-after-reservation", arguments: { path: "uncertain.txt", text: "must not run", expectedSha256: null } };
      const key = createHash("sha256").update(uncertain.callId).digest("hex");
      const digest = createHash("sha256").update(JSON.stringify({ arguments: { expectedSha256: null, path: uncertain.arguments.path, text: uncertain.arguments.text }, tool: uncertain.tool })).digest("hex");
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      await db.update(heartbeatRuns).set({ resultJson: { ...run!.resultJson, bridgeToolReceipts: { ...((run!.resultJson as any)?.bridgeToolReceipts ?? {}), [key]: { digest, tool: uncertain.tool, state: "pending" } } } }).where(eq(heartbeatRuns.id, f.runId));
      expect(await authority.execute(uncertain)).toMatchObject({ outcome: "unknown" });
      await expect(readFile(join(root, "uncertain.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      await db.update(agents).set({ adapterConfig: { provider: "openai_dot", dotWorkspaceAccess: false } }).where(eq(agents.id, f.agentId));
      await expect(authority.execute(call)).rejects.toThrow("disabled");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("creates and reassigns human tasks with company membership and retry checks", async () => {
    const f = await fixture(false), userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Owner", email: userId + "@test.example", createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
    const call = { tool: "create_task", callId: "hello-owner", arguments: { idempotencyKey: "hello-owner", title: "hello", assigneeUserId: userId } };
    const receipt = await f.authority.execute(call) as { task: { id: string } };
    expect(receipt).toMatchObject({ scheduledWakeIds: [], task: { assigneeActorId: null, assigneeUserId: userId } });
    expect(await f.authority.execute(call)).toEqual(receipt);
    expect(f.enqueueWakeup).not.toHaveBeenCalled();
    expect(await f.authority.execute({ tool: "list_people", callId: "people", arguments: {} })).toMatchObject([{ id: userId, name: "Owner", role: "owner" }]);
    await expect(f.authority.execute({ ...call, arguments: { ...call.arguments, idempotencyKey: "foreign", assigneeUserId: "foreign-person" } })).rejects.toThrow();
    await expect(f.authority.execute({ ...call, arguments: { ...call.arguments, assigneeActorId: f.agentId } })).rejects.toThrow("Choose one");
    const [human] = await db.select().from(issues).where(eq(issues.id, receipt.task.id));
    const reassign = { tool: "reassign_task", callId: "back-to-agent", arguments: { taskId: human!.id, assigneeActorId: f.agentId,
      expectedAssigneeActorId: null, expectedAssigneeUserId: userId, expectedStatusVersion: human!.statusVersion, reason: "Agent will help", idempotencyKey: "back-to-agent" } };
    await f.authority.execute(reassign);
    const [assigned] = await db.select().from(issues).where(eq(issues.id, human!.id));
    expect(assigned).toMatchObject({ assigneeAgentId: f.agentId, assigneeUserId: null });
    await f.authority.execute({ tool: "reassign_task", callId: "back-to-person", arguments: { taskId: human!.id, assigneeActorId: null, assigneeUserId: userId,
      expectedAssigneeActorId: f.agentId, expectedStatusVersion: assigned!.statusVersion, reason: "Owner takes over", idempotencyKey: "back-to-person" } });
    expect((await db.select().from(issues).where(eq(issues.id, human!.id)))[0]).toMatchObject({ assigneeAgentId: null, assigneeUserId: userId });
  });

  it.each([false, true])("persists the plan without waking an assigned backlog task (conversation=%s)", async conversation => {
    const f = await fixture(conversation);
    const call = { tool: "create_task", callId: "save-later", arguments: { idempotencyKey: "save-later", title: "Plan for later", status: "backlog", initialPlan: "1. Check status.\n2. Save the plan.\n3. Confirm creation." } };
    const receipt = await f.authority.execute(call) as { task: { id: string } };
    expect(receipt).toMatchObject({ scheduledWakeIds: [], task: { status: "backlog", assigneeActorId: f.agentId, parentId: conversation ? null : f.issueId } });
    const [task] = await db.select().from(issues).where(eq(issues.id, receipt.task.id));
    expect(task).toMatchObject({ status: "backlog", executionRunId: null, startedAt: null });
    expect(await documentService(db).getIssueDocumentByKey(task!.id, "plan")).toMatchObject({ body: call.arguments.initialPlan });
    expect(f.enqueueWakeup).not.toHaveBeenCalled();
    await expect(f.authority.execute({ ...call, callId: "retry" })).resolves.toEqual(receipt);

    const replacement = randomUUID();
    await db.insert(heartbeatRuns).values({ id: replacement, companyId: f.companyId, agentId: f.agentId, status: "running", runtimeMode: "native", nativeIssueId: f.issueId, invocationSource: "assignment", triggerDetail: "system" });
    await db.update(issues).set({ executionRunId: replacement }).where(eq(issues.id, f.issueId));
    await expect(new PaperclipRunnerToolAuthority(db, { ...f.binding, runId: replacement }).execute(call)).resolves.toMatchObject({ task: { id: task!.id, status: "backlog" }, scheduledWakeIds: [] });
    expect(f.enqueueWakeup).not.toHaveBeenCalled();
    const events = await db.select().from(activityLog).where(and(eq(activityLog.entityId, task!.id), eq(activityLog.action, "issue.created")));
    expect(events).toHaveLength(1);
    expect(events[0]!.details).toMatchObject({ status: "backlog" });
  });

  it.each(["todo", "done"])("keeps an explicit backlog hold with a %s prerequisite", async status => {
    const f = await fixture(true);
    const blockerId = randomUUID();
    await db.insert(issues).values({ id: blockerId, companyId: f.companyId, title: "Prerequisite", status });
    const receipt = await f.authority.execute({ tool: "create_task", callId: "held", arguments: { idempotencyKey: "held", title: "Held task", status: "backlog", blockedByTaskIds: [blockerId] } }) as { task: { id: string } };
    expect(receipt).toMatchObject({ task: { status: "backlog" }, scheduledWakeIds: [] });
    expect(await issueService(db).getRelationSummaries(receipt.task.id)).toMatchObject({ blockedBy: [expect.objectContaining({ id: blockerId })] });
    expect(f.enqueueWakeup).not.toHaveBeenCalled();
  });

  it.each(["in_progress", "done", "blocked", null])("rejects unsupported initial status %s before mutation", async status => {
    const f = await fixture(true);
    await expect(f.authority.execute({ tool: "create_task", callId: "invalid", arguments: { idempotencyKey: "invalid", title: "Invalid", status } })).rejects.toThrow();
    expect(await db.select().from(issues).where(eq(issues.companyId, f.companyId))).toHaveLength(1);
    expect(f.enqueueWakeup).not.toHaveBeenCalled();
  });
});
