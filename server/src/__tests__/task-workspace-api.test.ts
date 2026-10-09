import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { executionWorkspaces, issues, heartbeatRuns } from "@paperclipai/db";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { PaperclipRunnerToolAuthority } from "../services/native-runtime/paperclip-runner-tool-authority.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("task workspace API and native semantic authority", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  const originalSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  beforeAll(async () => { process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID(); server = await startRunnerApiTestServer(); }, 60_000);
  afterAll(async () => { await server?.close(); if (originalSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET; else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalSecret; });
  it("inspects admitted files, durably requests a repository, and stages root selection without interrupting", async () => {
    const f = await server.fixture({ conversation: true, disableWakeOnDemand: true });
    const [workspace] = await server.db.insert(executionWorkspaces).values({ companyId: f.companyId, projectId: null, sourceIssueId: f.issueId, name: "Task files", cwd: f.workspace, mode: "shared_workspace", strategyType: "task_directory" }).returning();
    await server.db.update(issues).set({ projectId: null, projectWorkspaceId: null, executionWorkspaceId: workspace.id }).where(eq(issues.id, f.issueId));
    const authority = new PaperclipRunnerToolAuthority(server.db, { companyId: f.companyId, issueId: f.issueId, agentId: f.agentId, runId: f.runId, apiUrl: server.apiUrl, workspaceRoot: "/admitted/task" });
    const call = (tool: string, args: Record<string, unknown>) => authority.execute({ tool, arguments: args, callId: randomUUID() });
    const view = await call("get_workspace", {}) as { bindingRevision: number; cwd: string; workspace: { id: string } };
    expect(view).toMatchObject({ cwd: "/admitted/task", workspace: { id: workspace.id } });
    const args = { repository: { kind: "url", url: "https://github.com/public/example" }, requestKey: "repository-one" };
    const first = await call("prepare_repository", args) as { preparationId: string; kind: string };
    expect(first.kind).toBe("requires_next_admission");
    expect(await call("prepare_repository", args)).toMatchObject({ preparationId: first.preparationId });
    expect(await call("select_workspace", { selection: { kind: "task_directory" }, expectedBindingRevision: view.bindingRevision, requestKey: "root-one" })).toMatchObject({ kind: "scheduled", applies: "next_normal_admission" });
    const [task] = await server.db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(task).toMatchObject({ executionWorkspaceId: workspace.id, projectId: null, workspacePendingSelection: { requestKey: "root-one" } });
    const runs = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: f.runId, status: "running" });
  });
  it("does not expose repository preparation or workspace selection to Ask mode", async () => {
    const f = await server.fixture({ mode: "ask", conversation: true, disableWakeOnDemand: true });
    await expect(f.authority.execute({ tool: "prepare_repository", callId: randomUUID(), arguments: { repository: { kind: "url", url: "https://github.com/public/example" }, requestKey: "denied" } })).rejects.toThrow();
    await expect(f.authority.execute({ tool: "select_workspace", callId: randomUUID(), arguments: { selection: { kind: "task_directory" }, expectedBindingRevision: 0, requestKey: "denied" } })).rejects.toThrow();
  });
});
