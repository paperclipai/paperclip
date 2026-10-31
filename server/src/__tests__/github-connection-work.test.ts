import { notifyChatEndpointConfiguration } from "../services/chat-channels/configuration-work-notifications.js";
import { toolAccessService } from "../services/tool-access.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { randomUUID, generateKeyPairSync, verify, createHash, diffieHellman, hkdfSync, randomBytes, createCipheriv } from "node:crypto";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { applyPendingMigrations, companies, activityLog, companySecrets, connectionEventDeliveries, connectionGrants, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, toolApplications, toolConnections } from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { createGitHubGrantContinuity, githubGrantContinuityDeadline, githubContinuityRevision } from "../services/tool-access/github-grant-continuity.js";
import { createPaperclipCloudConnector } from "../services/paperclip-cloud-connector.js";
import { githubConnectionEventService } from "../services/github-connection-events.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { registerGitHubConnectionContinuityWork, registerGitHubConnectionEventWork } from "../services/github-connection-work.js";
import { notifyGitHubCredentialChange } from "../services/github-connection-notifications.js";
import { createOAuthCredentialStore } from "../services/tool-access/oauth/credential-store.js";
import { createOAuthRefreshLeases } from "../services/tool-access/oauth/refresh-leases.js";
import { createOAuthGrantRefresh } from "../services/tool-access/oauth/grant-refresh.js";
import { secretService } from "../services/secrets.js";
import { writeConnectionCredential } from "../services/connection-credentials.js";
import { GITHUB_CONNECTOR_PROFILES } from "@paperclipai/shared";
import { notifyToolConnectionHealth } from "../services/tool-connection-health-notifications.js";
import { idleWorkSnapshot } from "../services/task-admission.js";

const databaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_GITHUB_WORK_TEST_DATABASE_URL");
const embeddedSupport = databaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeDatabase = embeddedSupport.supported ? describe : describe.skip;

