import { createPublicKey, randomUUID, verify } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  closeRegisteredClients,
  companies,
  companyWorkloadIdentityKeys,
  createDb,
  toolAccessAuditEvents,
  toolApplications,
  toolConnections,
  type Db,
} from "@paperclipai/db";
import { generateClientKeyPair } from "../services/tool-access/oauth/client-credentials.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { createApp } from "../app.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import { errorHandler } from "../middleware/error-handler.js";
import { workloadIdentityPublicRoutes, workloadIdentityRoutes } from "../routes/workload-identity.js";
import {
  resetWorkloadIdentityKeyCacheForTests,
  setWorkloadIdentityConfiguredPublicOrigin,
  WORKLOAD_IDENTITY_PUBLISH_BEFORE_USE_MS,
  WORKLOAD_IDENTITY_RETIRING_GRACE_MS,
  workloadIdentityIssuerOrigin,
  workloadIdentityService,
} from "../services/workload-identity.js";
import { uniqueIssuePrefix } from "./helpers/issue-prefix.js";

const ORIGIN = "https://acme.paperclip.app";
const actor = { actorType: "user" as const, actorId: "board-user" };
const externalDatabase = resolveExternalTestDatabaseUrl("PAPERCLIP_WORKLOAD_IDENTITY_TEST_DATABASE_URL");

function decode(token: string) {
  const [header, claims, signature] = token.split(".");
  return {
    header: JSON.parse(Buffer.from(header!, "base64url").toString("utf8")),
    claims: JSON.parse(Buffer.from(claims!, "base64url").toString("utf8")),
    signingInput: `${header}.${claims}`,
    signature: Buffer.from(signature!, "base64url"),
  };
}

/** What AWS does: find the key by `kid` in the published set and check the ES256 signature. */
function verifiesAgainst(token: string, keys: Array<Record<string, unknown>>): boolean {
  const { header, signingInput, signature } = decode(token);
  const jwk = keys.find((key) => key.kid === header.kid);
  if (!jwk) return false;
  return verify("sha256", Buffer.from(signingInput),
    { key: createPublicKey({ key: jwk as never, format: "jwk" }), dsaEncoding: "ieee-p1363" }, signature);
}

