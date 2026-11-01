import { createCipheriv, createHash, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, randomUUID, sign, verify } from "node:crypto";
import { createServer } from "node:http";
import { Socket } from "node:net";
import { once } from "node:events";
import { agents, agentApiKeys, agentSessionGoalActions, agentTaskSessions, authUsers, companies, companyMemberships, connectionGrants, createDb, heartbeatRuns, issues, issueThreadInteractions, toolApplications, toolConnections } from "@paperclipai/db";
import { access, mkdir, readdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { maintenanceDatabaseSupport } from "./helpers/maintenance/environment.js";
import { CLOUD_RUNTIME_IDENTITY_AUDIENCE, CLOUD_RUNTIME_IDENTITY_ISSUER, CLOUD_RUNTIME_IDENTITY_JWS_TYPE } from "../services/cloud-runtime-identity.js";
import { prepareMaintenanceRuntime } from "./helpers/maintenance/runtime-build.js";
import { startMaintenanceServer, withMaintenanceProvider } from "./helpers/maintenance/server-harness.js";

let databaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_MAINTENANCE_BOOT_TEST_DATABASE_URL");
let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
const databaseSupport = await maintenanceDatabaseSupport(databaseUrl);
const describeDatabase = databaseSupport.supported ? describe : describe.skip;
if (!databaseSupport.supported) console.warn(`Skipping maintenance PostgreSQL tests: ${databaseSupport.reason ?? "unsupported environment"}`);
async function clearDatabase() {
  if (!temporary && !new URL(databaseUrl!).pathname.endsWith("_test")) throw new Error("Maintenance boot requires an owned disposable _test database");
  const fixture = createDb(databaseUrl!, { maxConnections: 1 });
  try {
    const tables = await fixture.$client<{ tablename: string }[]>`select tablename from pg_tables where schemaname='public'`;
    if (tables.length) await fixture.$client.unsafe(`truncate ${tables.map(table => `"${table.tablename.replaceAll('"', '""')}"`).join(",")} cascade`);
  } finally { await fixture.$client.end(); }
}
async function settleClock(server: Awaited<ReturnType<typeof startMaintenanceServer>>) {
  for (let step = 0; step < 60; step++) {
    if (server.proxy.pending === 0 && (await server.snapshot()).idle.active === 0) return server.settled(100);
    if (server.proxy.pending === 0) await server.advance(1_000);
    await delay(50);
  }
  return server.settled();
}
function receipt(queries: Array<{ protocol: string; sql: string; fingerprint: string }>) {
  const groups = new Map<string, { fingerprint: string; protocol: string; calls: number; tables: string[] }>();
  for (const query of queries) {
    const key = `${query.protocol}:${query.fingerprint}`;
    const entry = groups.get(key) ?? { fingerprint: query.fingerprint, protocol: query.protocol, calls: 0,
      tables: [...new Set([...query.sql.matchAll(/(?:from|join|update|into)\s+"?([a-z_][a-z_0-9]*)"?/gi)].map(match => match[1]!))] };
    entry.calls++; groups.set(key, entry);
  }
  return [...groups.values()];
}
describeDatabase("assembled maintenance server production wiring", () => {
  beforeAll(async () => {
    await prepareMaintenanceRuntime();
    if (!databaseUrl) { temporary = await startEmbeddedPostgresTestDatabase("maintenance-server-"); databaseUrl = temporary.connectionString; }
  }, 150_000);
  afterAll(async () => { await temporary?.cleanup(); });
  it.each(["empty", "configured terminal history"] as const)("keeps enabled %s quiet for 90 real seconds and two qualified hourly windows", async state => {
    await clearDatabase();
    const fixture = createDb(databaseUrl!, { maxConnections: 1 });
    if (state !== "empty") {
      const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
      await fixture.insert(companies).values({ id: companyId, name: "Retained idle history", issuePrefix: "MIH" });
      await fixture.insert(agents).values({ id: agentId, companyId, name: "Idle retained agent", status: "idle", adapterType: "process",
        adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] }, runtimeConfig: { heartbeat: { enabled: true, intervalSec: 0, wakeOnDemand: true } } });
      await fixture.insert(issues).values({ id: issueId, companyId, title: "Retained terminal task", status: "done", assigneeAgentId: agentId });
      await fixture.insert(heartbeatRuns).values({ companyId, agentId, issueId, status: "succeeded", finishedAt: new Date(), contextSnapshot: { issueId } });
    }
    const server = await startMaintenanceServer(databaseUrl!, { clock: true });
    try {
      if (state !== "empty") await server.api("PATCH", "/instance/settings/experimental", { enableExternalObjects: true, enableStatusCards: true });
      await settleClock(server); await server.freeze();
      const before = await server.snapshot(), queryCount = server.proxy.queries.length, frames = server.proxy.frames, transport = server.proxy.transport;
      expect(before.startup.phase).toBe("ready"); expect(before.idle.active).toBe(0);
      await server.realtime();
      const wallStart = performance.now();
      for (let remaining = 90_000; remaining > 0; remaining = 90_000 - (performance.now() - wallStart)) {
        await delay(Math.ceil(remaining));
      }
      const wallElapsedMs = performance.now() - wallStart;
      await server.freeze();
      const real = await server.settled(100);
      expect(wallElapsedMs).toBeGreaterThanOrEqual(90_000);
      expect(real.now - before.now).toBeGreaterThanOrEqual(89_000);
      expect(real.idle.active).toBe(0);
      expect(server.proxy.queries.length).toBe(queryCount);
      expect(real.outgoingHttpRequests).toBe(before.outgoingHttpRequests);
      expect(real.network.nonDatabaseConnections).toBe(before.network.nonDatabaseConnections);
      expect(real.network.nonDatabaseBytesWritten).toBe(before.network.nonDatabaseBytesWritten);
      const realFrames = server.proxy.frames, realTransport = server.proxy.transport;
      expect(realTransport.connectionsOpened).toBeGreaterThan(0);
      expect(realTransport.connectionsOpened).toBe(transport.connectionsOpened);
      expect(realTransport.connectionsClosed).toBe(realTransport.connectionsOpened);
      expect({ ...realFrames, Terminate: frames.Terminate }).toEqual(frames);
      expect(realTransport.frontendBytes - transport.frontendBytes).toBe((realFrames.Terminate - frames.Terminate) * 5);
      expect(realTransport.backendBytes).toBe(transport.backendBytes);
      for (let step = 0; step < 240; step++) { await server.advance(30_000); await server.settled(10); }
      const after = await server.snapshot();
      expect(after.now - real.now).toBe(2 * 60 * 60_000);
      expect(after.idle.active).toBe(0);
      expect(server.proxy.queries.length).toBe(queryCount);
      expect(after.outgoingHttpRequests).toBe(before.outgoingHttpRequests);
      expect(after.network.nonDatabaseConnections).toBe(before.network.nonDatabaseConnections);
      expect(after.network.nonDatabaseBytesWritten).toBe(before.network.nonDatabaseBytesWritten);
      expect(server.proxy.errors).toEqual([]);
      expect(server.proxy.transport).toEqual(realTransport);
      await writeFile(path.join(server.directory, "enabled-quiet-measurement.json"), JSON.stringify({ phase: "enabled-quiet", state,
        wallElapsedMs, realClockElapsedMs: real.now - before.now, qualifiedClockMs: after.now - real.now, stepMs: 30_000, ioSettledBetweenSteps: true,
        measuredQueries: 0, startupQueries: queryCount, startup: receipt(server.proxy.queries), before, real, after,
        frames: { before: frames, real: realFrames, after: server.proxy.frames }, transport: { before: transport, real: realTransport, after: server.proxy.transport },
        boundary: "actual startServer, real elapsed 90s plus qualified child clock; pool connection housekeeping reported separately; no active provider/native work, Cloud enrollment, installed plugins, telemetry exporter, announcements or database backup; no host or database suspension claim",
      }, null, 2));
    } finally { await server.stop(); await fixture.$client.end(); }
  }, 240_000);

  it("releases an ordinary held task Retry into one real process execution", async () => {
    await clearDatabase();
    const server = await startMaintenanceServer(databaseUrl!, { clock: true });
    const fixture = createDb(databaseUrl!, { maxConnections: 1 });
    try {
      await settleClock(server);
      const company = await server.api<{ id: string }>("POST", "/companies", { name: "Receipt ingress" });
      await fixture.insert(authUsers).values({ id: "local-board", name: "Local operator", email: "maintenance-local@example.test", createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
      await fixture.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: "local-board", status: "active", membershipRole: "owner" }).onConflictDoNothing();
      const [agent] = await fixture.insert(agents).values({ companyId: company.id, name: "Receipt process", adapterType: "process", status: "idle", lifecycleState: "ready",
        adapterConfig: { command: process.execPath, args: ["-e", "console.log('assembled-receipt-proof')"], cwd: process.cwd() },
        runtimeConfig: { heartbeat: { enabled: true, intervalSec: 0, wakeOnDemand: true } } }).returning();
      const [issue] = await fixture.insert(issues).values({ companyId: company.id, title: "Resume saved task", status: "todo", assigneeAgentId: agent!.id, responsibleUserId: "local-board" }).returning();
      const [source] = await fixture.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent!.id, issueId: issue!.id, status: "failed", finishedAt: new Date(), responsibleUserId: "local-board", errorCode: "process_failed",
        contextSnapshot: { issueId: issue!.id }, resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } }).returning();
      const hold = await server.api<{ hold: { id: string } }>("POST", `/issues/${issue!.id}/tree-holds`, { mode: "pause", reason: "Retain ordinary Retry" });
      const retry = await server.api<{ accepted: boolean; requestId: string }>("POST", `/issues/${issue!.id}/retry`, { observedRunId: source!.id, idempotencyKey: randomUUID() });
      expect(retry.accepted).toBe(true);
      await settleClock(server);
      const [waiting] = await fixture.$client`select status, run_id, payload->'executionWait'->>'reason' as reason from agent_wakeup_requests where id=${retry.requestId}`;
      expect(waiting).toMatchObject({ status: "deferred_issue_execution", run_id: null, reason: "issue_tree_hold_active" });
      const beforeGrace = server.proxy.queries.length;
      await server.realtime(); await delay(31_000); await server.freeze(); await settleClock(server);
      const grace = receipt(server.proxy.queries.slice(beforeGrace));
      const [parked] = await fixture.$client`select status, run_id, payload->'executionWait'->>'reason' as reason from agent_wakeup_requests where id=${retry.requestId}`;
      expect(parked).toEqual(waiting);
      const baseline = server.proxy.queries.length;
      await server.realtime(); await delay(30_000); await server.freeze(); await settleClock(server);
      expect(server.proxy.queries.length).toBe(baseline);
      await server.api("POST", `/issues/${issue!.id}/tree-holds/${hold.hold.id}/release`, { reason: "Resume accepted Retry", metadata: { wakeAgents: false } });
      await server.realtime();
      let executed: Record<string, unknown> | undefined;
      for (let step = 0; step < 300; step++) {
        await delay(100);
        [executed] = await fixture.$client`select status, stdout_excerpt, error, error_code from heartbeat_runs where context_snapshot->>'taskRetryRequestId'=${retry.requestId}`;
        if (executed?.status === "succeeded") break;
      }
      await server.freeze();
      expect(executed, JSON.stringify(executed)).toMatchObject({ status: "succeeded", stdout_excerpt: expect.stringContaining("assembled-receipt-proof") });
      const [count] = await fixture.$client`select count(*)::integer as count from heartbeat_runs where context_snapshot->>'taskRetryRequestId'=${retry.requestId}`;
      expect(count!.count).toBe(1);
      await server.updateIssue({ id: issue!.id, status: "done" }); await settleClock(server);
      const quiet = server.proxy.queries.length;
      for (let step = 0; step < 4; step++) { await server.advance(30_000); await settleClock(server); }
      expect(server.proxy.queries.length).toBe(quiet);
      await writeFile(path.join(server.directory, "receipt-measurement.json"), JSON.stringify({ phase: "ordinary-held-task-retry", companyId: company.id, issueId: issue!.id,
        requestId: retry.requestId, waiting, grace, parked, executed, count: count!.count, parkedRealMs: 30_000, parkedQueries: 0, settledClockMs: 120_000, settledQueries: 0,
        boundary: "actual Retry and subtree release HTTP, wakeAgents false, real clock through process/controller authority, real local process, no outcome seeded", frames: server.proxy.frames }, null, 2));
    } finally { await server.stop(); await fixture.$client.end(); }
  }, 150_000);

  it("reconstructs residual work from a normal scheduler-admission change after suppression", async () => {
    await clearDatabase();
    const server = await startMaintenanceServer(databaseUrl!, { clock: true, suppressed: true });
    const fixture = createDb(databaseUrl!, { maxConnections: 1 });
    try {
      await server.settled();
      const company = await server.api<{ id: string }>("POST", "/companies", { name: "Admission reconstruction" });
      const { leaseId } = await server.createOrphanLease(company.id);
      await server.advance(1_000); await settleClock(server);
      const [suppressed] = await fixture.$client`select status, cleanup_status from environment_leases where id=${leaseId}`;
      expect(suppressed).toMatchObject({ status: "active", cleanup_status: null });
      const baseline = server.proxy.queries.length, before = await server.snapshot();
      for (let step = 0; step < 4; step++) { await server.advance(30_000); await server.settled(10); }
      expect(server.proxy.queries.length).toBe(baseline);
      expect((await server.snapshot()).outgoingHttpRequests).toBe(before.outgoingHttpRequests);
      await server.api("PATCH", "/instance/settings/experimental", { enableWorktreeRunExecution: true });
      await server.advance(1_000); await settleClock(server);
      const [admitted] = await fixture.$client`select experimental from instance_settings where singleton_key='default'`;
      expect(admitted!.experimental).toMatchObject({ enableWorktreeRunExecution: true,
        worktreeRunExecutionActivatedAt: expect.any(String), worktreeRunExecutionActivationInstanceId: "maintenance-test" });
      const [reconstructed] = await fixture.$client`select status, failure_reason, cleanup_status from environment_leases where id=${leaseId}`;
      expect(reconstructed).toMatchObject({ status: "expired", failure_reason: "pending_cleanup_retry", cleanup_status: "success" });
      await server.advance(30_000); await settleClock(server);
      const [cleaned] = await fixture.$client`select status, cleanup_status from environment_leases where id=${leaseId}`;
      expect(cleaned).toMatchObject({ status: "expired", cleanup_status: "success" });
      await writeFile(path.join(server.directory, "admission-measurement.json"), JSON.stringify({ phase: "ordinary-settings-admission-reconstruction",
        companyId: company.id, leaseId, suppressed, suppressedClockMs: 120_000, suppressedQueries: 0,
        admitted: admitted!.experimental, reconstructed, cleaned, frames: server.proxy.frames,
        boundary: "actual suppressed runtime, committed environment-cleanup ingress, normal operator activation; no direct worker wake or safety-gate bypass",
      }, null, 2));
    } finally { await server.stop(); await fixture.$client.end(); }
  }, 150_000);

  it("isolates a real goal-startup write failure and still registers residual and attention owners", async () => {
    await clearDatabase();
    const fixture = createDb(databaseUrl!, { maxConnections: 1 });
    const companyId = randomUUID(), agentId = randomUUID(), userId = randomUUID(), issueId = randomUUID(), requestId = randomUUID();
    await fixture.insert(authUsers).values({ id: userId, name: "Goal control owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await fixture.insert(companies).values({ id: companyId, name: "Startup failure isolation", issuePrefix: "MFI", defaultResponsibleUserId: userId });
    await fixture.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "member" });
    await fixture.insert(agents).values({ id: agentId, companyId, name: "Goal owner", adapterType: "codex_local", status: "idle", lifecycleState: "ready" });
    await fixture.insert(issues).values({ id: issueId, companyId, title: "Retained terminal goal task", status: "done", assigneeAgentId: agentId, responsibleUserId: userId });
    const [session] = await fixture.insert(agentTaskSessions).values({ companyId, agentId, taskKey: issueId, adapterType: "codex_local" }).returning();
    const [action] = await fixture.insert(agentSessionGoalActions).values({ companyId, sessionId: session!.id, requestId,
      action: "clear", payloadJson: { requestId, action: "clear" }, status: "pending" }).returning();
    await fixture.$client.unsafe(`create or replace function maintenance_fail_goal_startup() returns trigger language plpgsql as $$begin
      if new.reason = 'goal_control' then raise exception 'maintenance_goal_startup_injected'; end if; return new; end$$`);
    await fixture.$client.unsafe(`create trigger maintenance_fail_goal_startup before insert on agent_wakeup_requests for each row execute function maintenance_fail_goal_startup()`);
    let server: Awaited<ReturnType<typeof startMaintenanceServer>> | undefined;
    try {
      server = await startMaintenanceServer(databaseUrl!, { clock: true });
      await settleClock(server);
      expect((await server.snapshot()).startup.phase).toBe("ready");
      expect(server.output).toContain("maintenance_goal_startup_injected");
      const [retained] = await fixture.$client`select status from agent_session_goal_actions where id=${action!.id}`;
      expect(retained!.status).toBe("pending");
      const [failedWake] = await fixture.$client`select count(*)::integer as count from agent_wakeup_requests where reason='goal_control'`;
      expect(failedWake!.count).toBe(0);
      const start = (await server.snapshot()).now;
      const { leaseId } = await server.createOrphanLease(companyId);
      let discovered: Record<string, unknown> | undefined;
      for (let step = 0; step < 10; step++) {
        await server.advance(1_000); await delay(50);
        [discovered] = await fixture.$client`select status, failure_reason, provider, provider_lease_id from environment_leases where id=${leaseId}`;
        if (discovered?.status === "pending_cleanup") break;
      }
      expect(discovered).toMatchObject({ status: "pending_cleanup", failure_reason: "orphaned_active_lease_recovered", provider: "local", provider_lease_id: null });
      const elapsedClockMs = (await server.snapshot()).now - start;
      expect(elapsedClockMs).toBeLessThan(30_000);
      await server.advance(30_000); await settleClock(server);
      const [lease] = await fixture.$client`select status, cleanup_status, provider, provider_lease_id from environment_leases where id=${leaseId}`;
      expect(lease).toMatchObject({ status: "expired", cleanup_status: "success", provider: "local", provider_lease_id: null });
      await fixture.$client.unsafe(`create or replace function maintenance_age_isolation_attention() returns trigger language plpgsql as $$begin
        if new.title = 'Attention after goal failure' then new.updated_at = now() - interval '91 days'; end if; return new; end$$`);
      await fixture.$client.unsafe(`create trigger maintenance_age_isolation_attention before insert on issue_thread_interactions for each row execute function maintenance_age_isolation_attention()`);
      const issue = await server.api<{ id: string }>("POST", `/companies/${companyId}/issues`, { title: "Independent attention owner", status: "todo" });
      const card = await server.api<{ id: string }>("POST", `/issues/${issue.id}/interactions`, { kind: "request_confirmation", title: "Attention after goal failure",
        resolverPolicy: "human_only", continuationPolicy: "none", payload: { version: 1, prompt: "Choose a color?" } });
      await server.advance(1_000); await settleClock(server);
      const [archived] = await fixture.$client`select archived_reason, archived_at is not null as archived from decision_retention where source_id=${card.id}`;
      expect(archived).toMatchObject({ archived_reason: "idle_ttl", archived: true });
      await writeFile(path.join(server.directory, "startup-failure-measurement.json"), JSON.stringify({ phase: "actual-goal-startup-failure-isolation",
        companyId, actionId: action!.id, retained, failedWake, leaseId, discovered, lease, elapsedClockMs, archived, frames: server.proxy.frames,
        boundary: "fixture-only conditional goal_control INSERT failure; actual native classification untouched; actual environment cleanup ingress and ordinary attention HTTP producer",
      }, null, 2));
    } finally {
      await fixture.$client.unsafe("drop trigger if exists maintenance_fail_goal_startup on agent_wakeup_requests").catch(() => {});
      await fixture.$client.unsafe("drop function if exists maintenance_fail_goal_startup()").catch(() => {});
      await fixture.$client.unsafe("drop trigger if exists maintenance_age_isolation_attention on issue_thread_interactions").catch(() => {});
      await fixture.$client.unsafe("drop function if exists maintenance_age_isolation_attention()").catch(() => {});
      await server?.stop(); await fixture.$client.end();
    }
    if (server!.retainedDirectory) await access(server!.retainedDirectory);
    else await expect(access(server!.directory)).rejects.toMatchObject({ code: "ENOENT" });
  }, 150_000);

  it("exposes readiness while real deferred housekeeping is held and settles its work after release", async () => {
    await clearDatabase();
    const fixture = createDb(databaseUrl!, { maxConnections: 1 });
    const companyId = randomUUID(), issueId = randomUUID(), interactionId = randomUUID();
    await fixture.insert(companies).values({ id: companyId, name: "Readiness fixture", issuePrefix: "MRD" });
    await fixture.insert(issues).values({ id: issueId, companyId, title: "Historical human decision", status: "todo" });
    await fixture.insert(issueThreadInteractions).values({ id: interactionId, companyId, issueId, kind: "request_confirmation",
      title: "Historical human choice", continuationPolicy: "none", payload: { version: 1, prompt: "Choose a color?" },
      updatedAt: new Date(Date.now() - 91 * 86_400_000) });
    await fixture.$client.unsafe(`create or replace function maintenance_hold_startup_archive() returns trigger language plpgsql as $$begin
      perform pg_advisory_xact_lock(913703); return new; end$$`);
    await fixture.$client.unsafe(`create trigger maintenance_hold_startup_archive before insert on decision_retention for each row execute function maintenance_hold_startup_archive()`);
    let reserved: Awaited<ReturnType<typeof fixture.$client.reserve>> | undefined = await fixture.$client.reserve();
    await reserved`select pg_advisory_lock(913703)`;
    let server: Awaited<ReturnType<typeof startMaintenanceServer>> | undefined;
    try {
      server = await startMaintenanceServer(databaseUrl!, { suppressed: true });
      const current = server;
      await expect.poll(() => current.proxy.queries.some(query => /insert into "decision_retention"/.test(query.sql)), { timeout: 10_000 }).toBe(true);
      const snapshot = await server.snapshot();
      expect(snapshot.startup.phase).toBe("ready"); expect(snapshot.idle.active).toBeGreaterThan(0);
      expect(server.proxy.pending).toBeGreaterThan(0);
      const health = await server.api<{ status: string; startupRecovery: { phase: string } }>("GET", "/health");
      expect(health).toMatchObject({ status: "ok", startupRecovery: { phase: "ready" } });
      await reserved`select pg_advisory_unlock(913703)`; reserved.release(); reserved = undefined;
      await server.settled();
      const [archived] = await fixture.$client`select archived_reason, archived_at is not null as archived from decision_retention where source_id=${interactionId}`;
      expect(archived).toMatchObject({ archived_reason: "idle_ttl", archived: true });
      await writeFile(path.join(server.directory, "readiness-measurement.json"), JSON.stringify({ phase: "real-housekeeping-held-after-readiness",
        companyId, issueId, interactionId, beforeRelease: { startup: snapshot.startup, idle: snapshot.idle }, afterRelease: await server.snapshot(),
        archived, boundary: "fixture owns advisory lock on actual startup archive INSERT; no startup/DB/service mocks", frames: server.proxy.frames,
      }, null, 2));
    } finally {
      if (reserved) { await reserved`select pg_advisory_unlock(913703)`.catch(() => {}); reserved.release(); }
      await fixture.$client.unsafe("drop trigger if exists maintenance_hold_startup_archive on decision_retention").catch(() => {});
      await fixture.$client.unsafe("drop function if exists maintenance_hold_startup_archive()").catch(() => {});
      await fixture.$client.end(); await server?.stop();
    }
  }, 150_000);

  it("does not advance the child clock over an actual driver socket whose startup write is held", async () => {
    await clearDatabase();
    const server = await startMaintenanceServer(databaseUrl!, { clock: true, suppressed: true });
    const client = createDb(server.proxy.url, { maxConnections: 1, idleTimeoutSeconds: 0, connectTimeoutSeconds: 30 });
    const address = new URL(server.proxy.url);
    const socket = new Socket();
    let release = () => {};
    let query: Promise<unknown> | undefined;
    let advancing: ReturnType<typeof server.advance> | undefined;
    try {
      await settleClock(server); await server.freeze();
      socket.connect({ host: address.hostname, port: Number(address.port) });
      await once(socket, "connect");
      const write = socket.write;
      let entered!: () => void;
      const startupHeld = new Promise<void>(resolve => { entered = resolve; });
      socket.write = ((...args: Parameters<typeof socket.write>) => {
        socket.write = write;
        expect(Buffer.isBuffer(args[0]) && args[0].readInt32BE(4)).toBe(196608);
        let released = false;
        release = () => { if (!released) { released = true; Reflect.apply(write, socket, args); } };
        entered();
        return true;
      }) as typeof socket.write;
      Object.assign(client.$client.options, { socket: () => socket });
      query = client.$client`select 1 as startup_control`.then(rows => rows);
      await startupHeld;
      const before = await server.snapshot();
      advancing = server.advance(30_000);
      const during = await server.snapshot();
      expect(during.now).toBe(before.now);
      release();
      expect(await query).toMatchObject([{ startup_control: 1 }]);
      expect((await advancing).now).toBe(before.now + 30_000);
      await server.settled();
      await writeFile(path.join(server.directory, "startup-clock-measurement.json"), JSON.stringify({ phase: "held-real-driver-startup-clock-barrier",
        before, during, after: await server.snapshot(), boundary: "actual postgres.js StartupMessage write held before wire flush; child clock IPC stays behind startup, independent of the unexplained invalid-frame failure",
      }, null, 2));
    } finally {
      release();
      await Promise.allSettled([query, advancing]);
      await client.$client.end(); socket.destroy(); await server.stop();
    }
  }, 150_000);

  it("keeps the disabled-heartbeat boot quiet across two former hourly windows with a qualified child clock", async () => {
    await clearDatabase();
    const server = await startMaintenanceServer(databaseUrl!, { enabled: false, clock: true });
    try {
      await server.settled();
      await server.freeze();
      const baseline = server.proxy.queries.length, start = (await server.snapshot()).now;
      for (let step = 0; step < 240; step++) {
        await server.advance(30_000);
        await server.settled(10);
      }
      const after = await server.snapshot();
      expect(after.now - start).toBe(2 * 60 * 60_000);
      expect(server.proxy.queries.length).toBe(baseline);
      expect(after.outgoingHttpRequests).toBe(0);
      expect(after.network.nonDatabaseConnections).toBe(0);
      expect(server.proxy.errors).toEqual([]);
      await writeFile(path.join(server.directory, "measurement.json"), JSON.stringify({ phase: "disabled-empty-boot-clock",
        clockAdvanceMs: after.now - start, stepMs: 30_000, ioSettledBetweenSteps: true,
        startupQueries: baseline, startup: receipt(server.proxy.queries), frames: server.proxy.frames, network: after.network, measuredQueries: 0, outgoingHttpRequests: 0 }, null, 2));

      const company = await server.api<{ id: string }>("POST", "/companies", { name: "Configured idle maintenance fixture" });
      await server.api("PATCH", "/instance/settings/experimental", { enableExternalObjects: true, enableStatusCards: true });
      const history = await server.api<{ id: string }>("POST", `/companies/${company.id}/issues`, { title: "Retained completed history", status: "done" });
      await server.advance(30_000);
      await server.settled();
      const persisted = createDb(databaseUrl!, { maxConnections: 1 });
      try {
        const [saved] = await persisted.$client`select company_id, status from issues where id=${history.id}`;
        expect(saved).toMatchObject({ company_id: company.id, status: "done" });
      } finally { await persisted.$client.end(); }
      const historyBaseline = server.proxy.queries.length;
      await server.drain();
      for (let step = 0; step < 3; step++) { await server.advance(30_000); await server.settled(10); }
      await server.resume(); await server.settled();
      const resumed = server.proxy.queries.length;
      for (let step = 0; step < 240; step++) { await server.advance(30_000); await server.settled(10); }
      expect(server.proxy.queries.length).toBe(resumed);
      expect((await server.snapshot()).outgoingHttpRequests).toBe(0);
      await writeFile(path.join(server.directory, "history-measurement.json"), JSON.stringify({ phase: "disabled-configured-history-drain",
        companyId: company.id, issueId: history.id, historyBaseline, resumedQueries: resumed,
        postResumeClockMs: 2 * 60 * 60_000, measuredQueries: server.proxy.queries.length - resumed,
        frames: server.proxy.frames, outgoingHttpRequests: 0 }, null, 2));
    } finally { await server.stop(); }
  }, 150_000);

  it("settles an in-flight provider claim on shutdown and reconstructs its unfinished object after restart", async () => {
    await clearDatabase();
    let arrived!: () => void, cancelled = false;
    const firstRequest = new Promise<void>(resolve => { arrived = resolve; });
    const providerRequests: string[] = [];
    const provider = createServer((req, res) => {
      providerRequests.push(req.url!);
      if (providerRequests.length === 1) { res.once("close", () => { cancelled = true; }); arrived(); return; }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ id: 8, number: 8, state: "closed", merged: true, merged_at: new Date().toISOString(),
        title: "Recovered object", html_url: "https://github.com/maintenance/example/pull/8", user: { login: "fixture" } }));
    });
    await withMaintenanceProvider(provider, async origin => {
      const options = { enabled: false, clock: true, githubOrigin: origin };
      const fixture = createDb(databaseUrl!, { maxConnections: 1 });
      let server: Awaited<ReturnType<typeof startMaintenanceServer>> | undefined;
      try {
        server = await startMaintenanceServer(databaseUrl!, options);
        await server.settled();
        const company = await server.api<{ id: string }>("POST", "/companies", { name: "Shutdown recovery" });
        await server.api("PATCH", "/instance/settings/experimental", { enableExternalObjects: true });
        const issue = await server.api<{ id: string }>("POST", `/companies/${company.id}/issues`, {
          title: "Object survives shutdown", status: "done", description: "https://github.com/maintenance/example/pull/8",
        });
        await server.advance(1_000);
        await Promise.race([firstRequest, delay(10_000).then(() => { throw new Error("Provider claim did not arrive"); })]);
        const [claimed] = await fixture.$client`select is_terminal, refresh_started_at is not null as claimed from external_objects
          where company_id=${company.id}`;
        expect(claimed).toMatchObject({ is_terminal: false, claimed: true });
        await server.stop(); server = undefined;
        expect(cancelled).toBe(true);
        const [stopped] = await fixture.$client`select is_terminal, refresh_started_at, refresh_token from external_objects where company_id=${company.id}`;
        expect(stopped).toMatchObject({ is_terminal: false, refresh_started_at: null, refresh_token: null });
        server = await startMaintenanceServer(databaseUrl!, options);
        await settleClock(server);
        const [recovered] = await fixture.$client`select is_terminal, status_key from external_objects where company_id=${company.id}`;
        expect(recovered).toMatchObject({ is_terminal: true, status_key: "merged" });
        expect(providerRequests).toEqual(["/repos/maintenance/example/pulls/8", "/repos/maintenance/example/pulls/8"]);
        await writeFile(path.join(server.directory, "shutdown-measurement.json"), JSON.stringify({ phase: "actual-shutdown-inflight-and-restart",
          companyId: company.id, issueId: issue.id, claimed, cancelled, stopped, recovered, providerRequests,
          boundary: "first simulated HTTP response deliberately withheld; actual shutdown abort/settlement and real restart reconstruction",
          frames: server.proxy.frames,
        }, null, 2));
      } finally {
        try { await server?.stop(); } finally { await fixture.$client.end(); }
      }
    });
  }, 150_000);

  it("processes the first ordinary external-object producer committed during idle drain and becomes quiet again", async () => {
    await clearDatabase();
    const providerRequests: string[] = [];
    const provider = createServer((req, res) => {
      providerRequests.push(req.url!);
      res.setHeader("Content-Type", "application/json");
      if (!/^\/repos\/maintenance\/example\/pulls\/[12]$/.test(req.url!)) { res.statusCode = 500; res.end(JSON.stringify({ error: "Unexpected simulated GitHub request" })); return; }
      if (req.url!.endsWith("/2") && providerRequests.filter(url => url.endsWith("/2")).length === 1) {
        res.statusCode = 503; res.setHeader("Retry-After", "2"); res.end(JSON.stringify({ message: "Controlled provider outage" })); return;
      }
      const number = Number(req.url!.split("/").at(-1));
      res.end(JSON.stringify({ id: number, number, state: "closed", merged: true, merged_at: new Date().toISOString(),
        title: "Controlled merged pull request", html_url: `https://github.com/maintenance/example/pull/${number}`, user: { login: "fixture" } }));
    });
    await withMaintenanceProvider(provider, async origin => {
      const fixture = createDb(databaseUrl!, { maxConnections: 1 });
      let reserved: Awaited<ReturnType<typeof fixture.$client.reserve>> | undefined;
      let pendingIssue: Promise<{ id: string }> | undefined;
      let runtime: Awaited<ReturnType<typeof startMaintenanceServer>> | undefined;
      try {
        const server = runtime = await startMaintenanceServer(databaseUrl!, { enabled: false, clock: true,
        githubOrigin: origin });
        await server.settled();
        const company = await server.api<{ id: string }>("POST", "/companies", { name: "Drain activation" });
        await server.api("PATCH", "/instance/settings/experimental", { enableExternalObjects: true });
        await server.advance(30_000); await server.settled();
        await fixture.$client.unsafe(`create or replace function maintenance_hold_issue() returns trigger language plpgsql as $$begin
          if new.title = 'First write during idle drain' then perform pg_advisory_xact_lock(913701); end if;
          return new; end$$`);
        await fixture.$client.unsafe(`create trigger maintenance_hold_issue before insert on issues for each row execute function maintenance_hold_issue()`);
        reserved = await fixture.$client.reserve();
        await reserved`select pg_advisory_lock(913701)`;
        const before = server.proxy.queries.length;
        pendingIssue = server.api<{ id: string }>("POST", `/companies/${company.id}/issues`, {
          title: "First write during idle drain", description: "https://github.com/maintenance/example/pull/1", status: "done",
        });
        void pendingIssue.catch(() => {});
        await expect.poll(() => server.proxy.queries.slice(before).some(query => /insert into "issues"/.test(query.sql)), { timeout: 10_000 }).toBe(true);
        await server.drain();
        await reserved`select pg_advisory_unlock(913701)`; reserved.release(); reserved = undefined;
        const issue = await pendingIssue;
        await server.settled();
        expect(providerRequests).toEqual([]);
        const [waiting] = await fixture.$client`select eo.company_id, eo.is_terminal, eo.last_resolved_at from external_objects eo
          join external_object_mentions em on em.object_id=eo.id where em.source_issue_id=${issue.id}`;
        expect(waiting).toMatchObject({ company_id: company.id, is_terminal: false, last_resolved_at: null });
        const draining = server.proxy.queries.length;
        for (let step = 0; step < 4; step++) { await server.advance(30_000); await server.settled(10); }
        expect(server.proxy.queries.length).toBe(draining);
        await server.resume(); await server.advance(30_000); await server.settled();
        const [resolved] = await fixture.$client`select eo.company_id, eo.is_terminal, eo.status_key, floor(extract(epoch from eo.last_resolved_at) * 1000)::float8 as resolved_ms from external_objects eo
          join external_object_mentions em on em.object_id=eo.id where em.source_issue_id=${issue.id}`;
        expect(resolved).toMatchObject({ company_id: company.id, is_terminal: true, status_key: "merged", resolved_ms: expect.any(Number) });
        expect(resolved!.resolved_ms).toBeGreaterThan(0);
        expect(resolved!.resolved_ms).toBeLessThanOrEqual((await server.snapshot()).now);
        expect(providerRequests).toEqual(["/repos/maintenance/example/pulls/1"]);
        const settledQueries = server.proxy.queries.length, network = await server.snapshot();
        for (let step = 0; step < 240; step++) { await server.advance(30_000); await server.settled(10); }
        expect(server.proxy.queries.length).toBe(settledQueries);
        expect(providerRequests).toHaveLength(1);
        expect((await server.snapshot()).outgoingHttpRequests).toBe(network.outgoingHttpRequests);
        await writeFile(path.join(server.directory, "external-object-measurement.json"), JSON.stringify({
          phase: "ordinary-issue-producer-commit-during-drain", providerBoundary: "simulated GitHub HTTP; real application/database/transactions",
          companyId: company.id, issueId: issue.id, resolved, drainedClockMs: 120_000, drainedQueries: 0,
          postResolveClockMs: 7_200_000, postResolveQueries: 0, providerRequests, frames: server.proxy.frames, network,
        }, null, 2));

        const retryIssue = await server.api<{ id: string }>("POST", `/companies/${company.id}/issues`, {
          title: "Retry after idle drain", description: "https://github.com/maintenance/example/pull/2", status: "done",
        });
        await server.advance(1_000); await server.settled(100);
        const [failed] = await fixture.$client`select eo.last_error_code, floor(extract(epoch from eo.next_refresh_at) * 1000)::float8 as next_ms
          from external_objects eo join external_object_mentions em on em.object_id=eo.id where em.source_issue_id=${retryIssue.id}`;
        expect(failed!.last_error_code).toBe("github_unreachable");
        expect(failed!.next_ms).toBeGreaterThan((await server.snapshot()).now);
        await server.drain(); await server.settled();
        const retryDrainQueries = server.proxy.queries.length;
        for (let step = 0; step < 4; step++) { await server.advance(30_000); await server.settled(10); }
        expect(server.proxy.queries.length).toBe(retryDrainQueries);
        expect(providerRequests.filter(url => url.endsWith("/2"))).toHaveLength(1);
        await server.resume(); await server.advance(30_000); await server.settled();
        const [retried] = await fixture.$client`select eo.is_terminal, eo.status_key, eo.last_error_code from external_objects eo
          join external_object_mentions em on em.object_id=eo.id where em.source_issue_id=${retryIssue.id}`;
        expect(retried).toMatchObject({ is_terminal: true, status_key: "merged", last_error_code: null });
        expect(providerRequests.filter(url => url.endsWith("/2"))).toHaveLength(2);
        const retrySettled = server.proxy.queries.length;
        for (let step = 0; step < 20; step++) { await server.advance(30_000); await server.settled(10); }
        expect(server.proxy.queries.length).toBe(retrySettled);
        await writeFile(path.join(server.directory, "retry-measurement.json"), JSON.stringify({ phase: "provider-failure-retry-across-drain",
          providerBoundary: "simulated GitHub HTTP 503 then merged", retryIssueId: retryIssue.id, failed, retried,
          drainedClockMs: 120_000, drainedQueries: 0, quietAfterRetryMs: 600_000, quietAfterRetryQueries: 0,
          providerRequests, frames: server.proxy.frames }, null, 2));
      } finally {
        if (reserved) { await reserved`select pg_advisory_unlock(913701)`.catch(() => {}); reserved.release(); }
        await pendingIssue?.catch(() => {});
        await fixture.$client.unsafe("drop trigger if exists maintenance_hold_issue on issues").catch(() => {});
        await fixture.$client.unsafe("drop function if exists maintenance_hold_issue()").catch(() => {});
        try { await fixture.$client.end(); } finally { await runtime?.stop(); }
      }
    });
  }, 150_000);

  it("discovers and acknowledges a sealed GitHub event after the first ordinary connection activation", async () => {
    await clearDatabase();
    const signing = generateKeyPairSync("ed25519"), sealing = generateKeyPairSync("x25519");
    const requests: string[] = [], acknowledgements: unknown[] = [];
    let event: Record<string, unknown> | undefined, leased = false;
    const broker = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const [header, payload, signature] = body.request.split(".");
      if (!verify(null, Buffer.from(`${header}.${payload}`), signing.publicKey, Buffer.from(signature, "base64url"))) {
        res.statusCode = 401; res.end("{}"); return;
      }
      requests.push(req.url!); res.setHeader("Content-Type", "application/json");
      if (req.url === "/v1/connector/events/ack") { acknowledgements.push(JSON.parse(body.acknowledgement)); res.end("{}"); return; }
      if (req.url !== "/v1/connector/events/lease") { res.statusCode = 500; res.end("{}"); return; }
      if (!event || leased) { res.end(JSON.stringify({ events: [], eventWakeVersion: 1 })); return; }
      leased = true;
      const ephemeral = generateKeyPairSync("x25519"), algorithm = "X25519-HKDF-SHA256-A256GCM";
      const epk = Buffer.from(ephemeral.publicKey.export({ format: "jwk" }).x!, "base64url");
      const recipient = Buffer.from(sealing.publicKey.export({ format: "jwk" }).x!, "base64url");
      const aad = Buffer.from([1, algorithm, "events", "maintenance-connector", "test", "github", "github.code", ""].join("\n"));
      const key = Buffer.from(hkdfSync("sha256", diffieHellman({ privateKey: ephemeral.privateKey, publicKey: sealing.publicKey }), Buffer.concat([epk, recipient]), aad, 32));
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(aad);
      const clear = { v: 1, instanceId: "maintenance-connector", environment: "test", leaseId: "maintenance-lease", events: [event] };
      const ct = Buffer.concat([cipher.update(JSON.stringify(clear)), cipher.final(), cipher.getAuthTag()]);
      res.end(JSON.stringify({ leaseId: "maintenance-lease", eventWakeVersion: 1, sealed: { v: 1, alg: algorithm,
        purpose: "events", provider: "github", profile: "github.code", epk: epk.toString("base64url"), iv: iv.toString("base64url"), ct: ct.toString("base64url") } }));
    });
    await withMaintenanceProvider(broker, async origin => {
      const fixture = createDb(databaseUrl!, { maxConnections: 1 });
      let runtime: Awaited<ReturnType<typeof startMaintenanceServer>> | undefined;
      try {
        const server = runtime = await startMaintenanceServer(databaseUrl!, { enabled: false, clock: true,
        githubOrigin: origin, connector: {
        origin: origin, signPrivateKey: signing.privateKey.export({ format: "jwk" }).d!,
        sealPrivateKey: sealing.privateKey.export({ format: "jwk" }).d!,
      } });
        await server.settled(); expect(requests).toEqual([]);
        const company = await server.api<{ id: string }>("POST", "/companies", { name: "GitHub event ingress" });
        const [application] = await fixture.insert(toolApplications).values({ companyId: company.id, applicationKey: randomUUID(), name: "GitHub", type: "mcp_http", status: "active" }).returning();
        const [connection] = await fixture.insert(toolConnections).values({ companyId: company.id, applicationId: application!.id,
          uid: randomUUID(), name: "GitHub", status: "active", enabled: false, transport: "mcp_remote", authKind: "oauth", credentialPolicy: "per_user",
          config: { url: "https://api.github.com/mcp", sourceTemplateKey: "github", oauth: { connectorProfile: "github.code" } }, transportConfig: {} }).returning();
        const now = (await server.snapshot()).now;
        const [grant] = await fixture.insert(connectionGrants).values({ companyId: company.id, connectionId: connection!.id,
          kind: "user", subjectUserId: "maintenance-owner", status: "active", providerTenant: {
            oauth: { accessTokenExpiresAt: new Date(now + 8 * 3_600_000).toISOString(), refreshedAt: new Date(now).toISOString() },
            github: { userId: "42", login: "fixture", installationIds: ["101"], installationCount: 1, repositoryCount: 1,
              repositorySelection: "all", installationOwnerLogins: ["fixture"], accessRevision: randomUUID(), lastAccessRefreshAt: new Date(now).toISOString(), webhookHealth: "healthy" },
          } }).returning();
        event = { id: "maintenance-delivery", provider: "github", event: "pull_request", action: "closed", installationId: "101", repositoryId: "99",
          createdAt: new Date(now).toISOString(), bindingIds: [`${grant!.id}_101`], payload: { repository: "maintenance/example", number: 7,
            url: "https://github.com/maintenance/example/pull/7", state: "closed", merged: true, mergedAt: new Date(now).toISOString() } };
        await server.api("PATCH", `/tool-connections/${connection!.id}`, { enabled: true });
        await server.advance(5_000); await settleClock(server);
        const [delivery] = await fixture.$client`select company_id, status, attempts, processed_at is not null as processed, normalized_payload
          from connection_event_deliveries where provider_delivery_id='maintenance-delivery'`;
        expect(delivery).toMatchObject({ company_id: company.id, status: "processed", attempts: 1, processed: true,
          normalized_payload: expect.objectContaining({ repository: "maintenance/example", number: 7, merged: true }) });
        expect(acknowledgements).toHaveLength(1);
        const baseline = server.proxy.queries.length, requestCount = requests.length;
        for (let step = 0; step < 4; step++) { await server.advance(30_000); await server.settled(10); }
        expect(server.proxy.queries.length).toBe(baseline); expect(requests).toHaveLength(requestCount);
        await writeFile(path.join(server.directory, "github-measurement.json"), JSON.stringify({ phase: "ordinary-connection-activation-sealed-event",
          companyId: company.id, connectionId: connection!.id, grantId: grant!.id, delivery, requests, acknowledgements,
          quietClockMs: 120_000, quietQueries: 0, frames: server.proxy.frames,
          providerBoundary: "simulated Cloud HTTP validates real Ed25519 request and seals X25519/AES-GCM event; actual runtime decrypts/persists/acks",
        }, null, 2));
      } finally {
        try { await fixture.$client.end(); } finally { await runtime?.stop(); }
      }
    });
  }, 150_000);

  it("reacts to the first ordinary status-card source write and accepts authorized controlled summarizer output", async () => {
    await clearDatabase();
    const server = await startMaintenanceServer(databaseUrl!, { clock: true, suppressed: true });
    const fixture = createDb(databaseUrl!, { maxConnections: 1 });
    try {
      await server.settled();
      const company = await server.api<{ id: string }>("POST", "/companies", { name: "Status-card ingress" });
      const [agent] = await fixture.insert(agents).values({ companyId: company.id, name: "Controlled summarizer",
        status: "idle", adapterType: "process", adapterConfig: { command: "/usr/bin/false" } }).returning();
      const userId = randomUUID();
      await fixture.insert(authUsers).values({ id: userId, name: "Controlled writer owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
      await fixture.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: userId, status: "active", membershipRole: "member" });
      const token = randomUUID();
      await fixture.insert(agentApiKeys).values({ companyId: company.id, agentId: agent!.id, name: "Controlled writer", responsibleUserId: userId,
        keyHash: createHash("sha256").update(token).digest("hex") });
      await server.api("PATCH", "/instance/settings/experimental", { enableStatusCards: true });
      const card = await server.api<{ id: string; generatingIssueId: string }>("POST", `/companies/${company.id}/status-cards`, {
        interestPrompt: "Blocked tasks", agentId: agent!.id, refreshPolicy: { mode: "reactive", debounceSeconds: 60 },
      });
      async function writeback(generationIssueId: string, compile: boolean) {
        const [run] = await fixture.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent!.id,
          status: "running", responsibleUserId: userId, contextSnapshot: { issueId: generationIssueId } }).returning();
        await fixture.$client`update issues set checkout_run_id=${run!.id} where id=${generationIssueId}`;
        const headers = { authorization: `Bearer ${token}`, "x-paperclip-run-id": run!.id };
        if (compile) await server.api("PUT", `/status-cards/${card.id}/query`, { queries: [{ scope: "issues", status: ["blocked"] }],
          title: "Blocked tasks", changeSummary: "Controlled compilation", generationIssueId }, headers);
        await server.api("PUT", `/status-cards/${card.id}/summary`, { markdown: "Controlled current blockers",
          changeSummary: "Controlled summary", generationIssueId }, headers);
        await fixture.$client`update heartbeat_runs set status='succeeded', finished_at=now() where id=${run!.id}`;
        await server.api("PATCH", `/issues/${generationIssueId}`, { status: "done" });
      }
      await writeback(card.generatingIssueId, true); await server.advance(30_000); await settleClock(server);
      const [compiled] = await fixture.$client`select state, query_version, generating_issue_id from status_cards where id=${card.id}`;
      expect(compiled).toMatchObject({ state: "active", query_version: 1, generating_issue_id: null });
      const changed = await server.api<{ id: string }>("POST", `/companies/${company.id}/issues`, {
        title: "Ordinary new blocker", status: "blocked",
      });
      await server.advance(1_000); await settleClock(server);
      const [pending] = await fixture.$client`select pending_change_count, next_eval_at is not null as scheduled from status_cards where id=${card.id}`;
      expect(pending!.pending_change_count).toBeGreaterThan(0); expect(pending!.scheduled).toBe(true);
      for (let step = 0; step < 3; step++) { await server.advance(30_000); await settleClock(server); }
      const [generating] = await fixture.$client`select generating_issue_id from status_cards where id=${card.id}`;
      expect(generating!.generating_issue_id).toBeTypeOf("string");
      expect(generating!.generating_issue_id).not.toBe(card.generatingIssueId);
      await writeback(generating!.generating_issue_id, false); await server.advance(30_000); await settleClock(server);
      const [result] = await fixture.$client`select status, finished_at is not null as finished from status_card_updates
        where card_id=${card.id} and generation_issue_id=${generating!.generating_issue_id}`;
      expect(result).toMatchObject({ status: "ok", finished: true });
      const [saved] = await fixture.$client`select pending_change_count, generating_issue_id, state from status_cards where id=${card.id}`;
      expect(saved).toMatchObject({ pending_change_count: 0, generating_issue_id: null, state: "active" });
      await writeFile(path.join(server.directory, "status-card-measurement.json"), JSON.stringify({
        phase: "ordinary-reactive-card-source-and-authorized-writeback", companyId: company.id, cardId: card.id, issueId: changed.id,
        compiled, pending, generating, result, saved, frames: server.proxy.frames,
        executionBoundary: "controlled summarizer execution rows/key only; real authenticated query/summary routes; production execution suppressed; no model provider",
      }, null, 2));
    } finally { await fixture.$client.end(); await server.stop(); }
  }, 150_000);

  it("expires an ordinarily published backup after its ordinary task close without losing run history", async () => {
    await clearDatabase();
    const server = await startMaintenanceServer(databaseUrl!, { enabled: false, clock: true });
    const fixture = createDb(databaseUrl!, { maxConnections: 1 });
    try {
      await server.settled();
      const company = await server.api<{ id: string }>("POST", "/companies", { name: "Backup ingress" });
      const [agent] = await fixture.insert(agents).values({ companyId: company.id, name: "Backup owner", status: "paused" }).returning();
      const issue = await server.api<{ id: string }>("POST", `/companies/${company.id}/issues`, { title: "Close aged backup work", status: "todo" });
      const sessionId = randomUUID(), scopeDigest = "b".repeat(64);
      const [run] = await fixture.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent!.id,
        status: "succeeded", issueId: issue.id, nativeIssueId: issue.id, nativeSessionId: sessionId, finishedAt: new Date() }).returning();
      await fixture.insert(agentTaskSessions).values({ companyId: company.id, agentId: agent!.id, adapterType: "paperclip_runner",
        taskKey: issue.id, sessionParamsJson: { sessionId }, lastRunId: run!.id });
      const root = path.join(server.directory, "durable-sessions", scopeDigest), backupRoot = path.join(root, "failover-backups");
      const pendingRoot = path.join(backupRoot, "pending-publication"), current = path.join(backupRoot, "current");
      await mkdir(path.join(root, "control-plane"), { recursive: true }); await mkdir(pendingRoot, { recursive: true });
      await writeFile(path.join(root, "control-plane", "control-plane-state.json"), JSON.stringify({ identity: { runId: run!.id, normalizedSessionId: sessionId } }));
      await writeFile(path.join(pendingRoot, "manifest.json"), "{}"); await writeFile(path.join(pendingRoot, "session-bytes"), "retained session bytes");
      const old = new Date((await server.snapshot()).now - 10 * 86_400_000); await utimes(pendingRoot, old, old);
      await server.publishBackup({ companyId: company.id, scopeDigest, backupRoot, pendingRoot });
      await settleClock(server); await access(current);
      await fixture.$client.unsafe(`create or replace function maintenance_age_close() returns trigger language plpgsql as $$begin
        if new.title = 'Close aged backup work' and new.status = 'done' then new.completed_at = now() - interval '10 days'; end if;
        return new; end$$`);
      await fixture.$client.unsafe(`create trigger maintenance_age_close before update on issues for each row execute function maintenance_age_close()`);
      await server.api("PATCH", `/issues/${issue.id}`, { status: "done" });
      await server.advance(30_000); await settleClock(server);
      await expect(access(current)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(backupRoot)).toEqual([]);
      const [pointers] = await fixture.$client`select count(*)::integer as count from agent_task_sessions where agent_id=${agent!.id}`;
      const [history] = await fixture.$client`select status from heartbeat_runs where id=${run!.id}`;
      expect(pointers!.count).toBe(0); expect(history!.status).toBe("succeeded");
      await writeFile(path.join(server.directory, "backup-measurement.json"), JSON.stringify({ phase: "ordinary-publication-and-task-close",
        companyId: company.id, issueId: issue.id, runId: run!.id, scopeDigest, pointers: pointers!.count, history,
        timestampBoundary: "fixture ages backup mtime and ordinary close timestamp10days; cleanup outcome not seeded",
        publicationBoundary: "actual publishNativeHarnessBackup with actual runtime-owned DB; no provider execution", frames: server.proxy.frames,
      }, null, 2));
    } finally {
      await fixture.$client.unsafe("drop trigger if exists maintenance_age_close on issues").catch(() => {});
      await fixture.$client.unsafe("drop function if exists maintenance_age_close()").catch(() => {});
      await fixture.$client.end(); await server.stop();
    }
  }, 150_000);

  it("archives the first ordinary overdue attention source through the assembled retention worker", async () => {
    await clearDatabase();
    const server = await startMaintenanceServer(databaseUrl!, { clock: true, suppressed: true });
    const fixture = createDb(databaseUrl!, { maxConnections: 1 });
    try {
      await server.settled();
      const company = await server.api<{ id: string }>("POST", "/companies", { name: "Attention ingress" });
      const issue = await server.api<{ id: string }>("POST", `/companies/${company.id}/issues`, { title: "Await human decision", status: "todo" });
      await fixture.$client.unsafe(`create or replace function maintenance_age_attention() returns trigger language plpgsql as $$begin
        if new.title = 'Overdue ordinary human decision' then new.updated_at = now() - interval '91 days'; end if;
        return new; end$$`);
      await fixture.$client.unsafe(`create trigger maintenance_age_attention before insert on issue_thread_interactions for each row execute function maintenance_age_attention()`);
      const card = await server.api<{ id: string }>("POST", `/issues/${issue.id}/interactions`, {
        kind: "request_confirmation", title: "Overdue ordinary human decision", resolverPolicy: "human_only",
        continuationPolicy: "none", payload: { version: 1, prompt: "Choose the preferred color?" },
      });
      await server.advance(30_000); await settleClock(server);
      const [archived] = await fixture.$client`select company_id, source_kind, archived_reason, archived_by_type,
        archived_at is not null as archived, archive_version from decision_retention where source_id=${card.id}`;
      expect(archived).toMatchObject({ company_id: company.id, source_kind: "issue_thread_interaction", archived_reason: "idle_ttl",
        archived_by_type: "system", archived: true, archive_version: 1 });
      const [source] = await fixture.$client`select status, updated_at < now() - interval '90 days' as aged from issue_thread_interactions where id=${card.id}`;
      expect(source).toMatchObject({ status: "pending", aged: true });
      const audit = await fixture.$client`select actor_id, details from activity_log where company_id=${company.id}
        and action='decision_retention.auto_archived'`;
      expect(audit).toHaveLength(1);
      await writeFile(path.join(server.directory, "attention-measurement.json"), JSON.stringify({
        phase: "ordinary-overdue-attention-ingress", companyId: company.id, issueId: issue.id, interactionId: card.id,
        timestampBoundary: "fixture-only INSERT trigger ages source activity91days; no retention/outcome rows seeded",
        archived, source, audit, frames: server.proxy.frames,
      }, null, 2));
    } finally {
      await fixture.$client.unsafe("drop trigger if exists maintenance_age_attention on issue_thread_interactions").catch(() => {});
      await fixture.$client.unsafe("drop function if exists maintenance_age_attention()").catch(() => {});
      await fixture.$client.end(); await server.stop();
    }
  }, 150_000);

  it("accepts the first ordinary merge confirmation through the assembled provider worker", async () => {
    await clearDatabase();
    const providerRequests: string[] = [];
    const provider = createServer((req, res) => {
      providerRequests.push(req.url!); res.setHeader("Content-Type", "application/json");
      if (req.url !== "/repos/maintenance/example/pulls/39") { res.statusCode = 500; res.end("{}"); return; }
      res.end(JSON.stringify({ id: 39, number: 39, state: "closed", merged: true, merged_at: new Date().toISOString(),
        title: "Controlled merged confirmation", html_url: "https://github.com/maintenance/example/pull/39", user: { login: "fixture" } }));
    });
    await withMaintenanceProvider(provider, async origin => {
      const fixture = createDb(databaseUrl!, { maxConnections: 1 });
      let runtime: Awaited<ReturnType<typeof startMaintenanceServer>> | undefined;
      try {
        const server = runtime = await startMaintenanceServer(databaseUrl!, { clock: true, suppressed: true,
        githubOrigin: origin });
        await server.settled();
        const company = await server.api<{ id: string }>("POST", "/companies", { name: "Merge ingress" });
        const issue = await server.api<{ id: string }>("POST", `/companies/${company.id}/issues`, { title: "Merge task", status: "todo" });
        const card = await server.api<{ id: string }>("POST", `/issues/${issue.id}/interactions`, {
          kind: "request_confirmation", title: "Merge maintenance/example#39?", resolverPolicy: "human_only",
          continuationPolicy: "none", payload: { version: 1, prompt: "Merge the PR?" },
        });
        await server.advance(30_000); await settleClock(server);
        const [accepted] = await fixture.$client`select company_id, status, resolved_at is not null as resolved
          from issue_thread_interactions where id=${card.id}`;
        expect(accepted).toMatchObject({ company_id: company.id, status: "accepted", resolved: true });
        const audit = await fixture.$client`select actor_id, details from activity_log where company_id=${company.id}
          and action='issue.thread_interaction_accepted'`;
        expect(audit).toEqual([expect.objectContaining({ actor_id: "system:pr-merged", details: expect.objectContaining({ interactionId: card.id }) })]);
        expect(providerRequests).toEqual(["/repos/maintenance/example/pulls/39"]);
        await writeFile(path.join(server.directory, "confirmation-measurement.json"), JSON.stringify({
          phase: "ordinary-merge-confirmation", companyId: company.id, issueId: issue.id, interactionId: card.id,
          accepted, audit, providerRequests, frames: server.proxy.frames,
          providerBoundary: "simulated GitHub HTTP; actual production worker and interaction acceptance",
        }, null, 2));
      } finally {
        try { await fixture.$client.end(); } finally { await runtime?.stop(); }
      }
    });
  }, 150_000);

  it("projects the first ordinary routine completion in the actual suppressed Cloud runtime", async () => {
    await clearDatabase();
    const companyId = randomUUID(), agentId = randomUUID();
    const pair = generateKeyPairSync("ed25519");
    const publicJwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "maintenance-routine-key", use: "sig", alg: "EdDSA" };
    const storageRequests: string[] = [];
    const storage = createServer((req, res) => { storageRequests.push(req.url!); res.statusCode = 500; res.end("Unexpected S3 request in routine fixture"); });
    await withMaintenanceProvider(storage, async origin => {
      const fixture = createDb(databaseUrl!, { maxConnections: 1 });
      let runtime: Awaited<ReturnType<typeof startMaintenanceServer>> | undefined;
      try {
        await fixture.insert(companies).values({ id: companyId, name: "Routine ingress", issuePrefix: "MRT",
          defaultResponsibleUserId: "maintenance-board", requireBoardApprovalForNewAgents: false });
        await fixture.insert(agents).values({ id: agentId, companyId, name: "Suppressed routine worker", status: "active",
          lifecycleState: "ready", adapterType: "process", adapterConfig: { command: "/usr/bin/false" } });
        const server = runtime = await startMaintenanceServer(databaseUrl!, { clock: true, suppressed: true,
        cloud: { jwks: JSON.stringify({ keys: [publicJwk] }), s3Origin: origin, standby: false } });
        await server.settled();
        const routine = await server.api<{ id: string }>("POST", `/companies/${companyId}/routines`, {
          title: "Ordinary projected routine", assigneeAgentId: agentId, concurrencyPolicy: "always_enqueue",
        });
        const run = await server.api<{ id: string; linkedIssueId: string; status: string }>("POST", `/routines/${routine.id}/run`, {
          source: "manual", idempotencyKey: randomUUID(),
        });
        expect(run.status).toBe("issue_created");
        const [before] = await fixture.$client`select status, completed_at from routine_runs where id=${run.id}`;
        expect(before).toMatchObject({ status: "issue_created", completed_at: null });
        await fixture.$client.unsafe(`create or replace function maintenance_hold_completion() returns trigger language plpgsql as $$begin
          if new.id = '${run.linkedIssueId}'::uuid and new.status = 'done' then perform pg_advisory_xact_lock(913702); end if;
          return new; end$$`);
        await fixture.$client.unsafe(`create trigger maintenance_hold_completion before update on issues for each row execute function maintenance_hold_completion()`);
        const reserved = await fixture.$client.reserve();
        await reserved`select pg_advisory_lock(913702)`;
        const writesBefore = server.proxy.queries.length;
        const completing = server.updateIssue({ id: run.linkedIssueId, status: "done" });
        void completing.catch(() => {});
        try {
          await expect.poll(() => server.proxy.queries.slice(writesBefore).some(query => /update "issues"/.test(query.sql)), { timeout: 10_000 }).toBe(true);
          await server.drain();
        } finally { await reserved`select pg_advisory_unlock(913702)`; reserved.release(); }
        await completing; await server.advance(30_000); await settleClock(server);
        const [drained] = await fixture.$client`select status, completed_at from routine_runs where id=${run.id}`;
        expect(drained).toMatchObject({ status: "issue_created", completed_at: null });
        await server.resume(); await server.advance(30_000); await settleClock(server);
        const [projected] = await fixture.$client`select rr.company_id, rr.status, rr.completed_at is not null as completed,
          i.status as issue_status from routine_runs rr join issues i on i.id=rr.linked_issue_id where rr.id=${run.id}`;
        expect(projected).toMatchObject({ company_id: companyId, status: "completed", completed: true, issue_status: "done" });
        const restoredRun = await server.api<{ id: string; linkedIssueId: string }>("POST", `/routines/${routine.id}/run`, {
          source: "manual", idempotencyKey: randomUUID(),
        });
        const cancel = await server.api<{ hold: { id: string } }>("POST", `/issues/${restoredRun.linkedIssueId}/tree-holds`, { mode: "cancel", reason: "Ordinary cancel before restore" });
        await server.advance(1_000); await settleClock(server);
        const [cancelled] = await fixture.$client`select status from routine_runs where id=${restoredRun.id}`;
        expect(cancelled!.status).toBe("failed");
        await server.api("POST", `/issues/${restoredRun.linkedIssueId}/tree-holds`, { mode: "restore", reason: "Ordinary restore" });
        await server.advance(1_000); await settleClock(server);
        const [restored] = await fixture.$client`select rr.status, rr.completed_at, rr.failure_reason, i.status as issue_status
          from routine_runs rr join issues i on i.id=rr.linked_issue_id where rr.id=${restoredRun.id}`;
        expect(restored).toMatchObject({ status: "issue_created", completed_at: null, failure_reason: null, issue_status: "todo" });
        const [cancelHold] = await fixture.$client`select status from issue_tree_holds where id=${cancel.hold.id}`;
        expect(cancelHold!.status).toBe("released");
        const [executions] = await fixture.$client`select count(*)::integer as count from heartbeat_runs where company_id=${companyId}`;
        expect(executions!.count).toBe(0);
        expect(storageRequests).toEqual([]);
        await writeFile(path.join(server.directory, "routine-measurement.json"), JSON.stringify({
          phase: "ordinary-routine-service-completion-during-drain", completionBoundary: "actual issueService.update with runtime-owned DB; excludes redundant route projection hook", companyId, routineId: routine.id, runId: run.id,
          before, drained, projected, restoredRun, cancelled, restored, cancelHold, executions: executions!.count, storageRequests,
          suppression: "PAPERCLIP_IN_WORKTREE; actual production policy", frames: server.proxy.frames,
        }, null, 2));
      } finally {
        await fixture.$client.unsafe("drop trigger if exists maintenance_hold_completion on issues").catch(() => {});
        await fixture.$client.unsafe("drop function if exists maintenance_hold_completion()").catch(() => {});
        try { await runtime?.stop(); } finally { await fixture.$client.end(); }
      }
    });
  }, 150_000);

  it("keeps an actual Cloud warm standby quiet and activates after a normally signed durable claim", async () => {
    await clearDatabase();
    const pair = generateKeyPairSync("ed25519");
    const publicJwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "maintenance-test-key", use: "sig", alg: "EdDSA" };
    const storageRequests: string[] = [];
    const storage = createServer((req, res) => { storageRequests.push(req.url!); res.statusCode = 500; res.end("Unexpected S3 request in empty standby fixture"); });
    await withMaintenanceProvider(storage, async origin => {
      let runtime: Awaited<ReturnType<typeof startMaintenanceServer>> | undefined;
      try {
        const server = runtime = await startMaintenanceServer(databaseUrl!, { clock: true,
        cloud: { jwks: JSON.stringify({ keys: [publicJwk] }), s3Origin: origin, standby: true } });
        const standby = await server.settled(500, 1); await server.freeze();
        expect(standby.idle.active).toBe(1);
        const before = server.proxy.queries.length;
        for (let step = 0; step < 240; step++) { await server.advance(30_000); await server.settled(10, 1); }
        const health = await fetch(`http://127.0.0.1:${server.port}/api/health`, { signal: AbortSignal.timeout(10_000) });
        expect(health.status).toBe(200); expect(await health.json()).toMatchObject({ warmStandby: true });
        expect(server.proxy.queries.length).toBe(before);
        expect(storageRequests).toEqual([]);
        expect((await server.snapshot()).network.nonDatabaseConnections).toBe(0);
        const now = Math.floor((await server.snapshot()).now / 1000);
        const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: CLOUD_RUNTIME_IDENTITY_JWS_TYPE, kid: publicJwk.kid })).toString("base64url");
        const payload = Buffer.from(JSON.stringify({ v: 1, iss: CLOUD_RUNTIME_IDENTITY_ISSUER, aud: CLOUD_RUNTIME_IDENTITY_AUDIENCE,
          sub: "maintenance-stack", claimId: "maintenance-claim", previousOrigin: "https://pool-maintenance.staging.paperclip.app",
          canonicalOrigin: "https://claimed-maintenance.staging.paperclip.app", stackSlug: "claimed-maintenance", iat: now, exp: now + 300 })).toString("base64url");
        const assertion = `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`, "ascii"), pair.privateKey).toString("base64url")}`;
        const claimed = await fetch(`http://127.0.0.1:${server.port}/api/health`, {
          headers: { "x-paperclip-cloud-runtime-identity": assertion }, signal: AbortSignal.timeout(10_000),
        });
        expect(claimed.status).toBe(200); expect((await claimed.json()).warmStandby).toBeUndefined();
        await server.advance(30_000); const afterClaim = await server.settled();
        expect(afterClaim.idle.active).toBe(0);
        expect(server.proxy.queries.length).toBeGreaterThan(before);
        const fixture = createDb(databaseUrl!, { maxConnections: 1 });
        try {
          const [transfers] = await fixture.$client`select count(*)::integer as count from company_transfer_runs`;
          expect(transfers!.count).toBe(0);
          const [identity] = await fixture.$client`select general from instance_settings where singleton_key='cloud-runtime-identity/v1'`;
          expect(identity!.general).toMatchObject({ stackId: "maintenance-stack", claimId: "maintenance-claim", canonicalOrigin: "https://claimed-maintenance.staging.paperclip.app" });
        } finally { await fixture.$client.end(); }
        await writeFile(path.join(server.directory, "standby-measurement.json"), JSON.stringify({ phase: "real-cloud-standby-signed-claim",
          cloudBoundary: "actual managed configuration, local S3 HTTP guard, generated Ed25519 trust root; no production Cloud claim",
          clockMs: 7_200_000, standbyQueries: 0,
          deferredStartupIntent: { count: 1, queue: "import-spool-cleanup", producer: "companyTransferRunService.recoverStrandedApplyingRuns",
            reason: "Cloud standby disables both reconciliation and dispatch", releasedAfterSignedClaim: true, boundedResumeMs: 30_000, sleepEligibleWhileHeld: false }, storageRequests, beforeClaimQueries: before, afterClaimQueries: server.proxy.queries.length,
          frames: server.proxy.frames, network: await server.snapshot() }, null, 2));
      } finally {
        await runtime?.stop();
      }
    });
  }, 150_000);

});
