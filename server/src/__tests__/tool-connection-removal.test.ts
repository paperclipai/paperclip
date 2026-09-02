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
  companySecretVersions,
  connectionGrants,
  connectionTokenIssuances,
  createDb,
  heartbeatRuns,
  issues,
  secretAccessEvents,
  toolAccessAuditEvents,
  toolApplications,
  toolCatalogEntries,
  toolConnectionInstalls,
  toolConnections,
  toolGatewaySessions,
  toolMcpGateways,
  toolMcpGatewayTokens,
  toolOauthStates,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
  toolRuntimeSlots,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { toolAccessService } from "../services/tool-access.js";
import { toolAccessPolicyService } from "../services/tool-access-policy.js";
import { toolAccessRoutes } from "../routes/tool-access.js";
import { secretService } from "../services/secrets.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * PAP-17119 — "Remove app" is a credential revocation boundary, not a status
 * flip. Everything here asks the same question from a different angle: after a
 * removal, is there any surviving row that still resolves a credential or still
 * grants an agent a way to call the app?
 *
 * The connection is built through the real connect path where that is possible,
 * so the tests fail if `connectGalleryApp` ever starts writing credential state
 * somewhere the teardown does not look.
 */

// A public IP literal, matching the generic MCP suite: remote endpoints are
// DNS-pinned even in local/private mode (PAP-17098), so a made-up hostname would
// fail resolution before it ever reached this fixture.
const MCP_ORIGIN = "https://203.0.113.10";
const MCP_URL = `${MCP_ORIGIN}/mcp`;

const FIXTURE_TOOLS = [
  { name: "list_things", description: "List things", annotations: { readOnlyHint: true } },
  { name: "delete_thing", description: "Delete a thing", annotations: { readOnlyHint: false, destructiveHint: true } },
];

function jsonResponse(payload: unknown, status = 200): Response {
  const body = JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
    },
    text: async () => body,
    json: async () => payload,
  } as unknown as Response;
}

function headerRecord(init: RequestInit | undefined): Record<string, string> {
  const raw = init?.headers;
  if (!raw) return {};
  if (raw instanceof Headers) return Object.fromEntries(raw.entries());
  if (Array.isArray(raw)) return Object.fromEntries(raw as Array<[string, string]>);
  return Object.fromEntries(
    Object.entries(raw as Record<string, string>).map(([key, value]) => [key.toLowerCase(), value]),
  );
}

/**
 * The narrowest endpoint that satisfies a header-authenticated connect: it lists
 * tools when the expected header arrives and 401s otherwise, which is all the
 * catalog refresh and health check need.
 */
function installMcpFixture(requiredHeader: { name: string; value: string }) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const href = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = headerRecord(init);
    if (href === MCP_URL && method === "POST") {
      if (headers[requiredHeader.name.toLowerCase()] !== requiredHeader.value) {
        return jsonResponse({ error: "unauthorized" }, 401);
      }
      return jsonResponse({ jsonrpc: "2.0", id: "paperclip-catalog-refresh", result: { tools: FIXTURE_TOOLS } });
    }
    return jsonResponse({ error: "not_found" }, 404);
  });
}

