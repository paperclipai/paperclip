import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, agents, authUsers, companies, companyMemberships, companySecretBindings, companySecretVersions, companySecrets, connectionGrants, connectionTokenIssuances, createDb, heartbeatRuns, secretAccessEvents, toolAccessAuditEvents, toolApplications, toolCatalogEntries, toolConnectionInstalls, toolConnections, toolMcpGatewayTokens, toolMcpGateways, toolOauthStates, toolProfileBindings, toolProfileEntries, toolProfiles, toolRuntimeSlots, principalPermissionGrants } from "@paperclipai/db";
import { __resetDefaultMcpTemplateScopeForTests, captureDefaultMcpTemplateScope } from "../secrets/default-mcp-template-scope.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";
import {
  ARCANA_BRAIN_REVIEWED_TOOLS,
  ARCANA_STATIC_TEMPLATE_UID,
  DEFAULT_MCP_METADATA_KEY,
  DEFAULT_MCP_SPEC,
  DEFAULT_MCP_STATIC_CATALOG_CONFIG_KEY,
  readDefaultMcpState,
  staticCatalogAllowlist,
  stripDefaultMcpProtectedConfigKeys,
} from "../services/default-mcp-spec.js";
import { runDefaultMcpSetupForAgent, waitForScheduledDefaultMcpSetups } from "../services/default-mcp-setup.js";
import { ARCANA_MCP_URL_ENV, ARCANA_PROVISION_KEY_ENV, ARCANA_URL_ENV } from "../services/arcana-provisioner-client.js";
import { AGENT_MEMORY_ENABLED_ENV, AGENT_MEMORY_TOOLS_ENABLED_ENV, AGENT_MEMORY_URL_ENV } from "../services/default-mcp-agent-memory.js";
import { secretService } from "../services/secrets.js";
import { ensureStaticCompanyTemplates, repairStaticCatalogConnections } from "../services/default-mcp-static-template.js";
import { sweepCompanyTemplates } from "../services/default-mcp-template.js";
import { toolAccessService } from "../services/tool-access.js";
import { createToolGatewayService } from "../services/tool-gateway.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const FEATURE_ENV = "PAPERCLIP_DEFAULT_MCP_SPEC_ENABLED";
const ARCANA_URL = "https://arcana.example.test";
const MCP_URL = "https://arcana-mcp.example.test/mcp";
const PROVISION_KEY = "synthetic-provision-key-0123456789abcdef";
const ARCANA_ENTRY = DEFAULT_MCP_SPEC.find((entry) => entry.key === "arcana-brain")!;
const MARKER = DEFAULT_MCP_STATIC_CATALOG_CONFIG_KEY;
const MEMORY_ENTRY = DEFAULT_MCP_SPEC.find((entry) => entry.key === "agent-memory-tools")!;
const MEMORY_URL = "https://memory.example.test";
const MEMORY_MCP_URL = `${MEMORY_URL}/mcp`;

/** Real-shaped descriptors: the live server's text and schemas never match the seeded placeholders. */
const realDescriptor = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  description: `Live description of ${name} (differs from the seeded placeholder)`,
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  annotations: { readOnlyHint: true },
  ...extra,
});

/** A minimal MCP streamable-HTTP server at MCP_URL serving initialize / tools/list / tools/call. */
function mcpFetch(descriptors: () => Array<Record<string, unknown>>, serverUrl: string = MCP_URL) {
  return vi.fn(async (url: string, init: RequestInit) => {
    if (url !== serverUrl) throw new Error(`unexpected request ${url}`);
    if (init.method === "DELETE") return new Response(null, { status: 200 });
    const body = JSON.parse(String(init.body)) as { id?: number; method: string };
    if (body.method === "initialize") {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "arcana", version: "1" } } }),
        { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "session-arcana-test" } },
      );
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/list") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: descriptors() } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (body.method === "tools/call") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "{}" }] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected MCP method ${body.method}`);
  });
}

