import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueComments, issues, workspaceRuntimeServices } from "@paperclipai/db";
import { registerServerAdapter, unregisterServerAdapter, type AdapterExecutionContext } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { stopRuntimeServicesForExecutionWorkspace, type RuntimeServiceRef } from "../services/workspace-runtime.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const failedNotices = vi.hoisted(() => new Set<string>());
vi.mock("../services/issues.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/issues.js")>();
  return { ...actual, issueService: (...args: Parameters<typeof actual.issueService>) => {
    const service = actual.issueService(...args);
    return { ...service, addComment: (...input: Parameters<typeof service.addComment>) => {
      if (failedNotices.has(input[0]) && input[1].startsWith("## Workspace Ready")) {
        throw new Error("Fixture notice unavailable");
      }
      return service.addComment(...input);
    } };
  } };
});

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping heartbeat runtime services tests: ${support.reason}`);

describePostgres("heartbeat runtime services through adapter dispatch", () => {
  const adapterType = "runtime_services_test";
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  const roots: string[] = [];
  const captured = new Map<string, { services: RuntimeServiceRef[]; primaryUrl: unknown; intents: unknown }>();
  const failures = new Set<string>();

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("heartbeat-runtime-services-");
    db = createDb(temporary.connectionString);
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: adapterType, supportsLocalAgentJwt: false,
      execute: async (input: AdapterExecutionContext) => {
        const services = input.context.paperclipRuntimeServices as RuntimeServiceRef[];
        captured.set(input.runId, { services: structuredClone(services), primaryUrl: input.context.paperclipRuntimePrimaryUrl, intents: input.context.paperclipRuntimeServiceIntents });
        expect(await fetch(services[0]!.url!).then(response => response.text())).toBe("heartbeat runtime fixture");
        // Stop unfinished-task recovery from racing subsequent fixture runs.
        await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, String(input.context.issueId)));
        if (failures.has(input.agent.id)) throw new Error("Invalid fixture adapter configuration");
        return { exitCode: 0, signal: null, timedOut: false, resultJson: {}, runtimeServices: [{ id: randomUUID(), serviceName: "adapter-preview", url: "https://preview.example.test/fixture", providerRef: "fixture-preview" }] };
      },
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 30_000);

  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    for (const root of roots) {
      await stopRuntimeServicesForExecutionWorkspace({ db, executionWorkspaceId: randomUUID(), workspaceCwd: root });
      await rm(root, { recursive: true, force: true });
    }
    unregisterServerAdapter(adapterType);
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });

  async function seed(shared = false) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const root = await mkdtemp(path.join(os.tmpdir(), "heartbeat-runtime-service-"));
    roots.push(root);
    await writeFile(path.join(root, "serve.cjs"), "require('node:http').createServer((req,res)=>res.end('heartbeat runtime fixture')).listen(Number(process.env.PORT),'127.0.0.1');\n");
    await db.insert(companies).values({ id: companyId, name: "Runtime service fixture", issuePrefix: `R${companyId.slice(0, 6)}` });
    const userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Runtime user", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values([{ companyId, principalType: "user", principalId: userId, membershipRole: "operator" }, { companyId, principalType: "agent", principalId: agentId, membershipRole: "member" }]);
    await db.insert(agents).values({ id: agentId, companyId, name: "Runtime service reader", adapterType, status: "idle", adapterConfig: {
      cwd: root, workspaceRuntime: { services: [{ name: "web", command: `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(root, "serve.cjs"))}`,
        port: { type: "auto" }, readiness: { type: "http", urlTemplate: "http://127.0.0.1:{{port}}", timeoutSec: 10, intervalMs: 100 },
        lifecycle: shared ? "shared" : "ephemeral", reuseScope: "agent", stopPolicy: { type: shared ? "manual" : "on_run_finish" },
      }] },
    } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Runtime services fixture", status: "todo", assigneeAgentId: agentId, responsibleUserId: userId, issueNumber: 1 });
    return { companyId, agentId, issueId, root };
  }

  async function execute(f: Awaited<ReturnType<typeof seed>>) {
    const run = await heartbeat.wakeup(f.agentId, { source: "on_demand", triggerDetail: "manual", reason: "manual", payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId } });
    expect(run).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    const [finished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
    const services = await db.select().from(workspaceRuntimeServices).where(eq(workspaceRuntimeServices.companyId, f.companyId));
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
    const input = captured.get(run!.id)!;
    return { finished: finished!, services: services.filter(service => service.id === input.services[0]!.id || service.startedByRunId === run!.id),
      notices: comments.filter(comment => comment.createdByRunId === run!.id && comment.body.startsWith("## Workspace Ready")), input };
  }

  it("starts a real service before dispatch, retains its primary URL, and persists adapter-reported services", async () => {
    const f = await seed();
    const { finished, input, services, notices } = await execute(f);
    expect(finished.status, finished.error ?? undefined).toBe("succeeded");
    expect(input.intents).toEqual([expect.objectContaining({ name: "web" })]);
    expect(input.services).toEqual([expect.objectContaining({ companyId: f.companyId, serviceName: "web", status: "running", reused: false, startedByRunId: finished.id })]);
    expect(finished.contextSnapshot?.paperclipRuntimePrimaryUrl).toBe(input.primaryUrl);
    expect(finished.contextSnapshot?.paperclipRuntimeServices).toEqual([
      expect.objectContaining({ id: input.services[0]!.id }),
      expect.objectContaining({ serviceName: "adapter-preview", provider: "adapter_managed", url: "https://preview.example.test/fixture" }),
    ]);
    expect(services, finished.stderrExcerpt ?? undefined).toHaveLength(2);
    expect(services.find(service => service.provider === "local_process")).toMatchObject({ id: input.services[0]!.id, status: "stopped" });
    expect(services.find(service => service.provider === "adapter_managed")).toMatchObject({ companyId: f.companyId, issueId: f.issueId, status: "running", startedByRunId: finished.id });
    expect(notices).toHaveLength(2);
    expect(notices.every(notice => notice.authorAgentId === f.agentId && notice.createdByRunId === finished.id)).toBe(true);
    expect(notices.some(notice => notice.body.includes(String(input.primaryUrl)))).toBe(true);
    expect(notices.some(notice => notice.body.includes("https://preview.example.test/fixture"))).toBe(true);
  });

  it("reuses a shared service without posting another startup notice", async () => {
    const f = await seed(true);
    const first = await execute(f);
    const second = await execute(f);
    expect(second.finished.status, second.finished.error ?? undefined).toBe("succeeded");
    expect(second.input.services[0]).toMatchObject({ id: first.input.services[0]!.id, reused: true });
    expect(second.services.find(service => service.provider === "local_process")?.status).toBe("running");
    expect(first.notices).toHaveLength(2);
    expect(second.notices, second.finished.stderrExcerpt ?? undefined).toHaveLength(1);
    expect(second.notices[0]!.body).toContain("https://preview.example.test/fixture");
  });

  it("releases a started ephemeral service when adapter execution fails", async () => {
    const f = await seed();
    failures.add(f.agentId);
    const { finished, services } = await execute(f);
    expect(finished.status).toBe("failed");
    expect(finished.error).toContain("Invalid fixture adapter configuration");
    expect(services).toEqual([expect.objectContaining({ provider: "local_process", status: "stopped" })]);
  });

  it("keeps both service records and a successful result when readiness notices fail", async () => {
    const f = await seed();
    failedNotices.add(f.issueId);
    const { finished, services, notices } = await execute(f);
    expect(finished.status, finished.error ?? undefined).toBe("succeeded");
    expect(services, finished.stderrExcerpt ?? undefined).toHaveLength(2);
    expect(notices).toEqual([]);
    expect(finished.stderrExcerpt).toContain("Failed to post workspace-ready comment: Fixture notice unavailable");
    expect(finished.stderrExcerpt).toContain("Failed to post adapter-managed runtime comment: Fixture notice unavailable");
  });
});
