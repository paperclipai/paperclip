import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agentToolGrants, agents, companies, companyTools, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { toolAccessService } from "../services/tool-access.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres tool access service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("toolAccessService", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof toolAccessService>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("tool-access-service");
    stopDb = started.stop;
    db = createDb(started.connectionString);
    svc = toolAccessService(db);
  });

  afterEach(async () => {
    await db.delete(agentToolGrants);
    await db.delete(companyTools);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const [agent] = await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "GBrain Researcher",
      role: "researcher",
      status: "active",
      adapterType: "hermes_local",
      adapterConfig: { toolsets: "base" },
      runtimeConfig: {},
      permissions: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    }).returning();
    return { companyId, agentId, agent };
  }

  it("lists an empty matrix, creates a tool, and validates grant modes", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();

    expect(await svc.listMatrix(companyId)).toMatchObject({ tools: [], grants: [] });

    const created = await svc.createTool(companyId, {
      key: "mcp.gbrain.query",
      label: "GBrain query",
      source: "mcp_tool",
      adapter: "hermes_local",
      serverKey: "gbrain",
      toolName: "query",
      risk: "read",
      supportedModes: ["off", "read"],
      render: { hermes: { mcpServer: "gbrain", includeTool: "query" } },
    });

    expect(created.key).toBe("mcp.gbrain.query");

    const result = await svc.setGrant(companyId, agentId, created.id, "read", null);

    expect(result).toMatchObject({
      previousMode: "off",
      grant: { mode: "read" },
      tool: { key: "mcp.gbrain.query" },
    });
    await expect(svc.setGrant(companyId, agentId, created.id, "write", null)).rejects.toThrow(/does not support mode/);
  });

  it("renders granted tools into Hermes adapter config", async () => {
    const { companyId, agentId, agent } = await seedCompanyAndAgent();

    const terminal = await svc.createTool(companyId, {
      key: "adapter_toolset.terminal",
      label: "Terminal",
      source: "adapter_toolset",
      adapter: "hermes_local",
      risk: "admin",
      supportedModes: ["off", "admin"],
      render: { hermes: { toolset: "terminal" } },
    });
    const gbrain = await svc.createTool(companyId, {
      key: "mcp.gbrain.query",
      label: "GBrain query",
      source: "mcp_tool",
      adapter: "hermes_local",
      serverKey: "gbrain",
      toolName: "query",
      risk: "read",
      supportedModes: ["off", "read"],
      render: { hermes: { mcpServer: "gbrain", includeTool: "query" } },
    });

    await svc.setGrant(companyId, agentId, terminal.id, "admin", null);
    await svc.setGrant(companyId, agentId, gbrain.id, "read", null);

    const rendered = await svc.renderHermesAgentConfig(companyId, agent);

    expect(rendered.adapterConfig).toMatchObject({
      toolsets: "base,terminal",
      mcp_servers: {
        gbrain: {
          enabled: true,
          tools: {
            include: ["query"],
            resources: false,
            prompts: false,
          },
        },
      },
    });
    expect(rendered.metadata).toMatchObject({
      toolAccessRender: {
        version: 1,
        toolsets: ["terminal"],
        mcpServers: {
          gbrain: {
            include: ["query"],
            created: true,
          },
        },
      },
    });
  });

  it("removes previously rendered Hermes grants without deleting manual config", async () => {
    const { companyId, agentId, agent } = await seedCompanyAndAgent();

    const terminal = await svc.createTool(companyId, {
      key: "adapter_toolset.terminal",
      label: "Terminal",
      source: "adapter_toolset",
      adapter: "hermes_local",
      risk: "admin",
      supportedModes: ["off", "admin"],
      render: { hermes: { toolset: "terminal" } },
    });
    const gbrain = await svc.createTool(companyId, {
      key: "mcp.gbrain.query",
      label: "GBrain query",
      source: "mcp_tool",
      adapter: "hermes_local",
      serverKey: "gbrain",
      toolName: "query",
      risk: "read",
      supportedModes: ["off", "read"],
      render: { hermes: { mcpServer: "gbrain", includeTool: "query" } },
    });

    await svc.setGrant(companyId, agentId, terminal.id, "admin", null);
    await svc.setGrant(companyId, agentId, gbrain.id, "read", null);
    const renderedWithGrants = await svc.renderHermesAgentConfig(companyId, {
      ...agent,
      adapterConfig: {
        toolsets: "base,manual",
        mcp_servers: {
          gbrain: {
            enabled: true,
            tools: {
              include: ["manual_tool"],
              resources: true,
              prompts: true,
            },
          },
        },
      },
      metadata: { runtimeIdentity: { profileSlug: "gbrain-researcher" } },
    });

    expect(renderedWithGrants.adapterConfig).toMatchObject({
      toolsets: "base,manual,terminal",
      mcp_servers: {
        gbrain: {
          enabled: true,
          tools: {
            include: ["manual_tool", "query"],
            resources: true,
            prompts: true,
          },
        },
      },
    });

    await svc.setGrant(companyId, agentId, terminal.id, "off", null);
    await svc.setGrant(companyId, agentId, gbrain.id, "off", null);
    const renderedAfterRevocation = await svc.renderHermesAgentConfig(companyId, {
      ...agent,
      adapterConfig: renderedWithGrants.adapterConfig,
      metadata: renderedWithGrants.metadata,
    });

    expect(renderedAfterRevocation.adapterConfig).toMatchObject({
      toolsets: "base,manual",
      mcp_servers: {
        gbrain: {
          enabled: true,
          tools: {
            include: ["manual_tool"],
            resources: true,
            prompts: true,
          },
        },
      },
    });
    expect(renderedAfterRevocation.metadata).toEqual({
      runtimeIdentity: { profileSlug: "gbrain-researcher" },
    });
  });
});
