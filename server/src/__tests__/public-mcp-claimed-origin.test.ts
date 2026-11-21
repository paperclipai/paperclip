import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { authUsers, createDb } from "@paperclipai/db";
import { createApp } from "../app.js";
import {
  CLOUD_RUNTIME_IDENTITY_AUDIENCE,
  CLOUD_RUNTIME_IDENTITY_HEADER,
  CLOUD_RUNTIME_IDENTITY_ISSUER,
  CLOUD_RUNTIME_IDENTITY_JWS_TYPE,
  getCloudRuntimeIdentity,
  initializeCloudRuntimeIdentity,
  resetCloudRuntimeIdentityForTests,
} from "../services/cloud-runtime-identity.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { migrateCloudConfiguration } from "../services/cloud-configuration-migration.js";
import { initializeAdapterSettings } from "../services/adapter-settings.js";
import { initializeCloudRuntimeConfig } from "../services/cloud-runtime-config.js";
import { setCloudRuntimeConfigSnapshot } from "../services/cloud-runtime-config-snapshot.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

const STACK_ID = "stack-claimed-origin";
const POOL_ORIGIN = "https://pool-0a1b2c.paperclip.app";
const CANONICAL_ORIGIN = "https://claimed.paperclip.app";
const OTHER_ORIGIN = "https://other.paperclip.app";
const keyPair = generateKeyPairSync("ed25519");
const publicJwk = { ...keyPair.publicKey.export({ format: "jwk" }), kid: "claimed-origin-key", use: "sig", alg: "EdDSA" };

function encode(value: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function claimAssertion() {
  const iat = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "EdDSA", typ: CLOUD_RUNTIME_IDENTITY_JWS_TYPE, kid: publicJwk.kid });
  const payload = encode({
    v: 1, iss: CLOUD_RUNTIME_IDENTITY_ISSUER, aud: CLOUD_RUNTIME_IDENTITY_AUDIENCE, sub: STACK_ID, claimId: randomUUID(),
    previousOrigin: POOL_ORIGIN, canonicalOrigin: CANONICAL_ORIGIN, stackSlug: "claimed", iat, exp: iat + 300,
  });
  return `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`, "ascii"), keyPair.privateKey).toString("base64url")}`;
}

describePostgres("public MCP origin after a warm-pool claim", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let directory: string;
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  const userId = randomUUID();

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("public-mcp-claimed-origin-");
    db = createDb(database.connectionString);
    directory = await mkdtemp(join(tmpdir(), "public-mcp-claimed-origin-"));
    vi.stubEnv("PAPERCLIP_HOME", directory);
    vi.stubEnv("PAPERCLIP_CLOUD_STACK_ID", STACK_ID);
    vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "claimed-origin-tenant-token");
    vi.stubEnv("PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS", JSON.stringify({ keys: [publicJwk] }));
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", POOL_ORIGIN);
    vi.stubEnv("PAPERCLIP_AUTH_PUBLIC_BASE_URL", POOL_ORIGIN);
    vi.stubEnv("PAPERCLIP_API_URL", POOL_ORIGIN);
    vi.stubEnv("PAPERCLIP_MCP_AUTHORIZATION_ORIGIN", "");
    await db.insert(authUsers).values({ id: userId, name: "Operator", email: `${userId}@example.com`, createdAt: new Date(), updatedAt: new Date() });
    await instanceSettingsService(db).updateExperimental({ enablePublicMcp: true });
    await migrateCloudConfiguration(db);
    await initializeAdapterSettings(db);
    await initializeCloudRuntimeConfig(db);
    resetCloudRuntimeIdentityForTests();
    await initializeCloudRuntimeIdentity(db);
    app = await createApp(db, {
      uiMode: "none", serverPort: 0, bindHost: "127.0.0.1", allowedHostnames: [],
      deploymentMode: "authenticated", deploymentExposure: "public", authPublicBaseUrl: POOL_ORIGIN, authReady: true,
      companyDeletionEnabled: false, managedPluginAutoInstall: [],
      storageService: createStorageService(createLocalDiskStorageProvider(join(directory, "storage"))),
      decisionServiceOptions: { wakeOriginAgent: async () => null },
      resolveSession: async (req) => {
        if (req.get("x-test-operator") !== userId) return null;
        const [user] = await db.select().from(authUsers).where(eq(authUsers.id, userId));
        return user ? { session: { id: "claimed-origin-session", userId }, user } : null;
      },
    });
    await app.locals.bundledPluginsStartup;
  }, 120_000);

  afterAll(async () => {
    await app?.locals.paperclipShutdown?.();
    setCloudRuntimeConfigSnapshot(null);
    resetCloudRuntimeIdentityForTests();
    vi.unstubAllEnvs();
    await db?.$client.end();
    await database?.cleanup();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("serves the claimed origin and accepts only it for connection changes", async () => {
    if (!app) throw new Error("Missing app");
    expect(getCloudRuntimeIdentity()).toBeNull();
    const before = await request(app).get("/.well-known/oauth-authorization-server").set("Host", new URL(POOL_ORIGIN).host);
    expect(before.status).toBe(200);
    expect(before.body.issuer).toBe(POOL_ORIGIN);

    const claim = await request(app).get("/api/health").set("Host", new URL(POOL_ORIGIN).host).set(CLOUD_RUNTIME_IDENTITY_HEADER, claimAssertion());
    expect(claim.status, JSON.stringify(claim.body)).toBe(200);
    expect(getCloudRuntimeIdentity()).toMatchObject({ canonicalOrigin: CANONICAL_ORIGIN });

    const discovery = await request(app).get("/.well-known/oauth-authorization-server").set("Host", new URL(CANONICAL_ORIGIN).host);
    expect(discovery.status).toBe(200);
    expect(discovery.body.issuer).toBe(CANONICAL_ORIGIN);
    expect(discovery.body.authorization_endpoint).toBe(CANONICAL_ORIGIN + "/mcp/oauth/authorize");
    const resource = await request(app).get("/.well-known/oauth-protected-resource/mcp/paperclip").set("Host", new URL(CANONICAL_ORIGIN).host);
    expect(resource.body.resource).toBe(CANONICAL_ORIGIN + "/mcp/paperclip");
    const unauthenticated = await request(app).post("/mcp/paperclip").set("Host", new URL(CANONICAL_ORIGIN).host).set("Origin", CANONICAL_ORIGIN).send({});
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers["www-authenticate"]).toContain(`resource_metadata="${CANONICAL_ORIGIN}/.well-known/oauth-protected-resource/mcp/paperclip"`);

    const consent = (origin: string) => request(app!).post(`/api/mcp/requests/${randomUUID()}/consent`)
      .set("Host", new URL(origin).host).set("Origin", origin).set("x-test-operator", userId).send({});
    const accepted = await consent(CANONICAL_ORIGIN);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(400);
    expect(JSON.stringify(accepted.body)).toContain("Choose a company and the requested access.");
    for (const origin of [POOL_ORIGIN, OTHER_ORIGIN]) {
      const rejected = await consent(origin);
      expect(rejected.status, origin).toBe(403);
      expect(JSON.stringify(rejected.body), origin).toContain("Connection changes require the Paperclip browser origin.");
    }
  }, 120_000);
});
