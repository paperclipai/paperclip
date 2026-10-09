import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  toolApplications,
  toolConnections,
  toolAccessAuditEvents,
} from "@paperclipai/db";
import { toolAccessService } from "../services/tool-access.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const actor = { actorType: "user" as const, actorId: "tailscale-reviewer" };
const CLIENT_ID = "kFIXTURECNTRL";
const CLIENT_SECRET = "tskey-client-fixture-secret-value";
const TOKEN = "tskey-api-fixture-access-token";
const TEST_KEY_SECRET = "tskey-auth-fixture-minted-key";
const PROVIDER_BODY = "private tailnet detail: fixture.example.ts.net tag:secret-tag";
const SECRETS = [CLIENT_SECRET, TOKEN, TEST_KEY_SECRET, PROVIDER_BODY];

(support.supported ? describe : describe.skip)("Tailscale connection lifecycle", () => {
  let db: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-tailscale-");
    db = createDb(temp.connectionString);
  }, 30000);
  afterAll(async () => {
    await temp?.cleanup();
  });

  async function fixture() {
    const [company] = await db
      .insert(companies)
      .values({ name: "Tailscale fixture", issuePrefix: `TS${randomUUID().slice(0, 6)}` })
      .returning();
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: actor.actorId,
      membershipRole: "admin",
      status: "active",
    });
    const behavior: {
      tokenStatus: number;
      createStatus: number;
      scope: string;
      /** When set, the device list waits on this promise before it answers. */
      devicesGate: Promise<void> | null;
    } = { tokenStatus: 0, createStatus: 0, scope: "auth_keys devices:core", devicesGate: null };
    const calls: { method: string; path: string; body: string | undefined }[] = [];
    const request = vi.fn(async (url: string, init: RequestInit) => {
      const parsed = new URL(url);
      expect(parsed.origin).toBe("https://api.tailscale.com");
      const path = parsed.pathname.replace("/api/v2", "") + parsed.search;
      calls.push({ method: init.method ?? "GET", path, body: typeof init.body === "string" ? init.body : undefined });
      if (path === "/oauth/token") {
        const form = new URLSearchParams(String(init.body));
        if (behavior.tokenStatus || form.get("client_id") !== CLIENT_ID || form.get("client_secret") !== CLIENT_SECRET) {
          return Response.json({ message: PROVIDER_BODY }, { status: behavior.tokenStatus || 401 });
        }
        return Response.json({ access_token: TOKEN, token_type: "Bearer", expires_in: 3600, scope: behavior.scope });
      }
      if (new Headers(init.headers).get("Authorization") !== `Bearer ${TOKEN}`) {
        return Response.json({ message: PROVIDER_BODY }, { status: 401 });
      }
      if (/^\/tailnet\/[^/]+\/devices\?fields=all$/.test(path)) {
        if (behavior.devicesGate) await behavior.devicesGate;
        return Response.json({ devices: [{ nodeId: "nFIXTURE1", name: "devbox.fixture.example.ts.net", addresses: ["100.64.0.7"] }] });
      }
      if (/^\/tailnet\/[^/]+\/keys$/.test(path) && init.method === "POST") {
        if (behavior.createStatus) return Response.json({ message: PROVIDER_BODY }, { status: behavior.createStatus });
        const requested = JSON.parse(String(init.body)) as { capabilities: { devices: { create: { tags: string[] } } } };
        return Response.json({
          id: "kTESTKEY1",
          key: TEST_KEY_SECRET,
          expires: "2026-10-09T10:05:00Z",
          capabilities: { devices: { create: { reusable: false, ephemeral: true, preauthorized: true, tags: requested.capabilities.devices.create.tags } } },
        });
      }
      if (/^\/tailnet\/[^/]+\/keys\/kTESTKEY1$/.test(path) && init.method === "DELETE") return new Response(null, { status: 200 });
      throw new Error(`Unexpected fixture path ${init.method} ${path}`);
    });
    const access = toolAccessService(db, {
      remoteHttpRequest: request,
      remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }],
    });
    return { company, access, behavior, calls, request };
  }

  const PROBE = [
    "POST /oauth/token",
    "GET /tailnet/-/devices?fields=all",
    "POST /tailnet/-/keys",
    "DELETE /tailnet/-/keys/kTESTKEY1",
  ];

  async function connect(fx: Awaited<ReturnType<typeof fixture>>, configValues?: Record<string, string>) {
    const connected = await fx.access.connectGalleryApp(
      fx.company.id,
      {
        galleryKey: "tailscale",
        connectionMethodKey: "oauth-client",
        ...(configValues ? { configValues } : {}),
        credentialValues: {
          "credentials.oauthClientId": CLIENT_ID,
          "credentials.oauthClientSecret": CLIENT_SECRET,
        },
      },
      actor,
    );
    fx.calls.length = 0;
    return connected;
  }

  async function row(connectionId: string) {
    const [found] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId));
    return found;
  }

  function expectRedacted(value: unknown) {
    const text = JSON.stringify(value) ?? "";
    for (const secret of SECRETS) expect(text).not.toContain(secret);
  }

  it("verifies the OAuth client at setup, stores a redacted summary, and keeps the client in the vault", async () => {
    const { company, access, calls } = await fixture();
    const connected = await access.connectGalleryApp(
      company.id,
      {
        galleryKey: "tailscale",
        connectionMethodKey: "oauth-client",
        credentialValues: {
          "credentials.oauthClientId": CLIENT_ID,
          "credentials.oauthClientSecret": CLIENT_SECRET,
        },
      },
      actor,
    );
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /oauth/token",
      "GET /tailnet/-/devices?fields=all",
      "POST /tailnet/-/keys",
      "DELETE /tailnet/-/keys/kTESTKEY1",
    ]);
    expect(JSON.parse(calls[2]!.body!)).toMatchObject({
      capabilities: { devices: { create: { reusable: false, ephemeral: true, preauthorized: true, tags: ["tag:paperclip-agent"] } } },
      expirySeconds: 300,
    });
    expect(connected.catalog).toEqual([]);
    expect(connected.connection.healthStatus).toBe("ok");
    expect(connected.connection.healthMessage).toBe(
      "Tailscale OAuth client is connected to the client's tailnet. Scopes: auth_keys, devices:core. Tags: tag:paperclip-agent. Devices visible: 1.",
    );

    const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, connected.connectionId));
    expect(row.transport).toBe("rest_api");
    expect(row.config).toMatchObject({
      sourceTemplateKey: "tailscale",
      connectionMethodKey: "oauth-client",
      methodConfig: { tailnet: "-", agentTag: "tag:paperclip-agent" },
      tailscale: { tailnet: "-", scopes: ["auth_keys", "devices:core"], tags: ["tag:paperclip-agent"], deviceCount: 1 },
    });
    expect(row.credentialSecretRefs.map((ref) => ref.configPath).sort()).toEqual([
      "credentials.oauthClientId",
      "credentials.oauthClientSecret",
    ]);
    // Neither OAuth field is a request header, so nothing is projected as one.
    expect(row.credentialRefs).toEqual([]);
    expectRedacted(row.config);
    expectRedacted(connected);
    const [application] = await db.select().from(toolApplications).where(eq(toolApplications.id, row.applicationId));
    expect(application.type).toBe("rest_api");

    // A later health check repeats the full probe and keeps the summary current.
    calls.length = 0;
    const checked = await access.checkHealth(connected.connectionId, actor);
    expect(checked.connection.healthStatus).toBe("ok");
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /oauth/token",
      "GET /tailnet/-/devices?fields=all",
      "POST /tailnet/-/keys",
      "DELETE /tailnet/-/keys/kTESTKEY1",
    ]);
    const audits = await db.select().from(toolAccessAuditEvents).where(eq(toolAccessAuditEvents.connectionId, connected.connectionId));
    expect(audits.some((entry) => entry.action === "tool_connection.health_check" && entry.outcome === "success")).toBe(true);
    expectRedacted(audits);
  });

  it("addresses the configured tailnet and agent tag", async () => {
    const { company, access, calls } = await fixture();
    await access.connectGalleryApp(
      company.id,
      {
        galleryKey: "tailscale",
        connectionMethodKey: "oauth-client",
        configValues: { tailnet: "example.com", agentTag: "tag:paperclip-lab" },
        credentialValues: {
          "credentials.oauthClientId": CLIENT_ID,
          "credentials.oauthClientSecret": CLIENT_SECRET,
        },
      },
      actor,
    );
    expect(calls.map((call) => `${call.method} ${call.path}`)).toContain("GET /tailnet/example.com/devices?fields=all");
    expect(JSON.parse(calls[2]!.body!).capabilities.devices.create.tags).toEqual(["tag:paperclip-lab"]);
  });

  it("maps a provider refusal to an actionable 422 without echoing the provider body", async () => {
    const { company, access, behavior } = await fixture();
    behavior.createStatus = 403;
    await expect(
      access.connectGalleryApp(
        company.id,
        {
          galleryKey: "tailscale",
          connectionMethodKey: "oauth-client",
          credentialValues: {
            "credentials.oauthClientId": CLIENT_ID,
            "credentials.oauthClientSecret": CLIENT_SECRET,
          },
        },
        actor,
      ),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: "tailscale_tag_not_owned" },
      message: expect.stringContaining("tag:paperclip-agent"),
    });

    behavior.createStatus = 0;
    const connected = await access.connectGalleryApp(
      company.id,
      {
        galleryKey: "tailscale",
        connectionMethodKey: "oauth-client",
        credentialValues: {
          "credentials.oauthClientId": CLIENT_ID,
          "credentials.oauthClientSecret": CLIENT_SECRET,
        },
      },
      actor,
    );
    behavior.tokenStatus = 401;
    const failure = await access.checkHealth(connected.connectionId, actor).then(
      () => null,
      (error: unknown) => error as { status: number; message: string; details: Record<string, unknown> },
    );
    expect(failure).toMatchObject({ status: 422, details: { code: "tailscale_client_invalid" } });
    expect(failure!.message).not.toContain(PROVIDER_BODY);
    const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, connected.connectionId));
    expect(row.healthStatus).toBe("error");
    expect(row.healthMessage).toContain("rejected the OAuth client");
    expectRedacted(row);
  });

  it("reuses the setup probe for an immediate refresh, but probes again once a check has failed", async () => {
    const fx = await fixture();
    const connected = await connect(fx);
    const stored = await row(connected.connectionId);
    expect(stored.healthStatus).toBe("ok");
    expect(asRecord(stored.config.tailscale).probeFingerprint).toMatch(/^[0-9a-f]{32}$/);

    // Unchanged connection whose latest check succeeded: no second test key.
    const reused = await fx.access.refreshCatalog(connected.connectionId, actor);
    expect(fx.calls).toEqual([]);
    expect(reused.connection.healthStatus).toBe("ok");
    expect(reused.connection.healthMessage).toContain("Tailscale OAuth client is connected");

    // A failed check must not be hidden by a refresh inside the reuse window.
    fx.behavior.tokenStatus = 401;
    await expect(fx.access.checkHealth(connected.connectionId, actor)).rejects.toMatchObject({ status: 422, details: { code: "tailscale_client_invalid" } });
    expect((await row(connected.connectionId)).healthStatus).toBe("error");
    fx.calls.length = 0;
    await expect(fx.access.refreshCatalog(connected.connectionId, actor)).rejects.toMatchObject({ status: 422, details: { code: "tailscale_client_invalid" } });
    expect(fx.calls.map((call) => `${call.method} ${call.path}`)).toEqual(["POST /oauth/token"]);
    const failed = await row(connected.connectionId);
    expect(failed.healthStatus).toBe("error");
    expect(failed.healthMessage).toContain("rejected the OAuth client");

    // Once the provider accepts the client again, the refresh revalidates in full.
    fx.behavior.tokenStatus = 0;
    fx.calls.length = 0;
    const recovered = await fx.access.refreshCatalog(connected.connectionId, actor);
    expect(fx.calls.map((call) => `${call.method} ${call.path}`)).toEqual(PROBE);
    expect(recovered.connection.healthStatus).toBe("ok");
  });

  it("probes again on refresh when the tailnet or agent tag changed since the last check", async () => {
    const fx = await fixture();
    const connected = await connect(fx);
    const stored = await row(connected.connectionId);
    await fx.access.updateConnection(connected.connectionId, {
      config: { ...stored.config, methodConfig: { tailnet: "example.com", agentTag: "tag:paperclip-lab" } },
    });
    expect((await row(connected.connectionId)).healthStatus).toBe("ok");
    const refreshed = await fx.access.refreshCatalog(connected.connectionId, actor);
    expect(fx.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /oauth/token",
      "GET /tailnet/example.com/devices?fields=all",
      "POST /tailnet/example.com/keys",
      "DELETE /tailnet/example.com/keys/kTESTKEY1",
    ]);
    expect(JSON.parse(fx.calls[2]!.body!).capabilities.devices.create.tags).toEqual(["tag:paperclip-lab"]);
    expect(refreshed.connection.healthMessage).toContain("tailnet example.com");
    expect(refreshed.connection.healthMessage).toContain("Tags: tag:paperclip-lab");
    expect((await row(connected.connectionId)).config.tailscale).toMatchObject({ tailnet: "example.com", tags: ["tag:paperclip-lab"] });
  });

  it("keeps a settings save that lands during a probe and discards the stale evidence", async () => {
    const fx = await fixture();
    const connected = await connect(fx);
    const before = await row(connected.connectionId);
    const previousSummary = before.config.tailscale;

    let release!: () => void;
    fx.behavior.devicesGate = new Promise<void>((resolve) => { release = resolve; });
    const pendingCheck = fx.access.checkHealth(connected.connectionId, actor).then(
      () => null,
      (error: unknown) => error as { status: number; message: string; details: Record<string, unknown> },
    );
    await vi.waitFor(() => expect(fx.calls.map((call) => `${call.method} ${call.path}`)).toContain("GET /tailnet/-/devices?fields=all"));

    // The operator saves a new tailnet while the device list is still pending.
    await fx.access.updateConnection(connected.connectionId, {
      config: { ...before.config, methodConfig: { tailnet: "example.com", agentTag: "tag:paperclip-agent" } },
    });
    fx.behavior.devicesGate = null;
    release();

    const failure = await pendingCheck;
    expect(failure).toMatchObject({ status: 409, details: { code: "tailscale_connection_changed" } });
    const after = await row(connected.connectionId);
    expect(asRecord(after.config.methodConfig).tailnet).toBe("example.com");
    expect(after.config.tailscale).toEqual(previousSummary);
    expect(after.healthStatus).toBe("degraded");
    expect(after.healthMessage).toContain("Run the check again");
    expectRedacted(after);

    // The next check runs on the saved values and replaces the summary.
    fx.calls.length = 0;
    const checked = await fx.access.checkHealth(connected.connectionId, actor);
    expect(checked.connection.healthStatus).toBe("ok");
    expect(fx.calls.map((call) => `${call.method} ${call.path}`)).toContain("GET /tailnet/example.com/devices?fields=all");
    expect((await row(connected.connectionId)).config.tailscale).toMatchObject({ tailnet: "example.com" });
  });

  it("refuses to export the OAuth client to an agent", async () => {
    const { company, access } = await fixture();
    const connected = await access.connectGalleryApp(
      company.id,
      {
        galleryKey: "tailscale",
        connectionMethodKey: "oauth-client",
        credentialValues: {
          "credentials.oauthClientId": CLIENT_ID,
          "credentials.oauthClientSecret": CLIENT_SECRET,
        },
      },
      actor,
    );
    const [agent] = await db
      .insert(agents)
      .values({ companyId: company.id, name: "Tailnet agent", role: "engineer", adapterType: "process", adapterConfig: {} })
      .returning();
    const [run] = await db
      .insert(heartbeatRuns)
      .values({ companyId: company.id, agentId: agent.id, invocationSource: "on_demand", status: "running" })
      .returning();
    await expect(
      access.mintConnectionTokenForAgent({
        connectionId: connected.connectionId,
        companyId: company.id,
        agentId: agent.id,
        runId: run.id,
        body: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
