import { generateKeyPairSync, sign } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, instanceSettings } from "@paperclipai/db";
import {
  applyCloudRuntimeIdentityAssertion,
  CLOUD_RUNTIME_IDENTITY_AUDIENCE,
  CLOUD_RUNTIME_IDENTITY_ISSUER,
  CLOUD_RUNTIME_IDENTITY_JWS_TYPE,
  getCloudRuntimeIdentity,
  initializeCloudRuntimeIdentity,
  resetCloudRuntimeIdentityForTests,
  runtimePublicOrigin,
} from "../services/cloud-runtime-identity.js";
import { routineWebhookUrl } from "../services/routines.js";
import { paperclipCloudConnectorEnrollmentStatus } from "../services/paperclip-cloud-connector-enrollment.js";
import { cloudRuntimeIdentityMiddleware } from "../middleware/cloud-runtime-identity.js";
import { healthRoutes } from "../routes/health.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const STACK_ID = "stack-pool-123";
const POOL_ORIGIN = "https://pool-123.staging.paperclip.app";
const CANONICAL_ORIGIN = "https://gonzo.staging.paperclip.app";
const NOW = new Date("2099-01-01T00:00:00.000Z");

const pair = generateKeyPairSync("ed25519");
const publicJwk = {
  ...pair.publicKey.export({ format: "jwk" }),
  kid: "runtime-identity-test-key",
  use: "sig",
  alg: "EdDSA",
};

