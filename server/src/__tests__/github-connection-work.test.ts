import { randomUUID, generateKeyPairSync, verify, createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { applyPendingMigrations, companies, connectionGrants, createDb, toolApplications, toolConnections } from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { createGitHubGrantContinuity, githubGrantContinuityDeadline } from "../services/tool-access/github-grant-continuity.js";
import { createPaperclipCloudConnector } from "../services/paperclip-cloud-connector.js";
import { githubConnectionEventService } from "../services/github-connection-events.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { registerGitHubConnectionContinuityWork, registerGitHubConnectionEventWork } from "../services/github-connection-work.js";
import { notifyGitHubCredentialChange } from "../services/github-connection-notifications.js";
import { idleWorkSnapshot } from "../services/task-admission.js";

const databaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_GITHUB_WORK_TEST_DATABASE_URL");
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("GitHub coordinator with PostgreSQL and controlled Cloud HTTP (simulation)", () => {
  let db: ReturnType<typeof createDb>;
  let server: Server, origin: string;
  let bindings: Array<Record<string, unknown>>, leases: number, failBindings: boolean, githubRequests: number;
  const signing = generateKeyPairSync("ed25519"), sealing = generateKeyPairSync("x25519");
  const realFetch = globalThis.fetch;
  let companyIds: string[] = [];
  beforeAll(async () => {
    await applyPendingMigrations(databaseUrl!);
    db = createDb(databaseUrl!, { maxConnections: 4 });
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString();
      if (req.url!.startsWith("/v1/connector/")) {
        const body = JSON.parse(raw), [header, payload, signature] = body.request.split(".");
        expect(verify(null, Buffer.from(`${header}.${payload}`), signing.publicKey, Buffer.from(signature, "base64url"))).toBe(true);
        const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
        expect(claims.iss).toBe("instance"); expect(claims.env).toBe("test");
        expect(claims.aud).toBe(`${origin}${req.url}`);
        if (req.url!.endsWith("/events/lease")) {
          leases++; res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ events: [], ...(claims.ewv === 1 ? { eventWakeVersion: 1 } : {}) })); return;
        }
        expect(claims.sh).toBe(createHash("sha256").update(body.binding).digest("base64url"));
        bindings.push(JSON.parse(body.binding));
        res.writeHead(failBindings ? 503 : 200, { "content-type": "application/json" }).end("{}"); return;
      }
      githubRequests++;
      const body = req.url === "/user" ? { id: 42, login: "octocat" }
        : req.url!.startsWith("/user/installations?") ? { installations: [{ id: 101, repository_selection: "all", account: { login: "octocat" } }] }
        : { total_count: 1, repositories: [{ id: 999, full_name: "octocat/repo" }] };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("HTTP fixture did not start");
    origin = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    vi.restoreAllMocks(); vi.useRealTimers();
    for (const id of companyIds) await db.delete(companies).where(eq(companies.id, id)); companyIds = [];
  });
  afterAll(async () => { server.close(); await once(server, "close"); await db.$client.end({ timeout: 1 }); });

  async function fixture(ids: string[] = []) {
    bindings = []; leases = 0; failBindings = false; githubRequests = 0;
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
    const restarted = createGitHubGrantContinuity(db, f.dependencies);
    expect(await restarted.nextGitHubConnectionContinuityAt()).toBe(retryAt);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(await restarted.sweepGitHubConnectionContinuity()).toMatchObject({ due: 0 });
    failBindings = false; await vi.advanceTimersByTimeAsync(2_000);
    await Promise.all([restarted.sweepGitHubConnectionContinuity(), restarted.sweepGitHubConnectionContinuity()]);
    const [saved] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, f.grant.id));
    expect(saved!.providerTenant!.github!.bindingSync).toBeUndefined(); expect(saved!.providerTenant!.github!.continuityRetry).toBeUndefined();
    expect(bindings.filter(binding => binding.installationId === "202")).toHaveLength(1);
    expect(githubRequests).toBe(0);
    expect(await restarted.nextGitHubConnectionContinuityAt()).toBeGreaterThan(Date.now());
    await db.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, f.connection.id));
    expect(await restarted.nextGitHubConnectionContinuityAt()).toBeNull();
    await db.update(toolConnections).set({ enabled: true }).where(eq(toolConnections.id, f.connection.id));
    await db.update(companies).set({ status: "archived" }).where(eq(companies.id, f.company.id));
    expect(await restarted.nextGitHubConnectionContinuityAt()).toBeNull();
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
