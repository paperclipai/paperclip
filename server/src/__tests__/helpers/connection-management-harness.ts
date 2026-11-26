import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, vi } from "vitest";
import { companies, heartbeatRuns, issues } from "@paperclipai/db";
import { createLocalAgentJwt } from "../../agent-auth-jwt.js";
import { startRunnerApiTestServer } from "./runner-api-server.js";
import { configureAgentLifecycle } from "../../services/agent-lifecycle.js";
import { agentService } from "../../services/agents.js";
import { accessService } from "../../services/access.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { PaperclipRunnerToolAuthority } from "../../services/native-runtime/paperclip-runner-tool-authority.js";

export type ConnectionManagementProviderHandler = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export type ConnectionManagementServer = Awaited<
  ReturnType<typeof startRunnerApiTestServer>
>;

export type ConnectionManagementLifecycle = ReturnType<
  typeof configureAgentLifecycle
>;

export function createConnectionManagementHarness(
  getProvider: () => ConnectionManagementProviderHandler | null,
) {
  let server!: ConnectionManagementServer;
  let lifecycle!: ConnectionManagementLifecycle;
  let providerFetch: ReturnType<typeof vi.spyOn> | undefined;

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", randomUUID());
    vi.stubEnv("PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE", "shadow");
    vi.stubEnv("PAPERCLIP_AUTH_RATE_LIMIT_ENABLED", "false");
    const realFetch = globalThis.fetch;
    providerFetch = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      if (new URL(url).hostname === "127.0.0.1") return realFetch(input, init);
      const provider = getProvider();
      if (provider) return provider(url, init);
      throw new Error("Unexpected external request in provider fixture");
    });
    server = await startRunnerApiTestServer({
      authPublicBaseUrl: "https://paperclip.fixture.invalid",
      humanSessions: true,
      databaseUrl: process.env.PAPERCLIP_CONNECTION_MANAGEMENT_TEST_DATABASE_URL,
    });
    lifecycle = configureAgentLifecycle(server.db, {
      requiredPluginIds: async () => [],
      runPlugin: async () => "complete",
      runHost: async () => "complete",
    });
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", join(server.root, "master.key"));
    await instanceSettingsService(server.db).updateExperimental({
      enableChatConnectors: true,
      enableGoogleWorkspaceConnector: true,
    });
  }, 90_000);

  afterAll(async () => {
    await lifecycle?.stop();
    await server?.close();
    providerFetch?.mockRestore();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function fixture() {
    const base = await server.fixture({ connectionScenario: "fresh" });
    const userId = base.responsibleUserId!;
    const access = accessService(server.db);
    await access.ensureMembership(base.companyId, "user", userId, "operator", "active");
    await access.ensureRoleDefaultGrants(base.companyId, userId, "operator", userId);
    await server.db
      .update(companies)
      .set({ requireBoardApprovalForNewAgents: false })
      .where(eq(companies.id, base.companyId));
    const cookie = await server.humanSession(userId);
    const created = await fetch(`${server.apiUrl}/api/companies/${base.companyId}/agents`, {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json", origin: server.apiUrl },
      body: JSON.stringify({
        name: "Fresh standard agent",
        role: "engineer",
        adapterType: "paperclip_runner",
        adapterConfig: { provider: "codex" },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
        permissions: {},
      }),
    });
    const agent = await created.json();
    expect(agent, JSON.stringify(agent)).toHaveProperty("id");
    expect(created.status).toBe(201);
    await lifecycle.process(agent.id);
    await vi.waitFor(
      async () => expect((await agentService(server.db).getById(agent.id))?.status).toBe("idle"),
      { timeout: 10_000 },
    );
    await server.db
      .update(heartbeatRuns)
      .set({ agentId: agent.id })
      .where(eq(heartbeatRuns.id, base.runId));
    await server.db
      .update(issues)
      .set({ assigneeAgentId: agent.id, responsibleUserId: userId })
      .where(eq(issues.id, base.issueId));
    const key = await agentService(server.db).createApiKey(
      agent.id,
      "integration",
      { kind: "standard" },
      { responsibleUserId: userId },
    );
    const jwt = createLocalAgentJwt(agent.id, base.companyId, "paperclip_runner", base.runId, userId)!;
    const request = async (method: string, path: string, body?: unknown, token = key.token) => {
      const response = await fetch(
        server.apiUrl + (path.startsWith("/mcp/") ? "" : "/api") + path,
        {
          method,
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      return { status: response.status, body: await response.json().catch(() => null) };
    };
    return {
      ...base,
      agentId: agent.id,
      userId,
      key,
      jwt,
      request,
      authority: new PaperclipRunnerToolAuthority(server.db, {
        companyId: base.companyId,
        agentId: agent.id,
        issueId: base.issueId,
        runId: base.runId,
        apiUrl: server.apiUrl,
        storage: server.storage,
      }),
    };
  }

  return {
    get server() {
      return server;
    },
    get lifecycle() {
      return lifecycle;
    },
    fixture,
  };
}
