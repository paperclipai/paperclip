import { callProjectTool } from "../services/project-tools.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { issues, heartbeatRuns } from "@paperclipai/db";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";
import { issueService } from "../services/issues.js";
import { documentService } from "../services/documents.js";
import { activityService } from "../services/activity.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("chat project tool handoff", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  const originalSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  beforeAll(async () => { process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID(); server = await startRunnerApiTestServer(); }, 60_000);
  afterAll(async () => { await server?.close(); if (originalSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET; else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalSecret; });
  const call = (fixture: Awaited<ReturnType<typeof server.fixture>>, tool: string, args: Record<string, unknown>) => fixture.authority.execute({ tool, arguments: args, callId: randomUUID() });

  it("allows a conversation reply to enter review without manufacturing a review interaction", async () => {
    const f = await server.fixture({ conversation: true });
    const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.responsibleUserId)!;
    const response = await fetch(`${server.apiUrl}/api/issues/${f.issueId}`, {
      method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "in_review", comment: "The plan is ready for our next discussion." }),
    });
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(200);
    expect(result.status).toBe("in_review");
  });

  it("creates an ordinary project task and its plan atomically, retaining the conversation plan", async () => {
    const f = await server.fixture({ conversation: true });
    await documentService(server.db).upsertIssueDocument({ issueId: f.issueId, key: "plan", format: "markdown", body: "Full discussion plan" });
    const input = { title: "Implement the clarified outcome", projectId: f.projectId, initialPlan: "# Execution plan\n\nBuild and verify the outcome.", idempotencyKey: "handoff" };
    const first = await call(f, "create_task", input) as any;
    const again = await call(f, "create_task", input) as any;
    expect(again.task.id).toBe(first.task.id);
    expect(first.task.parentId).toBeNull();
    const [task] = await server.db.select().from(issues).where(eq(issues.id, first.task.id));
    expect(task).toMatchObject({ projectId: f.projectId, assigneeAgentId: f.agentId, status: "todo" });
    expect((await documentService(server.db).getIssueDocumentByKey(task.id, "plan"))?.body).toBe(input.initialPlan);
    expect((await documentService(server.db).getIssueDocumentByKey(f.issueId, "plan"))?.body).toBe("Full discussion plan");
    await expect(call(f, "create_task", { ...input, title: "Different" })).rejects.toThrow(/idempotency/);
  });

  it("rejects creation, child helpers, and reparenting under a chat, while retaining legacy children", async () => {
    const f = await server.fixture({ conversation: true });
    const svc = issueService(server.db);
    await expect(svc.create(f.companyId, { title: "Invalid", parentId: f.issueId })).rejects.toThrow(/cannot have new subtasks/);
    await expect(svc.createChild(f.issueId, { title: "Invalid" })).rejects.toThrow(/cannot have new subtasks/);
    await expect(svc.importIssues(f.companyId, [{
      id: randomUUID(), ref: "imported", title: "Imported child", parentId: f.issueId,
      projectId: null, projectWorkspaceId: null, description: null, assigneeAgentId: null,
      status: "backlog", priority: "medium", billingCode: null, assigneeAdapterOverrides: null,
      executionWorkspaceSettings: null, labelIds: [], monitorNotes: null, monitorScheduledBy: null,
    }])).rejects.toThrow(/cannot have new subtasks/);
    const ordinary = await svc.create(f.companyId, { title: "Ordinary" });
    await expect(svc.update(ordinary.id, { parentId: f.issueId })).rejects.toThrow(/cannot have new subtasks/);
    await server.db.update(issues).set({ parentId: f.issueId }).where(eq(issues.id, ordinary.id));
    expect(await svc.update(ordinary.id, { title: "Legacy edited", parentId: f.issueId })).toMatchObject({ title: "Legacy edited" });
    expect(await svc.update(ordinary.id, { parentId: null })).toMatchObject({ parentId: null });
  });

  it("hands off through the same API used by Claude/Codex MCP with the plan present on return", async () => {
    const f = await server.fixture({ conversation: true });
    const result = await callProjectTool({ name: "create_task", arguments: { title: "MCP handoff", projectId: f.projectId, initialPlan: "# Plan\nImplement in the execution task.", idempotencyKey: "mcp" },
      apiUrl: server.apiUrl, token: createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.responsibleUserId)!,
      companyId: f.companyId, issueId: f.issueId, agentId: f.agentId, conversation: true });
    expect(result).toMatchObject({ parentId: null, projectId: f.projectId, assigneeAgentId: f.agentId });
    expect((await documentService(server.db).getIssueDocumentByKey(result.id, "plan"))?.body).toContain("Implement in the execution task");
  });

  it("retains ordinary child delegation and projectless task creation", async () => {
    const f = await server.fixture();
    const result = await call(f, "create_task", { title: "Delegate ordinary work", idempotencyKey: "child" }) as any;
    expect(result.task.parentId).toBe(f.issueId);
    expect(await issueService(server.db).create(f.companyId, { title: "No project needed" })).toMatchObject({ projectId: null });
  });

  it("creates a project once through the production API and records it on the source feed", async () => {
    const f = await server.fixture({ conversation: true });
    const input = { name: "New non-code project", description: "A well-scoped outcome", idempotencyKey: "project" };
    const results = await Promise.all(Array.from({ length: 4 }, () => call(f, "create_project", input))) as any[];
    const project = results[0];
    expect(new Set(results.map(result => result.id)).size).toBe(1);
    expect(project.id).toBeTruthy();
    expect((await call(f, "create_project", input) as any).id).toBe(project.id);
    const feed = await activityService(server.db).forIssue(f.issueId);
    expect(feed.filter(event => event.action === "project.created")).toHaveLength(1);
    expect(feed.find(event => event.action === "project.created")).toMatchObject({ entityId: project.id, runId: f.runId, details: { sourceIssueId: f.issueId } });
    await expect(call(f, "create_project", { ...input, name: "Changed" })).rejects.toThrow(/different inputs/);
  });

  it("includes an explicit workspace repository in the committed project card", async () => {
    const f = await server.fixture({ conversation: true });
    const project = await call(f, "create_project", { name: "Workspace repo", workspace: { repoUrl: "https://github.com/example/web" }, idempotencyKey: "workspace" }) as any;
    const feed = await activityService(server.db).forIssue(f.issueId);
    expect(feed.find(event => event.entityId === project.id)?.details?.repositories).toEqual([
      expect.objectContaining({ url: "https://github.com/example/web" }),
    ]);
  });

  it("registers multiple previously unknown GitHub URLs and deduplicates equivalent URLs", async () => {
    const f = await server.fixture({ conversation: true });
    const project = await call(f, "create_project", { name: "Across repos", repositoryUrls: ["https://github.com/example/web.git", "https://github.com/example/api", "https://github.com/example/web/"], idempotencyKey: "urls" }) as any;
    expect(project.workspaces.map((w: any) => w.repoUrl).sort()).toEqual(["https://github.com/example/api", "https://github.com/example/web"]);
    expect(project.workspaces.filter((w: any) => w.isPrimary)).toHaveLength(1);
    await expect(call(f, "create_project", { name: "Invalid", repositoryUrls: ["https://github.com/example/api"], workspace: { repoUrl: "https://github.com/example/web" }, idempotencyKey: "conflict" })).rejects.toThrow(/either workspace/);
    await expect(call(f, "create_project", { name: "Invalid", repositoryUrls: ["https://user:password@github.com/example/api"], idempotencyKey: "credentials" })).rejects.toThrow(/without credentials/);
  });

  it("allows planning documents while denying project/task creation in Plan and Ask mode", async () => {
    for (const mode of ["planning", "ask"] as const) {
      const f = await server.fixture({ conversation: true, mode });
      await expect(call(f, "create_project", { name: "No", idempotencyKey: "no" })).rejects.toThrow(/mode_denied/);
      await expect(call(f, "create_task", { title: "No", idempotencyKey: "no" })).rejects.toThrow(/mode_denied/);
      if (mode === "planning") await call(f, "write_document", { key: "plan", title: "Plan", body: "Clarify and plan here", idempotencyKey: "plan" });
    }
  });

  it("rejects invented repository IDs and cancelled runs without creating a project", async () => {
    const f = await server.fixture({ conversation: true });
    await expect(call(f, "create_project", { name: "Missing repo", repositoryIds: ["999999"], idempotencyKey: "missing" })).rejects.toThrow(/repository.*available/);
    await server.db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.runId));
    await expect(call(f, "create_project", { name: "Cancelled", idempotencyKey: "cancelled" })).rejects.toThrow();
  });
});