function encodeJson(value: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function assertion(input: {
  claims?: Record<string, unknown>;
  header?: Record<string, unknown>;
  signingKey?: typeof pair.privateKey;
} = {}) {
  const iat = Math.floor(NOW.getTime() / 1000);
  const header = encodeJson({
    alg: "EdDSA",
    typ: CLOUD_RUNTIME_IDENTITY_JWS_TYPE,
    kid: publicJwk.kid,
    ...input.header,
  });
  const payload = encodeJson({
    v: 1,
    iss: CLOUD_RUNTIME_IDENTITY_ISSUER,
    aud: CLOUD_RUNTIME_IDENTITY_AUDIENCE,
    sub: STACK_ID,
    claimId: "pool-entry-123",
    previousOrigin: POOL_ORIGIN,
    canonicalOrigin: CANONICAL_ORIGIN,
    stackSlug: "gonzo",
    iat,
    exp: iat + 300,
    ...input.claims,
  });
  const signature = sign(
    null,
    Buffer.from(`${header}.${payload}`, "ascii"),
    input.signingKey ?? pair.privateKey,
  ).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

describeEmbeddedPostgres("Cloud runtime identity", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cloud-runtime-identity-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    await db.delete(instanceSettings);
    resetCloudRuntimeIdentityForTests();
    process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = "test-tenant-server-token";
    process.env.PAPERCLIP_CLOUD_STACK_ID = STACK_ID;
    process.env.PAPERCLIP_CLOUD_API_ORIGIN = "https://my-staging.paperclip.app";
    process.env.PAPERCLIP_PUBLIC_URL = POOL_ORIGIN;
    process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL = POOL_ORIGIN;
    process.env.PAPERCLIP_API_URL = POOL_ORIGIN;
    process.env.PAPERCLIP_PRIMARY_HOST = "pool-123.staging.paperclip.app";
    process.env.PAPERCLIP_STACK_SLUG = "pool-123";
    process.env.PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS = JSON.stringify({ keys: [publicJwk] });
    process.env.PAPERCLIP_CLOUD_CONNECTOR_INSTANCE_ID = "managed-instance";
    process.env.PAPERCLIP_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY = "managed-signing-key";
    process.env.PAPERCLIP_CLOUD_CONNECTOR_SEAL_PRIVATE_KEY = "managed-sealing-key";
    process.env.PAPERCLIP_CLOUD_CONNECTOR_ENVIRONMENT = "staging";
    process.env.PAPERCLIP_CLOUD_CONNECTOR_BASE_URL = "https://my-staging.paperclip.app";
    await initializeCloudRuntimeIdentity(db);
  });

  afterEach(() => {
    for (const key of [
      "PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN",
      "PAPERCLIP_CLOUD_STACK_ID",
      "PAPERCLIP_CLOUD_API_ORIGIN",
      "PAPERCLIP_PUBLIC_URL",
      "PAPERCLIP_AUTH_PUBLIC_BASE_URL",
      "PAPERCLIP_API_URL",
      "PAPERCLIP_PRIMARY_HOST",
      "PAPERCLIP_STACK_SLUG",
      "PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS",
      "PAPERCLIP_CLOUD_CONNECTOR_INSTANCE_ID",
      "PAPERCLIP_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY",
      "PAPERCLIP_CLOUD_CONNECTOR_SEAL_PRIVATE_KEY",
      "PAPERCLIP_CLOUD_CONNECTOR_ENVIRONMENT",
      "PAPERCLIP_CLOUD_CONNECTOR_BASE_URL",
      "PAPERCLIP_RUNTIME_API_CANDIDATES_JSON",
    ]) {
      const original = originalEnv[key];
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
    resetCloudRuntimeIdentityForTests();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("persists and immediately applies a valid one-time claim", async () => {
    const applied = await applyCloudRuntimeIdentityAssertion({
      db,
      compactJws: assertion(),
      now: NOW,
    });

    expect(applied.canonicalOrigin).toBe(CANONICAL_ORIGIN);
    expect(getCloudRuntimeIdentity()?.stackSlug).toBe("gonzo");
    expect(runtimePublicOrigin()).toBe(CANONICAL_ORIGIN);
    expect(process.env.PAPERCLIP_PUBLIC_URL).toBe(CANONICAL_ORIGIN);
    expect(process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL).toBe(CANONICAL_ORIGIN);
    expect(process.env.PAPERCLIP_API_URL).toBe(CANONICAL_ORIGIN);
    expect(process.env.PAPERCLIP_PRIMARY_HOST).toBe("gonzo.staging.paperclip.app");
    expect(process.env.PAPERCLIP_STACK_SLUG).toBe("gonzo");
    expect(routineWebhookUrl("hook-1")).toBe(
      "https://gonzo.staging.paperclip.app/api/routine-triggers/public/hook-1/fire",
    );
    expect(paperclipCloudConnectorEnrollmentStatus()).toMatchObject({
      configured: true,
      status: "active",
      origins: [CANONICAL_ORIGIN],
    });
  });

  it("applies the assertion on the existing health request and acknowledges the exact origin", async () => {
    const requestTime = Math.floor(Date.now() / 1000);
    const app = express();
    app.use(cloudRuntimeIdentityMiddleware(db));
    app.use("/api/health", healthRoutes(db, {
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      authReady: true,
      companyDeletionEnabled: false,
    }));

    const response = await request(app)
      .get("/api/health")
      .set("x-paperclip-cloud-runtime-identity", assertion({
        claims: { iat: requestTime, exp: requestTime + 300 },
      }));

    expect(response.status).toBe(200);
    expect(response.body.cloud.runtimeIdentity).toEqual({
      canonicalOrigin: CANONICAL_ORIGIN,
      stackSlug: "gonzo",
    });
  });

  it("restores the canonical identity before consumers read stale startup variables", async () => {
    await applyCloudRuntimeIdentityAssertion({ db, compactJws: assertion(), now: NOW });
    resetCloudRuntimeIdentityForTests();
    process.env.PAPERCLIP_PUBLIC_URL = POOL_ORIGIN;
    process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL = POOL_ORIGIN;
    process.env.PAPERCLIP_API_URL = POOL_ORIGIN;

    await initializeCloudRuntimeIdentity(db);

    expect(runtimePublicOrigin()).toBe(CANONICAL_ORIGIN);
    expect(process.env.PAPERCLIP_API_URL).toBe(CANONICAL_ORIGIN);
  });

  it("accepts the identical claim after a restart with already-aligned provider variables", async () => {
    await applyCloudRuntimeIdentityAssertion({ db, compactJws: assertion(), now: NOW });
    resetCloudRuntimeIdentityForTests();
    process.env.PAPERCLIP_PUBLIC_URL = CANONICAL_ORIGIN;
    process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL = CANONICAL_ORIGIN;
    process.env.PAPERCLIP_API_URL = CANONICAL_ORIGIN;
    await initializeCloudRuntimeIdentity(db);

    await expect(applyCloudRuntimeIdentityAssertion({
      db,
      compactJws: assertion(),
      now: NOW,
    })).resolves.toMatchObject({ canonicalOrigin: CANONICAL_ORIGIN });
  });

  it("accepts an identical replay but rejects a different claim or destination", async () => {
    await applyCloudRuntimeIdentityAssertion({ db, compactJws: assertion(), now: NOW });
    await expect(applyCloudRuntimeIdentityAssertion({
      db,
      compactJws: assertion(),
      now: NOW,
    })).resolves.toMatchObject({ canonicalOrigin: CANONICAL_ORIGIN });
    await expect(applyCloudRuntimeIdentityAssertion({
      db,
      compactJws: assertion({ claims: { claimId: "another-claim" } }),
      now: NOW,
    })).rejects.toThrow("already claimed");
  });

  it.each([
    ["expired", { exp: Math.floor(NOW.getTime() / 1000) - 1 }],
    ["cross-stack", { sub: "stack-someone-else" }],
    ["wrong previous origin", { previousOrigin: "https://another.staging.paperclip.app" }],
    ["path-bearing destination", { canonicalOrigin: `${CANONICAL_ORIGIN}/GON` }],
    ["slug mismatch", { stackSlug: "kermit" }],
  ])("rejects %s assertions", async (_label, claims) => {
    await expect(applyCloudRuntimeIdentityAssertion({
      db,
      compactJws: assertion({ claims }),
      now: NOW,
    })).rejects.toThrow();
  });

  it("rejects unknown keys and altered signed destinations", async () => {
    await expect(applyCloudRuntimeIdentityAssertion({
      db,
      compactJws: assertion({ header: { kid: "unknown" } }),
      now: NOW,
    })).rejects.toThrow("unknown signing key");

    const valid = assertion();
    const [header, payload, signature] = valid.split(".");
    const altered = encodeJson({
      ...JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")),
      canonicalOrigin: "https://attacker.example.com",
    });
    await expect(applyCloudRuntimeIdentityAssertion({
      db,
      compactJws: `${header}.${altered}.${signature}`,
      now: NOW,
    })).rejects.toThrow("signature is invalid");
  });
});