async function createCompany(db: ReturnType<typeof createDb>) {
  return db
    .insert(companies)
    .values({
      name: `Removal ${randomUUID()}`,
      issuePrefix: `RM${randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createAgent(db: ReturnType<typeof createDb>, companyId: string) {
  return db
    .insert(agents)
    .values({
      companyId,
      name: `Removal agent ${randomUUID()}`,
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    })
    .returning()
    .then((rows) => rows[0]!);
}

function createRouteApp(db: ReturnType<typeof createDb>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
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

describeEmbeddedPostgres("tool connection removal", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const HEADER = { name: "X-Api-Key", value: "fixture-secret-value" };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-removal-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await db.delete(toolGatewaySessions);
    await db.delete(toolMcpGatewayTokens);
    await db.delete(toolMcpGateways);
    await db.delete(connectionTokenIssuances);
    await db.delete(connectionGrants);
    await db.delete(toolOauthStates);
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(activityLog);
    await db.delete(toolAccessAuditEvents);
    await db.delete(toolRuntimeSlots);
    await db.delete(toolConnectionInstalls);
    await db.delete(toolProfileBindings);
    await db.delete(toolProfileEntries);
    await db.delete(toolProfiles);
    await db.delete(toolCatalogEntries);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /** Connect a header-authenticated app and finish the wizard for one agent. */
  async function connectHeaderApp(companyId: string, agentId: string) {
    const service = toolAccessService(db);
    const connected = await service.connectGalleryApp(companyId, {
      link: MCP_URL,
      name: `Removal fixture ${randomUUID().slice(0, 8)}`,
      credentialValues: { [`headers.${HEADER.name}`]: HEADER.value },
    });
    const readEntry = connected.catalog.find((entry) => entry.toolName === "list_things")!;
    const finished = await service.finishGalleryAppConnection(companyId, connected.connectionId, {
      enabledCatalogEntryIds: [readEntry.id],
      askFirstCatalogEntryIds: [],
      access: { agentIds: [agentId] },
    }, { actorType: "user", actorId: "board-user" });
    await service.putConnectionInstalls(connected.connectionId, {
      installs: [{ targetType: "agent", targetId: agentId, enabled: true }],
    }, { actorType: "user", actorId: "board-user" });
    return { service, connectionId: connected.connectionId, readEntry, profile: finished.profile };
  }

  it("revokes the custom-header credential and every access path it granted", async () => {
    installMcpFixture(HEADER);
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const policy = toolAccessPolicyService(db);
    const { service, connectionId, readEntry, profile } = await connectHeaderApp(company.id, agent.id);

    const [before] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId));
    // One pasted header value is one secret, referenced twice: once as a header
    // credential ref and once as a secret ref.
    const secretIds = [...new Set([
      ...before!.credentialRefs.map((ref) => ref.secretId),
      ...before!.credentialSecretRefs.map((ref) => ref.secretId),
    ])];
    expect(secretIds).toHaveLength(1);
    expect(before!.credentialRefs).toHaveLength(1);
    expect(before!.credentialSecretRefs).toHaveLength(1);
    // The credential really does resolve before removal, so the assertions after
    // it are measuring a change rather than a permanent failure.
    await expect(secretService(db).resolveSecretValue(company.id, secretIds[0]!, "latest", {
      consumerType: "tool_connection",
      consumerId: connectionId,
      configPath: `credentials.headers.${HEADER.name}`,
      actorType: "system",
    })).resolves.toBe(HEADER.value);
    await expect(policy.decide({
      companyId: company.id,
      actor: { actorType: "agent", actorId: agent.id, agentId: agent.id },
      request: { connectionId, catalogEntryId: readEntry.id, toolName: "list_things" },
    })).resolves.toMatchObject({ allowed: true });

    const removed = await service.archiveConnection(connectionId, company.id, {
      actorType: "user",
      actorId: "board-user",
    });

    expect(removed.connection).toMatchObject({ status: "archived", enabled: false });
    expect(removed.removal).toMatchObject({
      secretsRevoked: secretIds.length,
      secretsRetainedShared: 0,
      appProfile: "deleted",
      installsRemoved: 1,
      applicationArchived: true,
    });
    expect(removed.removal.credentialRefsCleared).toBeGreaterThan(0);
    expect(removed.removal.secretBindingsRemoved).toBeGreaterThan(0);
    expect(removed.removal.catalogEntriesMarkedRemoved).toBe(FIXTURE_TOOLS.length);

    // No secret row, no version row, nothing resolvable.
    for (const secretId of secretIds) {
      expect(await db.select().from(companySecrets).where(eq(companySecrets.id, secretId))).toEqual([]);
      expect(await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, secretId))).toEqual([]);
      await expect(secretService(db).resolveSecretValue(company.id, secretId, "latest", {
        consumerType: "tool_connection",
        consumerId: connectionId,
        configPath: `credentials.headers.${HEADER.name}`,
        actorType: "system",
      })).rejects.toMatchObject({ status: 404 });
    }
    expect(await db.select().from(companySecretBindings).where(and(
      eq(companySecretBindings.targetType, "tool_connection"),
      eq(companySecretBindings.targetId, connectionId),
    ))).toEqual([]);

    // No ref left on the connection to point at a credential.
    const [after] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId));
    expect(after!.credentialRefs).toEqual([]);
    expect(after!.credentialSecretRefs).toEqual([]);

    // No install, no app-managed profile, no profile entries or bindings.
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connectionId))).toEqual([]);
    expect(await db.select().from(toolProfiles).where(eq(toolProfiles.profileKey, `app:${connectionId}`))).toEqual([]);
    expect(await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, profile.id))).toEqual([]);
    expect(await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.profileId, profile.id))).toEqual([]);

    // Catalog history survives, marked non-executable.
    const catalog = await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, connectionId));
    expect(catalog.length).toBe(FIXTURE_TOOLS.length);
    expect(catalog.every((entry) => entry.status === "removed")).toBe(true);

    // And the agent is denied.
    await expect(policy.decide({
      companyId: company.id,
      actor: { actorType: "agent", actorId: agent.id, agentId: agent.id },
      request: { connectionId, catalogEntryId: readEntry.id, toolName: "list_things" },
    })).resolves.toMatchObject({ allowed: false });
    expect(await service.listConnectionInstalls(connectionId, company.id)).toEqual([]);
  });

  it("revokes OAuth secrets, grant credentials and outstanding authorization state", async () => {
    installMcpFixture(HEADER);
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { service, connectionId } = await connectHeaderApp(company.id, agent.id);
    const secrets = secretService(db);

    // Stand in for a completed sign-in: access and refresh tokens as dedicated
    // `tool_app.*` secrets, referenced by the connection and by a user grant.
    const accessSecret = await secrets.create(company.id, {
      name: `Removal access ${randomUUID().slice(0, 8)}`,
      key: `tool_app.${randomUUID()}.oauth_access_token`,
      provider: "local_encrypted",
      value: "oauth-access-token",
    });
    const refreshSecret = await secrets.create(company.id, {
      name: `Removal refresh ${randomUUID().slice(0, 8)}`,
      key: `tool_app.${randomUUID()}.oauth_refresh_token`,
      provider: "local_encrypted",
      value: "oauth-refresh-token",
    });
    const grantSecret = await secrets.create(company.id, {
      name: `Removal grant ${randomUUID().slice(0, 8)}`,
      key: `tool_app.${randomUUID()}.oauth_access_token`,
      provider: "local_encrypted",
      value: "grant-access-token",
    });
    const [existing] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId));
    const headerSecretIds = existing!.credentialSecretRefs.map((ref) => ref.secretId);
    await service.updateConnection(connectionId, {
      credentialSecretRefs: [
        ...existing!.credentialSecretRefs,
        { secretId: accessSecret.id, versionSelector: "latest", configPath: "oauth.access_token", required: true, label: "OAuth access token" },
        { secretId: refreshSecret.id, versionSelector: "latest", configPath: "oauth.refresh_token", required: false, label: "OAuth refresh token" },
      ],
    });
    const [grant] = await db.insert(connectionGrants).values({
      companyId: company.id,
      connectionId,
      kind: "user",
      subjectUserId: "user-1",
      credentialSecretRefs: [
        { secretId: grantSecret.id, versionSelector: "latest", configPath: "oauth.access_token", required: true, label: "OAuth access token" },
      ],
      status: "active",
    }).returning();
    await db.insert(toolOauthStates).values({
      state: `state-${randomUUID()}`,
      companyId: company.id,
      connectionId,
      codeVerifier: "verifier",
      expiresAt: new Date(Date.now() + 600_000),
    });
    await db.insert(connectionTokenIssuances).values({
      companyId: company.id,
      connectionId,
      agentId: agent.id,
      path: "oauth_access",
      outcome: "success",
      tokenHash: "a".repeat(64),
      expiresAt: new Date(Date.now() + 600_000),
    });

    const removed = await service.archiveConnection(connectionId, company.id);

    expect(removed.removal).toMatchObject({
      secretsRevoked: headerSecretIds.length + 3,
      secretsRetainedShared: 0,
      // The default organization grant and the explicit user grant are both revoked.
      grantsRevoked: 2,
      oauthStatesDiscarded: 1,
      tokenIssuanceHashesCleared: 1,
    });
    for (const secretId of [accessSecret.id, refreshSecret.id, grantSecret.id, ...headerSecretIds]) {
      expect(await db.select().from(companySecrets).where(eq(companySecrets.id, secretId))).toEqual([]);
    }
    const [grantAfter] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant!.id));
    expect(grantAfter).toMatchObject({ status: "revoked", isDefault: false });
    expect(grantAfter!.revokedAt).not.toBeNull();
    expect(grantAfter!.credentialSecretRefs).toEqual([]);
    expect(await db.select().from(toolOauthStates).where(eq(toolOauthStates.connectionId, connectionId))).toEqual([]);
    const [issuance] = await db.select().from(connectionTokenIssuances).where(eq(connectionTokenIssuances.connectionId, connectionId));
    expect(issuance!.tokenHash).toBeNull();
    // The ledger row itself is history and stays.
    expect(issuance!.path).toBe("oauth_access");
  });

  it("leaves another consumer's credential in place", async () => {
    installMcpFixture(HEADER);
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { service, connectionId } = await connectHeaderApp(company.id, agent.id);
    const secrets = secretService(db);

    // Two secrets removal must not destroy: one the operator manages by hand
    // (outside the `tool_app.` namespace), and one dedicated-looking secret a
    // second connection also binds.
    const operatorSecret = await secrets.create(company.id, {
      name: `Operator managed ${randomUUID().slice(0, 8)}`,
      key: `shared_api_key_${randomUUID().slice(0, 8)}`,
      provider: "local_encrypted",
      value: "operator-managed-value",
    });
    const alsoUsedSecret = await secrets.create(company.id, {
      name: `Shared app secret ${randomUUID().slice(0, 8)}`,
      key: `tool_app.${randomUUID()}.headers_x_shared`,
      provider: "local_encrypted",
      value: "shared-app-value",
    });
    const [existing] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId));
    await service.updateConnection(connectionId, {
      credentialSecretRefs: [
        ...existing!.credentialSecretRefs,
        { secretId: operatorSecret.id, versionSelector: "latest", configPath: "credentials.operator", required: false, label: "Operator key" },
        { secretId: alsoUsedSecret.id, versionSelector: "latest", configPath: "credentials.shared", required: false, label: "Shared key" },
      ],
    });

    // A second connection referencing the same secret is the other consumer.
    const [otherApplication] = await db.insert(toolApplications).values({
      companyId: company.id,
      applicationKey: `other:${randomUUID()}`,
      name: `Other app ${randomUUID().slice(0, 8)}`,
      type: "mcp_http",
      status: "active",
    }).returning();
    const otherConnection = await service.createConnection(company.id, {
      applicationId: otherApplication!.id,
      name: `Other connection ${randomUUID().slice(0, 8)}`,
      transport: "mcp_remote",
      config: { url: MCP_URL },
      credentialSecretRefs: [
        { secretId: alsoUsedSecret.id, versionSelector: "latest", configPath: "credentials.shared", required: false, label: "Shared key" },
      ],
    });

    const removed = await service.archiveConnection(connectionId, company.id);

    expect(removed.removal.secretsRetainedShared).toBe(2);
    for (const secretId of [operatorSecret.id, alsoUsedSecret.id]) {
      const [row] = await db.select().from(companySecrets).where(eq(companySecrets.id, secretId));
      expect(row).toBeTruthy();
      expect(row!.status).not.toBe("deleted");
    }
    // The other consumer can still resolve its credential.
    await expect(secretService(db).resolveSecretValue(company.id, alsoUsedSecret.id, "latest", {
      consumerType: "tool_connection",
      consumerId: otherConnection.id,
      configPath: "credentials.shared",
      actorType: "system",
    })).resolves.toBe("shared-app-value");
    // Its binding survives; the removed connection's does not.
    expect(await db.select().from(companySecretBindings).where(and(
      eq(companySecretBindings.targetType, "tool_connection"),
      eq(companySecretBindings.targetId, connectionId),
    ))).toEqual([]);
    expect((await db.select().from(companySecretBindings).where(and(
      eq(companySecretBindings.targetType, "tool_connection"),
      eq(companySecretBindings.targetId, otherConnection.id),
    ))).length).toBeGreaterThan(0);
    // And the removed connection no longer points at either of them.
    const [after] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId));
    expect(after!.credentialSecretRefs).toEqual([]);
  });

  it("fails closed and stays resumable when the secret provider errors", async () => {
    installMcpFixture(HEADER);
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { service, connectionId, readEntry } = await connectHeaderApp(company.id, agent.id);
    const policy = toolAccessPolicyService(db);

    const [before] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId));
    const secretIds = before!.credentialSecretRefs.map((ref) => ref.secretId);
    expect(secretIds.length).toBeGreaterThan(0);

    // Break provider deletion for the first attempt only. The registry hands out
    // this very object, so patching the method is enough.
    let failures = 0;
    const spy = vi.spyOn(localEncryptedProvider, "deleteOrArchive").mockImplementation(async () => {
      failures += 1;
      throw new Error("provider unavailable");
    });

    await expect(service.archiveConnection(connectionId, company.id)).rejects.toThrow("provider unavailable");
    expect(failures).toBe(1);

    // Failed closed: the app is already undispatchable and the credential is
    // already unresolvable, even though the provider copy survives.
    const [midway] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId));
    expect(midway).toMatchObject({ status: "archived", enabled: false });
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connectionId))).toEqual([]);
    expect(await db.select().from(toolProfiles).where(eq(toolProfiles.profileKey, `app:${connectionId}`))).toEqual([]);
    await expect(policy.decide({
      companyId: company.id,
      actor: { actorType: "agent", actorId: agent.id, agentId: agent.id },
      request: { connectionId, catalogEntryId: readEntry.id, toolName: "list_things" },
    })).resolves.toMatchObject({ allowed: false });
    await expect(secretService(db).resolveSecretValue(company.id, secretIds[0]!, "latest", {
      consumerType: "tool_connection",
      consumerId: connectionId,
      configPath: `credentials.headers.${HEADER.name}`,
      actorType: "system",
    })).rejects.toMatchObject({ status: 404 });
    // The ref survives the failure on purpose: it is the only pointer a retry
    // has to the secret it still has to revoke.
    expect(midway!.credentialSecretRefs.length).toBeGreaterThan(0);

    // Retrying the same removal finishes the job.
    spy.mockRestore();
    const removed = await service.archiveConnection(connectionId, company.id);
    expect(removed.removal.secretsRevoked).toBe(secretIds.length);
    expect(removed.removal.secretsRetainedShared).toBe(0);
    for (const secretId of secretIds) {
      expect(await db.select().from(companySecrets).where(eq(companySecrets.id, secretId))).toEqual([]);
    }
    const [after] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId));
    expect(after!.credentialSecretRefs).toEqual([]);

    // A third removal is a no-op that still succeeds.
    const again = await service.archiveConnection(connectionId, company.id);
    expect(again.removal).toMatchObject({
      secretsRevoked: 0,
      secretsRetainedShared: 0,
      installsRemoved: 0,
      appProfile: "absent",
      grantsRevoked: 0,
    });
  });

  it("archives the app profile and revokes gateway tokens when a gateway still points at it", async () => {
    installMcpFixture(HEADER);
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { service, connectionId, profile } = await connectHeaderApp(company.id, agent.id);

    const [gateway] = await db.insert(toolMcpGateways).values({
      companyId: company.id,
      name: `Gateway ${randomUUID().slice(0, 8)}`,
      slug: `gw-${randomUUID().slice(0, 8)}`,
      profileId: profile.id,
      status: "active",
    }).returning();
    const [token] = await db.insert(toolMcpGatewayTokens).values({
      companyId: company.id,
      gatewayId: gateway!.id,
      name: "client",
      tokenHash: randomUUID().replace(/-/g, "").padEnd(64, "0"),
    }).returning();

    const removed = await service.archiveConnection(connectionId, company.id);

    expect(removed.removal).toMatchObject({
      appProfile: "archived",
      gatewayTokensRevoked: 1,
    });
    const [profileAfter] = await db.select().from(toolProfiles).where(eq(toolProfiles.id, profile.id));
    // The row survives only because the gateway foreign key forbids deleting it;
    // a non-active profile with no entries is what the policy engine ignores.
    expect(profileAfter).toMatchObject({ status: "archived", defaultAction: "deny" });
    expect(await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, profile.id))).toEqual([]);
    const [tokenAfter] = await db.select().from(toolMcpGatewayTokens).where(eq(toolMcpGatewayTokens.id, token!.id));
    expect(tokenAfter!.revokedAt).not.toBeNull();
  });

  it("stops a live local runtime so no process keeps serving the revoked credential", async () => {
    installMcpFixture(HEADER);
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { service, connectionId } = await connectHeaderApp(company.id, agent.id);
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId));

    const [slot] = await db.insert(toolRuntimeSlots).values({
      companyId: company.id,
      applicationId: connection!.applicationId,
      connectionId,
      slotKey: `mcp:${company.id}:${connectionId}`,
      ownerScopeType: "connection",
      ownerScopeId: connectionId,
      runtimeKind: "local_stdio",
      status: "running",
      provider: "paperclip",
      healthStatus: "ok",
    }).returning();

    const removed = await service.archiveConnection(connectionId, company.id);

    expect(removed.removal.runtimeSlotsStopped).toBe(1);
    const [slotAfter] = await db.select().from(toolRuntimeSlots).where(eq(toolRuntimeSlots.id, slot!.id));
    expect(slotAfter!.status).toBe("stopped");
    expect(slotAfter!.metadata).toMatchObject({ stoppedReason: "connection_removed" });

    // A second removal has nothing left to stop.
    const again = await service.archiveConnection(connectionId, company.id);
    expect(again.removal.runtimeSlotsStopped).toBe(0);
  });

  it("removes over the route with a secret-free receipt, then requires fresh credentials to reconnect", async () => {
    installMcpFixture(HEADER);
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { service, connectionId } = await connectHeaderApp(company.id, agent.id);
    const app = createRouteApp(db);
    const [beforeRemoval] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId));
    const originalSecretIds = beforeRemoval!.credentialSecretRefs.map((ref) => ref.secretId);
    expect(originalSecretIds.length).toBeGreaterThan(0);

    const response = await request(app).delete(`/api/tool-connections/${connectionId}`).expect(200);

    expect(response.body).toMatchObject({ id: connectionId, status: "archived", enabled: false });
    expect(response.body.removal).toMatchObject({ appProfile: "deleted", secretsRetainedShared: 0 });
    expect(response.body.removal.secretsRevoked).toBeGreaterThan(0);
    // Nothing in the response body echoes the pasted value or a secret name.
    expect(JSON.stringify(response.body)).not.toContain(HEADER.value);

    const [receipt] = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, company.id), eq(activityLog.action, "tool_connection.archived")));
    expect(receipt!.details).toMatchObject({
      transport: "mcp_remote",
      appProfile: "deleted",
      secretsRetainedShared: 0,
      applicationArchived: true,
    });
    expect(Number((receipt!.details as Record<string, unknown>).secretsRevoked)).toBeGreaterThan(0);
    const receiptText = JSON.stringify(receipt!.details);
    expect(receiptText).not.toContain(HEADER.value);
    expect(receiptText).not.toContain("tool_app.");

    // Reconnect cannot lean on a retained credential: the archived connection
    // refuses both reconnect and sign-in, and a fresh connect has to be given
    // new credential values.
    await expect(service.reconnectGalleryApp(connectionId, company.id, { credentialValues: {} }))
      .rejects.toMatchObject({ status: 409 });
    await expect(service.startOAuth(company.id, connectionId, {
      redirectUri: "https://paperclip.fixture.test/api/tools/oauth/callback",
      actor: { actorType: "user", actorId: "board-user" },
    })).rejects.toMatchObject({ status: 409 });

    const [archived] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId));
    const reconnected = await service.connectGalleryApp(company.id, {
      applicationId: archived!.applicationId,
      link: MCP_URL,
      name: archived!.name,
      credentialValues: { [`headers.${HEADER.name}`]: HEADER.value },
    });
    // Same connection identity, brand new credential.
    expect(reconnected.connectionId).toBe(connectionId);
    const [after] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId));
    expect(after!.credentialSecretRefs.length).toBeGreaterThan(0);
    const reconnectedSecretIds = after!.credentialSecretRefs.map((ref) => ref.secretId);
    // Not one of the revoked secrets came back.
    for (const secretId of originalSecretIds) expect(reconnectedSecretIds).not.toContain(secretId);
    // A fresh connect recreates the deny-by-default profile, but does not restore installs.
    await expect(db.select().from(toolProfiles).where(eq(toolProfiles.profileKey, `app:${connectionId}`)))
      .resolves.toHaveLength(1);
    expect(await service.listConnectionInstalls(connectionId, company.id)).toEqual([]);
  });
});
