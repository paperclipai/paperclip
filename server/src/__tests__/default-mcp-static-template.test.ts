import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetDefaultMcpTemplateScopeForTests, captureDefaultMcpTemplateScope } from "../secrets/default-mcp-template-scope.js";
import { eq, sql } from "drizzle-orm";
import { activityLog, agents, authUsers, companies, companyMemberships, companySecretBindings, companySecretVersions, companySecrets, connectionGrants, connectionTokenIssuances, createDb, heartbeatRuns, toolAccessAuditEvents, toolApplications, toolCatalogEntries, toolConnectionInstalls, toolConnections, toolMcpGatewayTokens, toolMcpGateways, toolOauthStates, toolProfileBindings, toolProfileEntries, toolProfiles, toolRuntimeSlots, principalPermissionGrants } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";
import { ARCANA_BRAIN_REVIEWED_TOOLS, ARCANA_STATIC_TEMPLATE_UID, DEFAULT_MCP_SPEC, readDefaultMcpState, staticTemplateUidOf, type DefaultMcpEntrySpec } from "../services/default-mcp-spec.js";
import { runDefaultMcpSetupForAgent, waitForScheduledDefaultMcpSetups } from "../services/default-mcp-setup.js";
import { ARCANA_MCP_URL_ENV, ARCANA_PROVISION_KEY_ENV, ARCANA_URL_ENV, resolveArcanaMcpUrl, resolveStaticTemplateMcpUrl } from "../services/arcana-provisioner-client.js";
import { ensureStaticCompanyTemplates, staticTemplateEntries, sweepStaticCompanyTemplates } from "../services/default-mcp-static-template.js";
import { ensureCompanyTemplate, sweepCompanyTemplates } from "../services/default-mcp-template.js";
import { toolAccessService } from "../services/tool-access.js";
import { connectionHealthColumns } from "../services/default-mcp-spec.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const FEATURE_ENV = "PAPERCLIP_DEFAULT_MCP_SPEC_ENABLED";
const ARCANA_URL = "https://arcana.example.test";
const PROVISION_KEY = "synthetic-provision-key-0123456789abcdef";
const ARCANA_ENTRY = DEFAULT_MCP_SPEC.find((entry) => entry.key === "arcana-brain")!;
const later = (ms = 2 * 3_600_000) => () => new Date(Date.now() + ms);

const MCP_URL = "https://arcana-mcp.example.test/mcp";

// A second static entry with its own uid, endpoint and write tools (TECH-8832): proves the template is not Arcana-only.
const OTHER_URL_ENV = "TEST_STATIC_MCP_URL";
const OTHER_UID = "rh-test-static/default-mcp-template";
const OTHER_ENTRY: DefaultMcpEntrySpec = {
  key: "test-static",
  displayName: "Test Static",
  connectionName: "rh-test-static",
  authKind: "managed_token",
  defaultEnabled: false,
  setupHook: "agent_memory",
  templateBootstrap: "static",
  reviewedTools: { version: 1, allow: ["tool_search", "tool_add", "tool_delete"] },
  staticTemplate: {
    uid: OTHER_UID,
    mcpUrl: { env: OTHER_URL_ENV, path: "/mcp" },
    placeholderSecretKey: "default_mcp.test_static.template_placeholder",
    tools: {
      tool_add: { description: "Add one fact", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, riskLevel: "write" },
      tool_delete: { riskLevel: "write", isDestructive: false },
    },
  },
};

