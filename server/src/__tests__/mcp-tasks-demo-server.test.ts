import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
  projects,
  toolMcpTasks,
} from "@paperclipai/db";
import { and, eq, lte, ne } from "drizzle-orm";
import { forgetMcpHttpSessions } from "../services/mcp-http.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { toolAccessService } from "../services/tool-access.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { adapterExecutionControls, createAdapterExecutionControl } from "../services/adapter-execution-control.js";
import {
  createTasksDemoHttpServer,
  DemoTaskStore,
  type TasksDemoHttpServer,
} from "../../../packages/kv-demo-mcp-server/src/index.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * MCP Tasks end to end against the real demo server
 * (`packages/kv-demo-mcp-server/src/tasks`) over HTTP. The demo's clock is
 * moved by hand, so a "30-second" job finishes the moment the test says so.
 */
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("MCP Tasks with the demo server", () => {
  const actor = { actorType: "user" as const, actorId: "mcp-tasks-demo-user", actorSource: "local_implicit" as const };
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let keyDir: string;
  let demo: TasksDemoHttpServer;
  let demoUrl: string;
  let clock = Date.now();

  beforeAll(async () => {
    keyDir = await mkdtemp(join(tmpdir(), "mcp-tasks-demo-secrets-"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", join(keyDir, "key"));
    fixture = await startEmbeddedPostgresTestDatabase("mcp-tasks-demo-");
    db = createDb(fixture.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableMcpTasks: true });
    demo = createTasksDemoHttpServer({ store: new DemoTaskStore({ now: () => clock }) });
    demoUrl = `http://127.0.0.1:${await demo.listen(0)}/mcp`;
  }, 30_000);
  afterAll(async () => {
    await demo?.close();
    await fixture?.cleanup();
    vi.unstubAllEnvs();
    if (keyDir) await rm(keyDir, { recursive: true, force: true });
  });

  const starts = (tool: string) => demo.store.snapshot().toolCalls[tool] ?? 0;
  const demoTask = (tool: string) => demo.store.snapshot().tasks.filter((task) => task.tool === tool).at(-1);
  const polled = (tool: string) => demoTask(tool)?.polls ?? 0;

  async function setup() {
    const [org] = await db.insert(companies).values({ name: `Demo ${randomUUID()}`, issuePrefix: `D${randomUUID().slice(0, 5)}` }).returning();
    await db.insert(companyMemberships).values({ companyId: org.id, principalType: "user", principalId: actor.actorId, status: "active", membershipRole: "admin" });
    const [agent] = await db.insert(agents).values({ companyId: org.id, name: "Demo agent", role: "engineer", adapterType: "process", adapterConfig: {}, runtimeConfig: {} }).returning();
    const [project] = await db.insert(projects).values({ companyId: org.id, name: "Demo project" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: org.id, projectId: project.id, title: "Try the demo", status: "in_progress", assigneeAgentId: agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: org.id, agentId: agent.id, invocationSource: "assignment", status: "running", contextSnapshot: { issueId: issue.id, projectId: project.id } }).returning();
    // A public-looking link, forwarded to the local demo server.
    const options = { deploymentMode: "local_trusted" as const, deploymentExposure: "private" as const,
      remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 as const }],
      remoteHttpRequest: (_url: string, init: RequestInit) => fetch(demoUrl, init) };
    const service = toolAccessService(db, options);
    const connected = await service.connectGalleryApp(org.id, { link: `https://tasks-demo-${randomUUID().slice(0, 8)}.example.com/mcp`, name: "Tasks demo" }, actor);
    await service.finishGalleryAppConnection(org.id, connected.connectionId, {
      enabledCatalogEntryIds: connected.catalog.map((entry) => entry.id), askFirstCatalogEntryIds: [], access: "all_agents",
    }, actor);
    const gatewayOptions = { ...options, toolActionSigningSecret: "tasks-demo-signing-key" };
    let gateway = createToolGatewayService(db, gatewayOptions);
    const session = await gateway.createSession({ companyId: org.id, agentId: agent.id, runId: run.id });
    const names = (await gateway.listToolsForSession(session.token)).map((tool) => tool.name);
    const toolName = (name: string) => names.find((candidate) => candidate.endsWith(`:${name.replace(/_/g, "-")}`))!;
    const call = (name: string, parameters: Record<string, unknown> = {}, timeoutMs = 10_000, sessionToken = session.token) =>
      gateway.executeTool({ sessionToken, tool: toolName(name), parameters, timeoutMs });
    const rows = () => db.select().from(toolMcpTasks).where(eq(toolMcpTasks.companyId, org.id));
    return {
      org, agent, issue, run, call, rows, names,
      gateway: () => gateway,
      restart: () => { forgetMcpHttpSessions(connected.connectionId); gateway = createToolGatewayService(db, gatewayOptions); return gateway; },
      /** Background poll for this company only. */
      poll: async (wake: (input: unknown) => Promise<void>) => {
        await db.update(toolMcpTasks).set({ nextPollAt: new Date(Date.now() + 60 * 60_000) })
          .where(and(ne(toolMcpTasks.companyId, org.id), lte(toolMcpTasks.nextPollAt, new Date())));
        return gateway.pollDueMcpTasks({ wake });
      },
    };
  }

  it("lists every demo tool", async () => {
    const { names } = await setup();
    expect(names.map((name) => name.split(":")[1]).sort()).toEqual(["cancellable", "expires", "needs-approval", "quick-echo", "slow-report", "will-fail"]);
  });

  it("slow_report: polls the task and returns the report like a direct result", async () => {
    const { call, rows } = await setup();
    const before = starts("slow_report");
    const pending = call("slow_report", { topic: "uptime", seconds: 30 });
    await vi.waitFor(() => expect(polled("slow_report")).toBeGreaterThan(0), { timeout: 5_000 });
    clock += 30_000;
    const result = await pending;
    expect(result).toMatchObject({ status: "completed", result: { content: expect.stringContaining("Report on uptime"), data: { structuredContent: { topic: "uptime", seconds: 30 } } } });
    expect(starts("slow_report") - before).toBe(1);
    expect((await rows())[0]).toMatchObject({ status: "completed" });
  });

  it("slow_report: outlives the timeout and a Paperclip restart, then is delivered once without starting again", async () => {
    const ctx = await setup();
    const before = starts("slow_report");
    await expect(ctx.call("slow_report", { topic: "restart", seconds: 60 }, 400)).rejects.toMatchObject({ reasonCode: "provider_task_pending" });
    const fresh = ctx.restart();
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, ctx.run.id));
    const [row] = await ctx.rows();
    await db.update(toolMcpTasks).set({ nextPollAt: new Date(Date.now() - 1_000), leaseExpiresAt: null, leaseOwner: null }).where(eq(toolMcpTasks.id, row!.id));
    clock += 60_000;
    const wake = vi.fn(async () => undefined);
    await ctx.poll(wake);
    expect(wake).toHaveBeenCalledTimes(1);
    const [recovered] = await db.insert(heartbeatRuns).values({ companyId: ctx.org.id, agentId: ctx.agent.id, invocationSource: "assignment", status: "running", contextSnapshot: { issueId: ctx.issue.id } }).returning();
    const session = await fresh.createSession({ companyId: ctx.org.id, agentId: ctx.agent.id, runId: recovered!.id });
    expect(await ctx.call("slow_report", { topic: "restart", seconds: 60 }, 5_000, session.token))
      .toMatchObject({ status: "completed", result: { content: expect.stringContaining("Report on restart") } });
    expect(starts("slow_report") - before).toBe(1);
    // Asking again is new work: the first result was delivered exactly once.
    const [delivered] = await ctx.rows();
    expect(delivered!.deliveredAt).toBeInstanceOf(Date);
  });

  it("needs_approval: the question becomes a card, and the person's choice is sent with tasks/update", async () => {
    const { call, org, issue } = await setup();
    const first = await call("needs_approval", { action: "rotate the demo key" }).catch((error) => error);
    expect(first).toMatchObject({ reasonCode: "elicitation_required" });
    const [card] = await db.select().from(issueThreadInteractions).where(and(eq(issueThreadInteractions.companyId, org.id), eq(issueThreadInteractions.issueId, issue.id)));
    expect(card).toMatchObject({ kind: "ask_user_questions", status: "pending" });
    await db.update(issueThreadInteractions).set({ status: "answered", result: { version: 1, answers: [
      { questionId: "decision", optionIds: ["approve"] },
      { questionId: "note", optionIds: [], otherText: "go ahead" },
    ] } }).where(eq(issueThreadInteractions.id, card!.id));
    const pending = call("needs_approval", { action: "rotate the demo key" });
    await vi.waitFor(() => expect(demoTask("needs_approval")?.status).toBe("working"), { timeout: 5_000 });
    clock += 3_000;
    expect(await pending).toMatchObject({ status: "completed", result: { content: "Approved: rotate the demo key was carried out. Note: go ahead" } });
  });

  it("will_fail: becomes a tool error with the app's message", async () => {
    const { call } = await setup();
    const pending = call("will_fail", { seconds: 5 }).catch((error) => error);
    await vi.waitFor(() => expect(polled("will_fail")).toBeGreaterThan(0), { timeout: 5_000 });
    clock += 5_000;
    const failure = await pending;
    expect(failure).toMatchObject({ reasonCode: "provider_task_failed" });
    expect(failure.message).toContain("crashed on purpose");
  });

  it("cancellable: stopping the run cancels the task in the app", async () => {
    const { call, run, rows } = await setup();
    const control = createAdapterExecutionControl();
    adapterExecutionControls.set(run.id, control);
    try {
      const pending = call("cancellable").catch((error) => error);
      await vi.waitFor(() => expect(polled("cancellable")).toBeGreaterThan(0), { timeout: 5_000 });
      control.controller.abort();
      expect(await pending).toMatchObject({ reasonCode: "provider_task_cancelled" });
    } finally {
      adapterExecutionControls.delete(run.id);
    }
    expect(demoTask("cancellable")?.status).toBe("cancelled");
    expect((await rows())[0]).toMatchObject({ status: "cancelled", errorCode: "run_cancelled" });
  });

  it("expires: a task the app forgets ends with a clear error, never a hang", async () => {
    const { call, rows } = await setup();
    const pending = call("expires", { ttlSeconds: 15 }).catch((error) => error);
    await vi.waitFor(() => expect(polled("expires")).toBeGreaterThan(0), { timeout: 5_000 });
    clock += 15_000;
    expect(await pending).toMatchObject({ reasonCode: "provider_task_expired" });
    expect((await rows())[0]).toMatchObject({ status: "expired" });
  });

  it("quick_echo: an ordinary call stays synchronous", async () => {
    const { call, rows } = await setup();
    expect(await call("quick_echo", { text: "hi" })).toMatchObject({ status: "completed", result: { content: "echo: hi" } });
    expect(await rows()).toEqual([]);
  });
});
