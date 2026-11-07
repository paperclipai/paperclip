import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, issues } from "@paperclipai/db";
import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
const TEST_ADAPTER_TYPE = "runtime_tools_native_mcp_capture";

async function waitForRunToFinish(heartbeat: ReturnType<typeof heartbeatService>, runId: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await heartbeat.getRun(runId);
}

suite("heartbeat native MCP runtime tool delivery", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const oldPaperclipApiUrl = process.env.PAPERCLIP_API_URL;
  const oldJwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  const capturedServers: AdapterRuntimeMcpServer[][] = [];

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("heartbeat-runtime-tools-delivery-");
    db = createDb(temporary.connectionString);
    process.env.PAPERCLIP_API_URL = "http://127.0.0.1:3100/api";
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "runtime-tools-test-secret";
    registerServerAdapter({
      type: TEST_ADAPTER_TYPE,
      runtimeToolDelivery: "native_mcp",
      execute: async (ctx) => {
        capturedServers.push(ctx.runtimeMcp?.getServers() ?? []);
        return { exitCode: 0, signal: null, timedOut: false };
      },
      testEnvironment: async () => ({
        adapterType: TEST_ADAPTER_TYPE,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (db) await heartbeatService(db).drainActiveRunExecutions();
    unregisterServerAdapter(TEST_ADAPTER_TYPE);
    if (oldPaperclipApiUrl === undefined) delete process.env.PAPERCLIP_API_URL;
    else process.env.PAPERCLIP_API_URL = oldPaperclipApiUrl;
    if (oldJwtSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = oldJwtSecret;
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });

  it("offers the Paperclip connections server only to task-bound runs", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Native Runtime Tools",
      issuePrefix: "NRT",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(authUsers).values({ id: "responsible-user", name: "Fixture user", email: "owner@example.test", createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Native Runtime Capture",
      role: "engineer",
      status: "idle",
      adapterType: TEST_ADAPTER_TYPE,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({ id: issueId, companyId, title: "Connect a service", status: "todo", assigneeAgentId: agentId });
    const heartbeat = heartbeatService(db);

    const untaskedRun = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect((await waitForRunToFinish(heartbeat, untaskedRun!.id))?.status).toBe("succeeded");
    expect(capturedServers.at(-1)?.map((server) => server.connectionId)).not.toContain("paperclip-runtime-tools");

    const taskRun = await heartbeat.invoke(agentId, "on_demand", { issueId }, "manual");
    expect((await waitForRunToFinish(heartbeat, taskRun!.id))?.status).toBe("succeeded");
    expect(capturedServers.at(-1)).toContainEqual(expect.objectContaining({
      name: "Paperclip connections",
      connectionId: "paperclip-runtime-tools",
      url: "http://127.0.0.1:3100/mcp/runtime-tools",
    }));
  });
});