describeEmbeddedPostgres("default MCP static-catalog template bootstrap (TECH-7253)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-static-template-${randomUUID()}`);
  const env: NodeJS.ProcessEnv = { [FEATURE_ENV]: "true", [ARCANA_URL_ENV]: ARCANA_URL, [ARCANA_PROVISION_KEY_ENV]: PROVISION_KEY, [ARCANA_MCP_URL_ENV]: MCP_URL };
  const ctx = (over: Partial<Parameters<typeof ensureStaticCompanyTemplates>[0]> = {}) => ({
    db,
    env,
    spec: [ARCANA_ENTRY],
    scope: { mode: "all" } as const,
    ...over,
  });

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("static-template");
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

  async function seedCompany(status: "active" | "archived" = "active") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company-${companyId.slice(0, 8)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      status,
    });
    return companyId;
  }
  const rowsOf = (companyId: string) => db.select().from(toolConnections).where(eq(toolConnections.companyId, companyId));
  const catalogOf = (connectionId: string) => db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, connectionId));

  it("creates the template once, idempotently, with exactly the five reviewed verbs active", async () => {
    const companyId = await seedCompany();
    const first = await ensureStaticCompanyTemplates(ctx(), { companyId });
    expect(first).toEqual([{ kind: "ready", created: true }]);
    const second = await ensureStaticCompanyTemplates(ctx(), { companyId });
    expect(second).toEqual([{ kind: "ready", created: false }]);

    const rows = await rowsOf(companyId);
    expect(rows).toHaveLength(1);
    const template = rows[0]!;
    expect(template).toMatchObject({ name: "rh-arcana-brain", uid: ARCANA_STATIC_TEMPLATE_UID, transport: "mcp_remote", authKind: "api_key", status: "active" });
    expect((template.config as { url: string }).url).toBe(MCP_URL);
    const headers = (template.credentialRefs ?? []).filter((ref) => ref.placement === "header");
    expect(headers).toHaveLength(1);
    expect(headers[0]).toMatchObject({ key: "Authorization", prefix: "Bearer " });

    const catalog = await catalogOf(template.id);
    expect(catalog.map((row) => row.toolName).sort()).toEqual([...ARCANA_BRAIN_REVIEWED_TOOLS].sort());
    expect(catalog.every((row) => row.status === "active" && row.isReadOnly && !row.isWrite)).toBe(true);
    // Exactly one default-deny profile that includes exactly those entries, and no bindings.
    const [profile] = await db.select().from(toolProfiles).where(eq(toolProfiles.companyId, companyId));
    expect(profile!.defaultAction).toBe("deny");
    expect(await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, profile!.id))).toHaveLength(5);
    expect(await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, companyId))).toHaveLength(0);
    // One placeholder secret, reused rather than duplicated.
    expect(await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId))).toHaveLength(1);
  });

  it("narrows drift: a tool outside the reviewed verbs is disabled and a disabled reviewed verb is restored", async () => {
    const companyId = await seedCompany();
    await ensureStaticCompanyTemplates(ctx(), { companyId });
    const [template] = await rowsOf(companyId);
    await db.insert(toolCatalogEntries).values({ companyId, applicationId: template!.applicationId, connectionId: template!.id, name: "delete_everything", toolName: "delete_everything", versionHash: "x", status: "active" });
    await db.update(toolCatalogEntries).set({ status: "disabled" }).where(eq(toolCatalogEntries.toolName, "recall"));
    await ensureStaticCompanyTemplates(ctx(), { companyId });
    const catalog = await catalogOf(template!.id);
    expect(catalog.find((row) => row.toolName === "delete_everything")!.status).toBe("disabled");
    expect(catalog.find((row) => row.toolName === "recall")!.status).toBe("active");
  });

  it("adopts an org-authored same-named template unchanged", async () => {
    const companyId = await seedCompany();
    const application = await db.insert(toolApplications).values({ companyId, applicationKey: "org-app", name: "org arcana", type: "mcp_http", status: "active" }).returning().then((r) => r[0]!);
    await db.insert(toolConnections).values({ companyId, applicationId: application.id, name: "rh-arcana-brain", uid: `uid-${randomUUID()}`, transport: "mcp_remote", authKind: "api_key", credentialPolicy: "shared", status: "active", enabled: true, config: { url: "https://org.example.test/mcp" }, transportConfig: { url: "https://org.example.test/mcp" } });
    expect(await ensureStaticCompanyTemplates(ctx(), { companyId })).toEqual([{ kind: "adopted" }]);
    const rows = await rowsOf(companyId);
    expect(rows).toHaveLength(1);
    expect((rows[0]!.config as { url: string }).url).toBe("https://org.example.test/mcp");
    expect(await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.companyId, companyId))).toHaveLength(0);
    expect(await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId))).toHaveLength(0);
  });

  it("reports an ambiguous pair of same-named templates and writes nothing", async () => {
    const companyId = await seedCompany();
    const application = await db.insert(toolApplications).values({ companyId, applicationKey: "org-app", name: "org arcana", type: "mcp_http", status: "active" }).returning().then((r) => r[0]!);
    for (let i = 0; i < 2; i += 1) {
      await db.insert(toolConnections).values({ companyId, applicationId: application.id, name: "rh-arcana-brain", uid: `uid-${randomUUID()}`, transport: "mcp_remote", authKind: "api_key", credentialPolicy: "shared", status: "active", enabled: true, config: {}, transportConfig: {} });
    }
    expect(await ensureStaticCompanyTemplates(ctx(), { companyId })).toEqual([{ kind: "collision", reason: "template_ambiguous" }]);
    expect(await rowsOf(companyId)).toHaveLength(2);
  });

  it("never recreates a template an operator archived", async () => {
    const companyId = await seedCompany();
    await ensureStaticCompanyTemplates(ctx(), { companyId });
    await db.update(toolConnections).set({ status: "archived" }).where(eq(toolConnections.companyId, companyId));
    expect(await ensureStaticCompanyTemplates(ctx(), { companyId })).toEqual([{ kind: "revoked" }]);
    expect(await rowsOf(companyId)).toHaveLength(1);
  });

  it("waits, writing nothing, when the MCP URL is missing or invalid", async () => {
    const companyId = await seedCompany();
    const missing = { ...env, [ARCANA_MCP_URL_ENV]: "" };
    expect(await ensureStaticCompanyTemplates(ctx({ env: missing }), { companyId })).toEqual([{ kind: "waiting", reason: "mcp_url_not_configured" }]);
    for (const bad of ["http://evil.example.test/mcp", "not a url", "https://user:pw@h.example.test/mcp", "https://h.example.test/mcp?x=1"]) {
      const result = await ensureStaticCompanyTemplates(ctx({ env: { ...env, [ARCANA_MCP_URL_ENV]: bad } }), { companyId });
      expect(result).toEqual([{ kind: "waiting", reason: "mcp_url_invalid" }]);
    }
    expect(await rowsOf(companyId)).toHaveLength(0);
  });

  it("allows an http loopback MCP URL and nothing else over http", async () => {
    const companyId = await seedCompany();
    const out = await ensureStaticCompanyTemplates(ctx({ env: { ...env, [ARCANA_MCP_URL_ENV]: "http://127.0.0.1:8000/mcp" } }), { companyId });
    expect(out).toEqual([{ kind: "ready", created: true }]);
  });

  it("is skipped when the feature is off, the company is out of scope or archived", async () => {
    const companyId = await seedCompany();
    const archived = await seedCompany("archived");
    const { [FEATURE_ENV]: _off, ...noFeature } = env;
    expect(await ensureStaticCompanyTemplates(ctx({ env: noFeature }), { companyId })).toEqual([{ kind: "skipped", reason: "feature_disabled" }]);
    expect(await ensureStaticCompanyTemplates(ctx({ scope: { mode: "none" } }), { companyId })).toEqual([{ kind: "skipped", reason: "out_of_scope" }]);
    expect(await ensureStaticCompanyTemplates(ctx(), { companyId: archived })).toEqual([{ kind: "skipped", reason: "company_archived" }]);
    expect(await rowsOf(companyId)).toHaveLength(0);
    expect(await rowsOf(archived)).toHaveLength(0);
  });

  it("the sweep creates missing templates once and leaves existing ones alone", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    const swept = await sweepStaticCompanyTemplates(ctx());
    expect(swept).toBe(2);
    expect(await rowsOf(a)).toHaveLength(1);
    expect(await rowsOf(b)).toHaveLength(1);
    expect(await sweepStaticCompanyTemplates(ctx())).toBe(0);
  });

  it("the combined sweep and comms ensure ignore the static entry (comms behavior unchanged)", async () => {
    const companyId = await seedCompany();
    // With only the static entry in the spec the comms bootstrap has nothing to do and writes nothing.
    expect(await ensureCompanyTemplate(ctx(), { companyId })).toEqual({ kind: "skipped", reason: "no_bootstrap_entry" });
    expect(await rowsOf(companyId)).toHaveLength(0);
    expect(await sweepCompanyTemplates(ctx())).toBe(1); // only the static half acts
    const rows = await rowsOf(companyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.uid).toBe(ARCANA_STATIC_TEMPLATE_UID);
  });

  it("the created template passes the arcana_brain hook's template resolution and clones only the five verbs", async () => {
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
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { agent_principal_id: string };
      return new Response(JSON.stringify({ brain_id: `agent:${body.agent_principal_id}`, status: "active" }), { status: 201 });
    }) as unknown as typeof fetch;
    await runDefaultMcpSetupForAgent({ db, env, fetchImpl, spec: [ARCANA_ENTRY], now: () => new Date(Date.now() + 2 * 3_600_000) }, { companyId, agentId: created.id });
    const [agentRow] = await db.select().from(agents).where(eq(agents.id, created.id));
    const state = readDefaultMcpState(agentRow!.metadata)!.entries["arcana-brain"]!;
    expect(state.setup.state).toBe("ready");
    const dedicated = (await rowsOf(companyId)).find((row) => row.name === `rh-arcana-brain:${created.id}`)!;
    expect(dedicated.credentialPolicy).toBe("per_agent");
    const clonedTools = (await catalogOf(dedicated.id)).filter((row) => row.status === "active").map((row) => row.toolName).sort();
    expect(clonedTools).toEqual([...ARCANA_BRAIN_REVIEWED_TOOLS].sort());
  });
  it("heals a template an earlier health write marked broken, and never counts it as a degraded connection", async () => {
    const companyId = await seedCompany();
    await ensureStaticCompanyTemplates(ctx(), { companyId });
    const [template] = await rowsOf(companyId);
    const broken = { healthStatus: "missing_secret" as const, healthMessage: "A configured credential secret could not be resolved.", lastError: "A configured credential secret could not be resolved." };
    await db.update(toolConnections).set(broken).where(eq(toolConnections.id, template!.id));
    // A real per-agent connection with the same symptom still counts: only the template is exempt.
    await db.insert(toolConnections).values({
      companyId,
      applicationId: template!.applicationId,
      name: "rh-arcana-brain:agent-x",
      uid: `rh-arcana-brain/${randomUUID()}`,
      connectionKind: "managed",
      ownership: "customer",
      transport: "mcp_remote",
      authKind: "api_key",
      status: "active",
      enabled: true,
      ...broken,
      config: {},
      transportConfig: {},
    });
    const service = toolAccessService(db);
    expect((await service.getRuntimeHealth(companyId)).metrics.degradedConnections).toBe(1);

    await ensureStaticCompanyTemplates(ctx(), { companyId });
    const [healed] = (await rowsOf(companyId)).filter((row) => row.uid === ARCANA_STATIC_TEMPLATE_UID);
    expect(healed).toMatchObject({ healthStatus: "ok", healthMessage: null, lastError: null, enabled: true, status: "active" });
    const other = (await rowsOf(companyId)).find((row) => row.name === "rh-arcana-brain:agent-x")!;
    expect(other.healthStatus).toBe("missing_secret");
    // The template stays in the service's internal inventory (the clone source); only operator listings drop it.
    expect((await service.listConnections(companyId)).map((c) => c.uid)).toContain(ARCANA_STATIC_TEMPLATE_UID);
  });

  it("the health sweep never picks the template up, and health columns for it are always ok", async () => {
    const companyId = await seedCompany();
    await ensureStaticCompanyTemplates(ctx(), { companyId });
    const [template] = await rowsOf(companyId);
    await db.update(toolConnections).set({ healthCheckedAt: null }).where(eq(toolConnections.id, template!.id));
    const sweep = await toolAccessService(db).sweepConnectionHealth({ staleAfterMs: 0, limit: 25 });
    expect(JSON.stringify(sweep)).not.toContain(template!.id);
    const [after] = await rowsOf(companyId);
    expect(after).toMatchObject({ healthStatus: "ok", lastError: null, healthCheckedAt: null });

    expect(connectionHealthColumns({ uid: ARCANA_STATIC_TEMPLATE_UID }, "missing_secret", "boom")).toEqual({ healthStatus: "ok", healthMessage: null, lastError: null });
    expect(connectionHealthColumns({ uid: "rh-arcana-brain/x" }, "missing_secret", "boom")).toEqual({ healthStatus: "missing_secret", healthMessage: "boom", lastError: "boom" });
    expect(connectionHealthColumns({ uid: null }, "ok", null)).toEqual({ healthStatus: "ok", healthMessage: null, lastError: null });
  });

  it("covers company_not_found, a paused company, and an empty spec", async () => {
    expect(await ensureStaticCompanyTemplates(ctx(), { companyId: randomUUID() })).toEqual([{ kind: "skipped", reason: "company_not_found" }]);
    const paused = await seedCompany("paused");
    expect(await ensureStaticCompanyTemplates(ctx(), { companyId: paused })).toEqual([{ kind: "ready", created: true }]);
    expect(await ensureStaticCompanyTemplates(ctx({ spec: [] }), { companyId: paused })).toEqual([{ kind: "skipped", reason: "no_static_entry" }]);
  });

  it("selects only entries declaring templateBootstrap: 'static'", () => {
    const comms = DEFAULT_MCP_SPEC.find((entry) => entry.key === "comms-board")!;
    expect(staticTemplateEntries(DEFAULT_MCP_SPEC).map((entry) => entry.key)).toEqual(["arcana-brain"]);
    expect(staticTemplateEntries([comms])).toEqual([]);
    expect(staticTemplateEntries([{ ...ARCANA_ENTRY, templateBootstrap: true }])).toEqual([]);
    expect(staticTemplateEntries([{ ...ARCANA_ENTRY, reviewedTools: undefined }])).toEqual([]);
  });

  it("resolveArcanaMcpUrl validates the frozen URL", () => {
    expect(resolveArcanaMcpUrl({ [ARCANA_MCP_URL_ENV]: MCP_URL })).toEqual({ ok: true, url: MCP_URL });
    expect(resolveArcanaMcpUrl({})).toEqual({ ok: false, reason: "mcp_url_not_configured" });
    expect(resolveArcanaMcpUrl({ [ARCANA_MCP_URL_ENV]: "http://example.test/mcp" })).toEqual({ ok: false, reason: "mcp_url_invalid" });
    expect(resolveArcanaMcpUrl({ [ARCANA_MCP_URL_ENV]: "http://localhost:8000/mcp" })).toEqual({ ok: true, url: "http://localhost:8000/mcp" });
  });

  it("the sweep counts only templates actually created", async () => {
    const companyId = await seedCompany();
    await ensureStaticCompanyTemplates(ctx(), { companyId });
    expect(await sweepStaticCompanyTemplates(ctx())).toBe(0);
  });

  it("nudges an agent waiting on template_not_found when the template is created", async () => {
    const companyId = await seedCompany();
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
    await runDefaultMcpSetupForAgent({ db, env, spec: [ARCANA_ENTRY], now: later() }, { companyId, agentId: created.id });
    const read = async () => {
      const [row] = await db.select().from(agents).where(eq(agents.id, created.id));
      return readDefaultMcpState(row!.metadata)!.entries["arcana-brain"]!.setup;
    };
    const waiting = await read();
    expect(waiting.state).toBe("pending");
    expect(waiting.reason).toBe("template_not_found");
    const at = new Date(Date.now() + 5 * 60_000);
    await ensureStaticCompanyTemplates(ctx({ now: () => at }), { companyId });
    expect((await read()).nextAttemptAt).toBe(at.toISOString());
  });

  it("seeds a second static entry with its own uid, endpoint, placeholder and per-tool write flags", async () => {
    const otherEnv = { ...env, [OTHER_URL_ENV]: "https://memory.example.test/" };
    const companyId = await seedCompany();
    const outcomes = await ensureStaticCompanyTemplates(ctx({ env: otherEnv, spec: [ARCANA_ENTRY, OTHER_ENTRY] }), { companyId });
    expect(outcomes).toEqual([{ kind: "ready", created: true }, { kind: "ready", created: true }]);
    expect(await ensureStaticCompanyTemplates(ctx({ env: otherEnv, spec: [ARCANA_ENTRY, OTHER_ENTRY] }), { companyId })).toEqual([
      { kind: "ready", created: false },
      { kind: "ready", created: false },
    ]);

    const rows = await rowsOf(companyId);
    expect(rows.map((row) => row.uid).sort()).toEqual([ARCANA_STATIC_TEMPLATE_UID, OTHER_UID].sort());
    const other = rows.find((row) => row.uid === OTHER_UID)!;
    expect(other).toMatchObject({ name: "rh-test-static", transport: "mcp_remote", authKind: "api_key", status: "active" });
    expect((other.config as { url: string }).url).toBe("https://memory.example.test/mcp");
    expect((other.config as Record<string, unknown>).defaultMcpStaticCatalog).toBe("test-static");

    const catalog = Object.fromEntries((await catalogOf(other.id)).map((row) => [row.toolName, row]));
    expect(Object.keys(catalog).sort()).toEqual(["tool_add", "tool_delete", "tool_search"]);
    expect(catalog.tool_search).toMatchObject({ riskLevel: "read", isReadOnly: true, isWrite: false, isDestructive: false, inputSchema: { type: "object" }, description: "Test Static tool: tool_search" });
    expect(catalog.tool_add).toMatchObject({ riskLevel: "write", isReadOnly: false, isWrite: true, isDestructive: false, description: "Add one fact" });
    expect(catalog.tool_add!.inputSchema).toEqual({ type: "object", properties: { text: { type: "string" } }, required: ["text"] });
    expect(catalog.tool_delete).toMatchObject({ riskLevel: "write", isWrite: true, isDestructive: false, annotations: { readOnlyHint: false, destructiveHint: false } });
    expect(Object.values(catalog).every((row) => row.status === "active")).toBe(true);

    // Arcana's template is untouched, and each template has its own placeholder secret.
    const arcana = rows.find((row) => row.uid === ARCANA_STATIC_TEMPLATE_UID)!;
    expect((await catalogOf(arcana.id)).every((row) => row.isReadOnly && !row.isWrite)).toBe(true);
    const secretKeys = (await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId))).map((row) => row.key).sort();
    expect(secretKeys).toEqual(["default_mcp.arcana_brain.template_placeholder", "default_mcp.test_static.template_placeholder"]);
  });

  it("a second entry whose URL is unset waits without blocking the Arcana template", async () => {
    const companyId = await seedCompany();
    const outcomes = await ensureStaticCompanyTemplates(ctx({ spec: [ARCANA_ENTRY, OTHER_ENTRY] }), { companyId });
    expect(outcomes).toEqual([{ kind: "ready", created: true }, { kind: "waiting", reason: "mcp_url_not_configured" }]);
    expect((await rowsOf(companyId)).map((row) => row.uid)).toEqual([ARCANA_STATIC_TEMPLATE_UID]);
  });

  it("resolves a static template URL from a named env var and defaults to Arcana's", () => {
    expect(resolveStaticTemplateMcpUrl(undefined, { [ARCANA_MCP_URL_ENV]: MCP_URL })).toEqual({ ok: true, url: MCP_URL });
    const source = { env: OTHER_URL_ENV, path: "/mcp" };
    expect(resolveStaticTemplateMcpUrl(source, { [OTHER_URL_ENV]: "https://memory.example.test//" })).toEqual({ ok: true, url: "https://memory.example.test/mcp" });
    expect(resolveStaticTemplateMcpUrl(source, {})).toEqual({ ok: false, reason: "mcp_url_not_configured" });
    expect(resolveStaticTemplateMcpUrl(source, { [OTHER_URL_ENV]: "http://memory.example.test" })).toEqual({ ok: false, reason: "mcp_url_invalid" });
    expect(staticTemplateUidOf(ARCANA_ENTRY)).toBe(ARCANA_STATIC_TEMPLATE_UID);
    expect(staticTemplateUidOf(OTHER_ENTRY)).toBe(OTHER_UID);
  });
});