describeEmbeddedPostgres("static-catalog connections survive a live catalog refresh (TECH-7253)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-static-refresh-${randomUUID()}`);
  const env: NodeJS.ProcessEnv = { [FEATURE_ENV]: "true", [ARCANA_URL_ENV]: ARCANA_URL, [ARCANA_PROVISION_KEY_ENV]: PROVISION_KEY, [ARCANA_MCP_URL_ENV]: MCP_URL };
  const ctx = () => ({ db, env, spec: [ARCANA_ENTRY], scope: { mode: "all" } as const });
  const later = () => new Date(Date.now() + 2 * 3_600_000);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("static-catalog-refresh");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  beforeEach(() => {
    __resetDefaultMcpTemplateScopeForTests();
    captureDefaultMcpTemplateScope({});
  });

  afterEach(async () => {
    await waitForScheduledDefaultMcpSetups();
    vi.restoreAllMocks();
    await db.delete(secretAccessEvents);
    await db.delete(activityLog);
    await db.delete(toolAccessAuditEvents);
    await db.delete(connectionTokenIssuances);
    await db.delete(toolMcpGatewayTokens);
    await db.delete(toolMcpGateways);
    await db.delete(toolProfileBindings);
    await db.delete(toolProfileEntries);
    await db.delete(toolProfiles);
    await db.delete(toolCatalogEntries);
    await db.delete(toolOauthStates);
    await db.delete(connectionGrants);
    await db.delete(toolConnectionInstalls);
    await db.delete(companySecretBindings);
    await db.delete(toolRuntimeSlots);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(heartbeatRuns);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(authUsers);
    await db.delete(principalPermissionGrants);
    await db.execute(sql`truncate table ${companies} restart identity cascade`);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company-${companyId.slice(0, 8)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      status: "active",
    });
    return companyId;
  }

  /** Company + static template + ONE new default-ON agent taken all the way to `ready`. */
  async function readyAgent() {
    const companyId = await seedCompany();
    await ensureStaticCompanyTemplates(ctx(), { companyId });
    const owner = `user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({ id: owner, name: "Owner", email: "owner@redesignhealth.com", emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: owner, status: "active", membershipRole: "owner" });
    process.env[FEATURE_ENV] = "true";
    let created: Awaited<ReturnType<ReturnType<typeof agentService>["create"]>>;
    try {
      created = await agentService(db).create(
        companyId,
        { name: "Agent", role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, spentMonthlyCents: 0, lastHeartbeatAt: null },
        { claudeLogin: { storedSessionId: null, ownerUserId: owner } },
      );
      await waitForScheduledDefaultMcpSetups();
    } finally {
      delete process.env[FEATURE_ENV];
    }
    const provision = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { agent_principal_id: string };
      return new Response(JSON.stringify({ brain_id: `agent:${body.agent_principal_id}`, status: "active" }), { status: 201 });
    }) as unknown as typeof fetch;
    await runDefaultMcpSetupForAgent({ db, env, fetchImpl: provision, spec: [ARCANA_ENTRY], now: later }, { companyId, agentId: created.id });
    const [row] = await db.select().from(agents).where(eq(agents.id, created.id));
    expect(readDefaultMcpState(row!.metadata)!.entries["arcana-brain"]!.setup.state).toBe("ready");
    const connections = await db.select().from(toolConnections).where(eq(toolConnections.companyId, companyId));
    const dedicated = connections.find((c) => c.name === `rh-arcana-brain:${created.id}`)!;
    const template = connections.find((c) => c.uid === ARCANA_STATIC_TEMPLATE_UID)!;
    return { companyId, owner, agentId: created.id, dedicated, template };
  }

  const catalogOf = (connectionId: string) => db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, connectionId));
  const statusMap = async (connectionId: string) => Object.fromEntries((await catalogOf(connectionId)).map((row) => [row.toolName, row.status]));
  const accessFor = (server: ReturnType<typeof mcpFetch>) =>
    toolAccessService(db, {
      remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }],
      remoteHttpRequest: async (url: string, init: RequestInit) => server(url, init),
    } as never);
  const realServer = (extra: Array<Record<string, unknown>> = []) => mcpFetch(() => [...ARCANA_BRAIN_REVIEWED_TOOLS.map((name) => realDescriptor(name)), ...extra]);

  it("the template and a new agent's dedicated clone carry the server-owned marker, and the agent's clone is installed", async () => {
    const { dedicated, template, agentId } = await readyAgent();
    expect((template.config as Record<string, unknown>)[MARKER]).toBe("arcana-brain");
    expect((dedicated.config as Record<string, unknown>)[MARKER]).toBe("arcana-brain");
    expect(staticCatalogAllowlist(dedicated.config)).toEqual(new Set(ARCANA_BRAIN_REVIEWED_TOOLS));
    const installs = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, dedicated.id));
    expect(installs.map((i) => `${i.targetType}:${i.targetId}`)).toEqual([`agent:${agentId}`]);
  });

  it("creation, then a live refresh with real descriptors: the five verbs stay active and the agent's call path resolves recall", async () => {
    const { companyId, owner, agentId, dedicated } = await readyAgent();
    const server = realServer();
    const refresh = await accessFor(server).refreshCatalog(dedicated.id, { actorType: "system", actorId: "test" });
    expect(refresh.quarantinedCount).toBe(0);
    expect(await statusMap(dedicated.id)).toEqual(Object.fromEntries(ARCANA_BRAIN_REVIEWED_TOOLS.map((name) => [name, "active"])));
    // The real descriptor replaced the placeholder.
    const recall = (await catalogOf(dedicated.id)).find((row) => row.toolName === "recall")!;
    expect(recall.description).toContain("Live description of recall");
    expect(recall.quarantineReason).toBeNull();
    expect(recall.isReadOnly).toBe(true);
    // A second refresh (the health-check cadence) changes nothing either.
    await accessFor(server).refreshCatalog(dedicated.id, { actorType: "system", actorId: "test" });
    expect(await statusMap(dedicated.id)).toEqual(Object.fromEntries(ARCANA_BRAIN_REVIEWED_TOOLS.map((name) => [name, "active"])));

    // The same resolution the board's test-calls route performs: tool_not_found was the symptom in DEV.
    const gateway = createToolGatewayService(db, {
      toolActionSigningSecret: "static-catalog-test-signing-secret",
      remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }],
      remoteHttpRequest: async (url: string, init: RequestInit) => server(url, init),
    } as never);
    const outcome = await gateway
      .executeTestCall({ companyId, connectionId: dedicated.id, agentId, userId: owner, toolName: "recall", parameters: { query: "walrus" } })
      .then(() => "ok", (err: { reasonCode?: string }) => err.reasonCode ?? "error");
    expect(outcome).not.toBe("tool_not_found");
    expect(outcome).toBe("ok");
    const missing = await gateway
      .executeTestCall({ companyId, connectionId: dedicated.id, agentId, userId: owner, toolName: "add_source", parameters: {} })
      .then(() => "ok", (err: { reasonCode?: string }) => err.reasonCode ?? "error");
    expect(missing).toBe("tool_not_found");
  });

  it("a refresh that reports extra tools never adds or activates them", async () => {
    const { dedicated } = await readyAgent();
    const server = realServer([realDescriptor("add_source"), realDescriptor("delete_brain", { annotations: { destructiveHint: true } }), realDescriptor("Recall")]);
    const result = await accessFor(server).refreshCatalog(dedicated.id, { actorType: "system", actorId: "test" });
    expect(result.discoveredCount).toBe(ARCANA_BRAIN_REVIEWED_TOOLS.length + 3);
    expect(Object.keys(await statusMap(dedicated.id)).sort()).toEqual([...ARCANA_BRAIN_REVIEWED_TOOLS].sort());
    expect(Object.values(await statusMap(dedicated.id)).every((status) => status === "active")).toBe(true);
  });

  it("fails closed: a reviewed verb whose live descriptor is no longer a plain read is quarantined, the rest stay active", async () => {
    const { dedicated } = await readyAgent();
    const server = mcpFetch(() => ARCANA_BRAIN_REVIEWED_TOOLS.map((name) => realDescriptor(name, name === "recall" ? { annotations: { readOnlyHint: false } } : {})));
    await accessFor(server).refreshCatalog(dedicated.id, { actorType: "system", actorId: "test" });
    const statuses = await statusMap(dedicated.id);
    expect(statuses.recall).toBe("quarantined");
    for (const name of ARCANA_BRAIN_REVIEWED_TOOLS.filter((tool) => tool !== "recall")) expect(statuses[name]).toBe("active");
  });

  it("a refresh never re-enables a verb an operator disabled", async () => {
    const { dedicated } = await readyAgent();
    await db.update(toolCatalogEntries).set({ status: "disabled" }).where(and(eq(toolCatalogEntries.connectionId, dedicated.id), eq(toolCatalogEntries.toolName, "open_source")));
    await accessFor(realServer()).refreshCatalog(dedicated.id, { actorType: "system", actorId: "test" });
    const statuses = await statusMap(dedicated.id);
    expect(statuses.open_source).toBe("disabled");
    expect(statuses.recall).toBe("active");
  });

  describe("agent-memory-tools entry (TECH-8832)", () => {
    const memoryEnv: NodeJS.ProcessEnv = {
      [FEATURE_ENV]: "true",
      [AGENT_MEMORY_ENABLED_ENV]: "true",
      [AGENT_MEMORY_URL_ENV]: MEMORY_URL,
      [AGENT_MEMORY_TOOLS_ENABLED_ENV]: "true",
    };
    const memoryCtx = (extra: Partial<NodeJS.ProcessEnv> = {}) => ({ db, env: { ...memoryEnv, ...extra }, spec: [MEMORY_ENTRY], scope: { mode: "all" } as const });
    const MEMORY_TOOL_NAMES = ["memory_search", "memory_add", "memory_delete"];
    /** The live service's descriptors: memory_delete carries `destructiveHint`, which must not demote a reviewed verb. */
    const memoryDescriptors = () => [
      realDescriptor("memory_search"),
      realDescriptor("memory_add", { annotations: { readOnlyHint: false, destructiveHint: false } }),
      realDescriptor("memory_delete", { annotations: { destructiveHint: true } }),
      realDescriptor("memory_purge_agent", { annotations: { destructiveHint: true } }),
    ];

    /** A Claude agent whose agent-memory entry is ready (its token secret exists), with a pending memory tools entry. */
    async function memoryAgent(adapterType = "claude_local") {
      const companyId = await seedCompany();
      const created = await agentService(db).create(companyId, {
        name: "Agent",
        role: "engineer",
        status: "idle",
        adapterType,
        adapterConfig: {},
        runtimeConfig: {},
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      });
      const secret = await secretService(db).create(
        companyId,
        { name: "Agent memory token", key: `agent_memory.${created.id}`, provider: "local_encrypted", value: "synthetic-memory-token-0123456789", description: "test" },
        { userId: null },
      );
      const nowIso = new Date().toISOString();
      const setup = (state: string) => ({ state, reason: null, attemptCount: 0, nextAttemptAt: null, leaseUntil: null, claimId: null, registerAttemptedAt: null, mintAttemptedAt: null, updatedAt: nowIso });
      const memoryBinding = { boardAgentId: null, baseSub: `agent-memory-${created.id}`, agentKey: null, boardSub: null, secretId: secret.id, secretVersion: "latest", connectionId: null, grantId: null, tokenExpiresAt: null };
      await db
        .update(agents)
        .set({
          metadata: {
            [DEFAULT_MCP_METADATA_KEY]: {
              version: 1,
              entries: {
                "agent-memory": { key: "agent-memory", templateKey: "rh-agent-memory", dedicated: true, enabled: false, templateConnectionId: null, connectionId: null, ownerUserId: null, setup: setup("ready"), binding: memoryBinding },
                "agent-memory-tools": { key: "agent-memory-tools", templateKey: "rh-agent-memory-tools", dedicated: true, enabled: false, installOnReady: true, templateConnectionId: null, connectionId: null, ownerUserId: null, setup: setup("pending"), binding: null },
              },
            },
          },
        })
        .where(eq(agents.id, created.id));
      return { companyId, agentId: created.id, secretId: secret.id };
    }

    const runTools = (companyId: string, agentId: string, extra: Partial<NodeJS.ProcessEnv> = {}) =>
      runDefaultMcpSetupForAgent(
        { db, env: { ...memoryEnv, ...extra }, fetchImpl: vi.fn(async () => { throw new Error("no network expected"); }) as unknown as typeof fetch, spec: [MEMORY_ENTRY], now: later },
        { companyId, agentId },
      );
    const toolsEntry = async (agentId: string) => {
      const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
      return readDefaultMcpState(row!.metadata)!.entries["agent-memory-tools"]!;
    };

    it("the template carries the entry's own uid and marker and seeds the three reviewed verbs with their reviewed risk", async () => {
      const companyId = await seedCompany();
      expect(await ensureStaticCompanyTemplates(memoryCtx(), { companyId })).toEqual([{ kind: "ready", created: true }]);
      const [template] = await db.select().from(toolConnections).where(eq(toolConnections.companyId, companyId));
      expect(template!.uid).toBe(MEMORY_ENTRY.staticTemplate!.uid);
      expect(template!.uid).not.toBe(ARCANA_STATIC_TEMPLATE_UID);
      expect((template!.config as Record<string, unknown>)[MARKER]).toBe("agent-memory-tools");
      expect(template!.config).toMatchObject({ url: MEMORY_MCP_URL });
      const catalog = await catalogOf(template!.id);
      expect(catalog.map((row) => row.toolName).sort()).toEqual([...MEMORY_TOOL_NAMES].sort());
      expect(catalog.every((row) => row.status === "active")).toBe(true);
      expect(Object.fromEntries(catalog.map((row) => [row.toolName, [row.riskLevel, row.isDestructive]]))).toEqual({
        memory_search: ["read", false],
        memory_add: ["write", false],
        memory_delete: ["write", false],
      });
    });

    it("creates no template while the tools flag is off", async () => {
      const companyId = await seedCompany();
      expect(await ensureStaticCompanyTemplates(memoryCtx({ [AGENT_MEMORY_TOOLS_ENABLED_ENV]: "false" }), { companyId })).toEqual([{ kind: "skipped", reason: "no_static_entry" }]);
      expect(await db.select().from(toolConnections).where(eq(toolConnections.companyId, companyId))).toHaveLength(0);
    });

    it("waits until the agent's own agent-memory entry is ready, then binds that same secret to a dedicated connection and installs it", async () => {
      const { companyId, agentId, secretId } = await memoryAgent();
      await ensureStaticCompanyTemplates(memoryCtx(), { companyId });
      await runTools(companyId, agentId);
      const entry = await toolsEntry(agentId);
      expect(entry.setup.state).toBe("ready");
      expect(entry.binding?.secretId).toBe(secretId);
      const connections = await db.select().from(toolConnections).where(eq(toolConnections.companyId, companyId));
      const dedicated = connections.find((c) => c.name === `rh-agent-memory-tools:${agentId}`)!;
      expect(dedicated).toBeDefined();
      expect((dedicated.config as Record<string, unknown>)[MARKER]).toBe("agent-memory-tools");
      expect(dedicated.credentialRefs.filter((ref) => ref.placement === "header").map((ref) => ref.secretId)).toEqual([secretId]);
      const installs = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, dedicated.id));
      expect(installs.map((i) => `${i.targetType}:${i.targetId}`)).toEqual([`agent:${agentId}`]);
      expect(await statusMap(dedicated.id)).toEqual(Object.fromEntries(MEMORY_TOOL_NAMES.map((name) => [name, "active"])));
      // No second secret was minted: the vault still holds only the agent's one memory token.
      const secrets = await db.select().from(companySecrets).where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.key, `agent_memory.${agentId}`)));
      expect(secrets).toHaveLength(1);
    });

    it("waits (provisioner_not_configured) while the tools flag is off, writing no connection", async () => {
      const { companyId, agentId } = await memoryAgent();
      await ensureStaticCompanyTemplates(memoryCtx(), { companyId });
      await runTools(companyId, agentId, { [AGENT_MEMORY_TOOLS_ENABLED_ENV]: "false" });
      expect((await toolsEntry(agentId)).setup).toMatchObject({ state: "pending", reason: "provisioner_not_configured" });
      const connections = await db.select().from(toolConnections).where(eq(toolConnections.companyId, companyId));
      expect(connections.some((c) => c.name === `rh-agent-memory-tools:${agentId}`)).toBe(false);
    });

    it("waits (memory_token_unavailable) while the agent-memory entry is not ready", async () => {
      const { companyId, agentId } = await memoryAgent();
      await ensureStaticCompanyTemplates(memoryCtx(), { companyId });
      const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
      const state = readDefaultMcpState(row!.metadata)!;
      state.entries["agent-memory"]!.setup.state = "pending";
      await db.update(agents).set({ metadata: { [DEFAULT_MCP_METADATA_KEY]: state } }).where(eq(agents.id, agentId));
      await runTools(companyId, agentId);
      expect((await toolsEntry(agentId)).setup).toMatchObject({ state: "pending", reason: "memory_token_unavailable" });
    });

    it("refuses an agent that is not a Claude or Codex harness (Hermes has its own memory tools)", async () => {
      const { companyId, agentId } = await memoryAgent("hermes_local");
      await ensureStaticCompanyTemplates(memoryCtx(), { companyId });
      await runTools(companyId, agentId);
      expect((await toolsEntry(agentId)).setup).toMatchObject({ state: "error", reason: "adapter_unsupported" });
    });

    it("first live refresh keeps the reviewed write tools active (memory_delete's destructive hint does not quarantine it), and never adds the purge tool", async () => {
      const { companyId, agentId } = await memoryAgent();
      await ensureStaticCompanyTemplates(memoryCtx(), { companyId });
      await runTools(companyId, agentId);
      const [dedicated] = await db.select().from(toolConnections).where(and(eq(toolConnections.companyId, companyId), eq(toolConnections.name, `rh-agent-memory-tools:${agentId}`)));
      const server = mcpFetch(memoryDescriptors, MEMORY_MCP_URL);
      const refresh = await accessFor(server).refreshCatalog(dedicated!.id, { actorType: "system", actorId: "test" });
      expect(refresh.quarantinedCount).toBe(0);
      expect(await statusMap(dedicated!.id)).toEqual(Object.fromEntries(MEMORY_TOOL_NAMES.map((name) => [name, "active"])));
      const catalog = await catalogOf(dedicated!.id);
      const byName = Object.fromEntries(catalog.map((row) => [row.toolName, row]));
      expect(byName.memory_search!.description).toContain("Live description of memory_search");
      expect([byName.memory_add!.riskLevel, byName.memory_add!.isDestructive]).toEqual(["write", false]);
      expect([byName.memory_delete!.riskLevel, byName.memory_delete!.isDestructive]).toEqual(["write", false]);
      expect(byName.memory_purge_agent).toBeUndefined();
      // The health-check cadence: a second refresh changes nothing.
      await accessFor(server).refreshCatalog(dedicated!.id, { actorType: "system", actorId: "test" });
      expect(await statusMap(dedicated!.id)).toEqual(Object.fromEntries(MEMORY_TOOL_NAMES.map((name) => [name, "active"])));
    });
  });

  it("an unmarked connection keeps the generic behavior: drift is quarantined (control)", async () => {
    const { dedicated } = await readyAgent();
    const { [MARKER]: _drop, ...withoutMarker } = dedicated.config as Record<string, unknown>;
    await db.update(toolConnections).set({ config: withoutMarker }).where(eq(toolConnections.id, dedicated.id));
    await accessFor(realServer()).refreshCatalog(dedicated.id, { actorType: "system", actorId: "test" });
    expect(Object.values(await statusMap(dedicated.id)).every((status) => status === "quarantined")).toBe(true);
  });

  it("the marker is server-owned: stripped from client payloads and pinned across a client config replacement", async () => {
    const { dedicated } = await readyAgent();
    expect(stripDefaultMcpProtectedConfigKeys({ url: "https://x.test", [MARKER]: "arcana-brain" })).toEqual({ url: "https://x.test" });
    const service = accessFor(realServer());
    await service.updateConnection(dedicated.id, { config: { url: MCP_URL, mcpSessionRequired: true } } as never);
    const [after] = await db.select().from(toolConnections).where(eq(toolConnections.id, dedicated.id));
    expect((after!.config as Record<string, unknown>)[MARKER]).toBe("arcana-brain");
    // A client cannot forge it onto an arbitrary connection either.
    const forged = await service.updateConnection(after!.id, { config: { url: MCP_URL, [MARKER]: "nope" } } as never);
    expect((forged.config as Record<string, unknown>)[MARKER]).toBe("arcana-brain");
    expect(staticCatalogAllowlist({ [MARKER]: "comms-board" })).toBeNull();
    expect(staticCatalogAllowlist({ [MARKER]: "nope" })).toBeNull();
    expect(staticCatalogAllowlist({})).toBeNull();
    expect(staticCatalogAllowlist(null)).toBeNull();
  });

  describe("repair of connections quarantined by the earlier refresh behavior", () => {
    /** The DEV shape: marker absent, every entry quarantined `pending_review`, plus a stray extra and a disabled verb. */
    async function breakIt(connectionId: string, config: unknown) {
      const { [MARKER]: _drop, ...withoutMarker } = config as Record<string, unknown>;
      await db.update(toolConnections).set({ config: withoutMarker }).where(eq(toolConnections.id, connectionId));
      await db
        .update(toolCatalogEntries)
        .set({ status: "quarantined", quarantineReason: "pending_review", quarantinedAt: new Date() })
        .where(eq(toolCatalogEntries.connectionId, connectionId));
    }

    it("re-activates only the reviewed verbs on provably-ours connections, stamps the marker, logs once, and is idempotent", async () => {
      const { companyId, dedicated, template } = await readyAgent();
      await breakIt(dedicated.id, dedicated.config);
      await breakIt(template.id, template.config);
      // An operator-disabled verb and a stray quarantined extra on the agent's connection stay exactly as they are.
      await db.update(toolCatalogEntries).set({ status: "disabled", quarantineReason: null, quarantinedAt: null }).where(and(eq(toolCatalogEntries.connectionId, dedicated.id), eq(toolCatalogEntries.toolName, "recall")));
      await db.insert(toolCatalogEntries).values({ companyId, applicationId: dedicated.applicationId, connectionId: dedicated.id, name: "add_source", toolName: "add_source", versionHash: "x", status: "quarantined", quarantineReason: "pending_review", quarantinedAt: new Date() });
      // A look-alike connection no agent's state names: never touched.
      const impostor = await db
        .insert(toolConnections)
        .values({ companyId, applicationId: dedicated.applicationId, name: "rh-arcana-brain:impostor", uid: `uid-${randomUUID()}`, transport: "mcp_remote", authKind: "api_key", credentialPolicy: "per_agent", status: "active", enabled: true, config: { url: MCP_URL }, transportConfig: { url: MCP_URL } })
        .returning()
        .then((rows) => rows[0]!);
      await db.insert(toolCatalogEntries).values(["recall", "coverage"].map((tool) => ({ companyId, applicationId: impostor.applicationId, connectionId: impostor.id, name: tool, toolName: tool, versionHash: "x", status: "quarantined" as const, quarantineReason: "pending_review", quarantinedAt: new Date() })));

      expect(await repairStaticCatalogConnections(ctx())).toBe(2);

      const dedicatedStatuses = await statusMap(dedicated.id);
      expect(dedicatedStatuses).toMatchObject({ recall: "disabled", search_pages: "active", read_page: "active", coverage: "active", open_source: "active", add_source: "quarantined" });
      expect(await statusMap(template.id)).toEqual(Object.fromEntries(ARCANA_BRAIN_REVIEWED_TOOLS.map((name) => [name, "active"])));
      const [dedicatedAfter] = await db.select().from(toolConnections).where(eq(toolConnections.id, dedicated.id));
      expect((dedicatedAfter!.config as Record<string, unknown>)[MARKER]).toBe("arcana-brain");
      expect(dedicatedAfter!.config).toMatchObject({ quarantineNewEntries: true, mcpSessionRequired: true, url: MCP_URL });
      // Untouched look-alike.
      expect(await statusMap(impostor.id)).toEqual({ recall: "quarantined", coverage: "quarantined" });
      const [impostorAfter] = await db.select().from(toolConnections).where(eq(toolConnections.id, impostor.id));
      expect((impostorAfter!.config as Record<string, unknown>)[MARKER]).toBeUndefined();
      // One activity event per repaired connection.
      const events = await db.select().from(activityLog).where(eq(activityLog.action, "tool_connection.static_catalog_repaired"));
      expect(events.map((event) => event.entityId).sort()).toEqual([dedicated.id, template.id].sort());
      expect(events.find((event) => event.entityId === dedicated.id)!.details).toMatchObject({ key: "arcana-brain", markerStamped: true, reactivatedCount: 4 });
      expect(JSON.stringify(events)).not.toContain(PROVISION_KEY);

      // Idempotent: a second run changes and logs nothing.
      expect(await repairStaticCatalogConnections(ctx())).toBe(0);
      expect(await db.select().from(activityLog).where(eq(activityLog.action, "tool_connection.static_catalog_repaired"))).toHaveLength(2);
    });

    it("after the repair a normal refresh keeps the connection healthy (no re-quarantine)", async () => {
      const { dedicated } = await readyAgent();
      await breakIt(dedicated.id, dedicated.config);
      await repairStaticCatalogConnections(ctx());
      await accessFor(realServer()).refreshCatalog(dedicated.id, { actorType: "system", actorId: "test" });
      expect(Object.values(await statusMap(dedicated.id)).every((status) => status === "active")).toBe(true);
    });

    it("is driven by the periodic template sweep, and skipped when the feature is off or the company is out of scope", async () => {
      const { dedicated } = await readyAgent();
      await breakIt(dedicated.id, dedicated.config);
      const { [FEATURE_ENV]: _off, ...noFeature } = env;
      expect(await repairStaticCatalogConnections({ ...ctx(), env: noFeature })).toBe(0);
      expect(await repairStaticCatalogConnections({ ...ctx(), scope: { mode: "none" } })).toBe(0);
      expect(Object.values(await statusMap(dedicated.id)).every((status) => status === "quarantined")).toBe(true);
      await sweepCompanyTemplates(ctx());
      expect(Object.values(await statusMap(dedicated.id)).every((status) => status === "active")).toBe(true);
    });

    it("an allowlist scope repairs only its companies", async () => {
      const a = await readyAgent();
      const b = await readyAgent();
      await breakIt(a.dedicated.id, a.dedicated.config);
      await breakIt(b.dedicated.id, b.dedicated.config);
      expect(await repairStaticCatalogConnections({ ...ctx(), scope: { mode: "allowlist", companyIds: [a.companyId] } })).toBe(1);
      expect(Object.values(await statusMap(a.dedicated.id)).every((status) => status === "active")).toBe(true);
      expect(Object.values(await statusMap(b.dedicated.id)).every((status) => status === "quarantined")).toBe(true);
    });
  });
});
