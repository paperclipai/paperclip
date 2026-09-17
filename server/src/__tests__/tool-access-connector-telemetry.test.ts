import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  companies,
  companySecretBindings,
  companySecretVersions,
  companySecrets,
  connectionGrants,
  createDb,
  secretAccessEvents,
  toolApplications,
  toolCatalogEntries,
  toolConnections,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
} from "@paperclipai/db";
import type { ComposioClient } from "../services/composio.js";
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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

type Db = ReturnType<typeof createDb>;

function createdEvents() {
  return track.mock.calls.filter(([name]) => name === "connector.connection_created");
}

function updatedEvents() {
  return track.mock.calls.filter(([name]) => name === "connector.connection_updated");
}

async function createCompany(db: Db) {
  return db
    .insert(companies)
    .values({
      name: `Lifecycle telemetry ${randomUUID()}`,
      issuePrefix: `LT${randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createComposioParentAndChild(db: Db, companyId: string) {
  const secrets = secretService(db);
  const apiKey = await secrets.create(companyId, {
    name: `Composio test key ${randomUUID().slice(0, 8)}`,
    key: `tool_app.${randomUUID()}.credentials_apiKey`,
    provider: "local_encrypted",
    value: "composio-test-key",
  });
  const [application] = await db
    .insert(toolApplications)
    .values({ companyId, name: "Composio", type: "rest_api", status: "active" })
    .returning();
  const [parent] = await db
    .insert(toolConnections)
    .values({
      companyId,
      applicationId: application!.id,
      name: "Composio",
      uid: `composio/${randomUUID()}`,
      transport: "rest_api",
      authKind: "api_key",
      status: "active",
      enabled: true,
      config: { sourceTemplateKey: "composio" },
      transportConfig: { sourceTemplateKey: "composio" },
      credentialRefs: [
        {
          name: "credentials.apiKey",
          secretId: apiKey.id,
          version: "latest",
          placement: "header",
          key: "x-api-key",
          prefix: null,
        },
      ],
      credentialSecretRefs: [
        {
          secretId: apiKey.id,
          versionSelector: "latest",
          configPath: "credentials.apiKey",
          required: true,
          label: "Composio API key",
        },
      ],
    })
    .returning();
  await db.insert(companySecretBindings).values({
    companyId,
    secretId: apiKey.id,
    targetType: "tool_connection",
    targetId: parent!.id,
    configPath: "credentials.apiKey",
  });
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

function fakeComposioClient(accountStatus: () => string): ComposioClient {
  return {
    validateApiKey: vi.fn(async () => undefined),
    listToolkits: vi.fn(async () => ({
      items: [{ slug: "github", name: "GitHub" }],
    })),
    listAuthConfigs: vi.fn(async () => ({ items: [] })),
    createConnectLink: vi.fn(async () => ({
      link_token: "link",
      redirect_url: "https://composio.test/link",
      expires_at: new Date().toISOString(),
    })),
    listConnectedAccounts: vi.fn(async () => ({
      items: [
        {
          id: "account-github",
          user_id: "paperclip:test",
          status: accountStatus(),
          toolkit: { slug: "github" },
          auth_config: {
            id: "auth-github",
            auth_scheme: "OAUTH2",
            is_composio_managed: true,
          },
        },
      ],
    })),
    deleteConnectedAccount: vi.fn(async () => undefined),
    createSession: vi.fn(async () => ({
      session_id: "session",
      mcp: { url: "https://composio.test/mcp" },
    })),
    resumeSession: vi.fn(async () => ({
      session_id: "session",
      mcp: { url: "https://composio.test/mcp" },
    })),
  } as unknown as ComposioClient;
}

describeEmbeddedPostgres("connector lifecycle telemetry (tool-access)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null =
    null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-lifecycle-telemetry-",
    );
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    track.mockClear();
    await db.delete(activityLog);
    await db.delete(toolProfileEntries);
    await db.delete(toolProfileBindings);
    await db.delete(toolProfiles);
    await db.delete(toolCatalogEntries);
    await db.delete(connectionGrants);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
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
      change_source: "update_api",
      previous_enabled: true,
      enabled: false,
      previous_status: "active",
      status: "active",
    });

    track.mockClear();
    await svc.updateConnection(connection.id, { name: "Renamed fixture" });
    expect(updatedEvents()).toHaveLength(0);
  }, 30_000);

  it("composio parent pause emits child transitions from committed rows and stays silent on the no-op repeat", async () => {
    const company = await createCompany(db);
    const { parent, child } = await createComposioParentAndChild(db, company.id);
    const svc = service({
      composioClientFactory: () => fakeComposioClient(() => "ACTIVE"),
    });

    await svc.updateConnection(parent.id, { enabled: false });
    let events = updatedEvents();
    // Parent transition (update_api) + child cascade (composio_sync).
    expect(events).toHaveLength(2);
    const childEvent = events.find(
      ([, dims]) => (dims as { change_source: string }).change_source === "composio_sync",
    );
    expect(childEvent?.[1]).toMatchObject({
      connector_key: "custom",
      previous_enabled: true,
      enabled: false,
    });
    await expect(
      db.select().from(toolConnections).then((rows) =>
        rows.find((row) => row.id === child.id),
      ),
    ).resolves.toMatchObject({ enabled: false });

    track.mockClear();
    await svc.updateConnection(parent.id, { enabled: false });
    // Parent and child both already disabled: nothing changed, nothing emits.
    expect(updatedEvents()).toHaveLength(0);
  }, 30_000);

  it("a child deleted between listing and write produces no event", async () => {
    const company = await createCompany(db);
    const { parent, child } = await createComposioParentAndChild(db, company.id);
    const svc = service({
      composioClientFactory: () => fakeComposioClient(() => "ACTIVE"),
      beforeComposioChildLifecycleWrite: async (childId) => {
        await db.delete(toolConnections).where(eq(toolConnections.id, childId));
      },
    });

    await svc.updateConnection(parent.id, { enabled: false });
    const events = updatedEvents();
    // Only the parent's own committed transition may report.
    expect(events).toHaveLength(1);
    expect(
      events.every(
        ([, dims]) =>
          (dims as { change_source: string }).change_source !== "composio_sync",
      ),
    ).toBe(true);
    const remaining = await db.select().from(toolConnections);
    expect(remaining.find((row) => row.id === child.id)).toBeUndefined();
  }, 30_000);

  it("a failed child lifecycle write emits nothing for that child", async () => {
    const company = await createCompany(db);
    const { parent } = await createComposioParentAndChild(db, company.id);
    const svc = service({
      composioClientFactory: () => fakeComposioClient(() => "ACTIVE"),
      beforeComposioChildLifecycleWrite: async () => {
        throw new Error("forced child write failure");
      },
    });

    await expect(
      svc.updateConnection(parent.id, { enabled: false }),
    ).rejects.toThrow(/forced child write failure/);
    expect(
      updatedEvents().filter(
        ([, dims]) =>
          (dims as { change_source: string }).change_source === "composio_sync",
      ),
    ).toHaveLength(0);
  }, 30_000);

  it("restore emits only for children whose committed enabled state changed", async () => {
    const company = await createCompany(db);
    const { parent, child } = await createComposioParentAndChild(db, company.id);
    let accountStatus = "ACTIVE";
    const svc = service({
      composioClientFactory: () => fakeComposioClient(() => accountStatus),
    });

    await svc.updateConnection(parent.id, { enabled: false });
    track.mockClear();

    // Inactive account: the child stays disabled, so no transition may report.
    accountStatus = "INACTIVE";
    await svc.updateConnection(parent.id, { enabled: true });
    expect(
      updatedEvents().filter(
        ([, dims]) =>
          (dims as { change_source: string }).change_source === "composio_sync",
      ),
    ).toHaveLength(0);

    track.mockClear();
    accountStatus = "ACTIVE";
    await svc.updateConnection(parent.id, { enabled: true });
    const events = updatedEvents().filter(
      ([, dims]) =>
        (dims as { change_source: string }).change_source === "composio_sync",
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.[1]).toMatchObject({
      previous_enabled: false,
      enabled: true,
    });
    await expect(
      db.select().from(toolConnections).then((rows) =>
        rows.find((row) => row.id === child.id),
      ),
    ).resolves.toMatchObject({ enabled: true });
  }, 30_000);
});
