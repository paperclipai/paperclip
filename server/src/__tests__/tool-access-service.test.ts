import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  companySecretBindings,
  companySecrets,
  createDb,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
  principalPermissionGrants,
  toolAccessAuditEvents,
  toolActionRequests,
  toolApplications,
  toolCallEvents,
  toolCatalogEntries,
  toolConnections,
  toolOauthStates,
  toolInvocations,
  toolPolicies,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
  toolRuntimeSlots,
  toolStdioCommandTemplates,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { classifyRisk, toolAccessService } from "../services/tool-access.js";
import { toolAccessRoutes } from "../routes/tool-access.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function createCompany(db: ReturnType<typeof createDb>) {
  return db
    .insert(companies)
    .values({
      name: `Tool Access CRUD ${randomUUID()}`,
      issuePrefix: `TC${randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
}

function mockToolsList(tools: unknown[]) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    json: async () => ({ jsonrpc: "2.0", id: "paperclip-catalog-refresh", result: { tools } }),
  } as Response);
}

function createRouteApp(db: ReturnType<typeof createDb>, actor?: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor ?? {
      type: "board",
      userId: "board-user",
      userName: "Board User",
      userEmail: null,
      isInstanceAdmin: true,
      source: "local_implicit",
    };
    next();
  });
  app.use("/api", toolAccessRoutes(db));
  app.use(errorHandler);
  return app;
}

function boardSessionActor(
  companyId: string,
  membershipRole: "owner" | "admin" | "operator" | "member" | "viewer",
  userId = `${membershipRole}-${randomUUID()}`,
  sessionId = `session-${randomUUID()}`,
): Express.Request["actor"] {
  return {
    type: "board",
    userId,
    sessionId,
    userName: `${membershipRole} user`,
    userEmail: null,
    isInstanceAdmin: false,
    source: "session",
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole, status: "active" }],
  };
}

describeEmbeddedPostgres("tool access service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tool-access-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await db.delete(toolOauthStates);
    await db.delete(companySecretBindings);
    await db.delete(companySecrets);
    await db.delete(activityLog);
    await db.delete(toolCallEvents);
    await db.delete(toolActionRequests);
    await db.delete(toolInvocations);
    await db.delete(toolAccessAuditEvents);
    await db.delete(issueThreadInteractions);
    await db.delete(toolRuntimeSlots);
    await db.delete(toolStdioCommandTemplates);
    await db.delete(toolProfileBindings);
    await db.delete(toolProfileEntries);
    await db.delete(toolProfiles);
    await db.delete(toolCatalogEntries);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("quarantines new or changed catalog entries during active opt-in catalog refresh", async () => {
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const fetchMock = mockToolsList([
      {
        name: "search_notes",
        description: "Search notes.",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
        annotations: { readOnlyHint: true },
      },
      {
        name: "send_email",
        description: "Send an email.",
        inputSchema: { type: "object", properties: { to: { type: "string" } } },
        annotations: { readOnlyHint: false },
      },
    ]);

    const connection = await service.createConnection(company.id, {
      name: "Remote fixture",
      transport: "remote_http",
      config: { url: "https://fixture.example/mcp", quarantineNewEntries: true },
      enabled: true,
      status: "active",
    });
    const firstRefresh = await service.refreshCatalog(connection.id, { actorType: "user", actorId: "board" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://fixture.example/mcp",
      expect.objectContaining({ method: "POST" }),
    );
    expect(firstRefresh.discoveredCount).toBe(2);
    expect(firstRefresh.quarantinedCount).toBe(2);
    expect(firstRefresh.catalog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolName: "search_notes", status: "quarantined", riskLevel: "read" }),
        expect.objectContaining({
          toolName: "send_email",
          status: "quarantined",
          riskLevel: "write",
          quarantineReason: "pending_review",
        }),
      ]),
    );

    await db
      .update(toolCatalogEntries)
      .set({ status: "active", reviewedAt: new Date(), quarantineReason: null, quarantinedAt: null })
      .where(eq(toolCatalogEntries.toolName, "send_email"));
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        jsonrpc: "2.0",
        id: "paperclip-catalog-refresh",
        result: {
          tools: [
            {
              name: "send_email",
              description: "Send an email with attachments.",
              inputSchema: { type: "object", properties: { to: { type: "string" }, attachment: { type: "string" } } },
              annotations: { readOnlyHint: false },
            },
          ],
        },
      }),
    } as Response);

    const secondRefresh = await service.refreshCatalog(connection.id);

    expect(secondRefresh.quarantinedCount).toBe(1);
    expect(secondRefresh.catalog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolName: "send_email",
          status: "quarantined",
          quarantineReason: "pending_review",
        }),
      ]),
    );
  });

  it("registers an approved local stdio template and exposes its runtime slot", async () => {
    const company = await createCompany(db);
    const service = toolAccessService(db);

    const connection = await service.createConnection(company.id, {
      name: "Local echo fixture",
      transport: "local_stdio",
      config: { templateId: "paperclip.echo-calculator-time" },
      enabled: true,
      status: "active",
    });
    const health = await service.checkHealth(connection.id);
    const refresh = await service.refreshCatalog(connection.id);
    const runtimeSlots = await service.listRuntimeSlots(company.id);

    expect(health.runtimeSlot).toMatchObject({
      connectionId: connection.id,
      runtimeKind: "local_stdio",
      status: "stopped",
      commandTemplateKey: "paperclip.echo-calculator-time",
    });
    expect(refresh.catalog.map((entry) => entry.toolName).sort()).toEqual(["add", "echo", "fail_with_code", "now"]);
    expect(runtimeSlots).toEqual([
      expect.objectContaining({
        connectionId: connection.id,
        providerRef: "template:paperclip.echo-calculator-time",
        healthStatus: "ok",
      }),
    ]);
  });

  it("requires tools:admin to create, list, and disable stdio command templates", async () => {
    const company = await createCompany(db);
    const userId = `tool-admin-${randomUUID()}`;
    const actor: Express.Request["actor"] = {
      type: "board",
      userId,
      userName: "Tool Admin",
      userEmail: null,
      isInstanceAdmin: false,
      source: "session",
      companyIds: [company.id],
      memberships: [{ companyId: company.id, membershipRole: "operator", status: "active" }],
    };
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "operator",
    });
    const app = createRouteApp(db, actor);

    await request(app).get(`/api/companies/${company.id}/tools/stdio-templates`).expect(403);

    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "user",
      principalId: userId,
      permissionKey: "tools:admin",
      scope: null,
      grantedByUserId: "owner",
    });

    const created = await request(app)
      .post(`/api/companies/${company.id}/tools/stdio-templates`)
      .send({
        templateId: "local.echo-admin",
        name: "Local echo admin",
        command: "node",
        args: ["server.js"],
        envKeys: ["ECHO_TOKEN"],
        tools: [{ name: "echo", description: "Echo a message.", annotations: { readOnlyHint: true } }],
      })
      .expect(201);

    expect(created.body).toMatchObject({
      templateId: "local.echo-admin",
      status: "active",
      source: "admin",
      command: "node",
      args: ["server.js"],
      envKeys: ["ECHO_TOKEN"],
      tools: [expect.objectContaining({ name: "echo" })],
    });

    const listed = await request(app).get(`/api/companies/${company.id}/tools/stdio-templates`).expect(200);
    expect(listed.body.templates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ templateId: "paperclip.echo-calculator-time", source: "built_in" }),
        expect.objectContaining({ templateId: "local.echo-admin", source: "admin", status: "active" }),
      ]),
    );

    const disabled = await request(app)
      .post(`/api/companies/${company.id}/tools/stdio-templates/local.echo-admin/disable`)
      .send({ reason: "no longer trusted" })
      .expect(200);

    expect(disabled.body).toMatchObject({ templateId: "local.echo-admin", status: "disabled" });
  });

  it("launches local stdio slots only through active admin-defined templates", async () => {
    const company = await createCompany(db);
    const service = toolAccessService(db);

    await service.createStdioCommandTemplate(company.id, {
      templateId: "admin.local-echo",
      name: "Admin local echo",
      command: "node",
      args: ["./echo-mcp.js"],
      envKeys: ["ADMIN_ECHO_TOKEN"],
      tools: [{ name: "echo", description: "Echo a message.", annotations: { readOnlyHint: true } }],
    }, { actorType: "user", actorId: "board" });

    const connection = await service.createConnection(company.id, {
      name: "Admin local echo",
      transport: "local_stdio",
      config: { templateId: "admin.local-echo" },
      enabled: true,
      status: "active",
    });
    const health = await service.checkHealth(connection.id);
    const refresh = await service.refreshCatalog(connection.id);

    expect(health.runtimeSlot).toMatchObject({
      connectionId: connection.id,
      runtimeKind: "local_stdio",
      commandTemplateKey: "admin.local-echo",
    });
    expect(refresh.catalog).toEqual([
      expect.objectContaining({ toolName: "echo", status: "active", riskLevel: "read" }),
    ]);

    await expect(service.createConnection(company.id, {
      name: "Rejected command config",
      transport: "local_stdio",
      config: { command: "node", args: ["./unapproved.js"] },
      enabled: true,
      status: "active",
    })).rejects.toThrow("Local stdio MCP connections must use an approved templateId");

    await service.disableStdioCommandTemplate(company.id, "admin.local-echo");
    await expect(service.createConnection(company.id, {
      name: "Disabled admin template",
      transport: "local_stdio",
      config: { templateId: "admin.local-echo" },
      enabled: true,
      status: "active",
    })).rejects.toThrow("Local stdio MCP connections must use an approved templateId");
  });

  it("creates profiles with entries, binds them to agents, and resolves effective allowed tools", async () => {
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const [agent] = await db.insert(agents).values({
      companyId: company.id,
      name: `Profile Agent ${randomUUID()}`,
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    }).returning();
    const [application] = await db.insert(toolApplications).values({
      companyId: company.id,
      name: `Profile Fixture ${randomUUID()}`,
      type: "mcp_http",
      status: "active",
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: company.id,
      applicationId: application.id,
      name: `Profile Connection ${randomUUID()}`,
      transport: "remote_http",
      status: "active",
      enabled: true,
      config: { url: "https://fixture.example/mcp" },
      transportConfig: { url: "https://fixture.example/mcp" },
      healthStatus: "ok",
    }).returning();
    const [catalogEntry] = await db.insert(toolCatalogEntries).values({
      companyId: company.id,
      applicationId: application.id,
      connectionId: connection.id,
      name: "send_email",
      toolName: "send_email",
      riskLevel: "write",
      status: "active",
      versionHash: randomUUID(),
      schemaHash: randomUUID(),
    }).returning();

    const profile = await service.createProfile(company.id, {
      profileKey: `profile-${randomUUID()}`,
      name: "Email tools",
      defaultAction: "deny",
      entries: [{ selectorType: "tool_name", effect: "include", toolName: "send_email" }],
    });
    const added = await service.addProfileEntry(profile.id, {
      selectorType: "risk_level",
      effect: "exclude",
      riskLevel: "destructive",
    });
    await expect(service.updateProfileEntry(added.id, { effect: "include" })).resolves.toMatchObject({
      effect: "include",
      riskLevel: "destructive",
    });
    await expect(service.deleteProfileEntry(added.id)).resolves.toMatchObject({ id: added.id });
    await service.updateProfile(profile.id, {
      entries: [{ selectorType: "connection", effect: "include", connectionId: connection.id }],
    });
    await service.bindProfile(profile.id, { targetType: "agent", targetId: agent.id, priority: 25 }, { actorType: "user", actorId: "board" });

    const listed = await service.listProfiles(company.id);
    const effective = await service.getEffectiveProfilesForAgent(company.id, agent.id);

    expect(listed).toEqual([
      expect.objectContaining({
        id: profile.id,
        entries: [expect.objectContaining({ selectorType: "connection", connectionId: connection.id })],
        bindings: [expect.objectContaining({ targetType: "agent", targetId: agent.id, priority: 25 })],
      }),
    ]);
    expect(effective).toMatchObject({
      agentId: agent.id,
      allowedToolNames: ["send_email"],
      allowedTools: [expect.objectContaining({ id: catalogEntry.id, toolName: "send_email" })],
    });

    await expect(service.unbindProfile(profile.id, { targetType: "agent", targetId: agent.id })).resolves.toEqual({ unbound: 1 });
    await expect(service.getEffectiveProfilesForAgent(company.id, agent.id)).resolves.toMatchObject({
      profiles: [],
      allowedToolNames: [],
    });
  });

  it("summarizes profile index counts and restores archived profiles through update", async () => {
    const company = await createCompany(db);
    const [agentOne, agentTwo] = await db.insert(agents).values([
      {
        companyId: company.id,
        name: `Profile Agent ${randomUUID()}`,
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
      },
      {
        companyId: company.id,
        name: `Profile Agent ${randomUUID()}`,
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
      },
    ]).returning();
    const [application] = await db.insert(toolApplications).values({
      companyId: company.id,
      applicationKey: `summary-app-${randomUUID()}`,
      name: "Summary app",
      type: "mcp_http",
      status: "active",
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: company.id,
      applicationId: application!.id,
      name: "Summary connection",
      transport: "remote_http",
      status: "active",
      enabled: true,
      config: { url: "https://fixture.example/mcp" },
    }).returning();
    const [readEntry, writeEntry] = await db.insert(toolCatalogEntries).values([
      {
        companyId: company.id,
        applicationId: application!.id,
        connectionId: connection!.id,
        name: "read_notes",
        toolName: "read_notes",
        riskLevel: "read",
        status: "active",
        versionHash: randomUUID(),
        schemaHash: randomUUID(),
      },
      {
        companyId: company.id,
        applicationId: application!.id,
        connectionId: connection!.id,
        name: "send_email",
        toolName: "send_email",
        riskLevel: "write",
        status: "active",
        versionHash: randomUUID(),
        schemaHash: randomUUID(),
      },
    ]).returning();

    const service = toolAccessService(db);
    const profile = await service.createProfile(company.id, {
      profileKey: `profile-${randomUUID()}`,
      name: "All except write tools",
      defaultAction: "allow",
      entries: [{ selectorType: "tool_name", effect: "exclude", toolName: "send_email" }],
    });
    await service.bindProfile(profile.id, { targetType: "company", targetId: company.id }, { actorType: "user", actorId: "board" });

    const [listed] = await service.listProfiles(company.id);
    expect(listed).toMatchObject({
      id: profile.id,
      status: "active",
      summary: {
        accessMode: "all_except",
        allowedToolCount: 1,
        allowedApplicationCount: 1,
        excludedToolCount: 1,
        totalToolCount: 2,
        assignmentCount: 1,
        appliesToAgentCount: 2,
        isCompanyDefault: true,
      },
    });
    await expect(service.getEffectiveProfilesForAgent(company.id, agentOne!.id)).resolves.toMatchObject({
      allowedTools: [expect.objectContaining({ id: readEntry!.id, toolName: "read_notes" })],
      allowedToolNames: ["read_notes"],
    });

    const archived = await service.updateProfile(profile.id, { status: "archived" });
    expect(archived.status).toBe("archived");
    await expect(service.getEffectiveProfilesForAgent(company.id, agentTwo!.id)).resolves.toMatchObject({
      profiles: [],
      allowedTools: [],
      allowedToolNames: [],
    });

    const restored = await service.updateProfile(profile.id, { status: "active" });
    expect(restored.status).toBe("active");
    await expect(service.getEffectiveProfilesForAgent(company.id, agentTwo!.id)).resolves.toMatchObject({
      allowedTools: [expect.objectContaining({ id: readEntry!.id })],
      allowedToolNames: ["read_notes"],
    });
    expect(writeEntry).toBeDefined();
  });

  it("duplicates profiles with entries and optional assignments", async () => {
    const company = await createCompany(db);
    const [agent] = await db.insert(agents).values({
      companyId: company.id,
      name: `Duplicate Agent ${randomUUID()}`,
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    }).returning();
    const service = toolAccessService(db);
    const profile = await service.createProfile(company.id, {
      profileKey: `profile-${randomUUID()}`,
      name: "Email tools source",
      defaultAction: "allow",
      entries: [{ selectorType: "tool_name", effect: "exclude", toolName: "delete_email" }],
    });
    await service.bindProfile(profile.id, { targetType: "agent", targetId: agent!.id, priority: 25 }, { actorType: "user", actorId: "board" });

    const unassignedCopy = await service.duplicateProfile(profile.id, {
      name: "Email tools unassigned copy",
      includeAssignments: false,
    });
    expect(unassignedCopy).toMatchObject({
      name: "Email tools unassigned copy",
      status: "active",
      defaultAction: "allow",
      entries: [expect.objectContaining({ selectorType: "tool_name", effect: "exclude", toolName: "delete_email" })],
      bindings: [],
      summary: expect.objectContaining({ assignmentCount: 0 }),
    });

    const assignedCopy = await service.duplicateProfile(profile.id, {
      name: "Email tools assigned copy",
      includeAssignments: true,
    });
    expect(assignedCopy).toMatchObject({
      name: "Email tools assigned copy",
      status: "active",
      bindings: [expect.objectContaining({ targetType: "agent", targetId: agent!.id, priority: 25 })],
      summary: expect.objectContaining({ assignmentCount: 1, appliesToAgentCount: 1 }),
    });
  });

  it("deletes profiles with cascades and guards company defaults", async () => {
    const company = await createCompany(db);
    const [agent] = await db.insert(agents).values({
      companyId: company.id,
      name: `Delete Agent ${randomUUID()}`,
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    }).returning();
    const service = toolAccessService(db);
    const profile = await service.createProfile(company.id, {
      profileKey: `profile-${randomUUID()}`,
      name: "Delete source",
      entries: [{ selectorType: "tool_name", effect: "include", toolName: "send_email" }],
    });
    await service.bindProfile(profile.id, { targetType: "agent", targetId: agent!.id }, { actorType: "user", actorId: "board" });

    const deleted = await service.deleteProfile(profile.id, { force: false });
    expect(deleted).toMatchObject({
      profile: expect.objectContaining({ id: profile.id }),
      summary: expect.objectContaining({ assignmentCount: 1, appliesToAgentCount: 1 }),
      reassignedToProfileId: null,
    });
    await expect(service.getProfile(profile.id)).rejects.toMatchObject({ status: 404 });
    await expect(db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, profile.id))).resolves.toEqual([]);
    await expect(db.select().from(toolProfileBindings).where(eq(toolProfileBindings.profileId, profile.id))).resolves.toEqual([]);

    const defaultProfile = await service.createProfile(company.id, {
      profileKey: `default-profile-${randomUUID()}`,
      name: "Company default delete guard",
      defaultAction: "allow",
    });
    await service.bindProfile(defaultProfile.id, { targetType: "company", targetId: company.id }, { actorType: "user", actorId: "board" });
    await expect(service.deleteProfile(defaultProfile.id, { force: false })).rejects.toMatchObject({
      status: 422,
      details: {
        summary: expect.objectContaining({
          isCompanyDefault: true,
          assignmentCount: 1,
          appliesToAgentCount: 1,
        }),
      },
    });

    await expect(service.deleteProfile(defaultProfile.id, { force: true })).resolves.toMatchObject({
      profile: expect.objectContaining({ id: defaultProfile.id }),
      summary: expect.objectContaining({ isCompanyDefault: true }),
    });
  });

  it("installs the safe example fixture idempotently and smokes allow, deny, and audit paths", async () => {
    const company = await createCompany(db);
    const service = toolAccessService(db);

    const before = await service.listExamples(company.id);
    expect(before).toEqual([
      expect.objectContaining({
        id: "safe-read-only-todo-kv",
        install: expect.objectContaining({ installed: false, canInstall: true }),
      }),
    ]);

    const install = await service.installExample(company.id, "safe-read-only-todo-kv", {
      actorType: "user",
      actorId: "board",
    });
    const secondInstall = await service.installExample(company.id, "safe-read-only-todo-kv", {
      actorType: "user",
      actorId: "board",
    });

    expect(install.created).toBe(true);
    expect(secondInstall.created).toBe(false);
    expect(install.application).toMatchObject({
      applicationKey: "paperclip.examples.safe-read-only-todo-kv",
      type: "mcp_stdio",
      status: "active",
    });
    expect(install.connection).toMatchObject({
      transport: "local_stdio",
      status: "active",
      enabled: true,
      config: expect.objectContaining({ templateId: "paperclip.synthetic-todo-kv" }),
    });
    expect(install.profile).toMatchObject({
      profileKey: "paperclip.examples.safe-read-only-todo-kv.profile",
      defaultAction: "deny",
      status: "active",
    });
    expect(install.profileBinding).toMatchObject({
      targetType: "company",
      targetId: company.id,
    });
    expect(install.profileEntries.map((entry) => entry.toolName).sort()).toEqual(["get_value", "list_items"]);
    const installedCatalogByTool = new Map(install.catalog.map((entry) => [entry.toolName, entry]));
    expect(installedCatalogByTool.get("list_items")).toMatchObject({ status: "active", riskLevel: "read" });
    expect(installedCatalogByTool.get("set_value")).toMatchObject({ status: "quarantined", riskLevel: "write" });

    const smoke = await service.smokeExample(company.id, "safe-read-only-todo-kv", {
      actorType: "user",
      actorId: "board",
    });

    expect(smoke.ok).toBe(true);
    expect(smoke.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "allow_read_tool", ok: true, decision: "allow", reasonCode: "allow_profile" }),
        expect.objectContaining({ name: "deny_write_tool", ok: true, decision: "deny", reasonCode: "deny_default" }),
        expect.objectContaining({ name: "audit_written", ok: true }),
      ]),
    );
    const auditRows = await db.select().from(toolAccessAuditEvents).where(eq(toolAccessAuditEvents.companyId, company.id));
    expect(auditRows.some((row) => row.action === "tool_access.policy_decision" && row.reasonCode === "allow_profile")).toBe(true);
    expect(auditRows.some((row) => row.action === "tool_access.policy_decision" && row.reasonCode === "deny_default")).toBe(true);
  });

  it("serves the app gallery manifest through the board route", async () => {
    const company = await createCompany(db);
    const app = createRouteApp(db);

    const res = await request(app).get(`/api/companies/${company.id}/tools/gallery`);

    expect(res.status).toBe(200);
    expect(res.body.apps.map((entry: { key: string }) => entry.key)).toEqual([
      "zapier",
      "github",
      "slack",
      "notion",
      "linear",
      "google-drive",
      "context7",
    ]);
    expect(res.body.apps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "slack",
          authKind: "oauth",
          oauth: expect.objectContaining({ provider: "slack" }),
        }),
        expect.objectContaining({
          key: "zapier",
          credentialFields: [
            expect.objectContaining({
              configPath: "credentials.authorization",
              placement: "header",
              key: "Authorization",
            }),
          ],
        }),
      ]),
    );
  });

  it("starts and completes OAuth app sign-in with PKCE state and secret-backed tokens", async () => {
    vi.stubEnv("PAPERCLIP_TOOL_OAUTH_SLACK_CLIENT_ID", "slack-client-id");
    vi.stubEnv("PAPERCLIP_TOOL_OAUTH_SLACK_CLIENT_SECRET", "slack-client-secret");
    const company = await createCompany(db);
    const app = createRouteApp(db);

    const connectRes = await request(app)
      .post(`/api/companies/${company.id}/tools/apps/connect`)
      .send({ galleryKey: "slack", name: "Slack workspace" });

    expect(connectRes.status).toBe(201);
    expect(connectRes.body.connection).toMatchObject({
      status: "draft",
      enabled: false,
      credentialSecretRefs: [],
      config: expect.objectContaining({ sourceTemplateKey: "slack" }),
    });
    const startUrl = new URL(connectRes.body.auth.startUrl);
    expect(`${startUrl.origin}${startUrl.pathname}`).toBe("https://slack.com/oauth/v2/authorize");
    expect(startUrl.searchParams.get("client_id")).toBe("slack-client-id");
    expect(startUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(startUrl.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const state = startUrl.searchParams.get("state");
    expect(state).toBeTruthy();
    await expect(db.select().from(toolOauthStates)).resolves.toEqual([
      expect.objectContaining({
        state,
        connectionId: connectRes.body.connectionId,
        companyId: company.id,
        createdByActorType: "user",
        createdByActorId: "board-user",
        createdBySessionId: null,
      }),
    ]);

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const href = String(url);
      if (href === "https://slack.com/api/oauth.v2.access") {
        const body = init?.body as URLSearchParams;
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(body.get("code")).toBe("oauth-code");
        expect(body.get("client_secret")).toBe("slack-client-secret");
        expect(body.get("code_verifier")).toBeTruthy();
        return {
          ok: true,
          json: async () => ({
            ok: true,
            access_token: "access-token",
            refresh_token: "refresh-token",
            expires_in: 3600,
            token_type: "Bearer",
            scope: "channels:read chat:write search:read",
          }),
        } as Response;
      }
      if (href === "https://mcp.slack.com/mcp") {
        expect(init?.headers).toEqual(expect.objectContaining({ Authorization: "Bearer access-token" }));
        return {
          ok: true,
          json: async () => ({
            jsonrpc: "2.0",
            id: "paperclip-catalog-refresh",
            result: {
              tools: [
                { name: "search_messages", description: "Search messages.", annotations: { readOnlyHint: true } },
                { name: "send_message", description: "Send a message.", annotations: { readOnlyHint: false } },
              ],
            },
          }),
        } as Response;
      }
      throw new Error(`unexpected fetch ${href}`);
    });

    const callbackRes = await request(app)
      .get("/api/tools/oauth/callback")
      .query({ state, code: "oauth-code" });

    expect(callbackRes.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(callbackRes.body.connection).toMatchObject({
      id: connectRes.body.connectionId,
      status: "active",
      enabled: false,
      credentialSecretRefs: [
        expect.objectContaining({ configPath: "oauth.access_token", label: "OAuth access token" }),
        expect.objectContaining({ configPath: "oauth.refresh_token", label: "OAuth refresh token" }),
      ],
    });
    expect(callbackRes.body.actions.readOnly).toEqual([
      expect.objectContaining({ toolName: "search_messages", riskLevel: "read" }),
    ]);
    expect(callbackRes.body.actions.canMakeChanges).toEqual([
      expect.objectContaining({ toolName: "send_message", riskLevel: "write" }),
    ]);
    await expect(db.select().from(toolOauthStates)).resolves.toHaveLength(0);
    await expect(db.select().from(companySecretBindings)).resolves.toHaveLength(3);
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectRes.body.connectionId));
    expect(JSON.stringify(connection.config)).not.toContain("access-token");
    expect(JSON.stringify(connection.config)).not.toContain("refresh-token");
  });

  it("requires non-viewer board access to start OAuth for active app connections", async () => {
    vi.stubEnv("PAPERCLIP_TOOL_OAUTH_SLACK_CLIENT_ID", "slack-client-id");
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const connect = await service.connectGalleryApp(company.id, { galleryKey: "slack", name: "Slack reauth" });
    await db
      .update(toolConnections)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(toolConnections.id, connect.connectionId));

    const viewerApp = createRouteApp(db, boardSessionActor(company.id, "viewer", "viewer-user"));
    await request(viewerApp)
      .post(`/api/tools/oauth/${connect.connectionId}/start`)
      .send({})
      .expect(403);
    await request(viewerApp)
      .post(`/api/companies/${company.id}/tools/apps/connect`)
      .send({ galleryKey: "slack", name: "Viewer Slack" })
      .expect(403);

    const operatorActor = boardSessionActor(company.id, "operator", "operator-user");
    const operatorApp = createRouteApp(db, operatorActor);
    const startRes = await request(operatorApp)
      .post(`/api/tools/oauth/${connect.connectionId}/start`)
      .send({})
      .expect(200);

    const state = new URL(startRes.body.authorizationUrl).searchParams.get("state");
    expect(state).toBeTruthy();
    await expect(db.select().from(toolOauthStates)).resolves.toEqual([
      expect.objectContaining({
        state,
        connectionId: connect.connectionId,
        companyId: company.id,
        createdByActorType: "user",
        createdByActorId: "operator-user",
        createdBySessionId: operatorActor.sessionId,
      }),
    ]);
  });

  it("binds OAuth callback completion to the initiating board session", async () => {
    vi.stubEnv("PAPERCLIP_TOOL_OAUTH_SLACK_CLIENT_ID", "slack-client-id");
    vi.stubEnv("PAPERCLIP_TOOL_OAUTH_SLACK_CLIENT_SECRET", "slack-client-secret");
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const connect = await service.connectGalleryApp(company.id, { galleryKey: "slack", name: "Slack bound" });
    const initiatingActor = boardSessionActor(company.id, "operator", "oauth-operator");
    const initiatingApp = createRouteApp(db, initiatingActor);
    const startRes = await request(initiatingApp)
      .post(`/api/tools/oauth/${connect.connectionId}/start`)
      .send({})
      .expect(200);
    const state = new URL(startRes.body.authorizationUrl).searchParams.get("state")!;

    const anonymousApp = createRouteApp(db, { type: "none", source: "none" });
    await request(anonymousApp)
      .get("/api/tools/oauth/callback")
      .query({ state, code: "oauth-code" })
      .expect(403);

    const otherApp = createRouteApp(db, boardSessionActor(company.id, "operator", "other-operator"));
    await request(otherApp)
      .get("/api/tools/oauth/callback")
      .query({ state, code: "oauth-code" })
      .expect(403);

    const otherSessionSameUserApp = createRouteApp(
      db,
      boardSessionActor(company.id, "operator", "oauth-operator", "other-session"),
    );
    await request(otherSessionSameUserApp)
      .get("/api/tools/oauth/callback")
      .query({ state, code: "oauth-code" })
      .expect(403);

    const downgradedActor = {
      ...initiatingActor,
      companyIds: [company.id],
      memberships: [{ companyId: company.id, membershipRole: "viewer" as const, status: "active" }],
    };
    const downgradedApp = createRouteApp(db, downgradedActor);
    await request(downgradedApp)
      .get("/api/tools/oauth/callback")
      .query({ state, code: "oauth-code" })
      .expect(403);

    await expect(db.select().from(toolOauthStates)).resolves.toHaveLength(1);

    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const href = String(url);
      if (href === "https://slack.com/api/oauth.v2.access") {
        const body = init?.body as URLSearchParams;
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(body.get("code")).toBe("oauth-code");
        return {
          ok: true,
          json: async () => ({
            ok: true,
            access_token: "bound-access-token",
            refresh_token: "bound-refresh-token",
            expires_in: 3600,
            token_type: "Bearer",
          }),
        } as Response;
      }
      if (href === "https://mcp.slack.com/mcp") {
        expect(init?.headers).toEqual(expect.objectContaining({ Authorization: "Bearer bound-access-token" }));
        return {
          ok: true,
          json: async () => ({
            jsonrpc: "2.0",
            id: "paperclip-catalog-refresh",
            result: { tools: [{ name: "search_messages", annotations: { readOnlyHint: true } }] },
          }),
        } as Response;
      }
      throw new Error(`unexpected fetch ${href}`);
    });

    await request(initiatingApp)
      .get("/api/tools/oauth/callback")
      .query({ state, code: "oauth-code" })
      .expect(200);
    await expect(db.select().from(toolOauthStates)).resolves.toHaveLength(0);
  });

  it("refreshes expired OAuth access tokens before remote app calls", async () => {
    vi.stubEnv("PAPERCLIP_TOOL_OAUTH_SLACK_CLIENT_ID", "slack-client-id");
    vi.stubEnv("PAPERCLIP_TOOL_OAUTH_SLACK_CLIENT_SECRET", "slack-client-secret");
    const company = await createCompany(db);
    const service = toolAccessService(db);

    const connect = await service.connectGalleryApp(company.id, { galleryKey: "slack", name: "Slack refresh" });
    const start = await service.startOAuth(company.id, connect.connectionId, {
      redirectUri: "http://paperclip.test/api/tools/oauth/callback",
      actor: { actorType: "user", actorId: "board" },
    });
    const state = new URL(start.authorizationUrl).searchParams.get("state")!;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const href = String(url);
      if (href === "https://slack.com/api/oauth.v2.access") {
        const body = init?.body as URLSearchParams;
        if (body.get("grant_type") === "authorization_code") {
          return {
            ok: true,
            json: async () => ({
              ok: true,
              access_token: "old-access-token",
              refresh_token: "refresh-token",
              expires_in: 3600,
              token_type: "Bearer",
            }),
          } as Response;
        }
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe("refresh-token");
        return {
          ok: true,
          json: async () => ({
            ok: true,
            access_token: "new-access-token",
            refresh_token: "new-refresh-token",
            expires_in: 3600,
            token_type: "Bearer",
          }),
        } as Response;
      }
      if (href === "https://mcp.slack.com/mcp") {
        return {
          ok: true,
          json: async () => ({
            jsonrpc: "2.0",
            id: "paperclip-catalog-refresh",
            result: { tools: [{ name: "search_messages", annotations: { readOnlyHint: true } }] },
          }),
        } as Response;
      }
      throw new Error(`unexpected fetch ${href}`);
    });

    await service.completeOAuthCallback({
      state,
      code: "oauth-code",
      redirectUri: "http://paperclip.test/api/tools/oauth/callback",
      actor: { actorType: "user", actorId: "board" },
    });
    const [connected] = await db.select().from(toolConnections).where(eq(toolConnections.id, connect.connectionId));
    await db
      .update(toolConnections)
      .set({
        config: {
          ...connected.config,
          oauth: {
            ...(connected.config.oauth as Record<string, unknown>),
            expiresAt: "2000-01-01T00:00:00.000Z",
          },
        },
      })
      .where(eq(toolConnections.id, connect.connectionId));

    const health = await service.checkHealth(connect.connectionId);

    expect(health.connection.healthStatus).toBe("ok");
    const fetchCalls = vi.mocked(globalThis.fetch).mock.calls;
    const mcpCalls = fetchCalls.filter(([url]) => String(url) === "https://mcp.slack.com/mcp");
    expect(mcpCalls.at(-1)?.[1]?.headers).toEqual(expect.objectContaining({ Authorization: "Bearer new-access-token" }));
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, connect.connectionId));
    expect(Date.parse(String((connection.config.oauth as { expiresAt: string }).expiresAt))).toBeGreaterThan(Date.now());
  });

  it("returns a callback error when the provider rejects sign-in", async () => {
    const company = await createCompany(db);
    const app = createRouteApp(db, boardSessionActor(company.id, "operator", "operator-user"));

    const res = await request(app)
      .get("/api/tools/oauth/callback")
      .query({ error: "access_denied", error_description: "User declined" });

    expect(res.status).toBe(400);
  });

  it("aggregates app connections needing attention through the board route", async () => {
    const company = await createCompany(db);
    const app = createRouteApp(db);
    const [application] = await db.insert(toolApplications).values({
      companyId: company.id,
      name: `Attention app ${randomUUID()}`,
      type: "mcp_http",
      status: "active",
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: company.id,
      applicationId: application.id,
      name: `Attention connection ${randomUUID()}`,
      transport: "remote_http",
      status: "active",
      enabled: true,
      config: { url: "https://fixture.example/mcp" },
      transportConfig: { url: "https://fixture.example/mcp" },
      healthStatus: "error",
      healthMessage: "Token revoked.",
    }).returning();
    const [ignoredConnection] = await db.insert(toolConnections).values({
      companyId: company.id,
      applicationId: application.id,
      name: `Healthy connection ${randomUUID()}`,
      transport: "remote_http",
      status: "active",
      enabled: true,
      config: { url: "https://healthy.example/mcp" },
      transportConfig: { url: "https://healthy.example/mcp" },
      healthStatus: "ok",
    }).returning();
    const [catalogEntry] = await db.insert(toolCatalogEntries).values({
      companyId: company.id,
      applicationId: application.id,
      connectionId: connection.id,
      name: "send_email",
      toolName: "send_email",
      riskLevel: "write",
      isWrite: true,
      status: "quarantined",
      versionHash: "v1",
      schemaHash: "s1",
      quarantineReason: "pending_review",
      quarantinedAt: new Date(),
    }).returning();
    await db.insert(toolCatalogEntries).values({
      companyId: company.id,
      applicationId: application.id,
      connectionId: ignoredConnection.id,
      name: "search",
      toolName: "search",
      riskLevel: "read",
      isReadOnly: true,
      status: "active",
      versionHash: "v1",
      schemaHash: "s1",
    });
    const [invocation] = await db.insert(toolInvocations).values({
      companyId: company.id,
      applicationId: application.id,
      connectionId: connection.id,
      catalogEntryId: catalogEntry.id,
      toolName: "send_email",
      status: "awaiting_approval",
      approvalState: "pending",
    }).returning();
    await db.insert(toolActionRequests).values({
      companyId: company.id,
      invocationId: invocation.id,
      status: "pending",
      canonicalArgumentsHash: "args-hash",
      canonicalArgumentsSummary: { summary: "redacted", redactedFields: [] },
    });

    const res = await request(app).get(`/api/companies/${company.id}/tools/apps/attention`);

    expect(res.status).toBe(200);
    expect(res.body.totals).toMatchObject({
      connections: 1,
      health: 1,
      quarantinedCatalogEntries: 1,
      pendingActionRequests: 1,
    });
    expect(res.body.apps).toEqual([
      expect.objectContaining({
        connection: expect.objectContaining({ id: connection.id, healthStatus: "error" }),
        healthNeedsAttention: true,
        quarantinedCatalogEntryCount: 1,
        pendingActionRequestCount: 1,
        reasons: ["health", "quarantined_catalog_entries", "pending_action_requests"],
      }),
    ]);
  });

  it("tracks new profile tools, reviews mixed allow/block decisions, and clears pending counts", async () => {
    const company = await createCompany(db);
    const app = createRouteApp(db);
    const [application] = await db.insert(toolApplications).values({
      companyId: company.id,
      name: `Review app ${randomUUID()}`,
      type: "mcp_http",
      status: "active",
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: company.id,
      applicationId: application.id,
      name: `Review connection ${randomUUID()}`,
      transport: "remote_http",
      status: "active",
      enabled: true,
      config: { url: "https://review.example/mcp" },
      transportConfig: { url: "https://review.example/mcp" },
      healthStatus: "ok",
    }).returning();
    const oldSeenAt = new Date("2026-01-01T00:00:00.000Z");
    const profileCreatedAt = new Date("2026-01-02T00:00:00.000Z");
    const newSeenAt = new Date("2026-01-03T00:00:00.000Z");
    const [oldEntry] = await db.insert(toolCatalogEntries).values({
      companyId: company.id,
      applicationId: application.id,
      connectionId: connection.id,
      name: "read_email",
      toolName: "read_email",
      title: "Read email",
      description: "Read mailbox messages.",
      riskLevel: "read",
      isReadOnly: true,
      status: "active",
      versionHash: "old-v1",
      schemaHash: "old-s1",
      firstSeenAt: oldSeenAt,
      lastSeenAt: oldSeenAt,
    }).returning();
    const [sendEntry, deleteEntry] = await db.insert(toolCatalogEntries).values([
      {
        companyId: company.id,
        applicationId: application.id,
        connectionId: connection.id,
        name: "send_email",
        toolName: "send_email",
        title: "Send email",
        description: "Send outbound messages.",
        riskLevel: "write" as const,
        isReadOnly: false,
        isWrite: true,
        status: "active" as const,
        versionHash: "send-v1",
        schemaHash: "send-s1",
        firstSeenAt: newSeenAt,
        lastSeenAt: newSeenAt,
      },
      {
        companyId: company.id,
        applicationId: application.id,
        connectionId: connection.id,
        name: "delete_email",
        toolName: "delete_email",
        title: "Delete email",
        description: "Delete mailbox messages.",
        riskLevel: "destructive" as const,
        isReadOnly: false,
        isDestructive: true,
        status: "active" as const,
        versionHash: "delete-v1",
        schemaHash: "delete-s1",
        firstSeenAt: newSeenAt,
        lastSeenAt: newSeenAt,
      },
    ]).returning();
    const [profile] = await db.insert(toolProfiles).values({
      companyId: company.id,
      profileKey: `review-${randomUUID()}`,
      name: "Read-only starter",
      status: "active",
      defaultAction: "deny",
      createdAt: profileCreatedAt,
      updatedAt: profileCreatedAt,
    }).returning();
    await db.insert(toolProfileEntries).values({
      companyId: company.id,
      profileId: profile.id,
      selectorType: "catalog_entry",
      effect: "include",
      applicationId: application.id,
      connectionId: connection.id,
      catalogEntryId: oldEntry.id,
    });

    const listRes = await request(app).get(`/api/companies/${company.id}/tools/profiles`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.profiles).toContainEqual(expect.objectContaining({
      id: profile.id,
      newToolsPendingCount: 2,
    }));

    const detailRes = await request(app).get(`/api/tool-profiles/${profile.id}/new-tools`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body).toMatchObject({
      profileId: profile.id,
      pendingCount: 2,
      tools: expect.arrayContaining([
        expect.objectContaining({
          catalogEntryId: sendEntry.id,
          toolName: "send_email",
          applicationName: application.name,
          connectionName: connection.name,
          capability: "write",
          addedAt: newSeenAt.toISOString(),
        }),
        expect.objectContaining({
          catalogEntryId: deleteEntry.id,
          capability: "destructive",
        }),
      ]),
    });

    const reviewRes = await request(app)
      .post(`/api/tool-profiles/${profile.id}/new-tools/review`)
      .send({
        decisions: [
          { catalogEntryId: sendEntry.id, decision: "allow" },
          { catalogEntryId: deleteEntry.id, decision: "keep_blocked" },
        ],
      });

    expect(reviewRes.status).toBe(200);
    expect(reviewRes.body).toMatchObject({
      allowedCount: 1,
      keptBlockedCount: 1,
      profile: expect.objectContaining({ id: profile.id, newToolsPendingCount: 0 }),
      entriesCreated: [expect.objectContaining({ catalogEntryId: sendEntry.id, effect: "include" })],
      reviewedCatalogEntryIds: expect.arrayContaining([sendEntry.id, deleteEntry.id]),
    });
    const profileEntries = await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, profile.id));
    expect(profileEntries.some((entry) => entry.catalogEntryId === sendEntry.id && entry.effect === "include")).toBe(true);
    expect(profileEntries.some((entry) => entry.catalogEntryId === deleteEntry.id)).toBe(false);
    const [reviewedProfile] = await db.select().from(toolProfiles).where(eq(toolProfiles.id, profile.id));
    expect(reviewedProfile.newToolsReviewedAt).toBeInstanceOf(Date);

    const afterReviewRes = await request(app).get(`/api/companies/${company.id}/tools/profiles`);
    expect(afterReviewRes.body.profiles).toContainEqual(expect.objectContaining({
      id: profile.id,
      newToolsPendingCount: 0,
    }));
  });

  it("returns addedAt for auto-allowed effective profile tools without pending review state", async () => {
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const [agent] = await db.insert(agents).values({
      companyId: company.id,
      name: "Tool User",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
    }).returning();
    const [application] = await db.insert(toolApplications).values({
      companyId: company.id,
      name: "Auto app",
      type: "mcp_http",
      status: "active",
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: company.id,
      applicationId: application.id,
      name: "Auto connection",
      transport: "remote_http",
      status: "active",
      enabled: true,
      config: { url: "https://auto.example/mcp" },
      transportConfig: { url: "https://auto.example/mcp" },
      healthStatus: "ok",
    }).returning();
    const addedAt = new Date("2026-02-03T00:00:00.000Z");
    const [catalogEntry] = await db.insert(toolCatalogEntries).values({
      companyId: company.id,
      applicationId: application.id,
      connectionId: connection.id,
      name: "auto_allowed",
      toolName: "auto_allowed",
      riskLevel: "write",
      isWrite: true,
      status: "active",
      versionHash: "auto-v1",
      schemaHash: "auto-s1",
      firstSeenAt: addedAt,
      lastSeenAt: addedAt,
    }).returning();
    const [profile] = await db.insert(toolProfiles).values({
      companyId: company.id,
      profileKey: `auto-${randomUUID()}`,
      name: "Auto allow",
      status: "active",
      defaultAction: "allow",
    }).returning();
    await db.insert(toolProfileBindings).values({
      companyId: company.id,
      profileId: profile.id,
      targetType: "company",
      targetId: company.id,
    });

    const effective = await service.getEffectiveProfilesForAgent(company.id, agent.id);

    expect(effective.allowedTools).toContainEqual(expect.objectContaining({
      id: catalogEntry.id,
      addedAt,
      firstSeenAt: addedAt,
    }));
    const profiles = await service.listProfiles(company.id);
    expect(profiles.find((item) => item.id === profile.id)?.newToolsPendingCount).toBe(0);
  });

  it("surfaces and clears profile new-tools attention feed items", async () => {
    const company = await createCompany(db);
    const app = createRouteApp(db);
    const [application] = await db.insert(toolApplications).values({
      companyId: company.id,
      name: "Attention review app",
      type: "mcp_http",
      status: "active",
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: company.id,
      applicationId: application.id,
      name: "Attention review connection",
      transport: "remote_http",
      status: "active",
      enabled: true,
      config: { url: "https://attention-review.example/mcp" },
      transportConfig: { url: "https://attention-review.example/mcp" },
      healthStatus: "ok",
    }).returning();
    const [oldEntry] = await db.insert(toolCatalogEntries).values({
      companyId: company.id,
      applicationId: application.id,
      connectionId: connection.id,
      name: "read_records",
      toolName: "read_records",
      riskLevel: "read",
      isReadOnly: true,
      status: "active",
      versionHash: "read-v1",
      schemaHash: "read-s1",
      firstSeenAt: new Date("2026-03-01T00:00:00.000Z"),
      lastSeenAt: new Date("2026-03-01T00:00:00.000Z"),
    }).returning();
    const [newEntry] = await db.insert(toolCatalogEntries).values({
      companyId: company.id,
      applicationId: application.id,
      connectionId: connection.id,
      name: "write_records",
      toolName: "write_records",
      riskLevel: "write",
      isWrite: true,
      status: "active",
      versionHash: "write-v1",
      schemaHash: "write-s1",
      firstSeenAt: new Date("2026-03-03T00:00:00.000Z"),
      lastSeenAt: new Date("2026-03-03T00:00:00.000Z"),
    }).returning();
    const [profile] = await db.insert(toolProfiles).values({
      companyId: company.id,
      profileKey: `attention-review-${randomUUID()}`,
      name: "Read-only starter",
      status: "active",
      defaultAction: "deny",
      createdAt: new Date("2026-03-02T00:00:00.000Z"),
      updatedAt: new Date("2026-03-02T00:00:00.000Z"),
    }).returning();
    await db.insert(toolProfileEntries).values({
      companyId: company.id,
      profileId: profile.id,
      selectorType: "catalog_entry",
      effect: "include",
      applicationId: application.id,
      connectionId: connection.id,
      catalogEntryId: oldEntry.id,
    });

    const attentionRes = await request(app).get(`/api/companies/${company.id}/tools/apps/attention`);
    expect(attentionRes.status).toBe(200);
    expect(attentionRes.body.totals).toMatchObject({
      connections: 1,
      newToolsPendingReview: 1,
      newToolsPendingProfiles: 1,
    });
    expect(attentionRes.body.apps).toEqual([
      expect.objectContaining({
        connection: expect.objectContaining({ id: connection.id }),
        newToolsPendingReviewCount: 1,
        newToolsPendingProfiles: [expect.objectContaining({
          profileId: profile.id,
          profileName: "Read-only starter",
          pendingCount: 1,
        })],
        reasons: ["profile_new_tools"],
      }),
    ]);

    const reviewRes = await request(app)
      .post(`/api/tool-profiles/${profile.id}/new-tools/review`)
      .send({ decisions: [{ catalogEntryId: newEntry.id, decision: "keep_blocked" }] });
    expect(reviewRes.status).toBe(200);

    const clearedRes = await request(app).get(`/api/companies/${company.id}/tools/apps/attention`);
    expect(clearedRes.body.totals).toMatchObject({
      connections: 0,
      newToolsPendingReview: 0,
      newToolsPendingProfiles: 0,
    });
    expect(clearedRes.body.apps).toEqual([]);
  });

  it("rolls back app connect drafts when health check fails", async () => {
    const company = await createCompany(db);
    const service = toolAccessService(db);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

    await expect(service.connectGalleryApp(company.id, {
      link: "https://broken.example/mcp",
      name: "Broken app",
    }, { actorType: "user", actorId: "board" })).rejects.toMatchObject({ status: 502 });

    await expect(db.select().from(toolApplications)).resolves.toHaveLength(0);
    await expect(db.select().from(toolConnections)).resolves.toHaveLength(0);
    await expect(db.select().from(toolCatalogEntries)).resolves.toHaveLength(0);
  });

  it("reuses and revives an existing application when connecting with applicationId", async () => {
    const company = await createCompany(db);
    const service = toolAccessService(db);
    mockToolsList([
      {
        name: "read_items",
        description: "Read items.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
      },
    ]);

    const first = await service.connectGalleryApp(company.id, {
      link: "https://reuse.example.test/actions",
      name: "Reusable app",
    }, { actorType: "user", actorId: "board" });
    const applicationId = first.application.id;

    // Simulate "Remove app": archive the connection and its application.
    await db.update(toolConnections)
      .set({ status: "archived" })
      .where(eq(toolConnections.id, first.connectionId));
    await db.update(toolApplications)
      .set({ status: "archived", archivedAt: new Date() })
      .where(eq(toolApplications.id, applicationId));

    const second = await service.connectGalleryApp(company.id, {
      link: "https://reuse.example.test/actions",
      name: "Reusable app",
      applicationId,
    }, { actorType: "user", actorId: "board" });

    expect(second.application.id).toBe(applicationId);
    // The archived connection is revived in place, not duplicated.
    expect(second.connectionId).toBe(first.connectionId);
    await expect(db.select().from(toolApplications)).resolves.toHaveLength(1);
    await expect(db.select().from(toolConnections)).resolves.toHaveLength(1);
    const [revived] = await db.select().from(toolApplications).where(eq(toolApplications.id, applicationId));
    expect(revived.status).toBe("draft");
    expect(revived.archivedAt).toBeNull();

    await expect(service.connectGalleryApp(company.id, {
      link: "https://reuse.example.test/actions",
      applicationId: randomUUID(),
    }, { actorType: "user", actorId: "board" })).rejects.toMatchObject({ status: 404 });
  });

  it("does not delete a reused application when the connect rolls back", async () => {
    const company = await createCompany(db);
    const service = toolAccessService(db);
    mockToolsList([
      {
        name: "read_items",
        description: "Read items.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
      },
    ]);
    const first = await service.connectGalleryApp(company.id, {
      link: "https://rollback.example.test/actions",
      name: "Rollback app",
    }, { actorType: "user", actorId: "board" });
    await db.update(toolConnections)
      .set({ status: "archived" })
      .where(eq(toolConnections.id, first.connectionId));
    await db.update(toolApplications)
      .set({ status: "archived", archivedAt: new Date() })
      .where(eq(toolApplications.id, first.application.id));

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    await expect(service.connectGalleryApp(company.id, {
      link: "https://rollback.example.test/actions",
      applicationId: first.application.id,
    }, { actorType: "user", actorId: "board" })).rejects.toMatchObject({ status: 502 });

    const [stillThere] = await db.select().from(toolApplications).where(eq(toolApplications.id, first.application.id));
    expect(stillThere).toBeTruthy();
    expect(stillThere.status).toBe("archived");
    const [connectionBack] = await db.select().from(toolConnections).where(eq(toolConnections.id, first.connectionId));
    expect(connectionBack.status).toBe("archived");
  });

  it("connects pasted links with an optional secret-backed app key", async () => {
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const fetchMock = mockToolsList([
      {
        name: "read_items",
        description: "Read items.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
      },
    ]);

    const connect = await service.connectGalleryApp(company.id, {
      link: "https://links.example.test/actions",
      name: "Linked app",
      credentialValues: { "credentials.authorization": "link-secret" },
    }, { actorType: "user", actorId: "board" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://links.example.test/actions",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer link-secret" }),
      }),
    );
    expect(connect.connection).toMatchObject({
      status: "draft",
      enabled: false,
      config: { url: "https://links.example.test/actions", quarantineNewEntries: true },
      credentialSecretRefs: [
        expect.objectContaining({
          configPath: "credentials.authorization",
          label: "App key",
        }),
      ],
    });
    expect(JSON.stringify(connect.connection.config)).not.toContain("link-secret");
    await expect(db.select().from(companySecrets)).resolves.toHaveLength(1);
    await expect(db.select().from(companySecretBindings)).resolves.toHaveLength(2);
  });

  it("returns a sign-in-required code when a pasted link answers with an OAuth challenge", async () => {
    const company = await createCompany(db);
    const app = createRouteApp(db);
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
      headers: { get: (name: string) => name.toLowerCase() === "www-authenticate" ? "Bearer realm=\"app\"" : null },
      json: async () => ({}),
    } as Response);

    const res = await request(app)
      .post(`/api/companies/${company.id}/tools/apps/connect`)
      .send({ link: "https://signin.example.test/actions", name: "Sign-in app" });

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({
      error: "This app needs you to sign in - coming soon.",
      details: expect.objectContaining({ code: "oauth_challenge" }),
    });
    await expect(db.select().from(toolApplications)).resolves.toHaveLength(0);
    await expect(db.select().from(toolConnections)).resolves.toHaveLength(0);
  });

  it("connects gallery apps and finishes access profiles, bindings, and ask-first policies", async () => {
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const fetchMock = mockToolsList([
      {
        name: "list_zaps",
        description: "List Zapier actions.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
      },
      {
        name: "update_zap",
        description: "Update a Zapier action.",
        inputSchema: { type: "object", properties: { id: { type: "string" } } },
        annotations: { readOnlyHint: false },
      },
    ]);
    const [agent] = await db.insert(agents).values({
      companyId: company.id,
      name: `App Agent ${randomUUID()}`,
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    }).returning();

    const connect = await service.connectGalleryApp(company.id, {
      galleryKey: "zapier",
      name: "Zapier workspace",
      credentialValues: { "credentials.authorization": "zap-secret" },
    }, { actorType: "user", actorId: "board" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://mcp.zapier.com/api/mcp",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer zap-secret" }),
      }),
    );
    expect(connect.connection).toMatchObject({
      status: "draft",
      enabled: false,
      config: expect.objectContaining({ sourceTemplateKey: "zapier", quarantineNewEntries: true }),
      credentialSecretRefs: [
        expect.objectContaining({
          configPath: "credentials.authorization",
          label: "Zapier MCP token",
        }),
      ],
    });
    expect(connect.actions.readOnly).toEqual([
      expect.objectContaining({ toolName: "list_zaps", riskLevel: "read" }),
    ]);
    expect(connect.actions.canMakeChanges).toEqual([
      expect.objectContaining({ toolName: "update_zap", riskLevel: "write" }),
    ]);

    const listEntry = connect.catalog.find((entry) => entry.toolName === "list_zaps")!;
    const updateEntry = connect.catalog.find((entry) => entry.toolName === "update_zap")!;
    expect(connect.catalog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: listEntry.id, status: "active", quarantineReason: null }),
        expect.objectContaining({ id: updateEntry.id, status: "active", quarantineReason: null }),
      ]),
    );
    const finish = await service.finishGalleryAppConnection(company.id, connect.connectionId, {
      enabledCatalogEntryIds: [listEntry.id, updateEntry.id],
      askFirstCatalogEntryIds: [updateEntry.id],
      access: { agentIds: [agent.id] },
    }, { actorType: "user", actorId: "board" });

    expect(finish.connection).toMatchObject({ id: connect.connectionId, status: "active", enabled: true });
    expect(finish.profile).toMatchObject({
      profileKey: `app:${connect.connectionId}`,
      defaultAction: "deny",
      status: "active",
    });
    expect(finish.profileEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ selectorType: "catalog_entry", catalogEntryId: listEntry.id, effect: "include" }),
        expect.objectContaining({ selectorType: "catalog_entry", catalogEntryId: updateEntry.id, effect: "include" }),
      ]),
    );
    expect(finish.profileBindings).toEqual([
      expect.objectContaining({ targetType: "agent", targetId: agent.id }),
    ]);
    expect(finish.policies).toEqual([
      expect.objectContaining({
        policyType: "require_approval",
        enabled: true,
        selectors: { catalogEntryId: updateEntry.id },
      }),
    ]);
    const finishedCatalog = await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, connect.connectionId));
    expect(finishedCatalog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: listEntry.id, status: "active", reviewedAt: expect.any(Date), quarantineReason: null }),
        expect.objectContaining({ id: updateEntry.id, status: "active", reviewedAt: expect.any(Date), quarantineReason: null }),
      ]),
    );

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        jsonrpc: "2.0",
        id: "paperclip-catalog-refresh",
        result: {
          tools: [
            {
              name: "list_zaps",
              description: "List Zapier actions.",
              inputSchema: { type: "object", properties: {} },
              annotations: { readOnlyHint: true },
            },
            {
              name: "update_zap",
              description: "Update a Zapier action with new args.",
              inputSchema: { type: "object", properties: { id: { type: "string" }, label: { type: "string" } } },
              annotations: { readOnlyHint: false },
            },
            {
              name: "create_zap",
              description: "Create a Zapier action.",
              inputSchema: { type: "object", properties: { label: { type: "string" } } },
              annotations: { readOnlyHint: false },
            },
          ],
        },
      }),
    } as Response);
    const rereview = await service.refreshCatalog(connect.connectionId, { actorType: "user", actorId: "board" });
    expect(rereview.quarantinedCount).toBe(2);
    expect(rereview.catalog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolName: "list_zaps", status: "active" }),
        expect.objectContaining({ toolName: "update_zap", status: "quarantined", quarantineReason: "pending_review" }),
        expect.objectContaining({ toolName: "create_zap", status: "quarantined", quarantineReason: "pending_review" }),
      ]),
    );

    const [policy] = await db.select().from(toolPolicies).where(eq(toolPolicies.companyId, company.id));
    expect(policy).toMatchObject({
      policyType: "require_approval",
      selectors: { catalogEntryId: updateEntry.id },
      config: expect.objectContaining({
        source: "app_gallery_finish",
        connectionId: connect.connectionId,
        catalogEntryId: updateEntry.id,
      }),
    });
  });

  it("reconnects a gallery app by rotating the existing credential in place (PAP-10859)", async () => {
    const company = await createCompany(db);
    const service = toolAccessService(db);
    mockToolsList([
      { name: "list_zaps", description: "List", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
    ]);

    const connect = await service.connectGalleryApp(company.id, {
      galleryKey: "zapier",
      name: "Zapier reconnect",
      credentialValues: { "credentials.authorization": "old-secret" },
    }, { actorType: "user", actorId: "board" });

    const before = await service.getConnection(connect.connectionId, company.id);
    const beforeRef = before.credentialSecretRefs.find((r) => r.configPath === "credentials.authorization")!;
    expect(beforeRef).toBeDefined();

    await expect(
      service.reconnectGalleryApp(connect.connectionId, company.id, { credentialValues: {} }, { actorType: "user", actorId: "board" }),
    ).rejects.toMatchObject({ message: expect.stringContaining("Paste a new key") });

    const result = await service.reconnectGalleryApp(
      connect.connectionId,
      company.id,
      { credentialValues: { "credentials.authorization": "new-secret" } },
      { actorType: "user", actorId: "board" },
    );
    expect(result.connection.id).toBe(connect.connectionId);

    const after = await service.getConnection(connect.connectionId, company.id);
    const afterRef = after.credentialSecretRefs.find((r) => r.configPath === "credentials.authorization")!;
    // Rotated in place: same secret, no duplicate ref created.
    expect(after.credentialSecretRefs).toHaveLength(before.credentialSecretRefs.length);
    expect(afterRef.secretId).toBe(beforeRef.secretId);
  });

  it("stops and restarts local stdio runtime slots through the board service", async () => {
    const company = await createCompany(db);
    const service = toolAccessService(db, { now: () => new Date("2026-06-06T01:00:00.000Z") });

    const connection = await service.createConnection(company.id, {
      name: "Restartable local fixture",
      transport: "local_stdio",
      config: { templateId: "paperclip.echo-calculator-time" },
      enabled: true,
      status: "active",
    });
    const health = await service.checkHealth(connection.id);
    expect(health.runtimeSlot).toMatchObject({
      connectionId: connection.id,
      status: "stopped",
      runtimeKind: "local_stdio",
    });

    const restarted = await service.restartRuntimeSlot(company.id, health.runtimeSlot!.id, {
      actorType: "user",
      actorId: "board-user",
    });
    expect(restarted).toMatchObject({
      id: health.runtimeSlot!.id,
      status: "running",
      runtimeKind: "local_stdio",
      healthStatus: "ok",
    });
    expect(restarted.providerRef).toMatch(/^local-stdio:/);

    const stopped = await service.stopRuntimeSlot(company.id, health.runtimeSlot!.id, {
      actorType: "user",
      actorId: "board-user",
    });
    expect(stopped).toMatchObject({
      id: health.runtimeSlot!.id,
      status: "stopped",
      healthMessage: "Runtime slot stopped.",
    });

    const activities = await db.select().from(activityLog);
    expect(activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorType: "user",
          actorId: "board-user",
          action: "tool_runtime_slot.operator_restarted",
          entityId: health.runtimeSlot!.id,
        }),
        expect.objectContaining({
          actorType: "user",
          actorId: "board-user",
          action: "tool_runtime_slot.operator_stopped",
          entityId: health.runtimeSlot!.id,
        }),
      ]),
    );
  });

  it("exposes board runtime slot stop and restart endpoints", async () => {
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const app = createRouteApp(db);
    const connection = await service.createConnection(company.id, {
      name: "Route local fixture",
      transport: "local_stdio",
      config: { templateId: "paperclip.echo-calculator-time" },
      enabled: true,
      status: "active",
    });
    const health = await service.checkHealth(connection.id);
    const slotId = health.runtimeSlot!.id;

    const restart = await request(app)
      .post(`/api/companies/${company.id}/tools/runtime-slots/${slotId}/restart`)
      .send({});

    expect(restart.status).toBe(200);
    expect(restart.body).toMatchObject({
      id: slotId,
      companyId: company.id,
      runtimeKind: "local_stdio",
      status: "running",
    });

    const stop = await request(app)
      .post(`/api/companies/${company.id}/tools/runtime-slots/${slotId}/stop`)
      .send({});

    expect(stop.status).toBe(200);
    expect(stop.body).toMatchObject({
      id: slotId,
      companyId: company.id,
      runtimeKind: "local_stdio",
      status: "stopped",
    });
  });

  it("updates tool applications through the board route and records activity", async () => {
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const app = createRouteApp(db);
    const application = await service.createApplication(company.id, {
      name: "Editable app",
      description: "Before",
      type: "mcp_http",
    });

    const res = await request(app)
      .patch(`/api/tool-applications/${application.id}`)
      .send({ name: "Edited app", description: "After" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: application.id,
      companyId: company.id,
      name: "Edited app",
      description: "After",
      type: "mcp_http",
    });
    const activities = await db.select().from(activityLog).where(eq(activityLog.entityId, application.id));
    expect(activities).toEqual([
      expect.objectContaining({
        action: "tool_application.updated",
        companyId: company.id,
        details: expect.objectContaining({ name: "Edited app" }),
      }),
    ]);
  });

  it("returns 409 instead of 500 when an application update collides with a duplicate name", async () => {
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const app = createRouteApp(db);
    await service.createApplication(company.id, { name: "Existing app", type: "mcp_http" });
    const application = await service.createApplication(company.id, { name: "Editable app", type: "mcp_http" });

    const res = await request(app)
      .patch(`/api/tool-applications/${application.id}`)
      .send({ name: "Existing app" });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: "A tool access record with that name already exists",
    });
  });

  it("returns 403 for cross-company application updates and 404 for missing applications", async () => {
    const allowedCompany = await createCompany(db);
    const otherCompany = await createCompany(db);
    const application = await toolAccessService(db).createApplication(otherCompany.id, {
      name: "Other company app",
      type: "mcp_http",
    });
    const app = createRouteApp(db, {
      type: "board",
      userId: "member-user",
      userName: "Member User",
      userEmail: null,
      companyIds: [allowedCompany.id],
      memberships: [
        {
          companyId: allowedCompany.id,
          membershipRole: "owner",
          status: "active",
        },
      ],
      isInstanceAdmin: false,
      source: "session",
    });

    const forbiddenRes = await request(app)
      .patch(`/api/tool-applications/${application.id}`)
      .send({ name: "Forbidden edit" });
    const missingRes = await request(createRouteApp(db))
      .patch(`/api/tool-applications/${randomUUID()}`)
      .send({ name: "Missing edit" });

    expect(forbiddenRes.status).toBe(403);
    expect(missingRes.status).toBe(404);
  });

  it("deletes an application with zero connections and records activity", async () => {
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const app = createRouteApp(db);
    const application = await service.createApplication(company.id, {
      name: "Deletable app",
      type: "mcp_http",
    });

    const res = await request(app).delete(`/api/tool-applications/${application.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: application.id, name: "Deletable app" });
    const remaining = await db
      .select()
      .from(toolApplications)
      .where(eq(toolApplications.id, application.id));
    expect(remaining).toHaveLength(0);
    const activities = await db.select().from(activityLog).where(eq(activityLog.entityId, application.id));
    expect(activities).toEqual([
      expect.objectContaining({
        action: "tool_application.deleted",
        companyId: company.id,
        details: expect.objectContaining({ name: "Deletable app", type: "mcp_http" }),
      }),
    ]);
  });

  it("returns 409 and keeps the application when it still has connections", async () => {
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const app = createRouteApp(db);
    const connection = await service.createConnection(company.id, {
      name: "Guarded connection",
      transport: "remote_http",
      config: { url: "https://fixture.example/mcp" },
    });

    const res = await request(app).delete(`/api/tool-applications/${connection.applicationId}`);

    expect(res.status).toBe(409);
    expect(String(res.body.error)).toMatch(/connection/i);
    const remaining = await db
      .select()
      .from(toolApplications)
      .where(eq(toolApplications.id, connection.applicationId));
    expect(remaining).toHaveLength(1);
  });

  it("archives the application when its last connection is removed", async () => {
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const app = createRouteApp(db);
    const connection = await service.createConnection(company.id, {
      name: "Single connection",
      transport: "remote_http",
      config: { url: "https://fixture.example/mcp" },
      status: "active",
      enabled: true,
    });

    const res = await request(app).delete(`/api/tool-connections/${connection.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: connection.id, status: "archived", enabled: false });

    const [application] = await db
      .select()
      .from(toolApplications)
      .where(eq(toolApplications.id, connection.applicationId));
    expect(application).toMatchObject({ status: "archived" });
    expect(application?.archivedAt).toBeInstanceOf(Date);

    const activities = await db.select().from(activityLog).where(eq(activityLog.companyId, company.id));
    expect(activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "tool_connection.archived",
          entityId: connection.id,
        }),
        expect.objectContaining({
          action: "tool_application.archived",
          entityId: connection.applicationId,
          details: expect.objectContaining({ reason: "last_connection_removed" }),
        }),
      ]),
    );
  });

  it("keeps the application active when another connection remains", async () => {
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const app = createRouteApp(db);
    const application = await service.createApplication(company.id, {
      name: "Shared app",
      type: "mcp_http",
    });
    const first = await service.createConnection(company.id, {
      applicationId: application.id,
      name: "First connection",
      transport: "remote_http",
      config: { url: "https://one.example/mcp" },
      status: "active",
      enabled: true,
    });
    await service.createConnection(company.id, {
      applicationId: application.id,
      name: "Second connection",
      transport: "remote_http",
      config: { url: "https://two.example/mcp" },
      status: "active",
      enabled: true,
    });

    const res = await request(app).delete(`/api/tool-connections/${first.id}`);

    expect(res.status).toBe(200);
    const [remainingApplication] = await db
      .select()
      .from(toolApplications)
      .where(eq(toolApplications.id, application.id));
    expect(remainingApplication).toMatchObject({ status: "active", archivedAt: null });
    const activities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, application.id));
    expect(activities.some((activity) => activity.action === "tool_application.archived")).toBe(false);
  });

  it("fails closed at the database when a connection races an application delete (no silent cascade)", async () => {
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const connection = await service.createConnection(company.id, {
      name: "Racy connection",
      transport: "remote_http",
      config: { url: "https://fixture.example/mcp" },
    });

    // Simulate the delete-vs-create race: skip the endpoint's "any connections?" pre-check and
    // issue the raw DELETE it would run afterwards, standing in for a connection created in the
    // gap. Under the old ON DELETE CASCADE schema this silently removed the linked connection;
    // the hardened ON DELETE NO ACTION FK must reject it so the delete can never become an
    // implicit cascade.
    await expect(
      db.delete(toolApplications).where(eq(toolApplications.id, connection.applicationId)),
    ).rejects.toThrow();

    const remainingApp = await db
      .select()
      .from(toolApplications)
      .where(eq(toolApplications.id, connection.applicationId));
    const remainingConnection = await db
      .select()
      .from(toolConnections)
      .where(eq(toolConnections.id, connection.id));
    expect(remainingApp).toHaveLength(1);
    expect(remainingConnection).toHaveLength(1);
  });

  it("still cascades application + connection deletes when the owning company is removed", async () => {
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const connection = await service.createConnection(company.id, {
      name: "Company-scoped connection",
      transport: "remote_http",
      config: { url: "https://fixture.example/mcp" },
    });

    // NO ACTION (not RESTRICT) must keep the company teardown cascade intact: deleting the
    // company cascades to both tool_applications and tool_connections in one statement, and the
    // end-of-statement FK check passes because the connection is already gone. RESTRICT would
    // abort this delete mid-cascade.
    await db.delete(companies).where(eq(companies.id, company.id));

    const remainingApp = await db
      .select()
      .from(toolApplications)
      .where(eq(toolApplications.id, connection.applicationId));
    const remainingConnection = await db
      .select()
      .from(toolConnections)
      .where(eq(toolConnections.id, connection.id));
    expect(remainingApp).toHaveLength(0);
    expect(remainingConnection).toHaveLength(0);
  });

  it("returns 403 for cross-company application deletes and 404 for missing applications", async () => {
    const allowedCompany = await createCompany(db);
    const otherCompany = await createCompany(db);
    const application = await toolAccessService(db).createApplication(otherCompany.id, {
      name: "Other company app",
      type: "mcp_http",
    });
    const app = createRouteApp(db, {
      type: "board",
      userId: "member-user",
      userName: "Member User",
      userEmail: null,
      companyIds: [allowedCompany.id],
      memberships: [
        {
          companyId: allowedCompany.id,
          membershipRole: "owner",
          status: "active",
        },
      ],
      isInstanceAdmin: false,
      source: "session",
    });

    const forbiddenRes = await request(app).delete(`/api/tool-applications/${application.id}`);
    const missingRes = await request(createRouteApp(db)).delete(`/api/tool-applications/${randomUUID()}`);

    expect(forbiddenRes.status).toBe(403);
    expect(missingRes.status).toBe(404);
    const stillThere = await db
      .select()
      .from(toolApplications)
      .where(eq(toolApplications.id, application.id));
    expect(stillThere).toHaveLength(1);
  });

  it("links run tool decisions to invocations, audit events, and pending action requests", async () => {
    const company = await createCompany(db);
    const [agent] = await db.insert(agents).values({
      companyId: company.id,
      name: `Tool runner ${randomUUID()}`,
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    }).returning();
    const [issue] = await db.insert(issues).values({
      companyId: company.id,
      title: `Tool approval ${randomUUID()}`,
      status: "in_progress",
    }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: company.id,
      agentId: agent.id,
      invocationSource: "assignment",
      status: "running",
    }).returning();
    const [application] = await db.insert(toolApplications).values({
      companyId: company.id,
      name: "Governed tools",
      type: "mcp_http",
      status: "active",
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: company.id,
      applicationId: application.id,
      name: "Remote MCP",
      transport: "remote_http",
      status: "active",
      enabled: true,
      config: { url: "https://example.invalid/mcp" },
    }).returning();
    const [catalogEntry] = await db.insert(toolCatalogEntries).values({
      companyId: company.id,
      applicationId: application.id,
      connectionId: connection.id,
      name: "send_email",
      toolName: "send_email",
      riskLevel: "write",
      versionHash: randomUUID(),
      schemaHash: randomUUID(),
    }).returning();
    const [invocation] = await db.insert(toolInvocations).values({
      companyId: company.id,
      actorType: "agent",
      actorId: agent.id,
      agentId: agent.id,
      issueId: issue.id,
      runId: run.id,
      applicationId: application.id,
      connectionId: connection.id,
      catalogEntryId: catalogEntry.id,
      toolName: "send_email",
      argumentsHash: "abc123",
      argumentsSummary: { summary: "{\"to\":\"redacted\"}", sha256: "abc123", sizeBytes: 18 },
      policyDecision: "require_approval",
      approvalState: "pending",
      status: "awaiting_approval",
    }).returning();
    const [interaction] = await db.insert(issueThreadInteractions).values({
      companyId: company.id,
      issueId: issue.id,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee_on_accept",
      title: "Approve tool action",
      summary: "send_email requires approval.",
      createdByAgentId: agent.id,
      payload: {
        version: 1,
        prompt: "Approve send_email?",
        acceptLabel: "Approve action",
        rejectLabel: "Reject action",
        target: { type: "custom", key: "tool-action:test", revisionId: "abc123", label: "send_email" },
      },
    }).returning();
    const [actionRequest] = await db.insert(toolActionRequests).values({
      companyId: company.id,
      invocationId: invocation.id,
      issueId: issue.id,
      interactionId: interaction.id,
      status: "pending",
      canonicalArgumentsHash: "abc123",
      canonicalArgumentsSummary: { summary: "{\"to\":\"redacted\"}", sha256: "abc123", sizeBytes: 18 },
      previewMarkdown: "Tool: `send_email`",
      requestedByAgentId: agent.id,
    }).returning();
    const [auditEvent] = await db.insert(toolCallEvents).values({
      companyId: company.id,
      eventType: "approval_requested",
      actorType: "agent",
      actorId: agent.id,
      agentId: agent.id,
      runId: run.id,
      issueId: issue.id,
      applicationId: application.id,
      connectionId: connection.id,
      catalogEntryId: catalogEntry.id,
      invocationId: invocation.id,
      actionRequestId: actionRequest.id,
      toolName: "send_email",
      decision: "require_approval",
      outcome: "pending",
      reasonCode: "requires_approval_policy",
      requestHash: "abc123",
      requestSummary: { summary: "{\"to\":\"redacted\"}", sha256: "abc123", sizeBytes: 18 },
      metadata: { interactionId: interaction.id },
    }).returning();

    const lookup = await toolAccessService(db).getRunDecisionLookup(company.id, run.id);

    expect(lookup).toMatchObject({
      runId: run.id,
      decisions: [
        {
          invocation: expect.objectContaining({ id: invocation.id, runId: run.id, toolName: "send_email" }),
          actionRequest: expect.objectContaining({ id: actionRequest.id, status: "pending" }),
          latestAuditEvent: expect.objectContaining({ id: auditEvent.id, actionRequestId: actionRequest.id }),
          decision: "require_approval",
          reasonCode: "requires_approval_policy",
          pendingAction: expect.objectContaining({
            actionRequestId: actionRequest.id,
            interactionId: interaction.id,
            previewMarkdown: "Tool: `send_email`",
          }),
        },
      ],
    });
  });

  it("enriches connection activity with issue and approval resolver context", async () => {
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const [agent] = await db.insert(agents).values({
      companyId: company.id,
      name: "CodexCoder",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
    }).returning();
    const [application] = await db.insert(toolApplications).values({
      companyId: company.id,
      name: "GitHub",
      type: "mcp_http",
      status: "active",
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: company.id,
      applicationId: application.id,
      name: "GitHub",
      transport: "remote_http",
      status: "active",
      enabled: true,
      config: { url: "https://github.example/mcp" },
      transportConfig: { url: "https://github.example/mcp" },
    }).returning();
    const [issue] = await db.insert(issues).values({
      companyId: company.id,
      title: "Fix app connection copy",
      status: "in_progress",
      identifier: "PAP-10912",
      assigneeAgentId: agent.id,
    }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: company.id,
      agentId: agent.id,
      invocationSource: "assignment",
      status: "running",
      startedAt: new Date("2026-06-12T10:00:00Z"),
    }).returning();
    const [catalogEntry] = await db.insert(toolCatalogEntries).values({
      companyId: company.id,
      applicationId: application.id,
      connectionId: connection.id,
      name: "mark_done",
      toolName: "mark_done",
      title: "Mark done",
      riskLevel: "write",
      isWrite: true,
      status: "active",
      versionHash: "v1",
      schemaHash: "s1",
    }).returning();
    const [invocation] = await db.insert(toolInvocations).values({
      companyId: company.id,
      actorType: "agent",
      actorId: agent.id,
      agentId: agent.id,
      issueId: issue.id,
      runId: run.id,
      applicationId: application.id,
      connectionId: connection.id,
      catalogEntryId: catalogEntry.id,
      toolName: "Mark done",
      policyDecision: "require_approval",
      approvalState: "approved",
      status: "completed",
    }).returning();
    await db.insert(authUsers).values({
      id: "board-user",
      name: "Dotta",
      email: "dotta@example.com",
      emailVerified: true,
      createdAt: new Date("2026-06-12T09:00:00Z"),
      updatedAt: new Date("2026-06-12T09:00:00Z"),
    });
    const [actionRequest] = await db.insert(toolActionRequests).values({
      companyId: company.id,
      invocationId: invocation.id,
      issueId: issue.id,
      status: "approved",
      canonicalArgumentsHash: "abc123",
      canonicalArgumentsSummary: { summary: "{}", sha256: "abc123", sizeBytes: 2 },
      requestedByAgentId: agent.id,
      resolvedByUserId: "board-user",
      resolvedAt: new Date("2026-06-12T10:05:00Z"),
    }).returning();
    await db.insert(toolCallEvents).values([
      {
        companyId: company.id,
        eventType: "call_completed",
        actorType: "agent",
        actorId: agent.id,
        agentId: agent.id,
        runId: run.id,
        issueId: issue.id,
        applicationId: application.id,
        connectionId: connection.id,
        catalogEntryId: catalogEntry.id,
        invocationId: invocation.id,
        toolName: "Get value",
        decision: "allow",
        outcome: "success",
        createdAt: new Date("2026-06-12T10:04:00Z"),
      },
      {
        companyId: company.id,
        eventType: "approval_resolved",
        actorType: "agent",
        actorId: agent.id,
        agentId: agent.id,
        runId: run.id,
        issueId: issue.id,
        applicationId: application.id,
        connectionId: connection.id,
        catalogEntryId: catalogEntry.id,
        invocationId: invocation.id,
        actionRequestId: actionRequest.id,
        toolName: "Mark done",
        decision: "require_approval",
        outcome: "success",
        createdAt: new Date("2026-06-12T10:06:00Z"),
      },
    ]);

    const activity = await service.listConnectionActivity(connection.id, company.id, 10);

    expect(activity.events.map((event) => event.eventType)).toEqual(["approval_resolved", "call_completed"]);
    expect(activity.issues[issue.id]).toEqual({
      identifier: "PAP-10912",
      title: "Fix app connection copy",
    });
    expect(activity.actionRequests[actionRequest.id]).toEqual({
      status: "approved",
      resolverDisplayName: "Dotta",
      resolvedByAgentId: null,
      resolvedByUserId: "board-user",
    });
  });

  it("rejects runtime controls for non-local runtime kinds", async () => {
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const [application] = await db.insert(toolApplications).values({
      companyId: company.id,
      name: "Remote app",
      type: "mcp_http",
      status: "active",
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: company.id,
      applicationId: application.id,
      name: "Remote runtime",
      transport: "remote_http",
      status: "active",
      enabled: true,
      config: { url: "https://fixture.example/mcp" },
      transportConfig: { url: "https://fixture.example/mcp" },
    }).returning();
    const [slot] = await db.insert(toolRuntimeSlots).values({
      companyId: company.id,
      applicationId: application.id,
      connectionId: connection.id,
      slotKey: `${connection.id}:remote`,
      ownerScopeType: "connection",
      ownerScopeId: connection.id,
      runtimeKind: "remote_http",
      status: "running",
      reuseKey: connection.id,
      provider: "paperclip",
      providerRef: "remote:https://fixture.example/mcp",
      healthStatus: "ok",
    }).returning();

    await expect(service.stopRuntimeSlot(company.id, slot.id, { actorType: "user", actorId: "board-user" }))
      .rejects.toMatchObject({
        status: 422,
        details: expect.objectContaining({
          code: "runtime_control_unsupported",
          runtimeKind: "remote_http",
        }),
      });
  });

  it("summarizes runtime health and flags stale slots plus degraded connections", async () => {
    const company = await createCompany(db);
    const generatedAt = new Date("2026-06-06T00:00:00.000Z");
    const service = toolAccessService(db, {
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      trustedLocalStdioRuntimeHost: null,
      now: () => generatedAt,
    });
    const [application] = await db.insert(toolApplications).values({
      companyId: company.id,
      name: "Local stdio fixture",
      type: "mcp_stdio",
      status: "active",
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: company.id,
      applicationId: application.id,
      name: "Degraded local stdio",
      transport: "local_stdio",
      status: "active",
      enabled: true,
      config: { templateId: "paperclip.echo-calculator-time" },
      transportConfig: { templateId: "paperclip.echo-calculator-time" },
      healthStatus: "missing_secret",
      healthMessage: "A configured credential secret could not be resolved.",
    }).returning();
    const staleAt = new Date(generatedAt.getTime() - 10 * 60 * 1000);
    await db.insert(toolRuntimeSlots).values({
      companyId: company.id,
      applicationId: application.id,
      connectionId: connection.id,
      slotKey: `${connection.id}:paperclip.echo-calculator-time`,
      ownerScopeType: "connection",
      ownerScopeId: connection.id,
      runtimeKind: "local_stdio",
      status: "running",
      reuseKey: connection.id,
      provider: "paperclip",
      providerRef: "local-stdio:test-host:slot",
      commandTemplateKey: "paperclip.echo-calculator-time",
      healthStatus: "ok",
      startedAt: staleAt,
      lastUsedAt: staleAt,
      updatedAt: staleAt,
    });
    await db.insert(toolAccessAuditEvents).values([
      {
        companyId: company.id,
        action: "runtime_deferred",
        outcome: "failure",
        reasonCode: "runtime_host_capacity_exhausted",
        details: { durationMs: 250 },
        createdAt: generatedAt,
      },
      {
        companyId: company.id,
        action: "runtime_restart_suppressed",
        outcome: "failure",
        reasonCode: "runtime_restart_suppressed",
        details: {},
        createdAt: generatedAt,
      },
    ]);
    await db.insert(toolCallEvents).values([
      {
        companyId: company.id,
        eventType: "call_failed",
        outcome: "timeout",
        toolName: "mcp-stdio-fixture:increment_counter",
        createdAt: generatedAt,
      },
      {
        companyId: company.id,
        eventType: "call_completed",
        outcome: "success",
        toolName: "mcp-stdio-fixture:runtime_status",
        createdAt: generatedAt,
      },
    ]);

    const health = await service.getRuntimeHealth(company.id);

    expect(health.status).toBe("critical");
    expect(health.supportMatrix.localStdio.supported).toBe(false);
    expect(health.metrics).toMatchObject({
      activeSlots: 1,
      runningSlots: 1,
      stuckRunningSlots: 1,
      capacityDeferralsLastHour: 1,
      restartSuppressionsLastHour: 1,
      toolCallsLastHour: 2,
      toolTimeoutsLastHour: 1,
      timeoutRateLastHour: 50,
      degradedConnections: 1,
      localStdioConnections: 1,
    });
    expect(health.alerts.map((alert) => alert.name)).toEqual(
      expect.arrayContaining([
        "mcp_runtime_stuck_running_slot",
        "mcp_runtime_restart_storm",
        "mcp_runtime_connection_health_degraded",
      ]),
    );
    expect(health.recommendations.find((alert) => alert.name === "mcp_runtime_audit_write_failures"))
      .toMatchObject({ status: "not_instrumented" });
  });

  it("rejects enabled local stdio connections in public hosted mode without a trusted runtime host", async () => {
    const company = await createCompany(db);
    const hostedService = toolAccessService(db, {
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      trustedLocalStdioRuntimeHost: null,
    });

    await expect(hostedService.createConnection(company.id, {
      name: "Hosted local stdio",
      transport: "local_stdio",
      config: { templateId: "paperclip.echo-calculator-time" },
      enabled: true,
      status: "active",
    })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("cannot be enabled"),
    });

    const trustedService = toolAccessService(db, {
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      trustedLocalStdioRuntimeHost: "trusted-worker-1",
    });
    await expect(trustedService.createConnection(company.id, {
      name: "Trusted hosted local stdio",
      transport: "local_stdio",
      config: { templateId: "paperclip.echo-calculator-time" },
      enabled: true,
      status: "active",
    })).resolves.toMatchObject({
      transport: "local_stdio",
      enabled: true,
    });
  });

  it("previews mcp.json imports as draft managed connection records without carrying raw header values", async () => {
    const company = await createCompany(db);
    const preview = await toolAccessService(db).previewMcpJsonImport({
      mcpJson: {
        mcpServers: {
          github: {
            url: "https://mcp.example/github",
            headers: { Authorization: "Bearer should-not-be-stored" },
          },
          local: {
            command: "npx",
            args: ["-y", "@example/local-mcp"],
          },
        },
      },
    });

    expect(company.id).toBeTruthy();
    expect(JSON.stringify(preview)).not.toContain("should-not-be-stored");
    expect(preview.drafts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "github",
          transport: "remote_http",
          status: "draft",
          config: { url: "https://mcp.example/github" },
          warnings: [expect.stringContaining("Paperclip secret")],
        }),
        expect.objectContaining({
          name: "local",
          transport: "local_stdio",
          status: "draft",
          config: { importedCommand: "npx", importedArgs: ["-y", "@example/local-mcp"] },
          warnings: [expect.stringContaining("approved Paperclip template")],
        }),
      ]),
    );
  });

  it("fails closed when credential secrets cannot be resolved and writes value-free audit", async () => {
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const connection = await service.createConnection(company.id, {
      name: "Secret-backed remote",
      transport: "remote_http",
      config: { url: "https://fixture.example/mcp" },
      enabled: true,
      status: "active",
    });
    await db
      .update(toolConnections)
      .set({
        credentialRefs: [
          {
            name: "authorization",
            secretId: randomUUID(),
            version: "latest",
            placement: "header",
            key: "Authorization",
            prefix: "Bearer ",
          },
        ],
      })
      .where(eq(toolConnections.id, connection.id));

    await expect(service.checkHealth(connection.id, { actorType: "user", actorId: "board" })).rejects.toMatchObject({
      status: 422,
      details: expect.objectContaining({ code: "secret_missing" }),
    });
    const [updatedConnection] = await db.select().from(toolConnections).where(eq(toolConnections.id, connection.id));
    const [audit] = await db.select().from(toolAccessAuditEvents);

    expect(updatedConnection).toMatchObject({
      healthStatus: "missing_secret",
      healthMessage: "A configured credential secret could not be resolved.",
    });
    expect(audit).toMatchObject({
      action: "tool_connection.health_check",
      outcome: "failure",
      reasonCode: "secret_missing",
      details: { status: "missing_secret", transport: "remote_http" },
    });
    expect(JSON.stringify(audit)).not.toContain("Bearer ");
    expect(JSON.stringify(audit)).not.toContain("Authorization");
  });

  it("sweeps enabled active connection health and records failing connections", async () => {
    const company = await createCompany(db);
    const service = toolAccessService(db);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("revoked token"));
    const connection = await service.createConnection(company.id, {
      name: "Swept remote",
      transport: "remote_http",
      config: { url: "https://fixture.example/mcp" },
      enabled: true,
      status: "active",
    });

    const sweep = await service.sweepConnectionHealth({ staleAfterMs: 0 });
    const [updatedConnection] = await db.select().from(toolConnections).where(eq(toolConnections.id, connection.id));

    expect(sweep).toMatchObject({
      checked: 1,
      healthy: 0,
      failed: 1,
      failedConnectionIds: [connection.id],
    });
    expect(updatedConnection).toMatchObject({
      healthStatus: "error",
      healthMessage: "revoked token",
      lastError: "revoked token",
    });
  });

  it("enriches listConnections with lastUsedAt from the most recent tool-call event", async () => {
    const company = await createCompany(db);
    const service = toolAccessService(db);

    const used = await service.createConnection(company.id, {
      name: "Used remote",
      transport: "remote_http",
      config: { url: "https://used.example/mcp" },
      enabled: true,
      status: "active",
    });
    const unused = await service.createConnection(company.id, {
      name: "Unused remote",
      transport: "remote_http",
      config: { url: "https://unused.example/mcp" },
      enabled: true,
      status: "active",
    });

    const older = new Date("2026-06-01T00:00:00.000Z");
    const newest = new Date("2026-06-09T12:30:00.000Z");
    await db.insert(toolCallEvents).values([
      {
        companyId: company.id,
        eventType: "call_completed",
        connectionId: used.id,
        toolName: "search_notes",
        outcome: "success",
        createdAt: older,
      },
      {
        companyId: company.id,
        eventType: "call_completed",
        connectionId: used.id,
        toolName: "search_notes",
        outcome: "success",
        createdAt: newest,
      },
    ]);

    const connections = await service.listConnections(company.id);
    const usedRow = connections.find((connection) => connection.id === used.id);
    const unusedRow = connections.find((connection) => connection.id === unused.id);

    expect(new Date(usedRow!.lastUsedAt!).toISOString()).toBe(newest.toISOString());
    expect(unusedRow!.lastUsedAt).toBeNull();
  });
});

describe("classifyRisk", () => {
  const risk = (name: string, annotations?: Record<string, unknown>) =>
    classifyRisk({ name, annotations });

  it("classifies unprefixed write verbs as write", () => {
    expect(risk("create_widget")).toBe("write");
    expect(risk("update_zap")).toBe("write");
    expect(risk("send_message")).toBe("write");
    expect(risk("set_value")).toBe("write");
  });

  it("classifies namespaced write verbs as write (PAP-10902)", () => {
    // Real MCP servers return colon-namespaced names that the old leading-anchor
    // regex fell through to "read", pre-enabling writes in the Connect wizard.
    expect(risk("qa10864:create_widget")).toBe("write");
    expect(risk("github:create_issue")).toBe("write");
    expect(risk("notion:update_page")).toBe("write");
    expect(risk("linear:create_issue")).toBe("write");
  });

  it("classifies camelCase write verbs as write", () => {
    expect(risk("slack:postMessage")).toBe("write");
    expect(risk("createIssue")).toBe("write");
  });

  it("classifies namespaced destructive verbs as destructive", () => {
    expect(risk("delete_widget")).toBe("destructive");
    expect(risk("github:delete_repo")).toBe("destructive");
    expect(risk("notion:remove_page")).toBe("destructive");
    expect(risk("cms:unpublish_post")).toBe("destructive");
  });

  it("classifies read verbs and noise as read", () => {
    expect(risk("search_notes")).toBe("read");
    expect(risk("github:list_issues")).toBe("read");
    expect(risk("getUser")).toBe("read");
    expect(risk("echo")).toBe("read");
    // Verbs embedded mid-word must not trigger (no segment boundary).
    expect(risk("settings")).toBe("read");
    expect(risk("dataset_export")).toBe("read");
  });

  it("honours explicit annotation hints over name heuristics", () => {
    expect(risk("list_items", { destructiveHint: true })).toBe("destructive");
    expect(risk("list_items", { writeHint: true })).toBe("write");
    expect(risk("list_items", { readOnlyHint: false })).toBe("write");
  });
});