describe("company workload identity issuer", () => {
  let db: Db;
  let database: { connectionString: string; cleanup: () => Promise<void> };
  let directory: string;
  let clock: Date;
  const service = () => workloadIdentityService(db, { now: () => clock });

  async function company() {
    const id = randomUUID();
    await db.insert(companies).values({
      id, name: `Identity ${id.slice(0, 6)}`, issuePrefix: uniqueIssuePrefix("W"),
      defaultResponsibleUserId: "workload-identity-owner",
    });
    return id;
  }

  async function connection(companyId: string, state: { status?: "draft" | "active" | "disabled" | "archived"; enabled?: boolean } = {}) {
    const [application] = await db.insert(toolApplications).values({
      companyId, applicationKey: `aws-${randomUUID()}`, name: `AWS ${randomUUID().slice(0, 8)}`, type: "mcp_http", status: "active",
    }).returning();
    const [row] = await db.insert(toolConnections).values({
      companyId, applicationId: application!.id, name: `AWS ${randomUUID().slice(0, 6)}`,
      uid: `aws-${randomUUID()}`, connectionKind: "managed", ownership: "customer",
      transport: "mcp_remote", authKind: "oauth", credentialPolicy: "shared",
      status: state.status ?? "active", enabled: state.enabled ?? true,
    }).returning();
    return row!.id;
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "paperclip-workload-identity-"));
    vi.stubEnv("PAPERCLIP_HOME", directory);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "");
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", join(directory, "master.key"));
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", ORIGIN);
    database = externalDatabase
      ? { connectionString: externalDatabase, cleanup: () => closeRegisteredClients(externalDatabase) }
      : await startEmbeddedPostgresTestDatabase("paperclip-workload-identity-");
    db = createDb(database.connectionString);
  }, 120_000);

  afterAll(async () => {
    await database?.cleanup();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  beforeEach(() => {
    clock = new Date("2026-11-17T12:00:00.000Z");
    resetWorkloadIdentityKeyCacheForTests();
  });

  it("only offers an issuer on a public https address AWS can reach", () => {
    expect(workloadIdentityIssuerOrigin(ORIGIN)).toEqual({ available: true, origin: ORIGIN });
    expect(workloadIdentityIssuerOrigin(null)).toEqual({ available: false, reason: "no_public_url" });
    expect(workloadIdentityIssuerOrigin("http://acme.example.com")).toEqual({ available: false, reason: "not_https" });
    expect(workloadIdentityIssuerOrigin("https://acme.example.com:8443")).toEqual({ available: false, reason: "has_port" });
    expect(workloadIdentityIssuerOrigin("https://localhost")).toEqual({ available: false, reason: "loopback" });
    expect(workloadIdentityIssuerOrigin("https://127.0.0.1")).toEqual({ available: false, reason: "loopback" });
  });

  it("falls back to the configured auth address when no public URL variable is set", () => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", "");
    vi.stubEnv("PAPERCLIP_AUTH_PUBLIC_BASE_URL", "");
    vi.stubEnv("PAPERCLIP_API_URL", "");
    try {
      setWorkloadIdentityConfiguredPublicOrigin(null);
      expect(workloadIdentityIssuerOrigin()).toEqual({ available: false, reason: "no_public_url" });
      setWorkloadIdentityConfiguredPublicOrigin("https://paperclip.example.com/");
      expect(workloadIdentityIssuerOrigin()).toEqual({ available: true, origin: "https://paperclip.example.com" });
      vi.stubEnv("PAPERCLIP_PUBLIC_URL", ORIGIN);
      expect(workloadIdentityIssuerOrigin()).toEqual({ available: true, origin: ORIGIN });
    } finally {
      setWorkloadIdentityConfiguredPublicOrigin(null);
      vi.stubEnv("PAPERCLIP_PUBLIC_URL", ORIGIN);
    }
  });

  it("publishes nothing until a company uses it, then converges on one key", async () => {
    const companyId = await company();
    const app = express().use(workloadIdentityPublicRoutes(db));
    await request(app).get(`/oidc/companies/${companyId}/jwks.json`).expect(404);
    await request(app).get(`/oidc/companies/${companyId}/.well-known/openid-configuration`).expect(404);
    await request(app).get("/oidc/companies/not-a-uuid/jwks.json").expect(404);
    expect(await db.select().from(companyWorkloadIdentityKeys)
      .where(eq(companyWorkloadIdentityKeys.companyId, companyId))).toHaveLength(0);

    const keys = await Promise.all(Array.from({ length: 6 }, () => service().ensureActiveKey(companyId)));
    expect(new Set(keys.map((key) => key.keyId)).size).toBe(1);

    const discovery = await request(app).get(`/oidc/companies/${companyId}/.well-known/openid-configuration`).expect(200);
    const issuer = `${ORIGIN}/oidc/companies/${companyId}`;
    expect(discovery.body).toMatchObject({
      issuer, jwks_uri: `${issuer}/jwks.json`, id_token_signing_alg_values_supported: ["ES256"],
      response_types_supported: ["id_token"], subject_types_supported: ["public"],
    });
    expect(discovery.headers["cache-control"]).toBe("public, max-age=300");
    const jwks = await request(app).get(`/oidc/companies/${companyId}/jwks.json`).expect(200);
    expect(jwks.body.keys).toHaveLength(1);
  });

  it("never publishes private key members (AWS rejects the set and the key counts as exposed)", async () => {
    const companyId = await company();
    await service().ensureActiveKey(companyId);
    await service().beginRotation(companyId, actor);
    const keySet = await service().publicKeySet(companyId);
    expect(keySet!.keys).toHaveLength(2);
    for (const key of keySet!.keys) {
      expect(Object.keys(key).sort()).toEqual(["alg", "crv", "kid", "kty", "use", "x", "y"]);
      expect(key).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256", use: "sig" });
    }
    const [stored] = await db.select().from(companyWorkloadIdentityKeys)
      .where(eq(companyWorkloadIdentityKeys.companyId, companyId));
    expect(JSON.stringify(stored!.publicJwk)).not.toMatch(/"d"/);
    expect(JSON.stringify(stored!.privateKeyMaterial)).not.toMatch(/BEGIN PRIVATE KEY/);
  });

  it("signs a 5-minute token naming one connection that verifies against the published key", async () => {
    const companyId = await company();
    const connectionId = await connection(companyId);
    const signed = await service().signConnectionToken({ companyId, connectionId, audience: "sts.amazonaws.com" });
    const { header, claims } = decode(signed.token);
    expect(header).toEqual({ alg: "ES256", typ: "JWT", kid: signed.keyId });
    expect(claims).toMatchObject({
      iss: `${ORIGIN}/oidc/companies/${companyId}`,
      sub: `connection:${connectionId}`,
      aud: "sts.amazonaws.com",
    });
    expect(claims.exp - claims.iat).toBe(300);
    expect(claims.nbf).toBe(claims.iat);
    expect(verifiesAgainst(signed.token, (await service().publicKeySet(companyId))!.keys)).toBe(true);

    const [audit] = await db.select().from(toolAccessAuditEvents).where(and(
      eq(toolAccessAuditEvents.companyId, companyId), eq(toolAccessAuditEvents.action, "workload_identity.token_issued"),
    ));
    expect(audit).toMatchObject({ connectionId, outcome: "success" });
    expect(JSON.stringify(audit)).not.toContain(signed.token.split(".")[2]!);
  });

  it("keeps companies and connections apart", async () => {
    const companyA = await company();
    const companyB = await company();
    const connectionB = await connection(companyB);
    await expect(service().signConnectionToken({ companyId: companyA, connectionId: connectionB, audience: "sts.amazonaws.com" }))
      .rejects.toMatchObject({ status: 404 });
    const tokenB = await service().signConnectionToken({ companyId: companyB, connectionId: connectionB, audience: "sts.amazonaws.com" });
    await service().ensureActiveKey(companyA);
    expect(verifiesAgainst(tokenB.token, (await service().publicKeySet(companyA))!.keys)).toBe(false);
  });

  it("refuses to sign without a usable public address or after the address changed", async () => {
    const companyId = await company();
    const connectionId = await connection(companyId);
    await expect(service().signConnectionToken({
      companyId, connectionId, audience: "sts.amazonaws.com", origin: workloadIdentityIssuerOrigin("http://localhost:3100"),
    })).rejects.toMatchObject({ status: 422, details: { code: "workload_identity_unavailable", reason: "not_https" } });
    await expect(service().signConnectionToken({
      companyId, connectionId, audience: "sts.amazonaws.com", expectedIssuer: `https://old.example.com/oidc/companies/${companyId}`,
    })).rejects.toMatchObject({ status: 409, details: { code: "workload_identity_issuer_changed" } });
    await expect(service().signConnectionToken({ companyId, connectionId, audience: "has space" }))
      .rejects.toMatchObject({ status: 422 });
  });

  it("rotates in two published steps, and an emergency rotation drops old keys at once", async () => {
    const companyId = await company();
    const connectionId = await connection(companyId);
    const original = await service().ensureActiveKey(companyId);
    const begun = await service().beginRotation(companyId, actor);
    expect(begun.created).toBe(true);
    expect((await service().beginRotation(companyId, actor)).created).toBe(false);
    await expect(service().completeRotation(companyId, actor))
      .rejects.toMatchObject({ status: 409, details: { code: "workload_identity_rotation_not_ready" } });
    expect((await service().signConnectionToken({ companyId, connectionId, audience: "sts.amazonaws.com" })).keyId)
      .toBe(original.keyId);

    clock = new Date(clock.getTime() + WORKLOAD_IDENTITY_PUBLISH_BEFORE_USE_MS);
    await service().completeRotation(companyId, actor);
    const afterSwap = await service().signConnectionToken({ companyId, connectionId, audience: "sts.amazonaws.com" });
    expect(afterSwap.keyId).toBe(begun.keyId);
    expect((await service().publicKeySet(companyId))!.keys.map((key) => key.kid).sort())
      .toEqual([original.keyId, begun.keyId].sort());

    clock = new Date(clock.getTime() + WORKLOAD_IDENTITY_RETIRING_GRACE_MS);
    expect((await service().publicKeySet(companyId))!.keys.map((key) => key.kid)).toEqual([begun.keyId]);
    expect((await service().describe(companyId)).keys.map((key) => key.keyId)).toEqual([begun.keyId]);
    await service().beginRotation(companyId, actor);
    const [settled] = await db.select().from(companyWorkloadIdentityKeys).where(and(
      eq(companyWorkloadIdentityKeys.companyId, companyId), eq(companyWorkloadIdentityKeys.keyId, original.keyId),
    ));
    expect(settled!.status).toBe("retired");

    const emergency = await service().emergencyRotation(companyId, actor);
    const published = (await service().publicKeySet(companyId))!.keys.map((key) => key.kid);
    expect(published).toEqual([emergency.keyId]);
    const next = await service().signConnectionToken({ companyId, connectionId, audience: "sts.amazonaws.com" });
    expect(next.keyId).toBe(emergency.keyId);
    expect(verifiesAgainst(afterSwap.token, (await service().publicKeySet(companyId))!.keys)).toBe(false);
  });

  it("refuses to sign when the stored private key is not the published one", async () => {
    const companyId = await company();
    const connectionId = await connection(companyId);
    const key = await service().ensureActiveKey(companyId);
    const other = await generateClientKeyPair("ES256");
    const { material } = await localEncryptedProvider.createSecret({ value: other.privateKeyPem });
    await db.update(companyWorkloadIdentityKeys).set({ privateKeyMaterial: material })
      .where(eq(companyWorkloadIdentityKeys.id, key.id));
    resetWorkloadIdentityKeyCacheForTests();
    await expect(service().signConnectionToken({ companyId, connectionId, audience: "sts.amazonaws.com" }))
      .rejects.toThrow(/does not match its published key/);
    expect(await db.select().from(toolAccessAuditEvents).where(and(
      eq(toolAccessAuditEvents.companyId, companyId), eq(toolAccessAuditEvents.action, "workload_identity.token_issued"),
    ))).toHaveLength(0);
  });

  it("stops issuing tokens for a disabled, archived or switched-off connection, but lets setup test a draft", async () => {
    const companyId = await company();
    for (const state of [{ status: "disabled" as const }, { status: "archived" as const }, { enabled: false }]) {
      const connectionId = await connection(companyId, state);
      await expect(service().signConnectionToken({ companyId, connectionId, audience: "sts.amazonaws.com" }))
        .rejects.toMatchObject({ status: 422, details: { code: "workload_identity_connection_inactive" } });
    }
    const draft = await connection(companyId, { status: "draft", enabled: false });
    expect((await service().signConnectionToken({ companyId, connectionId: draft, audience: "sts.amazonaws.com" })).subject)
      .toBe(`connection:${draft}`);
  });

  it("writes a rotation's activity entry only when the key change commits", async () => {
    const companyId = await company();
    await expect(service().beginRotation(companyId, actor)).rejects.toMatchObject({ status: 409 });
    const entries = () => db.select().from(activityLog).where(and(
      eq(activityLog.companyId, companyId), eq(activityLog.action, "workload_identity.rotation_begin"),
    ));
    expect(await entries()).toHaveLength(0);
    await service().ensureActiveKey(companyId);
    await service().beginRotation(companyId, actor);
    expect(await entries()).toHaveLength(1);
    expect((await service().beginRotation(companyId, actor)).created).toBe(false);
    expect(await entries()).toHaveLength(1);
  });

  it("answers the public paths anonymously in the assembled app", async () => {
    const companyId = await company();
    await service().ensureActiveKey(companyId);
    const app = await createApp(db, {
      uiMode: "none", serverPort: 0, bindHost: "127.0.0.1", allowedHostnames: ["127.0.0.1"],
      deploymentMode: "authenticated", deploymentExposure: "private", authReady: true, companyDeletionEnabled: false,
      managedPluginAutoInstall: [], storageService: createStorageService(createLocalDiskStorageProvider(join(directory, "storage"))),
      decisionServiceOptions: { wakeOriginAgent: async () => null },
    });
    await app.locals.bundledPluginsStartup;
    const server = app.listen(0, "127.0.0.1");
    try {
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No HTTP test address");
      const base = `http://127.0.0.1:${address.port}/oidc/companies/${companyId}`;
      const discovery = await fetch(`${base}/.well-known/openid-configuration`);
      expect(discovery.status).toBe(200);
      expect((await discovery.json()).issuer).toBe(base.replace(`http://127.0.0.1:${address.port}`, ORIGIN));
      const jwks = await fetch(`${base}/jwks.json`);
      expect(jwks.status).toBe(200);
      expect((await jwks.json()).keys).toHaveLength(1);
      expect((await fetch(`http://127.0.0.1:${address.port}/api/companies/${companyId}/workload-identity`)).status)
        .not.toBe(200);
    } finally {
      await app.locals.paperclipShutdown?.();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 120_000);

  it("limits status and rotation to the board and logs each rotation", async () => {
    const companyId = await company();
    await service().ensureActiveKey(companyId);
    const boardApp = express().use(express.json(), (req, _res, next) => {
      req.actor = {
        type: "board", userId: "board-user", source: "local_implicit", companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }], isInstanceAdmin: true,
      } as Express.Request["actor"];
      next();
    }).use("/api", workloadIdentityRoutes(db)).use(errorHandler);
    const state = await request(boardApp).get(`/api/companies/${companyId}/workload-identity`).expect(200);
    expect(state.body.issuer).toBe(`${ORIGIN}/oidc/companies/${companyId}`);
    expect(JSON.stringify(state.body)).not.toMatch(/private|"d"/i);
    await request(boardApp).post(`/api/companies/${companyId}/workload-identity/rotation`).send({ step: "nope" }).expect(400);
    await request(boardApp).post(`/api/companies/${companyId}/workload-identity/rotation`).send({ step: "begin" }).expect(200);
    const [entry] = await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, companyId), eq(activityLog.action, "workload_identity.rotation_begin"),
    ));
    expect(entry).toMatchObject({ actorType: "user", actorId: "board-user", entityType: "company" });

    const agentApp = express().use(express.json(), (req, _res, next) => {
      req.actor = { type: "agent", agentId: randomUUID(), companyId, source: "agent_key" } as Express.Request["actor"];
      next();
    }).use("/api", workloadIdentityRoutes(db)).use(errorHandler);
    await request(agentApp).get(`/api/companies/${companyId}/workload-identity`).expect(403);
    await request(agentApp).post(`/api/companies/${companyId}/workload-identity/rotation`).send({ step: "emergency" }).expect(403);
  });
});
