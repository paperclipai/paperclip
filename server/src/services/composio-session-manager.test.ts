import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  companySecretBindings,
  companySecrets,
  companySecretVersions,
  createDb,
  secretAccessEvents,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { createComposioSessionManager } from "./composio-session-manager.js";
import { secretService } from "./secrets.js";
import type { ComposioClient } from "./composio.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("composio session manager", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-composio-session-manager-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createComposioParentAndChild(companyId: string) {
    const secrets = secretService(db);
    const apiKey = await secrets.create(companyId, {
      name: `Composio test key ${randomUUID().slice(0, 8)}`,
      key: `tool_app.${randomUUID()}.credentials_apiKey`,
      provider: "local_encrypted",
      value: "composio-test-key",
    });
    const [application] = await db.insert(toolApplications).values({
      companyId,
      name: "Composio",
      type: "mcp_http",
      status: "active",
    }).returning();
    const [parent] = await db.insert(toolConnections).values({
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
      credentialSecretRefs: [{
        secretId: apiKey.id,
        versionSelector: "latest",
        configPath: "credentials.apiKey",
        required: true,
        label: "Composio API key",
      }],
    }).returning();
    await db.insert(companySecretBindings).values({
      companyId,
      secretId: apiKey.id,
      targetType: "tool_connection",
      targetId: parent!.id,
      configPath: "credentials.apiKey",
    });
    const [child] = await db.insert(toolConnections).values({
      companyId,
      applicationId: application!.id,
      name: "Google Ads (via Composio)",
      uid: `composio/googleads/${randomUUID()}`,
      transport: "mcp_remote",
      authKind: "none",
      status: "active",
      enabled: true,
      config: {
        provider: "composio",
        parentConnectionId: parent!.id,
        toolkitSlug: "googleads",
        connectedAccountId: "ca_test",
      },
      transportConfig: {},
    }).returning();
    return { parent: parent!, child: child! };
  }

  function fakeComposioClient(mcpHeaders?: Record<string, string>): ComposioClient {
    return {
      validateApiKey: vi.fn(async () => undefined),
      listToolkits: vi.fn(async () => ({ items: [] })),
      listAuthConfigs: vi.fn(async () => ({ items: [] })),
      createConnectLink: vi.fn(async () => ({ link_token: "link", redirect_url: "https://composio.test/link", expires_at: new Date().toISOString() })),
      listConnectedAccounts: vi.fn(async () => ({ items: [] })),
      deleteConnectedAccount: vi.fn(async () => undefined),
      createSession: vi.fn(async () => ({
        session_id: `session-${randomUUID()}`,
        mcp: { url: "https://composio.test/mcp", ...(mcpHeaders ? { headers: mcpHeaders } : {}) },
      })),
      resumeSession: vi.fn(async () => ({ session_id: "session", mcp: { url: "https://composio.test/mcp" } })),
    };
  }

  it("excludes Composio's own meta-tools from the toolkit-scoped allowlist", async () => {
    const [company] = await db.insert(companies).values({
      name: `Composio session test ${randomUUID()}`,
      issuePrefix: `CS${randomUUID().slice(0, 6).toUpperCase()}`,
    }).returning();
    const { child } = await createComposioParentAndChild(company!.id);
    const client = fakeComposioClient();
    const manager = createComposioSessionManager(db, { composioClientFactory: () => client });

    // Regression guard for #12643: COMPOSIO_SEARCH_TOOLS et al. belong to the
    // "composio" toolkit itself, not to whichever child toolkit is calling
    // them, and Composio's API rejects scoping them under a child's own
    // allowlist. Every Composio child's catalog is made up entirely of these
    // meta-tools, so without this filter every real tool call would fail.
    await manager.ensureSession(child.id, {
      tools: ["COMPOSIO_SEARCH_TOOLS", "GOOGLEADS_LIST_ACCESSIBLE_CUSTOMERS"],
    });

    expect(client.createSession).toHaveBeenCalledWith(
      `paperclip:${company!.id}`,
      expect.objectContaining({
        tools: { googleads: { enable: ["GOOGLEADS_LIST_ACCESSIBLE_CUSTOMERS"] } },
      }),
    );
  });

  it("falls back to the parent's own API key when Composio omits mcp.headers.x-api-key", async () => {
    const [company] = await db.insert(companies).values({
      name: `Composio session test ${randomUUID()}`,
      issuePrefix: `CS${randomUUID().slice(0, 6).toUpperCase()}`,
    }).returning();
    const { child } = await createComposioParentAndChild(company!.id);
    // Regression guard for #12631: Composio's tool_router/session response
    // does not always include an x-api-key entry under mcp.headers, but the
    // returned MCP endpoint still requires one on every call.
    const client = fakeComposioClient(undefined);
    const manager = createComposioSessionManager(db, { composioClientFactory: () => client });

    const session = await manager.ensureSession(child.id, { tools: ["GOOGLEADS_LIST_ACCESSIBLE_CUSTOMERS"] });

    expect(session.headers["x-api-key"]).toBe("composio-test-key");

    const [persistedChild] = await db.select().from(toolConnections).where(eq(toolConnections.id, child.id));
    expect(persistedChild!.credentialSecretRefs).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "Composio MCP x-api-key header" })]),
    );
  });

  it("keeps an explicit Composio-supplied x-api-key header instead of overriding it", async () => {
    const [company] = await db.insert(companies).values({
      name: `Composio session test ${randomUUID()}`,
      issuePrefix: `CS${randomUUID().slice(0, 6).toUpperCase()}`,
    }).returning();
    const { child } = await createComposioParentAndChild(company!.id);
    const client = fakeComposioClient({ "x-api-key": "composio-issued-session-key" });
    const manager = createComposioSessionManager(db, { composioClientFactory: () => client });

    const session = await manager.ensureSession(child.id, { tools: ["GOOGLEADS_LIST_ACCESSIBLE_CUSTOMERS"] });

    expect(session.headers["x-api-key"]).toBe("composio-issued-session-key");
  });
});
