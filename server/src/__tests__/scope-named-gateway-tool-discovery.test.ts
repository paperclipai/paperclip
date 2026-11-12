import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  principalPermissionGrants,
  toolApplications,
  toolCatalogEntries,
  toolConnections,
  toolPolicies,
  toolProfileEntries,
  toolProfiles,
} from "@paperclipai/db";
import type { ToolAccessDecisionInput, ToolMcpGatewayDefaultProfileMode } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const evaluatedTools = vi.hoisted(() => [] as string[]);
const listingCaches = vi.hoisted(() => new Set<Map<string, Promise<unknown>>>());
vi.mock("../services/tool-access-policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/tool-access-policy.js")>();
  return {
    ...actual,
    toolAccessPolicyService: (db: Parameters<typeof actual.toolAccessPolicyService>[0]) => {
      const service = actual.toolAccessPolicyService(db);
      return {
        ...service,
        decide: (input: ToolAccessDecisionInput, options?: Parameters<typeof service.decide>[1]) => {
          evaluatedTools.push(input.request.upstreamToolName ?? input.request.toolName);
          if (options?.cache) listingCaches.add(options.cache);
          return service.decide(input, options);
        },
      };
    },
  };
});

import { toolAccessPolicyService } from "../services/tool-access-policy.js";
import { toolAccessService } from "../services/tool-access.js";
import { createToolGatewayService } from "../services/tool-gateway.js";

const postgresSupport = await getEmbeddedPostgresTestSupport();
const describePostgres = postgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

async function createRemoteMcpConnection(db: Db, companyId: string, key: string, toolNames: string[]) {
  const [application] = await db.insert(toolApplications).values({
    companyId,
    applicationKey: key,
    name: `App ${key}`,
    type: "mcp_http",
    status: "active",
  }).returning();
  const [connection] = await db.insert(toolConnections).values({
    companyId,
    applicationId: application!.id,
    name: `Connection ${key}`,
    uid: `test/${randomUUID()}`,
    transport: "mcp_remote",
    status: "active",
    enabled: true,
    healthStatus: "ok",
    config: { url: `https://${key}.example.test/mcp` },
    transportConfig: { url: `https://${key}.example.test/mcp` },
  }).returning();
  const catalogEntries = await db.insert(toolCatalogEntries).values(toolNames.map((toolName) => ({
    companyId,
    applicationId: application!.id,
    connectionId: connection!.id,
    entryKind: "tool" as const,
    name: toolName,
    toolName,
    title: toolName,
    description: `Description for ${toolName}`,
    inputSchema: { type: "object", properties: {} },
    riskLevel: "read" as const,
    isReadOnly: true,
    status: "active" as const,
    versionHash: randomUUID(),
  }))).returning();
  return { connection: connection!, catalogEntries };
}

