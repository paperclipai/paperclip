import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  companies,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
  invites,
  joinRequests,
} from "@paperclipai/db";
import {
  buildJoinDefaultsPayloadForAccept,
  normalizeAgentDefaultsForJoin,
  prepareAgentDefaultsPayloadForJoinPersistence,
} from "../routes/access.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres invite accept gateway defaults tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("buildJoinDefaultsPayloadForAccept (openclaw_gateway)", () => {
  it("leaves non-gateway payloads unchanged", () => {
    const defaultsPayload = { command: "echo hello" };
    const result = buildJoinDefaultsPayloadForAccept({
      adapterType: "process",
      defaultsPayload,
      inboundOpenClawAuthHeader: "ignored-token",
    });

    expect(result).toEqual(defaultsPayload);
  });

  it("normalizes wrapped x-openclaw-token header", () => {
    const result = buildJoinDefaultsPayloadForAccept({
      adapterType: "openclaw_gateway",
      defaultsPayload: {
        url: "ws://127.0.0.1:18789",
        headers: {
          "x-openclaw-token": {
            value: "gateway-token-1234567890",
          },
        },
      },
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      url: "ws://127.0.0.1:18789",
      headers: {
        "x-openclaw-token": "gateway-token-1234567890",
      },
    });
  });

  it("accepts inbound x-openclaw-token for gateway joins", () => {
    const result = buildJoinDefaultsPayloadForAccept({
      adapterType: "openclaw_gateway",
      defaultsPayload: {
        url: "ws://127.0.0.1:18789",
      },
      inboundOpenClawTokenHeader: "gateway-token-1234567890",
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      headers: {
        "x-openclaw-token": "gateway-token-1234567890",
      },
    });
  });

  it("derives x-openclaw-token from authorization header", () => {
    const result = buildJoinDefaultsPayloadForAccept({
      adapterType: "openclaw_gateway",
      defaultsPayload: {
        url: "ws://127.0.0.1:18789",
        headers: {
          authorization: "Bearer gateway-token-1234567890",
        },
      },
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      headers: {
        authorization: "Bearer gateway-token-1234567890",
        "x-openclaw-token": "gateway-token-1234567890",
      },
    });
  });
});

describe("normalizeAgentDefaultsForJoin (openclaw_gateway)", () => {
  it("generates persistent device key when device auth is enabled", () => {
    const normalized = normalizeAgentDefaultsForJoin({
      adapterType: "openclaw_gateway",
      defaultsPayload: {
        url: "ws://127.0.0.1:18789",
        headers: {
          "x-openclaw-token": "gateway-token-1234567890",
        },
        disableDeviceAuth: false,
      },
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    });

    expect(normalized.fatalErrors).toEqual([]);
    expect(normalized.normalized?.disableDeviceAuth).toBe(false);
    expect(typeof normalized.normalized?.devicePrivateKeyPem).toBe("string");
    expect((normalized.normalized?.devicePrivateKeyPem as string).length).toBeGreaterThan(64);
  });

  it("does not generate device key when disableDeviceAuth=true", () => {
    const normalized = normalizeAgentDefaultsForJoin({
      adapterType: "openclaw_gateway",
      defaultsPayload: {
        url: "ws://127.0.0.1:18789",
        headers: {
          "x-openclaw-token": "gateway-token-1234567890",
        },
        disableDeviceAuth: true,
      },
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    });

    expect(normalized.fatalErrors).toEqual([]);
    expect(normalized.normalized?.disableDeviceAuth).toBe(true);
    expect(normalized.normalized?.devicePrivateKeyPem).toBeUndefined();
  });
});

