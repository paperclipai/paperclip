import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import express from "express";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  activityLog,
  companies,
  companyMemberships,
  connectionGrants,
  createDb,
  heartbeatRuns,
  toolAccessAuditEvents,
  toolApplications,
  toolCatalogEntries,
  toolCallEvents,
  toolConnectionInstalls,
  toolConnections,
  toolGatewayRateLimitCounters,
  toolGatewaySessions,
  toolInvocations,
  toolMcpGateways,
  toolMcpGatewayTokens,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildPaperclipRuntimeMcpServers, createManagedMcpRunConfig } from "../services/heartbeat.js";
import { mcpGatewayProtocolRoutes } from "../routes/tool-gateway.js";
import { toolAccessService } from "../services/tool-access.js";
import { createToolGatewayService } from "../services/tool-gateway.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("heartbeat runtime MCP servers", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const originalApiUrl = process.env.PAPERCLIP_API_URL;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-runtime-mcp-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    if (originalApiUrl === undefined) delete process.env.PAPERCLIP_API_URL;
    else process.env.PAPERCLIP_API_URL = originalApiUrl;
    await db.delete(toolCallEvents);
    await db.delete(toolGatewaySessions);
    await db.delete(toolGatewayRateLimitCounters);
    await db.delete(toolInvocations);
    await db.delete(toolMcpGatewayTokens);
    await db.delete(activityLog);
    await db.delete(toolAccessAuditEvents);
    await db.delete(heartbeatRuns);
    await db.delete(toolMcpGateways);
    await db.delete(connectionGrants);
    await db.delete(toolConnectionInstalls);
    await db.delete(toolProfileBindings);
    await db.delete(toolProfileEntries);
    await db.delete(toolProfiles);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedSelectedTools(url: string, selection: "exact" | "exclusion" = "exact") {
    process.env.PAPERCLIP_API_URL = "https://paperclip.example.test";
    const [company] = await db.insert(companies).values({
      name: `Runtime tool selection ${randomUUID()}`,
      issuePrefix: `RT${randomUUID().slice(0, 5).toUpperCase()}`,
    }).returning();
    const [agent] = await db.insert(agents).values({
      companyId: company!.id, name: "Selected tools agent", role: "engineer",
      adapterType: "process", adapterConfig: {},
    }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: company!.id, agentId: agent!.id, status: "running", contextSnapshot: {},
    }).returning();
    const [application] = await db.insert(toolApplications).values({
      companyId: company!.id, applicationKey: `selection-${randomUUID().slice(0, 8)}`,
      name: "Selection fixture", type: "mcp_http", status: "active",
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: company!.id, applicationId: application!.id, name: "Three fixture tools",
      uid: `test/${randomUUID()}`, transport: "mcp_remote", status: "active", enabled: true,
      healthStatus: "ok", config: { url }, transportConfig: { url },
      credentialRefs: [], credentialSecretRefs: [],
    }).returning();
    await db.insert(connectionGrants).values({
      companyId: company!.id, connectionId: connection!.id, kind: "organization",
      status: "active", isDefault: true, credentialSecretRefs: [],
    });
    await db.insert(toolConnectionInstalls).values({
      companyId: company!.id, connectionId: connection!.id, targetType: "agent", targetId: agent!.id,
    });
    const catalog = await db.insert(toolCatalogEntries).values(
      ["read_alpha", "read_beta", "read_gamma"].map((name) => ({
        companyId: company!.id, applicationId: application!.id, connectionId: connection!.id,
        entryKind: "tool" as const, name, toolName: name,
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true }, riskLevel: "read" as const,
        isReadOnly: true, isWrite: false, isDestructive: false,
        status: "active" as const, versionHash: randomUUID(),
      })),
    ).returning();
    const [profile] = await db.insert(toolProfiles).values({
      companyId: company!.id, profileKey: `selected:${agent!.id}`,
      name: "Only alpha and beta", status: "active", defaultAction: "deny",
    }).returning();
    const entryBase = {
      companyId: company!.id, profileId: profile!.id,
      applicationId: application!.id, connectionId: connection!.id, conditions: {},
    };
    await db.insert(toolProfileEntries).values(selection === "exact"
      ? catalog.slice(0, 2).map((tool) => ({
        ...entryBase, selectorType: "catalog_entry" as const, effect: "include" as const, catalogEntryId: tool.id,
      }))
      : [
        { ...entryBase, selectorType: "connection" as const, effect: "include" as const },
        { ...entryBase, selectorType: "catalog_entry" as const, effect: "exclude" as const, catalogEntryId: catalog[2]!.id },
      ]);
    await db.insert(toolProfileBindings).values({
      companyId: company!.id, profileId: profile!.id, targetType: "agent", targetId: agent!.id,
    });
    return { company: company!, agent: agent!, run: run!, connection: connection!, profile: profile!, catalog };
  }

  it.each(["fresh exact selection", "legacy broad cache", "connection include with exclusion"])(
    "enforces selected tools through the issued runtime gateway: %s",
    async (scenario) => {
      const providerCalls: string[] = [];
      const server = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (body.method === "notifications/initialized") {
          res.writeHead(202).end();
          return;
        }
        if (body.method === "tools/call") providerCalls.push(body.params.name);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          jsonrpc: "2.0", id: body.id,
          result: body.method === "initialize"
            ? { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "selection-fixture", version: "1" } }
            : { content: [{ type: "text", text: `fixture:${body.params.name}` }] },
        }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Expected loopback fixture address");
        const fixture = await seedSelectedTools(
          `http://127.0.0.1:${address.port}/mcp`,
          scenario === "connection include with exclusion" ? "exclusion" : "exact",
        );
        const { company, agent, run, connection, profile, catalog } = fixture;
        const sourceEntries = await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, profile.id));
        const effective = await toolAccessService(db).getEffectiveProfilesForAgent(company.id, agent.id);
        expect(effective.allowedTools.map((tool) => tool.id).sort()).toEqual(catalog.slice(0, 2).map((tool) => tool.id).sort());
        const gatewayService = createToolGatewayService(db, {
          deploymentMode: "local_trusted", deploymentExposure: "private",
          toolActionSigningSecret: "runtime-selection-fixture",
        });
        const summary = await gatewayService.summarizeConnectionAccessForAgent({ companyId: company.id, connectionId: connection.id, agentId: agent.id });
        const selected = summary.tools.filter((tool) => tool.decision === "allowed");
        expect(selected.map((tool) => tool.toolName).sort()).toEqual(["read_alpha", "read_beta"]);
        const excluded = summary.tools.find((tool) => tool.toolName === "read_gamma")!;
        expect(excluded.decision).toBe("off");

        if (scenario === "legacy broad cache") {
          // Reproduce the v1 cache's actual key, names and gateway binding before any new build.
          const digest = createHash("sha256").update(JSON.stringify({
            version: 1, agentId: agent.id, connections: [connection.id],
            tools: catalog.slice(0, 2).map((tool) => tool.id).sort(),
          })).digest("hex");
          const [legacyProfile] = await db.insert(toolProfiles).values({
            companyId: company.id, profileKey: `native:${agent.id}:${digest}`,
            name: `Native ${agent.id.slice(0, 8)} ${digest.slice(0, 12)}`,
            defaultAction: "deny", metadata: { source: "paperclip_runner", agentId: agent.id, assignmentDigest: digest },
          }).returning();
          await db.insert(toolProfileEntries).values({
            companyId: company.id, profileId: legacyProfile!.id, selectorType: "connection", effect: "include",
            applicationId: connection.applicationId, connectionId: connection.id,
          });
          await gatewayService.createNamedGateway({
            companyId: company.id,
            body: {
              name: `Native ${agent.name} ${digest.slice(0, 8)}`,
              profileId: legacyProfile!.id, defaultProfileMode: "gateway_only",
              slug: `native-${agent.id.replaceAll("-", "").slice(0, 12)}-${digest.slice(0, 16)}`,
              metadata: { nativeRuntimeAssignmentDigest: digest, agentId: agent.id },
            },
            actor: { agentId: agent.id },
          });
        }
        const first = await buildPaperclipRuntimeMcpServers({ db, agent, runId: run.id });
        expect(first).toHaveLength(1);
        const [runtime] = await buildPaperclipRuntimeMcpServers({ db, agent, runId: run.id });
        expect(runtime).toBeDefined();
        expect(runtime!.url).toBe(first[0]!.url);
        const [realisedGateway] = await db.select().from(toolMcpGateways)
          .where(eq(toolMcpGateways.gatewayPublicId, new URL(runtime!.url).pathname.split("/").at(-1)!));
        const realisedEntries = await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, realisedGateway!.profileId));
        expect.soft(realisedEntries.map((entry) => ({ selectorType: entry.selectorType, effect: entry.effect, catalogEntryId: entry.catalogEntryId }))
          .sort((a, b) => String(a.catalogEntryId).localeCompare(String(b.catalogEntryId))))
          .toEqual(catalog.slice(0, 2).map((tool) => ({ selectorType: "catalog_entry", effect: "include", catalogEntryId: tool.id }))
            .sort((a, b) => a.catalogEntryId.localeCompare(b.catalogEntryId)));

        const app = express();
        app.use(express.json());
        app.use(mcpGatewayProtocolRoutes(gatewayService));
        const rpc = (method: string, params = {}) => request(app)
          .post(new URL(runtime!.url).pathname).set("authorization", `Bearer ${runtime!.token}`)
          .send({ jsonrpc: "2.0", id: randomUUID(), method, params });
        const listed = await rpc("tools/list");
        expect(listed.status).toBe(200);
        expect.soft(listed.body.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([
          ...selected.map((tool) => tool.gatewayToolName), "paperclip_list_resources", "paperclip_read_resource",
          "paperclip_list_prompts", "paperclip_get_prompt",
        ].sort());
        for (const tool of selected) {
          const called = await rpc("tools/call", { name: tool.gatewayToolName, arguments: {} });
          expect.soft(called.status).toBe(200);
          expect.soft(called.body.result).toMatchObject({ content: [{ type: "text", text: `fixture:${tool.toolName}` }], isError: false });
        }
        const denied = await rpc("tools/call", { name: excluded.gatewayToolName, arguments: {} });
        expect.soft(denied.status).toBe(403);
        expect.soft(denied.body.error?.data.reasonCode).toBe("deny_default");
        expect.soft(providerCalls.sort()).toEqual(["read_alpha", "read_beta"]);
        const contextDenied = await rpc("tools/call", { name: "paperclip_list_resources", arguments: {} });
        expect(contextDenied.status).toBe(403);
        expect(contextDenied.body.error.data.reasonCode).toBe("gateway_token_action_denied");
        expect(await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, profile.id))).toEqual(sourceEntries);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    },
  );

  it.each(["include", "exclude"] as const)("omits optional runtime delivery before creating access when a source %s has conditions", async (effect) => {
    const { agent, run, profile } = await seedSelectedTools("http://127.0.0.1:9/mcp", effect === "exclude" ? "exclusion" : "exact");
    await db.update(toolProfileEntries).set({ conditions: { context: { requireProject: true } } })
      .where(and(eq(toolProfileEntries.profileId, profile.id), eq(toolProfileEntries.effect, effect)));
    const profilesBefore = await db.select().from(toolProfiles);
    const entriesBefore = await db.select().from(toolProfileEntries);
    expect.soft(await buildPaperclipRuntimeMcpServers({ db, agent, runId: run.id })).toEqual([]);
    expect.soft(await db.select().from(toolProfiles)).toEqual(profilesBefore);
    expect.soft(await db.select().from(toolProfileEntries)).toEqual(entriesBefore);
    expect.soft(await db.select().from(toolMcpGateways)).toEqual([]);
    expect.soft(await db.select().from(toolMcpGatewayTokens)).toEqual([]);
  });

  it("rejects a cached gateway with an extra binding left by supported profile updates before minting another token", async () => {
    const { agent, run, company, connection } = await seedSelectedTools("http://127.0.0.1:9/mcp");
    const [runtime] = await buildPaperclipRuntimeMcpServers({ db, agent, runId: run.id });
    expect(runtime).toBeDefined();
    const [gateway] = await db.select().from(toolMcpGateways)
      .where(eq(toolMcpGateways.gatewayPublicId, new URL(runtime!.url).pathname.split("/").at(-1)!));
    const [broadProfile] = await db.insert(toolProfiles).values({
      companyId: company.id, profileKey: `broad:${agent.id}`, name: "Temporary whole connection",
      status: "active", defaultAction: "deny",
    }).returning();
    await db.insert(toolProfileEntries).values({
      companyId: company.id, profileId: broadProfile!.id, selectorType: "connection", effect: "include",
      applicationId: connection.applicationId, connectionId: connection.id,
    });
    const gatewayService = createToolGatewayService(db);
    await gatewayService.updateNamedGateway({ companyId: company.id, gatewayId: gateway!.id, body: { profileId: broadProfile!.id } });
    await gatewayService.updateNamedGateway({ companyId: company.id, gatewayId: gateway!.id, body: { profileId: gateway!.profileId } });
    const bindings = await db.select().from(toolProfileBindings)
      .where(and(eq(toolProfileBindings.targetType, "gateway"), eq(toolProfileBindings.targetId, gateway!.id)));
    expect(bindings.map((binding) => binding.profileId).sort()).toEqual([gateway!.profileId, broadProfile!.id].sort());
    const tokensBefore = await db.select().from(toolMcpGatewayTokens);
    await expect(buildPaperclipRuntimeMcpServers({ db, agent, runId: run.id })).rejects.toThrow(/cached runtime MCP gateway/);
    expect(await db.select().from(toolMcpGatewayTokens)).toEqual(tokensBefore);
  });

  it("provisions one aggregate gateway and omits unavailable access without blocking any runtime", async () => {
    process.env.PAPERCLIP_API_URL = "https://paperclip.example.test";
    const [company] = await db.insert(companies).values({
      name: `Runtime MCP ${randomUUID()}`,
      issuePrefix: `RM${randomUUID().slice(0, 5).toUpperCase()}`,
    }).returning();
    const [agent] = await db.insert(agents).values({
      companyId: company!.id,
      name: "Runtime MCP Agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
    }).returning();
    const [application] = await db.insert(toolApplications).values({
      companyId: company!.id,
      applicationKey: `runtime-${randomUUID().slice(0, 8)}`,
      name: "Runtime MCP App",
      type: "mcp_http",
      status: "active",
    }).returning();
    const [installedConnection, uninstalledConnection] = await db.insert(toolConnections).values([
      {
        companyId: company!.id,
        applicationId: application!.id,
        name: "Installed MCP",
        uid: `test/${randomUUID()}`,
        transport: "mcp_remote",
        status: "active",
        enabled: true,
        config: { url: "https://installed.example.test/mcp" },
      },
      {
        companyId: company!.id,
        applicationId: application!.id,
        name: "Uninstalled MCP",
        uid: `test/${randomUUID()}`,
        transport: "mcp_remote",
        status: "active",
        enabled: true,
        config: { url: "https://uninstalled.example.test/mcp" },
      },
    ]).returning();
    const [profile] = await db.insert(toolProfiles).values({
      companyId: company!.id,
      profileKey: `app:${installedConnection!.id}`,
      name: "Installed MCP",
      defaultAction: "deny",
    }).returning();
    await db.insert(toolProfileEntries).values({
      companyId: company!.id,
      profileId: profile!.id,
      selectorType: "connection",
      effect: "include",
      applicationId: application!.id,
      connectionId: installedConnection!.id,
    });
    await db.insert(toolProfileBindings).values({
      companyId: company!.id,
      profileId: profile!.id,
      targetType: "agent",
      targetId: agent!.id,
    });
    await db.insert(toolConnectionInstalls).values({
      companyId: company!.id,
      connectionId: installedConnection!.id,
      targetType: "agent",
      targetId: agent!.id,
    });

    const before = Date.now();
    const first = await buildPaperclipRuntimeMcpServers({ db, agent: agent!, runId: randomUUID() });
    const second = await buildPaperclipRuntimeMcpServers({ db, agent: agent!, runId: randomUUID() });

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      name: "paperclip-assigned",
      connectionId: expect.stringMatching(/^assignment:[a-f0-9]{64}$/),
      url: expect.stringMatching(/^https:\/\/paperclip\.example\.test\/mcp\/gateways\/gw_[a-f0-9]{32}$/),
      token: expect.stringMatching(/^pcgw_/),
    });
    expect(JSON.stringify(first)).not.toContain(uninstalledConnection!.id);
    expect(second).toHaveLength(1);
    expect(second[0]!.connectionId).toBe(first[0]!.connectionId);

    const gateways = await db.select().from(toolMcpGateways);
    expect(gateways).toHaveLength(1);
    expect(gateways[0]!.metadata).toMatchObject({
      nativeRuntimeAssignmentDigest: first[0]!.connectionId.slice("assignment:".length),
      agentId: agent!.id,
    });
    const tokens = await db.select().from(toolMcpGatewayTokens);
    expect(tokens).toHaveLength(2);
    for (const token of tokens) {
      expect(token.subjectType).toBe("heartbeat_run");
      expect(token.subjectId).toMatch(/^[0-9a-f-]{36}$/);
      expect(token.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 59 * 60 * 1000);
      expect(token.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + 61 * 60 * 1000);
    }
    expect(JSON.stringify(tokens)).not.toContain(first[0]!.token);

    await expect(
      buildPaperclipRuntimeMcpServers({
        db,
        agent: agent!,
        runId: randomUUID(),
        expectedAssignmentDigest: "0".repeat(64),
      }),
    ).resolves.toEqual([]);
    expect(await db.select().from(toolMcpGatewayTokens)).toHaveLength(2);

    await db.update(toolConnections)
      .set({ healthStatus: "degraded", healthMessage: "fixture unavailable" })
      .where(eq(toolConnections.id, installedConnection!.id));
    const unavailableReports: Array<Array<{ id: string; name: string }>> = [];
    await expect(
      buildPaperclipRuntimeMcpServers({
        db,
        agent: agent!,
        runId: randomUUID(),
        expectedAssignmentDigest: first[0]!.connectionId.slice("assignment:".length),
        onUnavailableAssignedConnections: (connections) => {
          unavailableReports.push(connections);
        },
      }),
    ).resolves.toEqual([]);
    expect(unavailableReports).toEqual([[
      { id: installedConnection!.id, name: installedConnection!.name },
    ]]);
    expect(await db.select().from(toolMcpGatewayTokens)).toHaveLength(2);
    await expect(
      createManagedMcpRunConfig({
        db,
        agent: agent!,
        runId: randomUUID(),
        config: {},
        projectId: null,
        issueId: null,
      }),
    ).resolves.toBeNull();
  });

  it("exposes only the dedicated GitHub connection when a personal connection is also installed", async () => {
    process.env.PAPERCLIP_API_URL = "https://paperclip.example.test";
    const [company] = await db.insert(companies).values({
      name: `Runtime GitHub identity ${randomUUID()}`,
      issuePrefix: `RG${randomUUID().slice(0, 5).toUpperCase()}`,
    }).returning();
    await db.insert(companyMemberships).values({
      companyId: company!.id,
      principalType: "user",
      principalId: "responsible-user",
      status: "active",
      membershipRole: "member",
    });
    const [agent] = await db.insert(agents).values({
      companyId: company!.id,
      name: "Dedicated GitHub Agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
    }).returning();
    const [application] = await db.insert(toolApplications).values({
      companyId: company!.id,
      applicationKey: `github-${randomUUID().slice(0, 8)}`,
      name: "GitHub",
      type: "mcp_http",
      status: "active",
      metadata: { sourceTemplateKey: "github" },
    }).returning();
    const [personal, dedicated] = await db.insert(toolConnections).values([
      {
        companyId: company!.id,
        applicationId: application!.id,
        name: "Responsible user's GitHub",
        uid: `github/${randomUUID()}`,
        transport: "mcp_remote",
        credentialPolicy: "per_user",
        status: "active",
        enabled: true,
        healthStatus: "ok",
        config: {},
        transportConfig: { sourceTemplateKey: "github" },
      },
      {
        companyId: company!.id,
        applicationId: application!.id,
        name: "Dedicated GitHub",
        uid: `github/${randomUUID()}`,
        transport: "mcp_remote",
        credentialPolicy: "per_agent",
        status: "active",
        enabled: true,
        healthStatus: "ok",
        config: {},
        transportConfig: { sourceTemplateKey: "github" },
      },
    ]).returning();
    await db.insert(connectionGrants).values([
      {
        companyId: company!.id,
        connectionId: personal!.id,
        kind: "user",
        subjectUserId: "responsible-user",
        status: "active",
        isDefault: false,
      },
      {
        companyId: company!.id,
        connectionId: dedicated!.id,
        kind: "agent",
        subjectAgentId: agent!.id,
        status: "active",
        isDefault: false,
      },
    ]);
    await db.insert(toolConnectionInstalls).values([
      {
        companyId: company!.id,
        connectionId: personal!.id,
        targetType: "company",
        targetId: company!.id,
      },
      {
        companyId: company!.id,
        connectionId: dedicated!.id,
        targetType: "agent",
        targetId: agent!.id,
      },
    ]);
    const [profile] = await db.insert(toolProfiles).values({
      companyId: company!.id,
      profileKey: `github-identities:${agent!.id}`,
      name: "GitHub identities",
      defaultAction: "deny",
    }).returning();
    await db.insert(toolProfileEntries).values([personal!, dedicated!].map((connection) => ({
      companyId: company!.id,
      profileId: profile!.id,
      selectorType: "connection" as const,
      effect: "include" as const,
      applicationId: application!.id,
      connectionId: connection.id,
    })));
    await db.insert(toolProfileBindings).values({
      companyId: company!.id,
      profileId: profile!.id,
      targetType: "agent",
      targetId: agent!.id,
    });
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: company!.id,
      agentId: agent!.id,
      status: "running",
      responsibleUserId: "responsible-user",
      contextSnapshot: {},
    }).returning();

    const servers = await buildPaperclipRuntimeMcpServers({ db, agent: agent!, runId: run!.id });

    expect(servers).toHaveLength(1);
    const [runtimeGateway] = await db.select().from(toolMcpGateways);
    expect(runtimeGateway).toBeTruthy();
    const runtimeEntries = await db.select().from(toolProfileEntries)
      .where(eq(toolProfileEntries.profileId, runtimeGateway!.profileId!));
    expect(runtimeEntries.map((entry) => entry.connectionId)).toEqual([dedicated!.id]);
  });

  it("audits permitted remote MCP connections that were not installed when delivery is empty", async () => {
    const [company] = await db.insert(companies).values({
      name: `Runtime MCP diagnostic ${randomUUID()}`,
      issuePrefix: `RD${randomUUID().slice(0, 5).toUpperCase()}`,
    }).returning();
    const [agent] = await db.insert(agents).values({
      companyId: company!.id,
      name: "Runtime MCP Diagnostic Agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
    }).returning();
    const [application] = await db.insert(toolApplications).values({
      companyId: company!.id,
      applicationKey: `runtime-diagnostic-${randomUUID().slice(0, 8)}`,
      name: "Zapier",
      type: "mcp_http",
      status: "active",
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: company!.id,
      applicationId: application!.id,
      name: "Zapier",
      uid: `test/${randomUUID()}`,
      transport: "mcp_remote",
      status: "active",
      enabled: true,
      config: { url: "https://zapier.example.test/mcp" },
    }).returning();
    const [profile] = await db.insert(toolProfiles).values({
      companyId: company!.id,
      profileKey: `app:${connection!.id}`,
      name: "Zapier",
      defaultAction: "deny",
    }).returning();
    await db.insert(toolProfileEntries).values({
      companyId: company!.id,
      profileId: profile!.id,
      selectorType: "connection",
      effect: "include",
      applicationId: application!.id,
      connectionId: connection!.id,
    });
    await db.insert(toolProfileBindings).values({
      companyId: company!.id,
      profileId: profile!.id,
      targetType: "agent",
      targetId: agent!.id,
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: company!.id,
      agentId: agent!.id,
      status: "running",
      contextSnapshot: {},
    });

    const servers = await buildPaperclipRuntimeMcpServers({ db, agent: agent!, runId });

    expect(servers).toEqual([]);
    const [activity] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "tool_gateway.runtime_mcp_delivery"));
    expect(activity).toMatchObject({
      companyId: company!.id,
      agentId: agent!.id,
      runId,
      details: expect.objectContaining({
        reasonCode: "permitted_connections_not_installed",
        deliveredServerCount: 0,
        permittedNotInstalledCount: 1,
        permittedNotInstalledConnections: [{ id: connection!.id, name: "Zapier" }],
      }),
    });
    const [audit] = await db.select().from(toolAccessAuditEvents);
    expect(audit).toMatchObject({
      companyId: company!.id,
      actorType: "agent",
      actorId: agent!.id,
      reasonCode: "permitted_connections_not_installed",
      details: expect.objectContaining({ runId, deliveredServerCount: 0 }),
    });
  });

  it("injects only managed gateways whose profile connections are installed for the agent", async () => {
    const [company] = await db.insert(companies).values({
      name: `Managed gateway installs ${randomUUID()}`,
      issuePrefix: `MG${randomUUID().slice(0, 5).toUpperCase()}`,
    }).returning();
    const [agent] = await db.insert(agents).values({
      companyId: company!.id,
      name: "Managed Gateway Agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
    }).returning();
    const [application] = await db.insert(toolApplications).values({
      companyId: company!.id,
      applicationKey: `managed-gateway-${randomUUID().slice(0, 8)}`,
      name: "Managed Gateway App",
      type: "mcp_http",
      status: "active",
    }).returning();
    const connections = await db.insert(toolConnections).values([
      {
        companyId: company!.id,
        applicationId: application!.id,
        name: "Installed gateway connection",
        uid: `test/${randomUUID()}`,
        transport: "mcp_remote",
        status: "active",
        enabled: true,
      },
      {
        companyId: company!.id,
        applicationId: application!.id,
        name: "Uninstalled gateway connection",
        uid: `test/${randomUUID()}`,
        transport: "mcp_remote",
        status: "active",
        enabled: true,
      },
    ]).returning();
    const profiles = await db.insert(toolProfiles).values(connections.map((connection) => ({
      companyId: company!.id,
      profileKey: `gateway:${connection.id}`,
      name: connection.name,
      defaultAction: "deny" as const,
    }))).returning();
    await db.insert(toolProfileEntries).values(profiles.map((profile, index) => ({
      companyId: company!.id,
      profileId: profile.id,
      selectorType: "connection" as const,
      effect: "include" as const,
      connectionId: connections[index]!.id,
    })));
    const gateways = await db.insert(toolMcpGateways).values(profiles.map((profile, index) => ({
      companyId: company!.id,
      name: `${connections[index]!.name} gateway`,
      slug: `gateway-${index}-${randomUUID().slice(0, 8)}`,
      profileId: profile.id,
      status: "active" as const,
    }))).returning();
    await db.insert(toolConnectionInstalls).values({
      companyId: company!.id,
      connectionId: connections[0]!.id,
      targetType: "agent",
      targetId: agent!.id,
    });

    const config = await createManagedMcpRunConfig({
      db,
      agent: agent!,
      runId: randomUUID(),
      config: {},
      projectId: null,
      issueId: null,
    });

    expect(config?.gateways).toHaveLength(1);
    expect(config?.gateways[0]).toMatchObject({
      id: gateways[0]!.id,
      name: gateways[0]!.name,
      endpointPath: `/mcp/gateways/${gateways[0]!.gatewayPublicId}`,
    });
    expect(config?.gateways.some((gateway) => gateway.id === gateways[1]!.id)).toBe(false);
  });
});