describeDatabase("GitHub coordinator with PostgreSQL and controlled Cloud HTTP (simulation)", () => {
  let db: ReturnType<typeof createDb>;
  let temporaryDatabase: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let server: Server, origin: string;
  let leaseTimes: number[] = [];
  let bindings: Array<Record<string, unknown>>, leases: number, failBindings: boolean, githubRequests: number;
  const signing = generateKeyPairSync("ed25519"), sealing = generateKeyPairSync("x25519");
  let releaseRefresh: (() => void) | undefined, refreshArrived: (() => void) | undefined;
  let refreshGate: Promise<void> | undefined;
  let discoveryFailureGate: Promise<void> | undefined, discoveryArrived: (() => void) | undefined;
  let heldBindingCompany: string | undefined, bindingGate: Promise<void> | undefined;
  let bindingArrived: (() => void) | undefined, bindingClosed: (() => void) | undefined;
  const realFetch = globalThis.fetch;
  let companyIds: string[] = [];
  beforeAll(async () => {
    if (databaseUrl) await applyPendingMigrations(databaseUrl);
    else temporaryDatabase = await startEmbeddedPostgresTestDatabase("paperclip-github-work-");
    db = createDb(databaseUrl ?? temporaryDatabase!.connectionString, { maxConnections: 4 });
    // This explicitly assigned external test database is exclusive to this suite.
    await db.transaction(async tx => { await tx.execute(sql`SET LOCAL client_min_messages = warning`); await tx.execute(sql`TRUNCATE companies CASCADE`); });
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString();
      if (req.url!.startsWith("/v1/connector/")) {
        const body = JSON.parse(raw), [header, payload, signature] = body.request.split(".");
        expect(verify(null, Buffer.from(`${header}.${payload}`), signing.publicKey, Buffer.from(signature, "base64url"))).toBe(true);
        const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
        expect(claims.iss).toBe("instance"); expect(claims.env).toBe("test");
        expect(claims.aud).toBe(`${origin}${req.url}`);
        if (req.url!.endsWith("/refresh")) {
          refreshArrived?.(); await refreshGate;
          const scopes = [...GITHUB_CONNECTOR_PROFILES["github.code"].scopes];
          const algorithm = "X25519-HKDF-SHA256-A256GCM";
          const purpose = "access";
          const aad = Buffer.from([1, algorithm, purpose, "instance", "test", "github", "github.code", scopes.sort().join(" ")].join("\n"));
          const ephemeral = generateKeyPairSync("x25519");
          const epk = Buffer.from(ephemeral.publicKey.export({ format: "jwk" }).x!, "base64url");
          const recipient = Buffer.from(sealing.publicKey.export({ format: "jwk" }).x!, "base64url");
          const key = Buffer.from(hkdfSync("sha256", diffieHellman({ privateKey: ephemeral.privateKey, publicKey: sealing.publicKey }), Buffer.concat([epk, recipient]), aad, 32));
          const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(aad);
          const credentials = { v: 1, accessToken: "rotated-access", refreshToken: "rotated-refresh", tokenType: "Bearer", scopes,
            accessTokenExpiresAt: new Date(Date.now() + 8 * 3600_000).toISOString(), refreshTokenExpiresAt: null,
            subject: claims.sub, companyId: claims.cid, instanceId: "instance", environment: "test", provider: "github", profile: "github.code" };
          const ct = Buffer.concat([cipher.update(JSON.stringify(credentials)), cipher.final(), cipher.getAuthTag()]);
          res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ sealed: { v: 1, alg: algorithm, purpose, provider: "github", profile: "github.code", epk: epk.toString("base64url"), iv: iv.toString("base64url"), ct: ct.toString("base64url") } })); return;
        }
        if (req.url!.endsWith("/events/lease")) {
          leases++; leaseTimes.push(Date.now()); res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ events: [], ...(claims.ewv === 1 ? { eventWakeVersion: 1 } : {}) })); return;
        }
        expect(claims.sh).toBe(createHash("sha256").update(body.binding).digest("base64url"));
        bindings.push(JSON.parse(body.binding));
        if (claims.cid === heldBindingCompany) {
          res.writeHead(200, { "content-type": "application/json" }); res.write("{");
          res.once("close", () => bindingClosed?.()); bindingArrived?.(); await bindingGate;
          res.end("}"); return;
        }
        res.writeHead(failBindings ? 503 : 200, { "content-type": "application/json" }).end("{}"); return;
      }
      githubRequests++;
      if (req.url === "/user" && discoveryFailureGate) {
        discoveryArrived?.(); await discoveryFailureGate;
        res.writeHead(503, { "content-type": "application/json", "retry-after": "86400" }).end("{}"); return;
      }
      const body = req.url === "/user" ? { id: 42, login: "octocat" }
        : req.url!.startsWith("/user/installations?") ? { installations: [{ id: 101, repository_selection: "all", account: { login: "octocat" } }] }
        : { total_count: 1, repositories: [{ id: 999, full_name: "octocat/repo" }] };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("HTTP fixture did not start");
    origin = `http://127.0.0.1:${address.port}`;
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(async () => {
    vi.restoreAllMocks(); vi.useRealTimers();
    for (const id of companyIds) { await db.delete(activityLog).where(eq(activityLog.companyId, id)); await db.delete(companySecrets).where(eq(companySecrets.companyId, id)); await db.delete(companies).where(eq(companies.id, id)); } companyIds = [];
  });
  afterAll(async () => { server.close(); await once(server, "close"); await db.$client.end({ timeout: 1 }); await temporaryDatabase?.cleanup(); });

  async function fixture(ids: string[] = []) {
    bindings = []; leases = 0; leaseTimes = []; failBindings = false; githubRequests = 0;
    const companyId = randomUUID(); companyIds.push(companyId);
    const [company] = await db.insert(companies).values({ id: companyId, name: "GitHub work test", issuePrefix: `GW${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}` }).returning();
    const [app] = await db.insert(toolApplications).values({ companyId, applicationKey: randomUUID(), name: "GitHub", type: "mcp_server", status: "active" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId, applicationId: app!.id, uid: randomUUID(), name: "GitHub", status: "active", enabled: true,
      transport: "mcp_remote", authKind: "oauth", credentialPolicy: "per_user", config: { sourceTemplateKey: "github", oauth: { connectorProfile: "github.code" } }, transportConfig: {} }).returning();
    const [grant] = await db.insert(connectionGrants).values({ companyId, connectionId: connection!.id, kind: "user", subjectUserId: "owner", status: "active",
      credentialSecretRefs: [{ configPath: "oauth.access_token", secretId: randomUUID(), label: "Access", provider: "local_encrypted" }],
      providerTenant: { oauth: { accessTokenExpiresAt: new Date(Date.now() + 8 * 3600_000).toISOString(), refreshedAt: new Date().toISOString() }, github: {
        userId: "42", login: "octocat", installationCount: ids.length, repositoryCount: 1, repositorySelection: "all", installationIds: ids,
        installationOwnerLogins: ["octocat"], accessRevision: randomUUID(), lastAccessRefreshAt: new Date().toISOString(), webhookHealth: "healthy",
      } } }).returning();
    const connector = createPaperclipCloudConnector({ config: { baseUrl: origin, instanceId: "instance", environment: "test",
      signPrivateKey: signing.privateKey.export({ format: "jwk" }).d!, sealPrivateKey: sealing.privateKey.export({ format: "jwk" }).d! } });
    type Dependencies = Parameters<typeof createGitHubGrantContinuity>[1];
    const dependencies: Dependencies = {
      now: () => new Date(), currentCloudConnector: () => connector,
      refreshOAuthGrantCredentials: async input => (await db.select().from(connectionGrants).where(eq(connectionGrants.id, input.grantId)))[0]!,
      resolveOAuthGrantSecret: (async () => ({ value: "controlled-token" })) as Dependencies["resolveOAuthGrantSecret"],
    };
    const service = createGitHubGrantContinuity(db, dependencies);
    return { company: company!, connection: connection!, grant: grant!, connector, service, dependencies };
  }
  const fakeClock = () => vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  async function settled(coordinator: ReturnType<typeof createDeliveryWorkCoordinator>) {
    await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0));
    expect(coordinator.nextWakeAt()).not.toBeNull();
  }

  it("ordinary grant refresh activates events from quiet, commits durable result, then performs no owner SQL/HTTP across old cadence windows", async () => {
    const f = await fixture(); fakeClock();
    vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => String(url).startsWith("https://api.github.com")
      ? realFetch(`${origin}${new URL(String(url)).pathname}${new URL(String(url)).search}`, init) : realFetch(url, init));
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const events = githubConnectionEventService(db, { connector: f.connector });
    const ew = registerGitHubConnectionEventWork(db, coordinator, events, () => true);
    const cw = registerGitHubConnectionContinuityWork(db, coordinator, f.service, () => true);
    try {
      await Promise.all([ew.ready, cw.ready]); expect(leases).toBe(1);
      const startupLeases = leases;
      await f.service.refreshManagedGitHubGrantAccess(f.connection, f.grant, { actorType: "system", actorId: "test" });
      await vi.advanceTimersByTimeAsync(6_000);
      await vi.waitFor(() => expect(leases).toBeGreaterThan(startupLeases));
      await vi.advanceTimersByTimeAsync(31_000); await settled(coordinator);
      const [saved] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, f.grant.id));
      expect(saved!.providerTenant!.github!.installationIds).toEqual(["101"]);
      expect(saved!.providerTenant!.github!.bindingSync).toBeUndefined();
      expect(bindings).toContainEqual(expect.objectContaining({ active: true, installationId: "101", id: `${f.grant.id}_101` }));
      const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction"), execute = vi.spyOn(db, "execute");
      const before = { leases, githubRequests, bindings: bindings.length };
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
      expect({ leases, githubRequests, bindings: bindings.length }).toEqual(before); expect(errors).toEqual([]);
    } finally { await ew.stop(); await cw.stop(); await coordinator.stop(); }
  });

  it("failed binding removal persists retry/debt through restart, uses current lease deadline and settles without refetching GitHub metadata", async () => {
    const f = await fixture(["101"]); fakeClock();
    await db.update(connectionGrants).set({ providerTenant: { ...f.grant.providerTenant, github: { ...f.grant.providerTenant!.github!,
      bindingSync: { id: randomUUID(), removeInstallationIds: ["202"] } } } }).where(eq(connectionGrants.id, f.grant.id));
    failBindings = true;
    expect(await f.service.sweepGitHubConnectionContinuity()).toMatchObject({ due: 1, failed: 1 });
    const [failed] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, f.grant.id));
    expect(failed!.providerTenant!.github!.bindingSync!.removeInstallationIds).toEqual(["202"]);
    const retryAt = Date.parse(failed!.providerTenant!.github!.continuityRetry!.at);
    const attemptedRemovals = bindings.filter(binding => binding.installationId === "202").length;
    const restarted = createGitHubGrantContinuity(db, f.dependencies);
    expect(await restarted.nextGitHubConnectionContinuityAt()).toBe(retryAt);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(await restarted.sweepGitHubConnectionContinuity()).toMatchObject({ due: 0 });
    failBindings = false; await vi.advanceTimersByTimeAsync(2_000);
    await Promise.all([restarted.sweepGitHubConnectionContinuity(), restarted.sweepGitHubConnectionContinuity()]);
    const [saved] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, f.grant.id));
    expect(saved!.providerTenant!.github!.bindingSync).toBeUndefined(); expect(saved!.providerTenant!.github!.continuityRetry).toBeUndefined();
    expect(bindings.filter(binding => binding.installationId === "202")).toHaveLength(attemptedRemovals + 1);
    expect(githubRequests).toBe(0);
    expect(await restarted.nextGitHubConnectionContinuityAt()).toBeGreaterThan(Date.now());
    await db.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, f.connection.id));
    expect(await restarted.nextGitHubConnectionContinuityAt()).toBeNull();
    await db.update(toolConnections).set({ enabled: true }).where(eq(toolConnections.id, f.connection.id));
    await db.update(companies).set({ status: "archived" }).where(eq(companies.id, f.company.id));
    expect(await restarted.nextGitHubConnectionContinuityAt()).toBeNull();
  });

  it.each(["credential", "installation"])("does not attach a withheld provider failure to newer %s work", async change => {
    const f = await fixture(["101"]);
    vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => String(url).startsWith("https://api.github.com")
      ? realFetch(`${origin}${new URL(String(url)).pathname}${new URL(String(url)).search}`, init) : realFetch(url, init));
    await db.update(connectionGrants).set({ providerTenant: { ...f.grant.providerTenant,
      oauth: { ...f.grant.providerTenant!.oauth, accessTokenExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString() } } }).where(eq(connectionGrants.id, f.grant.id));
    let release!: () => void;
    const arrived = new Promise<void>(resolve => { discoveryArrived = resolve; });
    discoveryFailureGate = new Promise<void>(resolve => { release = resolve; });
    const pending = f.service.sweepGitHubConnectionContinuity(f.company.id);
    const finished = Promise.allSettled([pending]);
    try {
      await Promise.race([arrived, pending.then(() => { throw new Error("Expected held provider request"); })]);
      const revision = randomUUID();
      const expiry = new Date(Date.now() + 10 * 60_000).toISOString();
      await db.transaction(async tx => {
        await notifyGitHubCredentialChange(tx, f.connection);
        await tx.update(connectionGrants).set({ providerTenant: change === "credential"
          ? sql`jsonb_set(${connectionGrants.providerTenant}, '{oauth,accessTokenExpiresAt}', ${JSON.stringify(expiry)}::jsonb)`
          : sql`jsonb_set(${connectionGrants.providerTenant}, '{github,bindingSync}', ${JSON.stringify({ id: revision, removeInstallationIds: ["202"] })}::jsonb)`,
          updatedAt: new Date() }).where(eq(connectionGrants.id, f.grant.id));
      });
      release();
      expect(await pending).toMatchObject({ due: 1, failed: 1 });
      const [saved] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, f.grant.id));
      expect(saved!.providerTenant!.github!.continuityRetry).toBeUndefined();
      if (change === "credential") expect(saved!.providerTenant!.oauth!.accessTokenExpiresAt).toBe(expiry);
      else expect(saved!.providerTenant!.github!.bindingSync!.id).toBe(revision);
      expect(githubGrantContinuityDeadline(f.connection, saved!)).toBeLessThanOrEqual(Date.now());
      discoveryFailureGate = undefined;
      const restarted = createGitHubGrantContinuity(db, f.dependencies);
      expect(await restarted.sweepGitHubConnectionContinuity(f.company.id)).toMatchObject({ due: 1, refreshed: 1, failed: 0 });
      expect(bindings).toContainEqual(expect.objectContaining({ installationId: "101", active: true }));
      if (change === "installation") expect(bindings).toContainEqual(expect.objectContaining({ installationId: "202", active: false }));
      const [settled] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, f.grant.id));
      expect(settled!.providerTenant!.github!.bindingSync).toBeUndefined();
      const next = await restarted.nextGitHubConnectionContinuityAt(f.company.id);
      expect(next).toBeLessThan(Date.now() + 24 * 60 * 60_000);
    } finally { release(); await finished; discoveryFailureGate = undefined; discoveryArrived = undefined; }
  });

  it("retains provider backoff for the actual attempted revision after its own credential rotation", async () => {
    const f = await fixture(["101"]);
    await db.update(connectionGrants).set({ providerTenant: { ...f.grant.providerTenant,
      oauth: { ...f.grant.providerTenant!.oauth, accessTokenExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString() } } }).where(eq(connectionGrants.id, f.grant.id));
    vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => String(url).startsWith("https://api.github.com")
      ? realFetch(`${origin}${new URL(String(url)).pathname}${new URL(String(url)).search}`, init) : realFetch(url, init));
    const owner = createGitHubGrantContinuity(db, { ...f.dependencies, refreshOAuthGrantCredentials: async () => {
      const [rotated] = await db.update(connectionGrants).set({ providerTenant: sql`jsonb_set(${connectionGrants.providerTenant}, '{oauth}', ${JSON.stringify({
        accessTokenExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), refreshedAt: new Date().toISOString(),
      })}::jsonb)` }).where(eq(connectionGrants.id, f.grant.id)).returning();
      return rotated!;
    } });
    discoveryFailureGate = Promise.resolve();
    try {
      expect(await owner.sweepGitHubConnectionContinuity(f.company.id)).toMatchObject({ due: 1, failed: 1 });
      const [saved] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, f.grant.id));
      expect(saved!.providerTenant!.github!.continuityRetry!.revision).toBe(githubContinuityRevision(saved!));
      expect(await owner.nextGitHubConnectionContinuityAt(f.company.id)).toBeGreaterThan(Date.now() + 23 * 60 * 60_000);
      const calls = githubRequests;
      expect(await createGitHubGrantContinuity(db, f.dependencies).sweepGitHubConnectionContinuity(f.company.id)).toMatchObject({ due: 0 });
      expect(githubRequests).toBe(calls);
    } finally { discoveryFailureGate = undefined; }
  });

  it.each([["suspend", "unsuspend"], ["unsuspend", "suspend"]])("reconciles same-batch installation order %s then %s and duplicate replay", async (first, last) => {
    const f = await fixture(["101"]);
    await db.update(connectionGrants).set({ providerTenant: { ...f.grant.providerTenant,
      github: { ...f.grant.providerTenant!.github!, bindingSync: { id: randomUUID(), removeInstallationIds: ["202"] } } } }).where(eq(connectionGrants.id, f.grant.id));
    const events = [first, last].map(action => ({ id: randomUUID(), provider: "github" as const, event: "installation", action,
      installationId: "101", repositoryId: null, createdAt: new Date(Date.now() + 1000).toISOString(), bindingIds: [`${f.grant.id}_101`], payload: { installationId: "101" } }));
    const acknowledge = vi.fn(async () => events.length);
    const ingress = githubConnectionEventService(db, { connector: { ...f.connector, leaseEvents: async () => ({ leaseId: "installation-batch", events }), acknowledgeEvents: acknowledge } });
    expect(await ingress.pollOnce({ forDelivery: true })).toMatchObject({ processed: 2, failed: 0 });
    const [saved] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, f.grant.id));
    const active = last === "unsuspend";
    expect(saved!.providerTenant!.github!.installationIds).toEqual(active ? ["101"] : []);
    expect(saved!.providerTenant!.github!.bindingSync!.removeInstallationIds.sort()).toEqual(active ? ["202"] : ["101", "202"]);
    expect(githubGrantContinuityDeadline(f.connection, saved!)).toBe(0);
    await f.service.syncGitHubGrantBindings(f.connection, saved!);
    expect(bindings.filter(binding => binding.installationId === "101")).toEqual([expect.objectContaining({ active })]);
    expect(bindings.filter(binding => binding.installationId === "202")).toEqual([expect.objectContaining({ active: false })]);
    const [settled] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, f.grant.id));
    expect(settled!.providerTenant!.github!.bindingSync).toBeUndefined();
    // Batch duplicates must retain terminal receipts and emit no registration changes.
    expect(await ingress.pollOnce({ forDelivery: true })).toMatchObject({ processed: 0, duplicate: active ? 2 : 0, ignored: active ? 0 : 2, failed: 0 });
    await f.service.syncGitHubGrantBindings(f.connection, saved!);
    expect(bindings).toHaveLength(2);
    expect((await db.select().from(connectionGrants).where(eq(connectionGrants.id, f.grant.id)))[0]!.providerTenant).toEqual(settled!.providerTenant);
    expect((await db.select().from(connectionEventDeliveries).where(eq(connectionEventDeliveries.companyId, f.company.id))).map(receipt => receipt.status)).toEqual(["processed", "processed"]);
    expect(acknowledge).toHaveBeenCalledTimes(2);
  });

  it("does not retire active installations from a legacy conflicting binding intent", async () => {
    const f = await fixture(["101"]);
    const [saved] = await db.update(connectionGrants).set({ providerTenant: { ...f.grant.providerTenant,
      github: { ...f.grant.providerTenant!.github!, bindingSync: { id: randomUUID(), removeInstallationIds: ["101", "202"] } } } }).where(eq(connectionGrants.id, f.grant.id)).returning();
    await f.service.syncGitHubGrantBindings(f.connection, saved!);
    expect(bindings.filter(binding => binding.installationId === "101")).toEqual([expect.objectContaining({ active: true })]);
    expect(bindings.filter(binding => binding.installationId === "202")).toEqual([expect.objectContaining({ active: false })]);
  });

  it("preserves webhook removal debt across an actual signed, held Cloud token rotation and lease cleanup", async () => {
    const f = await fixture(["101"]);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "01234567890123456789012345678901");
    const refs = [];
    for (const path of ["oauth.access_token", "oauth.refresh_token"]) {
      const saved = await writeConnectionCredential(db, { companyId: f.company.id, connectionName: "GitHub", configPath: path, label: path, value: path, ownerUserId: "owner" });
      refs.push({ configPath: path, secretId: saved.secret.id, versionSelector: "latest" as const });
    }
    const [connection] = await db.update(toolConnections).set({ credentialSource: "paperclip_vault", config: { ...f.connection.config,
      oauth: { strategy: "paperclip_cloud_connector", connectorProfile: "github.code" } } }).where(eq(toolConnections.id, f.connection.id)).returning();
    const [grant] = await db.update(connectionGrants).set({ credentialSecretRefs: refs }).where(eq(connectionGrants.id, f.grant.id)).returning();
    const getConnection = async () => (await db.select().from(toolConnections).where(eq(toolConnections.id, connection!.id)))[0]!;
    const store = createOAuthCredentialStore(db, secretService(db));
    await store.syncCredentialBindings(connection!, refs);
    const leases = createOAuthRefreshLeases(db, () => new Date(), getConnection, store.getOAuthGrantRow);
    const rotation = createOAuthGrantRefresh(db, { now: () => new Date(), store, leases, getConnectionRow: getConnection,
      currentCloudConnector: () => f.connector, exchangeOAuthToken: vi.fn() });
    const arrived = new Promise<void>(resolve => { refreshArrived = resolve; });
    refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve; });
    const pending = rotation({ companyId: f.company.id, connectionId: connection!.id, grantId: grant!.id, forceRefresh: true });
    const result = Promise.allSettled([pending]);
    try {
      await Promise.race([arrived, pending.then(() => { throw new Error("Rotation returned before the Cloud HTTP boundary"); })]);
      const connector = { ...f.connector, acknowledgeEvents: async () => 1, leaseEvents: async () => ({ leaseId: "removal", events: [{ id: randomUUID(), provider: "github" as const,
        event: "installation", action: "deleted", installationId: "101", repositoryId: null, createdAt: new Date(Date.now() + 1000).toISOString(), bindingIds: [`${grant!.id}_101`], payload: { installationId: "101" } }] }) };
      expect(await githubConnectionEventService(db, { connector }).pollOnce()).toMatchObject({ processed: 1 });
      const [before] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant!.id));
      expect(before!.providerTenant!.github!.bindingSync!.removeInstallationIds).toEqual(["101"]);
      releaseRefresh!();
      const [completion] = await result; if (completion.status === "rejected") throw completion.reason;
      const [saved] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant!.id));
      expect(saved!.providerTenant!.github).toEqual(before!.providerTenant!.github);
      expect(saved!.providerTenant!.oauth).toMatchObject({ tokenType: "Bearer" });
      expect(saved!.providerTenant!.oauth!.refreshLease).toBeUndefined();
      await f.service.syncGitHubGrantBindings(connection!, saved!);
      expect(bindings).toContainEqual(expect.objectContaining({ installationId: "101", active: false }));
      expect((await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant!.id)))[0]!.providerTenant!.github!.bindingSync).toBeUndefined();
    } finally { releaseRefresh?.(); await result; refreshGate = undefined; refreshArrived = undefined; vi.unstubAllEnvs(); }
  });

  it("bounds a held Cloud body without releasing revocation admission, while another company progresses and restart retains removal debt", async () => {
    const f = await fixture([]), other = await fixture([]);
    for (const row of [f, other]) await db.update(connectionGrants).set({ providerTenant: {
      ...row.grant.providerTenant, github: { ...row.grant.providerTenant!.github!, bindingSync: { id: randomUUID(), removeInstallationIds: ["101"] } },
    } }).where(eq(connectionGrants.id, row.grant.id));
    const latest = async (id: string) => (await db.select().from(connectionGrants).where(eq(connectionGrants.id, id)))[0]!;
    heldBindingCompany = f.company.id;
    let release!: () => void;
    bindingGate = new Promise<void>(resolve => { release = resolve; });
    const arrived = new Promise<void>(resolve => { bindingArrived = resolve; });
    const closed = new Promise<void>(resolve => { bindingClosed = resolve; });
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const deadlines = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => timeout(ms === 15_000 ? 3_000 : ms));
    let completed = false;
    const attempt = f.service.syncGitHubGrantBindings(f.connection, await latest(f.grant.id));
    const outcome = attempt.then(value => ({ value, error: null }), error => ({ value: null, error })).finally(() => { completed = true; });
    try {
      await arrived;
      const otherResult = await other.service.syncGitHubGrantBindings(other.connection, await latest(other.grant.id));
      expect(otherResult.providerTenant!.github!.bindingSync).toBeUndefined();
      await db.update(companies).set({ name: "Unrelated company changed while body held" }).where(eq(companies.id, other.company.id));
      expect(completed).toBe(false);
      expect((await outcome).error).toMatchObject({ code: "CONNECTOR_BAD_RESPONSE" });
      await closed;
      expect(deadlines).toHaveBeenCalledWith(15_000);
      expect((await latest(f.grant.id)).providerTenant!.github!.bindingSync!.removeInstallationIds).toEqual(["101"]);
      heldBindingCompany = undefined; release();
      const restarted = createGitHubGrantContinuity(db, f.dependencies);
      expect(await restarted.sweepGitHubConnectionContinuity(f.company.id)).toMatchObject({ due: 1, refreshed: 1, failed: 0 });
      expect((await latest(f.grant.id)).providerTenant!.github!.bindingSync).toBeUndefined();
    } finally { heldBindingCompany = undefined; release(); await outcome; bindingGate = undefined; bindingArrived = undefined; bindingClosed = undefined; }
  });

  it("lease acquire and cleanup cannot replace a concurrent webhook metadata revision", async () => {
    const f = await fixture(["101"]);
    let interleave = true;
    const removal = { id: randomUUID(), removeInstallationIds: ["202"] };
    const getGrant = async () => {
      const [snapshot] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, f.grant.id));
      if (interleave) {
        interleave = false;
        await db.update(connectionGrants).set({ providerTenant: sql`jsonb_set(${connectionGrants.providerTenant}, '{github,bindingSync}', ${JSON.stringify(removal)}::jsonb)` }).where(eq(connectionGrants.id, f.grant.id));
      }
      return snapshot!;
    };
    const leaseOwner = createOAuthRefreshLeases(db, () => new Date(), async () => f.connection, getGrant);
    const lease = await leaseOwner.acquireOAuthGrantRefreshLease(f.connection, f.grant, true);
    expect(lease.leaseId).toBeTruthy();
    expect(lease.grant.providerTenant!.github!.bindingSync).toEqual(removal);
    // Cleanup deliberately reads a stale snapshot immediately before a new delta.
    const second = { ...removal, id: randomUUID(), removeInstallationIds: ["202", "303"] };
    const cleanup = createOAuthRefreshLeases(db, () => new Date(), async () => f.connection, async () => {
      const snapshot = await getGrant();
      await db.update(connectionGrants).set({ providerTenant: sql`jsonb_set(${connectionGrants.providerTenant}, '{github,bindingSync}', ${JSON.stringify(second)}::jsonb)` }).where(eq(connectionGrants.id, f.grant.id));
      return snapshot;
    });
    const cleared = await cleanup.clearOAuthGrantRefreshLease(lease.grant, lease.leaseId!);
    expect(cleared.providerTenant!.github!.bindingSync).toEqual(second);
    expect(cleared.providerTenant!.oauth!.refreshLease).toBeUndefined();
  });

  it("ignores unrelated health write bursts and scopes credential reconstruction to its owning company", async () => {
    const f = await fixture(["101"]), other = await fixture(["202"]); fakeClock();
    // A large unrelated company set must not enter a targeted credential reload.
    for (let index = 0; index < 50; index++) {
      const id = randomUUID(); companyIds.push(id);
      await db.insert(companies).values({ id, name: "Unrelated credential owner", issuePrefix: `U${index}${id.slice(0, 6)}` });
    }
    const [unrelatedConnection] = await db.update(toolConnections).set({ config: {}, transportConfig: {}, transport: "rest_api", authKind: "none", credentialRefs: [], credentialSecretRefs: [] }).where(eq(toolConnections.id, other.connection.id)).returning();
    await db.update(connectionGrants).set({ credentialSecretRefs: [] }).where(eq(connectionGrants.id, other.grant.id));
    const api = toolAccessService(db);
    const loadTimes: number[] = [];
    const schedule = f.service.githubConnectionContinuitySchedule.bind(f.service);
    const load = vi.spyOn(f.service, "githubConnectionContinuitySchedule").mockImplementation(companyId => { loadTimes.push(Date.now()); return schedule(companyId); });
    const sweep = vi.spyOn(f.service, "sweepGitHubConnectionContinuity");
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true });
    const continuity = registerGitHubConnectionContinuityWork(db, coordinator, f.service, () => true);
    const events = registerGitHubConnectionEventWork(db, coordinator, githubConnectionEventService(db, { connector: f.connector }), () => true);
    try {
      await Promise.all([continuity.ready, events.ready]);
      await vi.waitFor(() => expect(leases).toBe(1));
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
      load.mockClear(); loadTimes.length = 0; sweep.mockClear();
      for (let i = 0; i < 30; i++) {
        await db.transaction(async tx => { await notifyToolConnectionHealth(tx, other.connection); await notifyChatEndpointConfiguration(tx, { id: randomUUID(), provider: "discord" }); });
        await api.updateConnection(unrelatedConnection!.id, { name: `Unrelated patch ${i}` });
      }
      await vi.advanceTimersByTimeAsync(10_000);
      expect(load).not.toHaveBeenCalled(); expect(sweep).not.toHaveBeenCalled(); expect(leases).toBe(1);
      for (let index = 0; index < 30; index++) await db.transaction(async tx => { await notifyGitHubCredentialChange(tx, f.connection); });
      expect(leases).toBeLessThanOrEqual(2);
      await vi.advanceTimersByTimeAsync(6_000);
      await vi.waitFor(() => expect(load).toHaveBeenCalledWith(f.company.id));
      expect(load.mock.calls.every(([companyId]) => companyId === f.company.id)).toBe(true);
      expect(sweep).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(leases).toBeGreaterThanOrEqual(2));
      // The first hint can run immediately; changes during it get one spaced pass.
      expect(leases).toBeLessThanOrEqual(3); expect(load.mock.calls.length).toBeLessThanOrEqual(2);
      if (loadTimes.length === 2) expect(loadTimes[1]! - loadTimes[0]!).toBeGreaterThanOrEqual(5_000);
      if (leaseTimes.length === 3) expect(leaseTimes[2]! - leaseTimes[1]!).toBeGreaterThanOrEqual(5_000);
      // A hint arriving during the first SQL pass retains one spaced generation.
      // Start the empty-window assertion after that concrete work has settled.
      await vi.advanceTimersByTimeAsync(31_000); await settled(coordinator);
      expect(leases).toBeLessThanOrEqual(3); expect(load.mock.calls.length).toBeLessThanOrEqual(2);
      if (loadTimes.length === 2) expect(loadTimes[1]! - loadTimes[0]!).toBeGreaterThanOrEqual(5_000);
      const quiet = { leases, loads: load.mock.calls.length };
      await vi.advanceTimersByTimeAsync(60_000);
      expect({ leases, loads: load.mock.calls.length }).toEqual(quiet);
    } finally { await events.stop(); await continuity.stop(); await coordinator.stop(); }
  });

  it("settles only the company and grant that own saved binding debt", async () => {
    const f = await fixture(["101"]), other = await fixture(["202"]);
    await db.update(connectionGrants).set({ providerTenant: { ...f.grant.providerTenant, github: { ...f.grant.providerTenant!.github!,
      bindingSync: { id: randomUUID(), removeInstallationIds: [] } } } }).where(eq(connectionGrants.id, f.grant.id));
    await f.service.sweepGitHubConnectionContinuity();
    expect(bindings).toHaveLength(1); expect(bindings[0]).toMatchObject({ grantId: f.grant.id, installationId: "101" });
    const [untouched] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, other.grant.id));
    expect(untouched!.providerTenant).toEqual(other.grant.providerTenant);
  });

  it("retains a real deadline when successful renewal leaves a short-lived credential unchanged", async () => {
    const f = await fixture(["101"]); fakeClock();
    vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => String(url).startsWith("https://api.github.com")
      ? realFetch(`${origin}${new URL(String(url)).pathname}${new URL(String(url)).search}`, init) : realFetch(url, init));
    await db.update(connectionGrants).set({ providerTenant: { ...f.grant.providerTenant,
      oauth: { ...f.grant.providerTenant!.oauth, accessTokenExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString() } } }).where(eq(connectionGrants.id, f.grant.id));
    expect(await f.service.sweepGitHubConnectionContinuity()).toMatchObject({ due: 1, refreshed: 1 });
    const [saved] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, f.grant.id));
    const retryAt = Date.parse(saved!.providerTenant!.github!.continuityRetry!.at);
    expect(retryAt).toBeGreaterThanOrEqual(Date.now() + 59 * 60_000);
    const restarted = createGitHubGrantContinuity(db, f.dependencies);
    expect(await restarted.nextGitHubConnectionContinuityAt()).toBe(retryAt);
    const requests = githubRequests; await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(await restarted.sweepGitHubConnectionContinuity()).toMatchObject({ due: 0 }); expect(githubRequests).toBe(requests);
  });

  it("outer commit, rollback and first producer during drain retain the deadline and resume obligation without cross-company work", async () => {
    const f = await fixture(["101"]); fakeClock();
    let enabled = false;
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => enabled, canReconcile: () => true, onError: error => errors.push(error) });
    const worker = registerGitHubConnectionContinuityWork(db, coordinator, f.service, () => enabled);
    try {
      await worker.ready;
      const dueAt = Date.now() + 90 * 60_000;
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const transaction = db.transaction(async tx => {
        await tx.transaction(async nested => {
          await notifyGitHubCredentialChange(nested, f.connection);
          await nested.update(connectionGrants).set({ providerTenant: { ...f.grant.providerTenant,
            oauth: { ...f.grant.providerTenant!.oauth, accessTokenExpiresAt: new Date(dueAt + 3600_000).toISOString() } } }).where(eq(connectionGrants.id, f.grant.id));
        });
        await held;
      });
      await new Promise(resolve => setImmediate(resolve));
      expect(bindings).toHaveLength(0); release(); await transaction;
      await vi.advanceTimersByTimeAsync(31_000);
      expect(idleWorkSnapshot().active).toBe(0); expect(bindings).toHaveLength(0);
      enabled = true; await vi.advanceTimersByTimeAsync(31_000);
      await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBe(dueAt));
      await expect(db.transaction(async tx => { await notifyGitHubCredentialChange(tx, f.connection);
        await tx.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, f.grant.id)); throw new Error("rollback"); })).rejects.toThrow("rollback");
      await vi.advanceTimersByTimeAsync(31_000);
      await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBe(dueAt)); expect(errors).toEqual([]);
    } finally { await worker.stop(); await coordinator.stop(); }
  });
});