describe("normalizeAgentDefaultsForJoin (hermes_gateway)", () => {
  it("rejects remote plain HTTP by default", () => {
    const normalized = normalizeAgentDefaultsForJoin({
      adapterType: "hermes_gateway",
      defaultsPayload: {
        apiBaseUrl: "http://192.168.1.25:8642",
        apiKey: "hermes-key-1234567890",
      },
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    });

    expect(normalized.fatalErrors.join("\n")).toContain("remote plain HTTP");
    expect(normalized.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_plain_http_remote_denied",
        }),
      ]),
    );
  });

  it("allows remote plain HTTP only with the explicit unsafe flag", () => {
    const normalized = normalizeAgentDefaultsForJoin({
      adapterType: "hermes_gateway",
      defaultsPayload: {
        apiBaseUrl: "http://192.168.1.25:8642",
        apiKey: "hermes-key-1234567890",
        dangerouslyAllowInsecureRemoteHttp: true,
      },
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    });

    expect(normalized.fatalErrors).toEqual([]);
    expect(normalized.normalized?.apiBaseUrl).toBe("http://192.168.1.25:8642/");
    expect(normalized.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_plain_http_remote_unsafe_allowed",
        }),
      ]),
    );
  });

  it("maps the default Hermes dashboard root to the API base path", () => {
    const normalized = normalizeAgentDefaultsForJoin({
      adapterType: "hermes_gateway",
      defaultsPayload: {
        apiBaseUrl: "http://127.0.0.1:9119",
        apiKey: "hermes-key-1234567890",
      },
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    });

    expect(normalized.fatalErrors).toEqual([]);
    expect(normalized.normalized?.apiBaseUrl).toBe("http://127.0.0.1:9119/api");
    expect(normalized.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_dashboard_root_mapped",
          level: "info",
          hint: expect.stringContaining("/api/v1/runs"),
        }),
        expect.objectContaining({
          code: "hermes_gateway_api_base_url_configured",
          message: "Hermes gateway endpoint set to http://127.0.0.1:9119/api",
        }),
      ]),
    );
  });

  it("maps the default Hermes dashboard chat URL to the API base path", () => {
    const normalized = normalizeAgentDefaultsForJoin({
      adapterType: "hermes_gateway",
      defaultsPayload: {
        apiBaseUrl: "http://127.0.0.1:9119/chat",
        apiKey: "hermes-key-1234567890",
      },
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    });

    expect(normalized.fatalErrors).toEqual([]);
    expect(normalized.normalized?.apiBaseUrl).toBe("http://127.0.0.1:9119/api");
    expect(normalized.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_dashboard_root_mapped",
          level: "info",
          hint: expect.stringContaining("/api/v1/runs"),
        }),
      ]),
    );
  });
});

describeEmbeddedPostgres("prepareAgentDefaultsPayloadForJoinPersistence (hermes_gateway)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-hermes-join-defaults-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("hermes-join-defaults");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(joinRequests);
    await db.delete(invites);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    }
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  it("stores a secret ref instead of the literal apiKey in join request defaults", async () => {
    const companyId = randomUUID();
    const inviteId = randomUUID();
    const joinRequestId = randomUUID();
    const literalApiKey = `hermes-key-${randomUUID()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(invites).values({
      id: inviteId,
      companyId,
      inviteType: "company_join",
      tokenHash: `invite-token-${randomUUID()}`,
      allowedJoinTypes: "agent",
      defaultsPayload: null,
      expiresAt: new Date("2027-03-10T00:00:00.000Z"),
    });

    const joinDefaults = normalizeAgentDefaultsForJoin({
      adapterType: "hermes_gateway",
      defaultsPayload: {
        apiBaseUrl: "https://hermes.example",
        apiKey: literalApiKey,
        paperclipApiUrl: "https://paperclip.example",
      },
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    });
    expect(joinDefaults.fatalErrors).toEqual([]);

    const persistedDefaults = await prepareAgentDefaultsPayloadForJoinPersistence({
      db,
      companyId,
      adapterType: "hermes_gateway",
      normalized: joinDefaults.normalized,
    });

    await db.insert(joinRequests).values({
      id: joinRequestId,
      inviteId,
      companyId,
      requestType: "agent",
      status: "pending_approval",
      requestIp: "127.0.0.1",
      agentName: "Hermes Gateway",
      adapterType: "hermes_gateway",
      capabilities: "Hermes gateway agent",
      agentDefaultsPayload: persistedDefaults,
      claimSecretHash: "claim-secret-hash",
      claimSecretExpiresAt: new Date("2027-03-11T00:00:00.000Z"),
    });

    const persistedJoinRequest = await db
      .select()
      .from(joinRequests)
      .where(eq(joinRequests.id, joinRequestId))
      .then((rows) => rows[0]);
    const storedPayload = persistedJoinRequest?.agentDefaultsPayload as Record<string, unknown>;
    expect(JSON.stringify(storedPayload)).not.toContain(literalApiKey);
    expect(storedPayload.apiKey).toMatchObject({
      type: "secret_ref",
      version: "latest",
    });

    const storedSecrets = await db.select().from(companySecrets);
    expect(storedSecrets).toHaveLength(1);
    expect((storedPayload.apiKey as { secretId: string }).secretId).toBe(storedSecrets[0]?.id);
  });
});
