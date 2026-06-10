import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companySecretBindings,
  createDb,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
  toolAccessAuditEvents,
  toolActionRequests,
  toolApplications,
  toolCallEvents,
  toolCatalogEntries,
  toolConnections,
  toolInvocations,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
  toolRuntimeSlots,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { toolAccessService } from "../services/tool-access.js";
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

describeEmbeddedPostgres("tool access service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tool-access-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(companySecretBindings);
    await db.delete(activityLog);
    await db.delete(toolCallEvents);
    await db.delete(toolActionRequests);
    await db.delete(toolInvocations);
    await db.delete(toolAccessAuditEvents);
    await db.delete(issueThreadInteractions);
    await db.delete(toolRuntimeSlots);
    await db.delete(toolProfileBindings);
    await db.delete(toolProfileEntries);
    await db.delete(toolProfiles);
    await db.delete(toolCatalogEntries);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("registers a remote MCP connection and quarantines new or changed write tools during catalog refresh", async () => {
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
      config: { url: "https://fixture.example/mcp" },
      enabled: true,
      status: "active",
    });
    const firstRefresh = await service.refreshCatalog(connection.id, { actorType: "user", actorId: "board" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://fixture.example/mcp",
      expect.objectContaining({ method: "POST" }),
    );
    expect(firstRefresh.discoveredCount).toBe(2);
    expect(firstRefresh.quarantinedCount).toBe(1);
    expect(firstRefresh.catalog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolName: "search_notes", status: "active", riskLevel: "read" }),
        expect.objectContaining({
          toolName: "send_email",
          status: "quarantined",
          riskLevel: "write",
          quarantineReason: "new_write_tool",
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
          quarantineReason: "changed_write_tool",
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
    expect(install.catalog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolName: "list_items", status: "active", riskLevel: "read" }),
        expect.objectContaining({ toolName: "set_value", status: "quarantined", riskLevel: "write" }),
      ]),
    );

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
});
