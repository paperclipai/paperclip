import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentMcpServers,
  agents,
  companies,
  createDb,
  mcpServerCatalogSnapshots,
  mcpServers,
  pluginManagedResources,
  plugins,
} from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import {
  deactivatePluginManagedMcpServers,
  reactivatePluginManagedMcpServers,
} from "../services/plugin-managed-mcp-servers.js";
import { mcpServerService } from "../services/mcp-servers.js";
import { agentMcpToolService } from "../services/agent-mcp-tools.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function createEventBusStub() {
  return {
    forPlugin() {
      return {
        emit: async () => {},
        subscribe: () => {},
      };
    },
  } as any;
}

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

function manifest(): PaperclipPluginManifestV1 {
  return {
    id: "paperclip.managed-mcp-test",
    apiVersion: 1,
    version: "0.1.0",
    displayName: "Managed MCP Test",
    description: "Test plugin",
    author: "Paperclip",
    categories: ["automation"],
    capabilities: ["mcp.servers.managed"],
    entrypoints: { worker: "./dist/worker.js" },
    mcpServers: [{
      serverKey: "linear",
      displayName: "Linear MCP",
      description: "Linear issue tools over MCP.",
      transport: "http",
      url: "https://mcp.example.com/linear",
      headers: { "x-plugin": "managed" },
      metadata: { vendor: "linear" },
    }],
  };
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres plugin-managed MCP server tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("plugin-managed MCP servers", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let previousFlag: string | undefined;

  beforeAll(async () => {
    previousFlag = process.env.PAPERCLIP_MCP_CLIENT_ENABLED;
    process.env.PAPERCLIP_MCP_CLIENT_ENABLED = "true";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-managed-mcp-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(mcpServerCatalogSnapshots);
    await db.delete(agentMcpServers);
    await db.delete(activityLog);
    await db.delete(pluginManagedResources);
    await db.delete(mcpServers);
    await db.delete(agents);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (previousFlag === undefined) {
      delete process.env.PAPERCLIP_MCP_CLIENT_ENABLED;
    } else {
      process.env.PAPERCLIP_MCP_CLIENT_ENABLED = previousFlag;
    }
    await tempDb?.cleanup();
  });

  async function seedCompanyAndPlugin(pluginManifest = manifest()) {
    const companyId = randomUUID();
    const pluginId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: issuePrefix(companyId),
      // Per-company MCP client gate (D2-5): without this opt-in the merged
      // tools endpoint returns an empty surface regardless of bindings.
      mcpClientEnabled: true,
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: pluginManifest.id,
      packageName: "@paperclipai/plugin-managed-mcp-test",
      version: pluginManifest.version,
      apiVersion: pluginManifest.apiVersion,
      categories: pluginManifest.categories,
      manifestJson: pluginManifest,
      status: "ready",
      installOrder: 1,
    });
    const services = buildHostServices(db, pluginId, pluginManifest.id, createEventBusStub(), undefined, {
      manifest: pluginManifest,
    });
    return { companyId, pluginId, pluginManifest, services };
  }

  it("reconciles a declared MCP server into the company pool, disabled and plugin-stamped", async () => {
    const { companyId, services } = await seedCompanyAndPlugin();

    const created = await services.mcpServers.managedReconcile({ companyId, serverKey: "linear" });

    expect(created.status).toBe("created");
    expect(created.server).toMatchObject({
      companyId,
      name: "Linear MCP",
      slug: "plugin-paperclip-managed-mcp-test-linear",
      transport: "http",
      url: "https://mcp.example.com/linear",
      headers: { "x-plugin": "managed" },
      // Governance parity: never born enabled — an operator must turn it on.
      enabled: false,
      metadata: {
        vendor: "linear",
        pluginManaged: { pluginKey: "paperclip.managed-mcp-test", resourceKey: "linear" },
      },
    });
    expect(created.defaultDrift).toBeNull();

    const resolved = await services.mcpServers.managedGet({ companyId, serverKey: "linear" });
    expect(resolved.status).toBe("resolved");
    expect(resolved.mcpServerId).toBe(created.mcpServerId);

    const [binding] = await db.select().from(pluginManagedResources);
    expect(binding).toMatchObject({
      companyId,
      resourceKind: "mcp_server",
      resourceKey: "linear",
      resourceId: created.mcpServerId,
    });
  });

  it("preserves operator config on reconcile and restores declared config (but not enabled) on reset", async () => {
    const { companyId, services } = await seedCompanyAndPlugin();
    const created = await services.mcpServers.managedReconcile({ companyId, serverKey: "linear" });
    expect(created.mcpServerId).toBeTruthy();

    await db
      .update(mcpServers)
      .set({ name: "Renamed by operator", enabled: true, updatedAt: new Date() })
      .where(eq(mcpServers.id, created.mcpServerId!));

    const reconciled = await services.mcpServers.managedReconcile({ companyId, serverKey: "linear" });
    expect(reconciled.status).toBe("resolved");
    expect(reconciled.server).toMatchObject({ name: "Renamed by operator", enabled: true });
    expect(reconciled.defaultDrift).toEqual({ changedFields: ["name"] });

    const reset = await services.mcpServers.managedReset({ companyId, serverKey: "linear" });
    expect(reset.status).toBe("reset");
    expect(reset.server).toMatchObject({
      name: "Linear MCP",
      url: "https://mcp.example.com/linear",
      enabled: true,
    });
    expect(reset.defaultDrift).toBeNull();
  });

  it("relinks by declared slug when the managed binding is lost", async () => {
    const { companyId, services } = await seedCompanyAndPlugin();
    const created = await services.mcpServers.managedReconcile({ companyId, serverKey: "linear" });
    await db.delete(pluginManagedResources).where(eq(pluginManagedResources.resourceId, created.mcpServerId!));

    const relinked = await services.mcpServers.managedReconcile({ companyId, serverKey: "linear" });

    expect(relinked.status).toBe("relinked");
    expect(relinked.mcpServerId).toBe(created.mcpServerId);
    const [binding] = await db.select().from(pluginManagedResources);
    expect(binding).toMatchObject({ resourceKind: "mcp_server", resourceId: created.mcpServerId });
  });

  it("seals reconcile-time credentials instead of storing plaintext", async () => {
    const { companyId, services } = await seedCompanyAndPlugin();
    const created = await services.mcpServers.managedReconcile({
      companyId,
      serverKey: "linear",
      credential: "super-secret-token",
    });

    expect(created.server?.credentialSecretRef).toBeTruthy();
    expect(created.server?.credentialSecretRef).not.toContain("super-secret-token");
  });

  it("deregisters managed servers when the plugin goes down and restores only auto-disabled ones", async () => {
    const { companyId, pluginId, services } = await seedCompanyAndPlugin();
    const created = await services.mcpServers.managedReconcile({ companyId, serverKey: "linear" });
    await db
      .update(mcpServers)
      .set({ enabled: true, updatedAt: new Date() })
      .where(eq(mcpServers.id, created.mcpServerId!));

    await deactivatePluginManagedMcpServers(db, pluginId);
    let [row] = await db.select().from(mcpServers).where(eq(mcpServers.id, created.mcpServerId!));
    expect(row.enabled).toBe(false);
    expect((row.metadata as any).pluginManaged.autoDisabled).toBe(true);

    await reactivatePluginManagedMcpServers(db, pluginId);
    [row] = await db.select().from(mcpServers).where(eq(mcpServers.id, created.mcpServerId!));
    expect(row.enabled).toBe(true);
    expect((row.metadata as any).pluginManaged.autoDisabled).toBeUndefined();

    // An operator disable carries no autoDisabled stamp — plugin re-enable
    // must not override it.
    await db
      .update(mcpServers)
      .set({ enabled: false, updatedAt: new Date() })
      .where(eq(mcpServers.id, created.mcpServerId!));
    await reactivatePluginManagedMcpServers(db, pluginId);
    [row] = await db.select().from(mcpServers).where(eq(mcpServers.id, created.mcpServerId!));
    expect(row.enabled).toBe(false);
  });

  it("refuses the managed MCP surface when PAPERCLIP_MCP_CLIENT_ENABLED is off", async () => {
    const { companyId, services } = await seedCompanyAndPlugin();
    process.env.PAPERCLIP_MCP_CLIENT_ENABLED = "false";
    try {
      await expect(
        services.mcpServers.managedReconcile({ companyId, serverKey: "linear" }),
      ).rejects.toThrow(/PAPERCLIP_MCP_CLIENT_ENABLED/);
    } finally {
      process.env.PAPERCLIP_MCP_CLIENT_ENABLED = "true";
    }
  });

  it("exposes a plugin-managed server's tools to permitted agents through the standard per-agent filter", async () => {
    const { companyId, services } = await seedCompanyAndPlugin();
    const created = await services.mcpServers.managedReconcile({ companyId, serverKey: "linear" });
    const serverId = created.mcpServerId!;

    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ToolUser",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const secrets = secretService(db);
    const operatorSvc = mcpServerService(db, { secrets });
    const toolSvc = agentMcpToolService(db, { secrets });

    // Persisted discovery result — the merged-tools endpoint reads the
    // latest catalog snapshot, not a live connection.
    await db.insert(mcpServerCatalogSnapshots).values({
      companyId,
      mcpServerId: serverId,
      status: "succeeded",
      tools: [{ name: "create_issue", title: "Create issue", description: "Create a Linear issue", inputSchema: {} }],
    });

    // Governance still applies: nothing is visible until the company enables
    // the server AND the agent is bound to it. The allow-list must be explicit —
    // an empty allowedTools exposes ZERO tools (NEO-445 deny-by-default).
    await operatorSvc.bindToAgent(companyId, agentId, {
      mcpServerId: serverId,
      allowedTools: ["create_issue"],
    });
    const beforeEnable = await toolSvc.listForAgent(agentId, { companyId });
    expect(beforeEnable.tools).toHaveLength(0);

    await operatorSvc.update(serverId, { enabled: true });
    const afterEnable = await toolSvc.listForAgent(agentId, { companyId });
    expect(afterEnable.tools).toEqual([
      expect.objectContaining({
        serverSlug: "plugin-paperclip-managed-mcp-test-linear",
        toolName: "create_issue",
      }),
    ]);

    // An unbound agent in the same company sees nothing.
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "Bystander",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const unbound = await toolSvc.listForAgent(otherAgentId, { companyId });
    expect(unbound.tools).toHaveLength(0);
  });
});
