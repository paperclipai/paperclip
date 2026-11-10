import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issues } from "@paperclipai/db";
import { startRunnerApiTestServer } from "../../__tests__/helpers/runner-api-server.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";

describe("native Studio test authorization", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  const oldSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID();
    server = await startRunnerApiTestServer();
  }, 60_000);
  afterAll(async () => {
    await server?.close();
    if (oldSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = oldSecret;
  });

  it.each(["skill_test", "standard"] as const)("keeps admitted tests task-scoped with current mode %s", async workMode => {
    const fixture = await server.fixture();
    await server.db.update(issues).set({ workMode }).where(eq(issues.id, fixture.issueId));
    await server.db.update(issues).set({ parentId: fixture.issueId }).where(eq(issues.id, fixture.blockerId));
    await server.db.update(heartbeatRuns).set({ contextSnapshot: {
      issueId: fixture.issueId, paperclipAgentJwtScope: { kind: "skill_test", issueId: fixture.issueId },
    } }).where(eq(heartbeatRuns.id, fixture.runId));
    const authority = new PaperclipRunnerToolAuthority(server.db, { ...fixture, workMode });
    const call = (tool: string, args: unknown = {}) => ({ tool, callId: randomUUID(), arguments: args });
    const before = await fixture.snapshot();
    const wakes = await server.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, fixture.companyId));
    const create = call("create_task", { title: "Must not escape Studio", idempotencyKey: "denied-create", assigneeActorId: fixture.agentId });
    for (const denied of [create, call("search_tasks"), call("list_agents"), call("list_people"), call("list_approvals"),
      call("get_agent", { actorId: fixture.agentId }), call("connection_request", { service: "notion" })]) {
      await expect(authority.execute(denied)).rejects.toMatchObject({ status: 403 });
      await expect(authority.recover(denied)).rejects.toMatchObject({ status: 403 });
    }
    expect((await fixture.snapshot()).issues).toEqual(before.issues);
    expect(await server.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, fixture.companyId))).toEqual(wakes);
    const context = await authority.execute(call("get_task_context"));
    expect(context).toMatchObject({ activeTask: { id: fixture.issueId }, childTasks: [], childReviewOutcomes: [] });
    expect(JSON.stringify(context)).not.toContain(fixture.blockerId);
    const write = call("write_document", { key: "proof", title: "Studio evidence", body: "Executed the delivered skill", idempotencyKey: "own-proof" });
    const receipt = await authority.execute(write);
    expect(await authority.recover(write)).toEqual({ result: receipt });
    expect(await authority.execute(call("read_document", { key: "proof" }))).toMatchObject({ document: { body: "Executed the delivered skill" } });
    expect(await authority.execute(call("get_task", { taskId: fixture.issueId }))).toMatchObject({ ok: true, status: 200, data: { id: fixture.issueId } });
    expect(await authority.execute(call("get_task", { taskId: fixture.blockerId }))).toMatchObject({ ok: false, status: 404 });
    if (workMode === "skill_test") {
      const names = authority.definitions().map(tool => tool.name);
      expect(names).toContain("write_document");
      expect(names).toContain("get_task_context");
      expect(names).not.toContain("create_task");
      expect(names).not.toContain("list_agents");
      expect(names).not.toContain("connection_request");
    }
  });

  it("still creates ordinary tasks for a standard run", async () => {
    const fixture = await server.fixture({ disableWakeOnDemand: true });
    await fixture.authority.execute({ tool: "create_task", callId: randomUUID(), arguments: {
      title: "Normal child task", idempotencyKey: "standard-create", assigneeActorId: fixture.agentId,
    } });
    expect((await fixture.snapshot()).issues.filter(issue => issue.title === "Normal child task")).toHaveLength(1);
  });
});
