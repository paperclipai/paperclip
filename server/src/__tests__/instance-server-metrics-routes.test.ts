import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentApiKeys, agents, authUsers, boardApiKeys, companies, companyMemberships, createDb, databaseStatementCount,
  instanceUserRoles } from "@paperclipai/db";
import { createApp } from "../app.js";
import { activeServerMetrics, recordMissedLeaseRenewal, recordRunEventCommitted } from "../services/server-metrics.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const PATH = "/api/instance/server-metrics";
const FIELDS = [
  "schema", "processId", "buildRevision", "uptimeSec", "sampledAt", "windowMs", "mainThreadCpu", "processCpu",
  "eventLoopUtilization", "eventLoopDelayP99Ms", "statementsPerSecond", "runEventLatenessP99Ms", "runEventLatenessSamples",
  "agentApiPreHandlerP99Ms", "agentApiPreHandlerSamples", "leaseRenewalsMissed", "dedicatedConnections",
].sort();

type Db = ReturnType<typeof createDb>;
type App = Awaited<ReturnType<typeof createApp>>;

describePostgres("instance server metrics route", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let directory: string;
  const hash = (token: string) => createHash("sha256").update(token).digest("hex");
  const ids = { companyId: randomUUID(), agentId: randomUUID(), adminId: randomUUID(), memberId: randomUUID() };
  const keys = { admin: `pcp_board_${randomUUID()}`, member: `pcp_board_${randomUUID()}`, agent: `pcp_agent_${randomUUID()}` };

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("instance-server-metrics-");
    db = createDb(database.connectionString);
    directory = await mkdtemp(join(tmpdir(), "instance-server-metrics-storage-"));
    await db.insert(companies).values({ id: ids.companyId, name: "Metrics company", issuePrefix: "MET" });
    await db.insert(authUsers).values([ids.adminId, ids.memberId].map(id => ({ id, name: "Person", email: `${id}@example.com`,
      createdAt: new Date(), updatedAt: new Date() })));
    await db.insert(instanceUserRoles).values({ userId: ids.adminId, role: "instance_admin" });
    await db.insert(agents).values({ id: ids.agentId, companyId: ids.companyId, name: "Metrics agent", adapterType: "process",
      status: "idle", permissions: {}, runtimeConfig: { heartbeat: { wakeOnDemand: false, intervalSec: 0 } } });
    await db.insert(companyMemberships).values([
      { companyId: ids.companyId, principalType: "user", principalId: ids.memberId, membershipRole: "owner", status: "active" },
      { companyId: ids.companyId, principalType: "agent", principalId: ids.agentId, membershipRole: "member", status: "active" },
    ]);
    await db.insert(boardApiKeys).values([
      { userId: ids.adminId, name: "Admin", keyHash: hash(keys.admin) },
      { userId: ids.memberId, name: "Member", keyHash: hash(keys.member) },
    ]);
    await db.insert(agentApiKeys).values({ companyId: ids.companyId, agentId: ids.agentId, name: "Agent", keyHash: hash(keys.agent),
      responsibleUserId: ids.memberId });
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function serve<T>(serverMetricsEnabled: boolean, body: (call: (path: string, token?: string) => Promise<{ status: number; body: any; text: string }>) => Promise<T>) {
    const app: App = await createApp(db, {
      uiMode: "none", serverPort: 0, bindHost: "127.0.0.1", allowedHostnames: ["127.0.0.1"],
      deploymentMode: "authenticated", deploymentExposure: "private", authReady: true, companyDeletionEnabled: false,
      managedPluginAutoInstall: [], storageService: createStorageService(createLocalDiskStorageProvider(directory)),
      decisionServiceOptions: { wakeOriginAgent: async () => null }, serverMetricsEnabled,
    });
    await app.locals.bundledPluginsStartup;
    const server = app.listen(0, "127.0.0.1");
    try {
      await new Promise<void>(resolve => server.once("listening", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No HTTP test address");
      const call = async (path: string, token?: string) => {
        const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
        const text = await response.text();
        let parsed: unknown = null;
        try { parsed = JSON.parse(text); } catch { parsed = null; }
        return { status: response.status, body: parsed, text };
      };
      return await body(call);
    } finally {
      await app.locals.paperclipShutdown?.();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }

  it("serves numbers to an instance admin only, and they move with load", async () => {
    await serve(true, async (call) => {
      expect(activeServerMetrics()).not.toBeNull();
      expect([401, 403]).toContain((await call(PATH)).status);
      expect((await call(PATH, keys.member)).status).toBe(403);
      expect((await call(PATH, keys.agent)).status).toBe(403);

      const first = await call(PATH, keys.admin);
      expect(first.status).toBe(200);
      expect(Object.keys(first.body).sort()).toEqual(FIELDS);
      expect(first.body).toMatchObject({ schema: "paperclip.server-metrics.v1", processId: expect.stringMatching(/^[0-9a-f]{16}$/) });
      expect(first.body.buildRevision === null || /^[0-9a-f]{40}$/.test(first.body.buildRevision)).toBe(true);
      for (const field of ["uptimeSec", "windowMs", "processCpu", "eventLoopUtilization", "eventLoopDelayP99Ms", "statementsPerSecond",
        "runEventLatenessSamples", "agentApiPreHandlerSamples", "leaseRenewalsMissed"]) {
        expect(typeof first.body[field], field).toBe("number");
      }
      expect(first.body.eventLoopUtilization).toBeGreaterThanOrEqual(0);
      expect(first.body.dedicatedConnections).toMatchObject({ limit: expect.any(Number), inUse: expect.any(Number), waiting: expect.any(Number),
        queued: expect.any(Number) });
      expect(first.body.eventLoopUtilization).toBeLessThanOrEqual(1);

      const statementsBefore = databaseStatementCount();
      for (let index = 0; index < 5; index += 1) expect((await call("/api/agents/me", keys.agent)).status).toBe(200);
      expect(databaseStatementCount()).toBeGreaterThan(statementsBefore);
      recordRunEventCommitted(new Date(Date.now() - 750).toISOString(), Date.now());
      recordMissedLeaseRenewal();

      const second = await call(PATH, keys.admin);
      expect(second.status).toBe(200);
      expect(second.body.processId).toBe(first.body.processId);
      expect(second.body.agentApiPreHandlerSamples).toBeGreaterThanOrEqual(first.body.agentApiPreHandlerSamples + 5);
      expect(second.body.agentApiPreHandlerP99Ms).toBeGreaterThan(0);
      expect(second.body.statementsPerSecond).toBeGreaterThan(0);
      expect(second.body.runEventLatenessSamples).toBe(first.body.runEventLatenessSamples + 1);
      expect(second.body.runEventLatenessP99Ms).toBeGreaterThanOrEqual(700);
      expect(second.body.leaseRenewalsMissed).toBe(first.body.leaseRenewalsMissed + 1);
      for (const secret of [...Object.values(ids), ...Object.values(keys)]) expect(second.text).not.toContain(secret);
      expect(second.text).not.toMatch(/select|insert|update|from\s/i);
    });
    expect(activeServerMetrics()).toBeNull();
  }, 240_000);

  it("is absent and collects nothing when the kill switch is off", async () => {
    await serve(false, async (call) => {
      expect(activeServerMetrics()).toBeNull();
      expect((await call(PATH, keys.admin)).status).toBe(404);
      expect((await call(PATH, keys.member)).status).toBe(404);
      expect((await call("/api/agents/me", keys.agent)).status).toBe(200);
      expect(activeServerMetrics()).toBeNull();
    });
  }, 240_000);
});
