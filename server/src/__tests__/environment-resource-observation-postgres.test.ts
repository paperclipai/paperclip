import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, companies, environmentLeases, environments, heartbeatRuns, secretAccessEvents,
  applyPendingMigrations, createDb, dedicatedDbConnectionStats, withDedicatedDbConnection, type Db } from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "../lib/dedicated-test-database-url.js";
import { environmentService } from "../services/environments.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { observeStoppedExecutionResource, readEnvironmentResourceObservationFailure } from "../services/environment-resource-observation.js";
import { historicalProviderCredentials } from "../services/historical-provider-credentials.js";
import { secretService } from "../services/secrets.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";

const url = resolveExternalTestDatabaseUrl("PAPERCLIP_RESOURCE_OBSERVATION_TEST_DATABASE_URL");
const suite = url ? describe : describe.skip;
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function entered<T>(signal: Promise<T>, operation: Promise<unknown>): Promise<T> {
  return await Promise.race([signal, operation.then(() => { throw new Error("operation settled before controlled boundary"); })]);
}
suite("optional resource observation with an owned PostgreSQL scope", () => {
  let db: Db;
  let control: Db;
  let keyHome: string;
  const previousKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  beforeAll(async () => {
    if (!url) throw new Error("explicit owned database URL required");
    if (!process.env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL) throw new Error("explicit owned admin URL required");
    await applyPendingMigrations(url);
    // Main1 + one borrowed dedicated1 + functional control1 = aggregate3.
    // No coordinator observer or embedded PostgreSQL fallback.
    db = createDb(url, { maxConnections: 1, dedicatedConnectionMax: 1 });
    control = createDb(url, { maxConnections: 1 });
    keyHome = await mkdtemp(join(tmpdir(), "resource-observation-secret-"));
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = join(keyHome, "master.key");
  }, 90_000);
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    try { await Promise.all([db?.$client.end({ timeout: 1 }), control?.$client.end({ timeout: 1 })]); }
    finally {
      if (previousKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
      else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKey;
      if (keyHome) await rm(keyHome, { recursive: true, force: true });
    }
  }, 30_000);
  async function seed() {
    const companyId = randomUUID(); const agentId = randomUUID(); const runId = randomUUID();
    const environmentId = randomUUID(); const leaseId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Observation scope", issuePrefix: `OBS${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Observation agent", adapterType: "codex_local", status: "idle" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "failed", invocationSource: "on_demand", finishedAt: new Date() });
    await db.insert(environments).values({ id: environmentId, name: `Controlled observation ${environmentId}`, driver: "sandbox", status: "active", config: { provider: "controlled-provider", image: "fixture", reuseLease: false } });
    await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId, heartbeatRunId: runId, provider: "controlled-provider", providerLeaseId: randomUUID(), status: "active" });
    const service = environmentService(db);
    const environment = await service.getById(environmentId); const lease = await service.getLeaseById(leaseId);
    if (!environment || !lease) throw new Error("normal environment fixture was not created");
    return { companyId, runId, environment, lease };
  }

  it.each(["initial_read", "final_read"] as const)("returns the original command error during a locked %s and preserves the shared client", async blocked => {
    const fixture = await seed();
    const mainEntered = deferred<number>(); const mainRelease = deferred();
    const lockRequested = deferred(); const lockEntered = deferred(); const lockRelease = deferred();
    let activity!: () => Promise<Array<{ pid: number; birth: string; state: string; wait: string | null }>>;
    const inspect = vi.fn(async () => {
      if (blocked === "final_read") {
        lockRequested.resolve();
        await entered(lockEntered.promise, lock);
      }
      return { providerLeaseId: fixture.lease.providerLeaseId!, state: "stopped" as const };
    });
    const original = new Error("original command failed");
    const runtime = environmentRuntimeService(db, { drivers: [{ driver: "sandbox",
      acquireRunLease: async () => { throw new Error("unexpected acquire"); }, releaseRunLease: async () => null,
      execute: async () => { throw original; }, inspectLeaseResource: inspect,
    }] });
    const main = db.transaction(async tx => {
      const rows = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      mainEntered.resolve(rows[0]!.pid); await mainRelease.promise;
    });
    const lock = control.transaction(async tx => {
      await lockRequested.promise;
      await tx.execute(sql`lock table environment_leases in access exclusive mode`);
      activity = async () => {
        await tx.execute(sql`select pg_stat_clear_snapshot()`);
        return Array.from(await tx.execute<{ pid: number; birth: string; state: string; wait: string | null }>(sql`
        select pid, backend_start::text as birth, state, wait_event_type as wait from pg_stat_activity
        where datname = current_database() and (application_name = 'paperclip-workspace-finalization-lock' or pid <> pg_backend_pid())`));
      };
      lockEntered.resolve(); await lockRelease.promise;
    });
    let primary: unknown;
    let execution: Promise<unknown> | undefined;
    try {
      const mainPid = await entered(mainEntered.promise, main);
      if (blocked === "initial_read") {
        lockRequested.resolve();
        await entered(lockEntered.promise, lock);
      }
      const commandStartedAt = performance.now();
      const operation = runtime.execute({ environment: fixture.environment, lease: fixture.lease, command: "controlled", timeoutMs: 1500 });
      const outcome = operation.then(value => ({ value }), error => ({ error }));
      execution = outcome;
      await entered(lockEntered.promise, operation);
      let blockedPid: number | undefined;
      let blockedBirth: string | undefined;
      // The same functional control transaction owns the table lock and proves
      // the exact scoped query reached PostgreSQL, without another observer pool.
      await vi.waitFor(async () => {
        const rows = await activity();
        const blocked = rows.find(row => row.wait === "Lock" && row.pid !== mainPid);
        expect(blocked).toBeDefined(); blockedPid = blocked!.pid; blockedBirth = blocked!.birth;
      }, { timeout: 1000 });
      const result = await outcome;
      const callerReturnedAt = performance.now();
      console.info("resource-observation-caller-timing", JSON.stringify({
        stage: blocked, originalCommandBudgetMs: 1500,
        callerDurationMs: callerReturnedAt - commandStartedAt,
      }));
      expect("error" in result).toBe(true);
      if (!("error" in result)) throw new Error("failed command unexpectedly succeeded");
      expect(result.error).toBe(original);
      expect(readEnvironmentResourceObservationFailure(original)).toBe("budget_exhausted");
      if (blocked === "initial_read") expect(inspect).not.toHaveBeenCalled();
      else expect(inspect).toHaveBeenCalledOnce();
      // end(0) must actually close the borrowed backend; admission must drain.
      await vi.waitFor(() => expect(dedicatedDbConnectionStats(db)?.inUse).toBe(0), { timeout: 5000 });
      expect(dedicatedDbConnectionStats(db)).toMatchObject({ waiting: 0, overLimit: 0, nestedOverLimit: 0 });
      // Both lock and main are intentionally STILL held here. The command has
      // returned without closing the shared pool or needing its busy session.
      await vi.waitFor(async () => {
        const rows = await activity();
        expect(rows.some(row => row.pid === blockedPid && row.birth === blockedBirth)).toBe(false);
        expect(rows.find(row => row.pid === mainPid)?.state).toBe("idle in transaction");
      }, { timeout: 5000 });
      console.info("resource-observation-deadline-timing", JSON.stringify({
        stage: blocked, originalCommandBudgetMs: 1500,
        callerDurationMs: callerReturnedAt - commandStartedAt,
        backendTailAfterCallerMs: performance.now() - callerReturnedAt,
        semantics: "bounded server tail; not instantaneous cancellation",
      }));
    } catch (error) { primary = error; }
    finally {
      mainRelease.resolve(); lockRequested.resolve(); lockRelease.resolve();
      const joined = await Promise.allSettled([main, lock, execution]);
      const errors = joined.flatMap(value => value.status === "rejected" ? [value.reason] : []);
      if (primary || errors.length) throw new AggregateError([...(primary ? [primary] : []), ...errors], "scoped observation SQL control failed");
    }
    expect((await db.execute<{ value: number }>(sql`select 1::int as value`))[0]?.value).toBe(1);
  }, 60_000);

  it("refuses optional observation at dedicated capacity without bypassing an already queued owner", async () => {
    const fixture = await seed();
    const held = deferred(); const release = deferred();
    const holder = withDedicatedDbConnection(db, async () => { held.resolve(); await release.promise; });
    await entered(held.promise, holder);
    let queuedEntered = false;
    const queued = withDedicatedDbConnection(db, async () => { queuedEntered = true; });
    const before = dedicatedDbConnectionStats(db);
    const read = vi.fn(async () => fixture.lease); const inspect = vi.fn();
    try {
      expect(before).toMatchObject({ inUse: 1, waiting: 1 });
      const original = new Error("failed command at capacity");
      expect(await observeStoppedExecutionResource({ db, expected: fixture.lease, originalError: original,
        deadline: performance.now() + 1000, readCurrentLease: read, inspect })).toBeNull();
      expect(readEnvironmentResourceObservationFailure(original)).toBe("observation_capacity_busy");
      expect(read).not.toHaveBeenCalled(); expect(inspect).not.toHaveBeenCalled(); expect(queuedEntered).toBe(false);
      expect(dedicatedDbConnectionStats(db)).toEqual(before);
    } finally { release.resolve(); await Promise.all([holder, queued]); }
    expect(queuedEntered).toBe(true);
    expect(dedicatedDbConnectionStats(db)).toMatchObject({ inUse: 0, waiting: 0, overLimit: 0, nestedOverLimit: 0 });

    // A separate, normally ended owner must not be reopened by optional work.
    // It never executes a query or creates a live socket before ending.
    const closedOwner = createDb(url!, { maxConnections: 1, dedicatedConnectionMax: 1 });
    try {
      await closedOwner.$client.end({ timeout: 1 });
      const closedBefore = dedicatedDbConnectionStats(closedOwner);
      expect(closedBefore).toMatchObject({ closed: true, inUse: 0, peakInUse: 0, queued: 0 });
      const closedError = new Error("failed command after owner end");
      read.mockClear(); inspect.mockClear();
      expect(await observeStoppedExecutionResource({ db: closedOwner, expected: fixture.lease, originalError: closedError,
        deadline: performance.now() + 1000, readCurrentLease: read, inspect })).toBeNull();
      expect(readEnvironmentResourceObservationFailure(closedError)).toBe("observation_capacity_busy");
      expect(read).not.toHaveBeenCalled(); expect(inspect).not.toHaveBeenCalled();
      // No helper loan/queue/creation is possible when all admission counters
      // remain at zero after the normal owner has marked its set closed.
      expect(dedicatedDbConnectionStats(closedOwner)).toEqual(closedBefore);
    } finally { await closedOwner.$client.end({ timeout: 1 }); }
  }, 60_000);

  it("suppresses late historical-secret audit and inspection while retaining ordinary authorized resolution", async () => {
    const fixture = await seed();
    const secret = await secretService(db).create(fixture.companyId, { name: `observation-${randomUUID()}`, provider: "local_encrypted", value: "owned-value" });
    const config = { provider: "controlled-provider", image: "fixture", reuseLease: false, apiKey: secret.id };
    const schema = { properties: { apiKey: { type: "string", format: "secret-ref" } } };
    const originalResolve = localEncryptedProvider.resolveVersion.bind(localEncryptedProvider);
    const providerEntered = deferred(); const release = deferred();
    const resolver = vi.spyOn(localEncryptedProvider, "resolveVersion").mockImplementationOnce(async input => {
      const value = await originalResolve(input);
      providerEntered.resolve(); await release.promise; return value;
    });
    const rpc = vi.fn(); const original = new Error("command failed before optional credentials");
    let inspection: Promise<{ providerLeaseId: string; state: "stopped" }> | undefined;
    const observation = observeStoppedExecutionResource({ db, expected: fixture.lease, originalError: original,
      deadline: performance.now() + 500, readCurrentLease: async () => fixture.lease,
      inspect: async (_lease, _timeout, scope) => {
        inspection = (async () => {
          const credentials = await historicalProviderCredentials(scope.db!, fixture.companyId, config, schema,
            { issueId: null, heartbeatRunId: fixture.runId }, scope.signal);
          rpc(credentials);
          return { providerLeaseId: fixture.lease.providerLeaseId!, state: "stopped" as const };
        })();
        return await inspection;
      },
    });
    try {
      await entered(providerEntered.promise, observation);
      expect(await observation).toBeNull();
      expect(readEnvironmentResourceObservationFailure(original)).toBe("budget_exhausted");
      release.resolve(); await Promise.allSettled([inspection]);
      expect(rpc).not.toHaveBeenCalled();
      expect(await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.secretId, secret.id))).toHaveLength(0);
      resolver.mockRestore();
      expect(await historicalProviderCredentials(db, fixture.companyId, config, schema,
        { issueId: null, heartbeatRunId: fixture.runId })).toMatchObject({ apiKey: "owned-value" });
      expect(await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.secretId, secret.id))).toHaveLength(1);
    } finally { release.resolve(); await observation; await Promise.allSettled([inspection]); }
  }, 60_000);
});
