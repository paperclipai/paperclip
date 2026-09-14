import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, closeRegisteredClients, companies, createDb, environmentLeases, environments, heartbeatRuns, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { heartbeatRunProcessLocation, persistHeartbeatRunProcessMetadata } from "../services/run-process-metadata.js";
import { readProcessStartedAt } from "../services/hot-restart.js";

describe("host and remote run process metadata namespaces", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    const connectionString = process.env.PAPERCLIP_TEST_DATABASE_URL?.trim();
    database = connectionString ? { connectionString, cleanup: () => closeRegisteredClients(connectionString) }
      : await startEmbeddedPostgresTestDatabase("paperclip-process-metadata-");
    db = createDb(database.connectionString);
  }, 30000);
  afterAll(async () => { await database?.cleanup(); });
  async function fixture() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Process receipt", issuePrefix: `R${companyId.slice(0, 6)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Developer", status: "active" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id, status: "running" }).returning();
    const [environment] = await db.insert(environments).values({ name: companyId, driver: "sandbox", config: { provider: "daytona" } }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId, environmentId: environment!.id, heartbeatRunId: run!.id, provider: "daytona", providerLeaseId: randomUUID(), status: "active", metadata: {
      runtimeServiceBoundary: { version: 1, provider: "daytona", workspaceRoot: "/workspace/app" },
    } }).returning();
    return { companyId, run: run!, lease: lease! };
  }
  const reported = "2000-01-01T00:00:00.000Z";
  const identity = { version: 1 as const, pid: process.pid, uid: 1000, processGroupId: process.pid, bootId: "1d2c2412-544b-4f04-955e-c41256fe5866", startTicks: "123456" };
  const meta = { pid: process.pid, processGroupId: process.pid, startedAt: reported };

  it("preserves verified host birth observations for local adapters", async () => {
    const f = await fixture();
    const birth = await readProcessStartedAt(process.pid);
    const saved = await persistHeartbeatRunProcessMetadata(db, f.run.id, meta);
    expect(saved?.processStartedAt?.toISOString()).toBe(birth);
    expect(saved?.processGroupId).toBe(process.pid);
    expect(saved?.processLocation).toBe("local");
    expect(await heartbeatRunProcessLocation(db, saved!)).toBe("local");
  });
  it("never substitutes a colliding host PID's birth time or process group for a remote PID", async () => {
    const f = await fixture();
    const saved = await persistHeartbeatRunProcessMetadata(db, f.run.id, { ...meta, processLocation: "remote" });
    expect(saved?.processStartedAt?.toISOString()).toBe(reported);
    expect(saved?.processGroupId).toBeNull();
    expect(saved?.processLocation).toBe("remote");
    expect(await heartbeatRunProcessLocation(db, saved!)).toBe("remote");
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    expect(lease?.metadata).not.toHaveProperty("runtimeServiceProcessOwner");
  });
  it("binds a pre-exec receipt to the server-owned company, run, physical sandbox and directory", async () => {
    const f = await fixture();
    await persistHeartbeatRunProcessMetadata(db, f.run.id, { ...meta, processLocation: "remote", remoteProcessIdentity: identity }, f.lease.id);
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    expect(lease?.metadata?.runtimeServiceProcessOwner).toEqual({ version: 1, provider: "daytona", runId: f.run.id, environmentLeaseId: f.lease.id, providerLeaseId: f.lease.providerLeaseId, workspaceRoot: "/workspace/app", process: identity });
    expect(lease?.metadata?.runtimeServiceBoundary).toEqual(f.lease.metadata?.runtimeServiceBoundary);
  });
  it("recognizes older remote rows from their own lease history", async () => {
    const f = await fixture();
    expect(f.run.processLocation).toBeNull();
    expect(await heartbeatRunProcessLocation(db, f.run)).toBe("remote");
    await db.update(environmentLeases).set({ status: "released", provider: null, metadata: {} }).where(eq(environmentLeases.id, f.lease.id));
    expect(await heartbeatRunProcessLocation(db, f.run)).toBe("remote");
  });
  it("keeps deleted legacy lease evidence unknown despite a colliding host PID", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ processPid: process.pid }).where(eq(heartbeatRuns.id, f.run.id));
    await db.delete(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    expect(await heartbeatRunProcessLocation(db, f.run)).toBeNull();
  });
  it("does not use another company's remote lease as a local row's namespace", async () => {
    const f = await fixture(); const other = await fixture();
    await db.delete(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    await db.update(environmentLeases).set({ heartbeatRunId: f.run.id }).where(eq(environmentLeases.id, other.lease.id));
    expect(await heartbeatRunProcessLocation(db, f.run)).toBeNull();
  });
  it("cannot use another company's active lease and rolls back the process update", async () => {
    const f = await fixture(); const other = await fixture();
    await expect(persistHeartbeatRunProcessMetadata(db, f.run.id, { ...meta, processLocation: "remote", remoteProcessIdentity: identity }, other.lease.id)).rejects.toThrow("active run");
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
    expect(run?.processPid).toBeNull();
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, other.lease.id));
    expect(lease?.metadata).not.toHaveProperty("runtimeServiceProcessOwner");
  });
  it.each(["released", "finished", "wrong_provider"])("rejects a receipt after %s", async (scenario) => {
    const f = await fixture();
    if (scenario === "released") await db.update(environmentLeases).set({ status: "released" }).where(eq(environmentLeases.id, f.lease.id));
    if (scenario === "finished") await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.run.id));
    if (scenario === "wrong_provider") await db.update(environmentLeases).set({ metadata: { runtimeServiceBoundary: { provider: "local", workspaceRoot: "/workspace/app" } } }).where(eq(environmentLeases.id, f.lease.id));
    await expect(persistHeartbeatRunProcessMetadata(db, f.run.id, { ...meta, processLocation: "remote", remoteProcessIdentity: identity }, f.lease.id)).rejects.toThrow("active run");
    const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, f.run.id), eq(heartbeatRuns.companyId, f.companyId)));
    expect(run?.processPid).toBeNull();
  });
  it("rejects a receipt on the local callback or for another PID", async () => {
    const f = await fixture();
    await expect(persistHeartbeatRunProcessMetadata(db, f.run.id, { ...meta, remoteProcessIdentity: identity }, f.lease.id)).rejects.toThrow("Invalid remote");
    await expect(persistHeartbeatRunProcessMetadata(db, f.run.id, { ...meta, processLocation: "remote", remoteProcessIdentity: { ...identity, pid: identity.pid + 1 } }, f.lease.id)).rejects.toThrow("Invalid remote");
  });
});
