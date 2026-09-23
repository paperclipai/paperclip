import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  companies,
  companyMemberships,
  companySecretBindings,
  companySecretVersions,
  companySecrets,
  connectionGrants,
  createDb,
  secretAccessEvents,
  toolApplications,
  toolCatalogEntries,
  toolConnectionInstalls,
  toolConnections,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const track = vi.fn();
const isRegisteredEventName = vi.fn(() => true);
vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => ({ track, isRegisteredEventName }),
}));

const { toolAccessService } = await import("../services/tool-access.js");
const { secretService } = await import("../services/secrets.js");
const { instanceSettingsService } = await import("../services/instance-settings.js");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

type Db = ReturnType<typeof createDb>;

function createdEvents() {
  return track.mock.calls.filter(([name]) => name === "connection.created");
}

function updatedEvents() {
  return track.mock.calls.filter(([name]) => name === "connection.updated");
}

async function createCompany(db: Db) {
  const company = await db
    .insert(companies)
    .values({
      name: `Lifecycle telemetry ${randomUUID()}`,
      issuePrefix: `LT${randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
  await db.insert(companyMemberships).values({
    companyId: company.id,
    principalType: "user",
    principalId: actor.actorId,
    status: "active",
    membershipRole: "admin",
  });
  return company;
}

const actor = {
  actorType: "user" as const,
  actorId: "lifecycle-telemetry-user",
  actorSource: "local_implicit" as const,
};

const mcpTool = (name: string) => ({
  name,
  description: name,
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true },
});

/**
 * Minimal remote MCP server: answers initialize, the initialized notification,
 * and tools/list. Mirrors the fixture the remote-connector lifecycle tests use
 * so the direct Composio MCP path here is the real gallery path, not a stub.
 */
function remoteMcpFixture() {
  const requests: { url: string; headers: Headers }[] = [];
  const remoteHttpRequest = async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { id: number; method: string };
    requests.push({ url, headers: new Headers(init.headers) });
    if (body.method === "initialize") {
      return Response.json(
        {
          id: body.id,
          jsonrpc: "2.0",
          result: { protocolVersion: "2025-06-18", capabilities: {} },
        },
        { headers: { "Mcp-Session-Id": "session" } },
      );
    }
    if (body.method === "notifications/initialized")
      return new Response(null, { status: 202 });
    return Response.json({
      id: body.id,
      jsonrpc: "2.0",
      result: { tools: [mcpTool("read"), mcpTool("ask")] },
    });
  };
  return { requests, remoteHttpRequest };
}

/**
 * Retained legacy broker records (#13758): a `rest_api` parent keyed to the
 * catalog slug and a `provider: composio` child. Master keeps such rows only
 * for inspection and explicit removal; they cannot execute or reconnect.
 */
async function insertRetiredComposioRecords(db: Db, companyId: string) {
  const [application] = await db
    .insert(toolApplications)
    .values({ companyId, name: "Composio", type: "rest_api", status: "active" })
    .returning();
  const [parent] = await db
    .insert(toolConnections)
    .values({
      companyId,
      applicationId: application!.id,
      name: "Composio (legacy broker)",
      uid: `composio/${randomUUID()}`,
      transport: "rest_api",
      authKind: "api_key",
      status: "active",
      enabled: true,
      config: { sourceTemplateKey: "composio" },
      transportConfig: { sourceTemplateKey: "composio" },
    })
    .returning();
  const [child] = await db
    .insert(toolConnections)
    .values({
      companyId,
      applicationId: application!.id,
      name: "GitHub (via Composio)",
      uid: `composio/github/${randomUUID()}`,
      transport: "mcp_remote",
      authKind: "none",
      status: "active",
      enabled: true,
      config: {
        provider: "composio",
        parentConnectionId: parent!.id,
        toolkitSlug: "github",
        connectedAccountId: "account-github",
      },
      transportConfig: {},
    })
    .returning();
  return { parent: parent!, child: child! };
}

describeEmbeddedPostgres("connector lifecycle telemetry (tool-access)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null =
    null;
  let keyDir: string | null = null;

  beforeAll(async () => {
    keyDir = await mkdtemp(join(tmpdir(), "lifecycle-telemetry-secrets-"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", join(keyDir, "key"));
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-lifecycle-telemetry-",
    );
    db = createDb(tempDb.connectionString);
    await instanceSettingsService(db).updateExperimental({
      enableMcpAggregators: true,
    });
  }, 30_000);

  afterEach(async () => {
    track.mockClear();
    await db.delete(activityLog);
    await db.delete(toolProfileEntries);
    await db.delete(toolProfileBindings);
    await db.delete(toolProfiles);
    await db.delete(toolCatalogEntries);
    await db.delete(connectionGrants);
    await db.delete(toolConnectionInstalls);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    vi.unstubAllEnvs();
    if (keyDir) await rm(keyDir, { recursive: true, force: true });
  });

  function service(options: Parameters<typeof toolAccessService>[1] = {}) {
    return toolAccessService(db, {
      remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }],
      ...options,
    });
  }

  it("createConnection emits one created event with the catalog key from the committed row", async () => {
    const company = await createCompany(db);
    const svc = service();
    await svc.createConnection(company.id, {
      name: "GitHub fixture",
      transport: "mcp_remote",
      config: { url: "https://fixture.example/mcp", sourceTemplateKey: "github" },
      enabled: true,
      status: "active",
    });
    const events = createdEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.[1]).toMatchObject({
      connector_key: "github",
      transport: "mcp_remote",
      setup_flow: "api",
      status: "active",
      enabled: true,
    });
  }, 30_000);

  it("updateConnection emits committed transitions only; metadata saves stay silent", async () => {
    const company = await createCompany(db);
    const svc = service();
    const connection = await svc.createConnection(company.id, {
      name: "Custom fixture",
      transport: "mcp_remote",
      config: { url: "https://fixture.example/mcp" },
      enabled: true,
      status: "active",
    });
    track.mockClear();

    await svc.updateConnection(connection.id, { enabled: false });
    let events = updatedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.[1]).toMatchObject({
      connector_key: "custom",
      change_source: "api",
      previous_enabled: true,
      enabled: false,
      previous_status: "active",
      status: "active",
    });

    track.mockClear();
    await svc.updateConnection(connection.id, { name: "Renamed fixture" });
    expect(updatedEvents()).toHaveLength(0);
  }, 30_000);

  it("direct Composio MCP setup from the gallery emits catalog identity only, never the session URL", async () => {
    const company = await createCompany(db);
    const remote = remoteMcpFixture();
    const svc = service({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      remoteHttpRequest: remote.remoteHttpRequest,
    });
    // The same server path the Apps gallery and inline task cards call
    // (POST /companies/:companyId/tools/apps/connect): Composio Connect with an
    // externally configured MCP session URL.
    const connected = await svc.connectGalleryApp(
      company.id,
      {
        galleryKey: "composio",
        connectionMethodKey: "mcp",
        link: "https://mcp.composio.dev/session/fixture?token=fixture-secret",
        authMode: "none",
      },
      actor,
    );
    expect(remote.requests.length).toBeGreaterThan(0);
    const created = createdEvents();
    expect(created).toHaveLength(1);
    expect(created[0]?.[1]).toMatchObject({
      connector_key: "composio",
      transport: "mcp_remote",
      auth_kind: "none",
      setup_flow: "gallery",
      status: connected.connection.status,
      enabled: connected.connection.enabled,
    });
    expect(JSON.stringify(track.mock.calls)).not.toContain("fixture-secret");
    expect(JSON.stringify(track.mock.calls)).not.toContain("mcp.composio.dev");

    track.mockClear();
    const finished = await svc.finishGalleryAppConnection(
      company.id,
      connected.connectionId,
      {
        enabledCatalogEntryIds: connected.catalog.map((entry) => entry.id),
        askFirstCatalogEntryIds: [],
        access: "all_agents",
      },
      actor,
    );
    // Connect commits a draft; the finish step is the committed draft -> active
    // transition, so it is the one `gallery` update this setup reports.
    expect(connected.connection).toMatchObject({ status: "draft", enabled: false });
    expect(finished.connection).toMatchObject({ status: "active", enabled: true });
    const updated = updatedEvents();
    expect(updated).toHaveLength(1);
    expect(updated[0]?.[1]).toMatchObject({
      connector_key: "composio",
      transport: "mcp_remote",
      change_source: "gallery",
      previous_status: "draft",
      status: "active",
      previous_enabled: false,
      enabled: true,
    });
    expect(createdEvents()).toHaveLength(0);
  }, 30_000);

  it("pausing and resuming a direct Composio MCP connection reports api transitions with the catalog key", async () => {
    const company = await createCompany(db);
    const remote = remoteMcpFixture();
    const svc = service({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      remoteHttpRequest: remote.remoteHttpRequest,
    });
    const connected = await svc.connectGalleryApp(
      company.id,
      {
        galleryKey: "composio",
        connectionMethodKey: "mcp",
        link: "https://mcp.composio.dev/session/fixture?token=fixture-secret",
        authMode: "none",
      },
      actor,
    );
    await svc.finishGalleryAppConnection(
      company.id,
      connected.connectionId,
      {
        enabledCatalogEntryIds: connected.catalog.map((entry) => entry.id),
        askFirstCatalogEntryIds: [],
        access: "all_agents",
      },
      actor,
    );
    track.mockClear();

    await svc.updateConnection(connected.connectionId, { enabled: false });
    await svc.updateConnection(connected.connectionId, { enabled: true });
    const updated = updatedEvents();
    expect(updated).toHaveLength(2);
    expect(updated.map(([, dims]) => dims)).toEqual([
      expect.objectContaining({
        connector_key: "composio",
        transport: "mcp_remote",
        change_source: "api",
        previous_enabled: true,
        enabled: false,
      }),
      expect.objectContaining({
        connector_key: "composio",
        change_source: "api",
        previous_enabled: false,
        enabled: true,
      }),
    ]);
    // No per-app child rows exist for direct MCP, so nothing else cascades.
    expect(createdEvents()).toHaveLength(0);
  }, 30_000);

  it("finalizing OAuth access reports the committed draft -> active transition as a gallery step", async () => {
    // Direct MCP aggregator OAuth (Composio Connect via DCR) from the Apps
    // gallery or an inline task card: the callback stores a personal grant,
    // then finalizeOAuthAccess — POST .../apps/:id/finalize-oauth-access, also
    // called by connection-intent completion — activates the draft row itself
    // before handing off to the finish step.
    const company = await createCompany(db);
    const svc = service();
    const [application] = await db
      .insert(toolApplications)
      .values({ companyId: company.id, name: "Composio", type: "mcp_remote", status: "active" })
      .returning();
    const [connection] = await db
      .insert(toolConnections)
      .values({
        companyId: company.id,
        applicationId: application!.id,
        name: "Composio",
        uid: `composio/${randomUUID()}`,
        transport: "mcp_remote",
        authKind: "oauth",
        credentialPolicy: "per_user",
        status: "draft",
        enabled: false,
        config: {
          sourceTemplateKey: "composio",
          connectionMethodKey: "mcp",
          url: "https://connect.composio.dev/mcp",
        },
        transportConfig: { url: "https://connect.composio.dev/mcp" },
      })
      .returning();
    const accessToken = await secretService(db).create(company.id, {
      name: `OAuth access token ${randomUUID().slice(0, 8)}`,
      key: `tool_app.${randomUUID()}.oauth_access_token`,
      provider: "local_encrypted",
      value: "fixture-access-token",
    });
    await db.insert(connectionGrants).values({
      companyId: company.id,
      connectionId: connection!.id,
      kind: "user",
      subjectUserId: actor.actorId,
      status: "active",
      credentialSecretRefs: [
        {
          secretId: accessToken.id,
          versionSelector: "latest",
          configPath: "oauth.access_token",
          required: true,
          label: "OAuth access token",
        },
      ],
    });
    track.mockClear();

    const finished = await svc.finalizeOAuthAccess(
      company.id,
      connection!.id,
      { grantKind: "user" },
      actor,
    );
    expect(finished.connection).toMatchObject({ status: "active", enabled: true });
    const updated = updatedEvents();
    // Exactly one transition: finalize's own write. The finish step it calls
    // afterwards re-reads an already-active row and stays silent.
    expect(updated).toHaveLength(1);
    expect(updated[0]?.[1]).toMatchObject({
      connector_key: "composio",
      transport: "mcp_remote",
      auth_kind: "oauth",
      change_source: "gallery",
      previous_status: "draft",
      status: "active",
      previous_enabled: false,
      enabled: true,
    });
    expect(createdEvents()).toHaveLength(0);
    expect(JSON.stringify(track.mock.calls)).not.toContain("fixture-access-token");
  }, 30_000);

  it("retained legacy broker records emit only their explicit removal, distinguishable by transport", async () => {
    const company = await createCompany(db);
    const { parent, child } = await insertRetiredComposioRecords(db, company.id);
    const svc = service();
    track.mockClear();

    await svc.archiveConnection(parent.id);
    await svc.archiveConnection(child.id);
    const updated = updatedEvents();
    expect(updated).toHaveLength(2);
    expect(updated[0]?.[1]).toMatchObject({
      // Legacy parent: catalog slug survives, but `rest_api` marks it as the
      // retired broker rather than a direct MCP connection.
      connector_key: "composio",
      transport: "rest_api",
      change_source: "archive",
      status: "archived",
    });
    expect(updated[1]?.[1]).toMatchObject({
      // Legacy child: no catalog key; the raw toolkit slug never leaves.
      connector_key: "custom",
      transport: "mcp_remote",
      change_source: "archive",
      status: "archived",
    });
    expect(JSON.stringify(track.mock.calls)).not.toContain("github");
    expect(JSON.stringify(track.mock.calls)).not.toContain("account-github");
    expect(createdEvents()).toHaveLength(0);
  }, 30_000);
});