describePostgres("named gateway tool discovery scope", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-gateway-discovery-scope-");
    db = createDb(database.connectionString);
  }, 20_000);

  beforeEach(() => {
    evaluatedTools.length = 0;
    listingCaches.clear();
  });

  afterAll(async () => {
    await database?.cleanup();
  });

  async function seedGateway(defaultProfileMode: ToolMcpGatewayDefaultProfileMode = "gateway_only") {
    const [company] = await db.insert(companies).values({
      name: `Gateway ${randomUUID()}`,
      issuePrefix: `G${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    }).returning();
    const companyId = company!.id;
    const alpha = await createRemoteMcpConnection(db, companyId, `alpha${randomUUID().slice(0, 8)}`, ["alpha_read", "alpha_write"]);
    const beta = await createRemoteMcpConnection(db, companyId, `beta${randomUUID().slice(0, 8)}`, ["beta_read", "beta_write"]);
    await createRemoteMcpConnection(db, companyId, `gamma${randomUUID().slice(0, 8)}`, ["gamma_read", "gamma_write"]);
    const profile = await toolAccessService(db).createProfile(companyId, {
      profileKey: `alpha-only-${randomUUID()}`,
      name: "Alpha only",
      status: "active",
      defaultAction: "deny",
      entries: [{ selectorType: "connection", effect: "include", connectionId: alpha.connection.id }],
    });
    const gatewayService = createToolGatewayService(db, { toolActionSigningSecret: "test-tool-action-signing-secret" });
    const gateway = await gatewayService.createNamedGateway({
      companyId,
      body: { name: "Alpha gateway", profileId: profile.id, defaultProfileMode },
    });
    const token = await gatewayService.createNamedGatewayToken({
      companyId,
      gatewayId: gateway.id,
      body: { name: "Discovery", clientLabel: "Discovery client", ownerNote: "Discovery scope test token.", allowedActions: ["tools/list"] },
    });
    const listTools = async () => (await gatewayService.listToolsForNamedGateway({
      gatewayId: gateway.id,
      bearerToken: token.token,
    })).map((tool) => tool.upstreamToolName ?? tool.name);
    const scope = (actor: ToolAccessDecisionInput["actor"] = { actorType: "system", actorId: gateway.id, agentId: null }) =>
      toolAccessPolicyService(db).namedGatewayDiscoveryScope({ companyId, gatewayId: gateway.id, actor });
    return { companyId, alpha, beta, profileId: profile.id, listTools, scope };
  }

  it("evaluates only the tools a gateway_only profile includes when nothing else can allow a tool", async () => {
    const { listTools } = await seedGateway();

    const tools = await listTools();

    expect(tools).toEqual(expect.arrayContaining(["alpha_read", "alpha_write"]));
    expect(tools.some((name) => /^(beta|gamma)_/.test(name))).toBe(false);
    expect(evaluatedTools.filter((name) => /^(beta|gamma)_/.test(name))).toEqual([]);
  });

  it("reads only the included catalog entries into the listing cache", async () => {
    const { companyId, alpha, listTools } = await seedGateway();

    await listTools();

    const caches = [...listingCaches];
    expect(caches).toHaveLength(1);
    const entries = await caches[0]!.get(`active-catalog-tools:${companyId}`) as Map<string, unknown>;
    expect([...entries.keys()].sort()).toEqual(alpha.catalogEntries.map((entry) => entry.id).sort());
  });

  it("lists a collision-suffixed tool under the name a call resolves", async () => {
    const [company] = await db.insert(companies).values({
      name: `Gateway ${randomUUID()}`,
      issuePrefix: `G${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    }).returning();
    const companyId = company!.id;
    const files = await createRemoteMcpConnection(db, companyId, `files${randomUUID().slice(0, 8)}`, ["read-file", "read_file"]);
    const readFile = files.catalogEntries.find((entry) => entry.toolName === "read-file")!;
    const profile = await toolAccessService(db).createProfile(companyId, {
      profileKey: `read-file-${randomUUID()}`,
      name: "Read file only",
      status: "active",
      defaultAction: "deny",
      entries: [{ selectorType: "catalog_entry", effect: "include", catalogEntryId: readFile.id }],
    });
    const gatewayService = createToolGatewayService(db, { toolActionSigningSecret: "test-tool-action-signing-secret" });
    const gateway = await gatewayService.createNamedGateway({
      companyId,
      body: { name: "Files gateway", profileId: profile.id, defaultProfileMode: "gateway_only" },
    });
    const token = await gatewayService.createNamedGatewayToken({
      companyId,
      gatewayId: gateway.id,
      body: { name: "Files", clientLabel: "Files client", ownerNote: "Collision name test token.", allowedActions: ["tools/list", "tools/call"] },
    });

    const listed = (await gatewayService.listToolsForNamedGateway({ gatewayId: gateway.id, bearerToken: token.token }))
      .filter((tool) => tool.connectionId === files.connection.id);
    expect(listed.map((tool) => tool.upstreamToolName)).toEqual(["read-file"]);

    const call = gatewayService.executeTool({ sessionToken: token.token, gatewayId: gateway.id, tool: listed[0]!.name, parameters: {} });
    await expect(call).rejects.toThrow("Organization authorization is required");
  });

  it("evaluates only the tools of an application the profile includes", async () => {
    const { companyId, beta, profileId, listTools } = await seedGateway();
    await db.insert(toolProfileEntries).values({
      companyId,
      profileId,
      selectorType: "application",
      effect: "include",
      applicationId: beta.connection.applicationId,
    });

    const tools = await listTools();

    expect(tools).toEqual(expect.arrayContaining(["alpha_read", "alpha_write", "beta_read", "beta_write"]));
    expect(tools.some((name) => name.startsWith("gamma_"))).toBe(false);
    expect(evaluatedTools.filter((name) => name.startsWith("gamma_"))).toEqual([]);
  });

  it("still lists a tool that an allow policy permits outside the gateway profile", async () => {
    const { companyId, beta, listTools } = await seedGateway();
    const betaRead = beta.catalogEntries.find((entry) => entry.toolName === "beta_read")!;
    await toolAccessPolicyService(db).createPolicy(companyId, {
      name: "Allow beta_read",
      policyType: "allow",
      priority: 10,
      enabled: true,
      selectors: { catalogEntryId: betaRead.id },
    });

    const tools = await listTools();

    expect(tools).toEqual(expect.arrayContaining(["alpha_read", "alpha_write", "beta_read"]));
    expect(tools).not.toContain("beta_write");
  });

  it("evaluates every company tool for a gateway that adds context profiles", async () => {
    const { listTools, scope } = await seedGateway("gateway_then_context");

    await listTools();

    expect(evaluatedTools).toEqual(expect.arrayContaining(["beta_read", "beta_write", "gamma_read", "gamma_write"]));
    expect(await scope()).toBeNull();
  });

  describe("falls back to every company tool when something else can allow a tool", () => {
    it("scopes to the included connection when nothing else can", async () => {
      const { alpha, scope } = await seedGateway();
      expect(await scope()).toEqual({ applicationIds: [], connectionIds: [alpha.connection.id], catalogEntryIds: [] });
    });

    it("for an allow-by-default gateway profile", async () => {
      const { profileId, scope } = await seedGateway();
      await db.update(toolProfiles).set({ defaultAction: "allow" }).where(eq(toolProfiles.id, profileId));
      expect(await scope()).toBeNull();
    });

    it.each(["allow", "trust_rule", "require_approval"] as const)("for an enabled %s policy", async (policyType) => {
      const { companyId, scope } = await seedGateway();
      await db.insert(toolPolicies).values({ companyId, name: `${policyType} policy`, policyType, enabled: true, selectors: {} });
      expect(await scope()).toBeNull();
    });

    it("but not for the approval policy of the app wizard", async () => {
      const { companyId, scope } = await seedGateway();
      await db.insert(toolPolicies).values({
        companyId,
        name: "App wizard approval",
        policyType: "require_approval",
        enabled: true,
        selectors: {},
        config: { source: "app_gallery_finish" },
      });
      expect(await scope()).not.toBeNull();
    });

    it("for an actor with a tools:use grant", async () => {
      const { companyId, scope } = await seedGateway();
      const [agent] = await db.insert(agents).values({
        companyId,
        name: "Granted agent",
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
      }).returning();
      const actor = { actorType: "agent" as const, actorId: agent!.id, agentId: agent!.id };
      expect(await scope(actor)).not.toBeNull();
      await db.insert(principalPermissionGrants).values({
        companyId,
        principalType: "agent",
        principalId: agent!.id,
        permissionKey: "tools:use",
      });
      expect(await scope(actor)).toBeNull();
    });

    it("for an include entry that selects by tool name", async () => {
      const { companyId, profileId, scope } = await seedGateway();
      await db.insert(toolProfileEntries).values({
        companyId,
        profileId,
        selectorType: "tool_name",
        effect: "include",
        toolName: "gamma_read",
      });
      expect(await scope()).toBeNull();
    });
  });
});
