import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, heartbeatRuns, issues, toolConnections } from "@paperclipai/db";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";
import { configureAgentLifecycle } from "../services/agent-lifecycle.js";
import { agentService } from "../services/agents.js";
import { accessService } from "../services/access.js";

vi.mock("../services/agent-lifecycle-driver.js", () => ({
  createLifecycleDriver: () => ({ requiredPluginIds: async () => [], runPlugin: async () => "complete", runHost: async () => "complete" }),
}));

// Requests traverse the assembled server and production bearer middleware.
describe("tool policy list for agent callers", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  let lifecycle: ReturnType<typeof configureAgentLifecycle>;
  let externalFetch: ReturnType<typeof vi.spyOn>;
  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", randomUUID());
    vi.stubEnv("PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE", "shadow");
    vi.stubEnv("PAPERCLIP_AUTH_RATE_LIMIT_ENABLED", "false");
    const realFetch = globalThis.fetch;
    externalFetch = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      if (new URL(String(input)).hostname === "127.0.0.1") return realFetch(input, init);
      throw new Error("Unexpected external request in policy list fixture");
    });
    server = await startRunnerApiTestServer({ authPublicBaseUrl: "https://paperclip.fixture.invalid", humanSessions: true });
    lifecycle = configureAgentLifecycle(server.db, { requiredPluginIds: async () => [], runPlugin: async () => "complete", runHost: async () => "complete" });
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", join(server.root, "master.key"));
  }, 90_000);
  afterAll(async () => { await lifecycle?.stop(); await server?.close(); externalFetch?.mockRestore(); vi.unstubAllEnvs(); });

  async function fixture() {
    const base = await server.fixture({ connectionScenario: "fresh" });
    const userId = base.responsibleUserId!;
    const access = accessService(server.db);
    await access.ensureMembership(base.companyId, "user", userId, "operator", "active");
    await access.ensureRoleDefaultGrants(base.companyId, userId, "operator", userId);
    await server.db.update(companies).set({ requireBoardApprovalForNewAgents: false }).where(eq(companies.id, base.companyId));
    const cookie = await server.humanSession(userId);
    const created = await fetch(`${server.apiUrl}/api/companies/${base.companyId}/agents`, {
      method: "POST", headers: { cookie, "Content-Type": "application/json", origin: server.apiUrl },
      body: JSON.stringify({ name: "Policy reader", role: "engineer", adapterType: "paperclip_runner", adapterConfig: { provider: "codex" },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } }, permissions: {} }),
    });
    const agent = await created.json();
    expect(created.status, JSON.stringify(agent)).toBe(201);
    await lifecycle.process(agent.id);
    await vi.waitFor(async () => expect((await agentService(server.db).getById(agent.id))?.status).toBe("idle"), { timeout: 10_000 });
    await server.db.update(heartbeatRuns).set({ agentId: agent.id }).where(eq(heartbeatRuns.id, base.runId));
    await server.db.update(issues).set({ assigneeAgentId: agent.id, responsibleUserId: userId }).where(eq(issues.id, base.issueId));
    const key = await agentService(server.db).createApiKey(agent.id, "integration", { kind: "standard" }, { responsibleUserId: userId });
    const request = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${server.apiUrl}/api${path}`, { method, headers: { Authorization: `Bearer ${key.token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json().catch(() => null) };
    };
    return { ...base, agentId: agent.id as string, request };
  }

  it("checks each distinct resource once, however many rules name it", async () => {
    const f = await fixture();
    const connection = await f.request("POST", `/companies/${f.companyId}/tools/connections`, { name: "Shared policy target", transport: "mcp_remote", authKind: "none", transportConfig: { url: "https://1.1.1.1/mcp" } });
    expect(connection).toMatchObject({ status: 201 });
    const path = `/companies/${f.companyId}/tools/policies`;
    const policyIds: string[] = [];
    for (let index = 0; index < 40; index++) {
      const policy = await f.request("POST", path, { name: `Shared rule ${index}`, policyType: "allow", selectors: { agentId: f.agentId, connectionId: connection.body.id } });
      expect(policy).toMatchObject({ status: 201 });
      policyIds.push(policy.body.id);
    }
    let connectionReads = 0;
    const originalSelect = server.db.select.bind(server.db);
    const select = vi.spyOn(server.db, "select").mockImplementation(((selection: never) => {
      const builder = originalSelect(selection);
      const originalFrom = builder.from.bind(builder);
      builder.from = ((table: never) => {
        if (table === toolConnections) connectionReads++;
        return originalFrom(table);
      }) as typeof builder.from;
      return builder;
    }) as unknown as typeof server.db.select);
    try {
      const listed = await f.request("GET", path);
      expect(listed).toMatchObject({ status: 200 });
      expect((listed.body.policies as Array<{ id: string }>).map(policy => policy.id)).toEqual(expect.arrayContaining(policyIds));
      // Checking every rule again made long rule lists exceed the agent API timeout.
      expect(connectionReads).toBeLessThan(10);
    } finally { select.mockRestore(); }
  });
});
