import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MANAGED_DATABASE_HTTP, type ManagedDatabaseReceipt } from "@paperclipai/shared/managed-database";
import { signManagedDatabasePayload, signManagedDatabaseReceipt } from "@paperclipai/shared/managed-database-server";
import { closeServer, createControlServer, listenUnix } from "../managed-database/control-server.js";
import { managedDatabaseLayout, writeJsonAtomic } from "../managed-database/layout.js";
import type { ManagedDatabaseSupervisor } from "../managed-database/supervisor.js";
import {
  acquireLease,
  appSql,
  buildCommand,
  buildSupervisor,
  createTestStack,
  establishedConfig,
  getManagedDatabaseTestSupport,
  sendCommand,
  signedArchiveHeaders,
  signedUpload,
  socketRequest,
  superuserSql,
  type TestStack,
  uploadArchive,
} from "./helpers/managed-database.js";

const support = await getManagedDatabaseTestSupport();
const describeSnapshots = support.supported && support.pgTools ? describe : describe.skip;
const describeEngine = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping managed database recovery tests: ${support.reason}`);
else if (!support.pgTools) console.warn("Skipping managed database snapshot tests: pg_dump/pg_restore 18 not found (install postgresql-client-18 or set PAPERCLIP_MANAGED_DATABASE_PG_CLIENT_BIN_DIR)");

const TIMEOUT = 240_000;
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "managed-database");
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function waitFor<T>(probe: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 30_000, label = "condition"): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function countCompanies(supervisor: ManagedDatabaseSupervisor): Promise<number> {
  const app = appSql(supervisor);
  try {
    return (await app<{ n: number }[]>`select count(*)::int as n from companies`)[0]!.n;
  } finally {
    await app.end();
  }
}

/** Restart on the next generation, as the harness does after a config change. */
async function restart(stack: TestStack, current: ManagedDatabaseSupervisor, patch: Partial<TestStack["config"]> = {}, extra = {}) {
  const systemIdentifier = current.readiness().systemIdentifier!;
  await current.stop();
  stack.config = establishedConfig(stack.config, systemIdentifier, patch);
  if (!support.supported) throw new Error("unsupported");
  const next = await buildSupervisor(stack, support, extra);
  await next.start();
  return next;
}

describeSnapshots("managed embedded database: release migration and verified restore", () => {
  if (!support.supported) return;
  let stack: TestStack;
  let supervisor: ManagedDatabaseSupervisor;

  beforeAll(async () => {
    stack = await createTestStack();
    supervisor = await buildSupervisor(stack, support);
    await supervisor.start();
  }, TIMEOUT);

  afterAll(async () => {
    await supervisor?.stop();
    stack?.cleanup();
  });

  it("restores the pre-migration database after the pinned migrator fails, then migrates cleanly", async () => {
    const keptCompany = randomUUID();
    let app = appSql(supervisor);
    await app`insert into companies (id, name, issue_prefix) values (${keptCompany}, 'Before migration', 'BFM')`;
    await app.end();

    // Stand in for the previous release: the newest migration is not applied yet.
    const latest = supervisor.readiness().release.latestMigration;
    let su = superuserSql(stack);
    const [{ n: journalBefore }] = await su<{ n: number }[]>`select count(*)::int as n from drizzle.__drizzle_migrations`;
    await su`delete from drizzle.__drizzle_migrations where id = (select max(id) from drizzle.__drizzle_migrations)`;
    await su.end();
    supervisor = await restart(stack, supervisor);
    expect(supervisor.readiness().schema).toMatchObject({ state: "pending" });
    expect(supervisor.readiness().schema.latestApplied).not.toBe(latest);

    // A serving config on a stale schema stays in maintenance: no app writers.
    supervisor = await restart(stack, supervisor, { mode: "serving" }, { appCommand: [process.execPath, "-e", "process.exit(9)"] });
    expect(supervisor.readiness()).toMatchObject({ mode: "serving", status: "maintenance", appRunning: false });
    supervisor = await restart(stack, supervisor, { mode: "maintenance" });

    // Release step 4: quiesced snapshot while PostgreSQL stays up for the maintenance process.
    const lease = await acquireLease(supervisor, stack);
    const snap = await sendCommand(supervisor, stack, { kind: "snapshot.create", lease });
    expect(snap.status).toBe(200);
    const snapshot = snap.receipt.details.snapshot as { snapshotId: string; consistency: string; tableRowCounts: Record<string, number> };
    expect(snapshot.consistency).toBe("quiesced");
    expect(snapshot.tableRowCounts["public.companies"]).toBe(1);

    // Writes after the snapshot must be rolled back by the restore.
    app = appSql(supervisor);
    await app`insert into companies (id, name, issue_prefix) values (${randomUUID()}, 'After snapshot', 'AFS')`;
    await app.end();

    // Privilege drift makes the real migrator fail whatever the pending file
    // contains: the schema owner can no longer read or write the journal.
    su = superuserSql(stack);
    await su`alter table drizzle.__drizzle_migrations owner to paperclip_supervisor`;
    await su.end();

    const release = supervisor.readiness().release;
    const failed = await sendCommand(supervisor, stack, { kind: "schema.migrate", args: { snapshotId: snapshot.snapshotId, release }, lease });
    expect(failed.status).toBe(500);
    expect(failed.receipt).toMatchObject({ outcome: "failed", code: "operation_failed" });
    expect(supervisor.readiness().hold).toMatchObject({ reason: "migration_failed" });

    // The hold blocks a retry and keeps a serving config from launching the app.
    const retry = await sendCommand(supervisor, stack, { kind: "schema.migrate", args: { snapshotId: snapshot.snapshotId, release }, lease });
    expect(retry.receipt.code).toBe("recovery_hold");

    // A wrong release (not this image's migrator) is refused before mutation.
    const wrongRelease = await sendCommand(supervisor, stack, {
      kind: "schema.migrate",
      args: { snapshotId: snapshot.snapshotId, release: { ...release, migrationsDigest: "f".repeat(64) } },
      lease,
    });
    expect(["recovery_hold", "precondition_failed"]).toContain(wrongRelease.receipt.code);

    const restored = await sendCommand(supervisor, stack, { kind: "snapshot.restore", args: { snapshotId: snapshot.snapshotId }, lease });
    expect(restored.status).toBe(200);
    expect(restored.receipt.details).toMatchObject({ verifiedTables: Object.keys(snapshot.tableRowCounts).length, schema: { state: "pending" } });
    expect(supervisor.readiness().hold).toBeNull();
    app = appSql(supervisor);
    expect(await app`select id from companies`).toEqual([{ id: keptCompany }]);
    await app.end();
    su = superuserSql(stack);
    const [{ owner }] = await su<{ owner: string }[]>`select tableowner as owner from pg_tables where schemaname = 'drizzle' and tablename = '__drizzle_migrations'`;
    expect(owner).toBe("paperclip_owner");
    await su.end();

    const status = await sendCommand(supervisor, stack, { kind: "status" });
    const retained = (status.receipt.details.retainedDatabases as string[]).find((name) => name.startsWith("paperclip_pre_restore_"))!;
    expect(retained).toBeTruthy();

    // A fresh quiesced snapshot at the restored journal, then the migration succeeds.
    const snap2 = await sendCommand(supervisor, stack, { kind: "snapshot.create", lease });
    const snapshot2 = snap2.receipt.details.snapshot as { snapshotId: string };
    const stale = await sendCommand(supervisor, stack, { kind: "schema.migrate", args: { snapshotId: "missing_snapshot", release }, lease });
    expect(stale.receipt.code).toBe("precondition_failed");
    const migrated = await sendCommand(supervisor, stack, { kind: "schema.migrate", args: { snapshotId: snapshot2.snapshotId, release }, lease });
    expect(migrated.status).toBe(200);
    expect(supervisor.readiness().schema).toMatchObject({ state: "current", latestApplied: latest });
    su = superuserSql(stack);
    const [{ n: journalAfter }] = await su<{ n: number }[]>`select count(*)::int as n from drizzle.__drizzle_migrations`;
    await su.end();
    expect(journalAfter).toBe(journalBefore);

    const discarded = await sendCommand(supervisor, stack, { kind: "restore.discard", args: { database: retained }, lease });
    expect(discarded.status).toBe(200);
    await sendCommand(supervisor, stack, { kind: "lease.release", lease });
  }, TIMEOUT);

  it("fences a restore whose lease expired before the swap", async () => {
    let clock = Date.now();
    supervisor = await restart(stack, supervisor, {}, { now: () => clock });
    const lease = await acquireLease(supervisor, stack, 10);
    const snap = await sendCommand(supervisor, stack, { kind: "snapshot.create", lease }, { issuedAt: new Date(clock).toISOString() });
    const snapshotId = (snap.receipt.details.snapshot as { snapshotId: string }).snapshotId;
    const before = await countCompanies(supervisor);
    const body = buildCommand(stack, { kind: "snapshot.restore", args: { snapshotId }, lease }, { issuedAt: new Date(clock).toISOString() });
    // The lease expires while the restore is in flight (verification takes time).
    const pending = supervisor.handleCommand(body, signManagedDatabasePayload(stack.controlKey, "command", body));
    clock += 11_000;
    const response = await pending;
    expect((response.body as ManagedDatabaseReceipt).outcome).toBe("failed");
    expect((response.body as ManagedDatabaseReceipt).error).toMatch(/lease expired before the restore swap/);
    expect(await countCompanies(supervisor)).toBe(before);
    const su = superuserSql(stack, "postgres");
    const leftovers = await su`select datname from pg_database where datname like 'paperclip\\_restore\\_%'`;
    await su.end();
    expect(leftovers).toEqual([]);
  }, TIMEOUT);

  it("rechecks the lease before migrating and keeps it while a command runs", async () => {
    // Past the previous test's simulated lease expiry.
    let clock = Date.now() + 60_000;
    let su = superuserSql(stack);
    await su`delete from drizzle.__drizzle_migrations where id = (select max(id) from drizzle.__drizzle_migrations)`;
    const [{ n: journalBefore }] = await su<{ n: number }[]>`select count(*)::int as n from drizzle.__drizzle_migrations`;
    await su.end();
    supervisor = await restart(stack, supervisor, {}, { now: () => clock });
    expect(supervisor.readiness().schema.state).toBe("pending");
    const issuedAt = () => new Date(clock).toISOString();
    const granted = (await sendCommand(supervisor, stack, { kind: "lease.acquire", args: { holder: "test", ttlSeconds: 10 } }, { issuedAt: issuedAt() })).receipt.details.lease as { id: string; epoch: number };
    const lease = { id: granted.id, epoch: granted.epoch };

    // The holder cannot release the lease while a command acts under it.
    const snapBody = buildCommand(stack, { kind: "snapshot.create", lease }, { issuedAt: issuedAt() });
    const snapping = supervisor.handleCommand(snapBody, signManagedDatabasePayload(stack.controlKey, "command", snapBody));
    const early = await sendCommand(supervisor, stack, { kind: "lease.release", lease }, { issuedAt: issuedAt() });
    expect(early.receipt.code).toBe("busy");
    const snapshotId = ((await snapping).body as ManagedDatabaseReceipt & { details: { snapshot: { snapshotId: string } } }).details.snapshot.snapshotId;

    // The lease expires after the gate, while the journal is being read.
    const release = supervisor.readiness().release;
    const body = buildCommand(stack, { kind: "schema.migrate", args: { snapshotId, release }, lease }, { issuedAt: issuedAt() });
    const pending = supervisor.handleCommand(body, signManagedDatabasePayload(stack.controlKey, "command", body));
    clock += 11_000;
    const response = (await pending).body as ManagedDatabaseReceipt;
    expect(response).toMatchObject({ outcome: "rejected", code: "lease_stale" });
    expect(supervisor.readiness()).toMatchObject({ hold: null, schema: { state: "pending" } });
    su = superuserSql(stack);
    const [{ n: journalAfter }] = await su<{ n: number }[]>`select count(*)::int as n from drizzle.__drizzle_migrations`;
    await su.end();
    expect(journalAfter).toBe(journalBefore);
  }, TIMEOUT);
});

describeSnapshots("managed embedded database: off-volume archives and disaster restore", () => {
  if (!support.supported) return;
  const stacks: TestStack[] = [];
  const supervisors: ManagedDatabaseSupervisor[] = [];
  const servers: Array<ReturnType<typeof createControlServer>> = [];

  afterAll(async () => {
    for (const server of servers) await closeServer(server);
    for (const supervisor of supervisors) await supervisor.stop();
    for (const stack of stacks) stack.cleanup();
  });

  async function serve(stack: TestStack, overrides = {}) {
    if (!support.supported) throw new Error("unsupported");
    const supervisor = await buildSupervisor(stack, support, overrides);
    await supervisor.start();
    const server = createControlServer(supervisor, () => !supervisor.appRunning);
    await listenUnix(server, supervisor.layout.controlSocket);
    supervisors.push(supervisor);
    servers.push(server);
    stacks.push(stack);
    return supervisor;
  }

  async function command(stack: TestStack, socket: string, body: Record<string, unknown>) {
    const response = await socketRequest(socket, "POST", MANAGED_DATABASE_HTTP.command, {
      "content-type": "application/json",
      [MANAGED_DATABASE_HTTP.signatureHeader]: signManagedDatabasePayload(stack.controlKey, "command", body),
    }, JSON.stringify(body));
    return { status: response.status, receipt: JSON.parse(response.body.toString("utf8")) as ManagedDatabaseReceipt };
  }

  it("downloads a verified archive, refuses foreign or corrupt uploads, and restores into a fresh destination", async () => {
    const source = await createTestStack();
    const sourceSupervisor = await serve(source);
    const socket = sourceSupervisor.layout.controlSocket;

    const app = appSql(sourceSupervisor);
    for (let i = 0; i < 25; i += 1) {
      await app`insert into companies (id, name, issue_prefix) values (${randomUUID()}, ${`Company ${i}`}, ${`D${i}`})`;
    }
    await app.end();
    // Enough plugin tables that the receipt (one row count per table) is
    // larger than an HTTP header may be.
    const pluginSql = appSql(sourceSupervisor, "plugin");
    await pluginSql`create schema plugin_bulk_fixture`;
    for (let i = 0; i < 300; i += 1) {
      await pluginSql.unsafe(`create table plugin_bulk_fixture.t_${String(i).padStart(3, "0")}_${"x".repeat(40)} (id int)`);
    }
    await pluginSql.end();

    const health = await socketRequest(socket, "GET", MANAGED_DATABASE_HTTP.health, {});
    expect(JSON.parse(health.body.toString())).toEqual({ status: "maintenance" });

    const leaseReceipt = await command(source, socket, buildCommand(source, { kind: "lease.acquire", args: { holder: "harness", ttlSeconds: 600 } }));
    const lease = leaseReceipt.receipt.details.lease as { id: string; epoch: number };
    const created = await command(source, socket, buildCommand(source, { kind: "snapshot.create", lease: { id: lease.id, epoch: lease.epoch } }));
    expect(created.status).toBe(200);
    const snapshotReceipt = created.receipt;
    const details = snapshotReceipt.details.snapshot as { snapshotId: string; sha256: string; sizeBytes: number };

    const download = await socketRequest(socket, "GET", MANAGED_DATABASE_HTTP.archive, signedArchiveHeaders(source.controlKey,
      buildCommand(source, { kind: "snapshot.download", args: { snapshotId: details.snapshotId }, lease: { id: lease.id, epoch: lease.epoch } })));
    expect(download.status).toBe(200);
    expect(download.headers[MANAGED_DATABASE_HTTP.archiveSha256Header]).toBe(details.sha256);
    expect(createHash("sha256").update(download.body).digest("hex")).toBe(details.sha256);
    const archive = download.body;
    expect(Buffer.from(JSON.stringify(snapshotReceipt)).toString("base64url").length).toBeGreaterThan(16 * 1024);

    // A download that is already open survives a concurrent delete.
    const racing = buildCommand(source, { kind: "snapshot.download", args: { snapshotId: details.snapshotId }, lease: { id: lease.id, epoch: lease.epoch } });
    const opened = sourceSupervisor.openArchiveDownload(Buffer.from(JSON.stringify(racing)).toString("base64url"), signManagedDatabasePayload(source.controlKey, "command", racing));
    if (!opened.ok) throw new Error(JSON.stringify(opened.response));
    const deleted = await command(source, socket, buildCommand(source, { kind: "snapshot.delete", args: { snapshotId: details.snapshotId }, lease: { id: lease.id, epoch: lease.epoch } }));
    expect(deleted.status).toBe(200);
    try {
      expect(createHash("sha256").update(readFileSync(opened.fd)).digest("hex")).toBe(details.sha256);
    } finally {
      closeSync(opened.fd);
    }
    const gone = await socketRequest(socket, "GET", MANAGED_DATABASE_HTTP.archive, signedArchiveHeaders(source.controlKey,
      buildCommand(source, { kind: "snapshot.download", args: { snapshotId: details.snapshotId }, lease: { id: lease.id, epoch: lease.epoch } })));
    expect(gone.status).toBe(404);

    // Disaster: the source volume is gone. A fresh volume for the same stack.
    const destination = await createTestStack({
      stackId: source.config.stackId,
      cluster: { state: "initialize", initializationId: `init_dr_${randomBytes(3).toString("hex")}` },
    });
    destination.controlKey = source.controlKey;
    let destinationClockOffset = 0;
    const destinationSupervisor = await serve(destination, { now: () => Date.now() + destinationClockOffset });
    const destinationSocket = destinationSupervisor.layout.controlSocket;
    const destLeaseReceipt = await command(destination, destinationSocket, buildCommand(destination, { kind: "lease.acquire", args: { holder: "dr", ttlSeconds: 600 } }));
    const destLease = destLeaseReceipt.receipt.details.lease as { id: string; epoch: number };
    const destLeaseRef = { id: destLease.id, epoch: destLease.epoch };

    // A corrupted transfer is rejected and leaves nothing behind.
    const corrupt = Buffer.from(archive);
    corrupt[corrupt.length - 10] ^= 0xff;
    const badUpload = await uploadArchive(destinationSocket, signedUpload(destination.controlKey, buildCommand(destination, { kind: "snapshot.upload", args: { receipt: snapshotReceipt }, lease: destLeaseRef }), corrupt));
    expect(JSON.parse(badUpload.body.toString()).code).toBe("precondition_failed");
    expect(existsSync(path.join(destinationSupervisor.layout.snapshotsDir, `${details.snapshotId}.dump`))).toBe(false);

    // A body longer than the receipt declares is cut off at that size.
    const oversized = Buffer.concat([archive, Buffer.alloc(1)]);
    const longUpload = await uploadArchive(destinationSocket, signedUpload(destination.controlKey, buildCommand(destination, { kind: "snapshot.upload", args: { receipt: snapshotReceipt }, lease: destLeaseRef }), oversized));
    expect(longUpload.status).toBe(409);
    expect(longUpload.headers.connection).toBe("close");
    expect(JSON.parse(longUpload.body.toString())).toMatchObject({ code: "precondition_failed", error: expect.stringContaining("exceeds") });
    expect(readdirSync(destinationSupervisor.layout.snapshotsDir).filter((name) => name.startsWith(details.snapshotId))).toEqual([]);

    // Another stack's archive (validly signed by that stack) is refused.
    const foreign = await createTestStack();
    const foreignReceipt = signManagedDatabaseReceipt(foreign.controlKey, { ...snapshotReceipt, stackId: foreign.config.stackId });
    const foreignUpload = await uploadArchive(destinationSocket, signedUpload(destination.controlKey, buildCommand(destination, { kind: "snapshot.upload", args: { receipt: foreignReceipt }, lease: destLeaseRef }), archive));
    expect(JSON.parse(foreignUpload.body.toString()).code).toBe("precondition_failed");
    foreign.cleanup();

    const uploadRequest = signedUpload(destination.controlKey, buildCommand(destination, { kind: "snapshot.upload", args: { receipt: snapshotReceipt }, lease: destLeaseRef }), archive);
    const upload = await uploadArchive(destinationSocket, uploadRequest);
    expect(upload.status).toBe(200);

    // The upload response was lost and the harness came back after the replay
    // window: the exact upload returns its stored receipt, the lookup agrees.
    destinationClockOffset = 6 * 60_000;
    const replayedUpload = await uploadArchive(destinationSocket, uploadRequest);
    expect(replayedUpload.status).toBe(200);
    expect(JSON.parse(replayedUpload.body.toString())).toEqual(JSON.parse(upload.body.toString()));
    const uploadReceipt = JSON.parse(upload.body.toString()) as ManagedDatabaseReceipt;
    const uploadLookup = await command(destination, destinationSocket, buildCommand(destination, {
      kind: "receipt.get",
      args: { commandId: uploadReceipt.commandId, requestSha256: uploadReceipt.requestSha256 },
    }, { issuedAt: new Date(Date.now() + destinationClockOffset).toISOString() }));
    expect(uploadLookup.receipt.details).toMatchObject({ state: "found", receipt: uploadReceipt });
    destinationClockOffset = 0;

    // A crash between the archive and its metadata: a retried upload repairs it.
    const uploadedMetadata = path.join(destinationSupervisor.layout.snapshotsDir, `${details.snapshotId}.json`);
    rmSync(uploadedMetadata);
    const retried = await uploadArchive(destinationSocket, signedUpload(destination.controlKey, buildCommand(destination, { kind: "snapshot.upload", args: { receipt: snapshotReceipt }, lease: destLeaseRef }), archive));
    expect(retried.status).toBe(200);
    expect(existsSync(uploadedMetadata)).toBe(true);

    const startedAt = Date.now();
    const restored = await command(destination, destinationSocket, buildCommand(destination, { kind: "snapshot.restore", args: { snapshotId: details.snapshotId }, lease: destLeaseRef }));
    const restoreMs = Date.now() - startedAt;
    expect(restored.status).toBe(200);
    expect(await countCompanies(destinationSupervisor)).toBe(25);
    console.info(`[managed-database evidence] disaster restore of ${details.sizeBytes} byte archive verified in ${restoreMs} ms`);
  }, TIMEOUT);
});

describeSnapshots("managed embedded database: serving stack with live writers", () => {
  if (!support.supported) return;
  let stack: TestStack;
  let supervisor: ManagedDatabaseSupervisor;
  let statusFile: string;
  const fatal: string[] = [];

  beforeAll(async () => {
    stack = await createTestStack();
    const init = await buildSupervisor(stack, support);
    await init.start();
    statusFile = path.join(stack.volume, "writer-status.json");
    supervisor = await restart(stack, init, { mode: "serving" }, {
      appCommand: [process.execPath, path.join(fixtures, "writer-app.mjs")],
      env: { WRITER_STATUS_FILE: statusFile, PATH: process.env.PATH, HOME: process.env.HOME },
      onFatal: (_code: number, reason: string) => fatal.push(reason),
    });
  }, TIMEOUT);

  afterAll(async () => {
    await supervisor?.stop();
    stack?.cleanup();
  });

  const written = () => (existsSync(statusFile) ? JSON.parse(readFileSync(statusFile, "utf8")) as { pid: number; written: number } : null);

  it("launches the app with the restricted connection once the schema is current", async () => {
    expect(supervisor.readiness()).toMatchObject({ status: "serving", mode: "serving" });
    await waitFor(() => (written()?.written ?? 0) > 5, 20_000, "writer progress");
  }, TIMEOUT);

  it("takes an online snapshot whose receipt matches the archive exactly", async () => {
    const lease = await acquireLease(supervisor, stack);
    const snap = await sendCommand(supervisor, stack, { kind: "snapshot.create", lease });
    expect(snap.status).toBe(200);
    const details = snap.receipt.details.snapshot as { snapshotId: string; consistency: string; tableRowCounts: Record<string, number> };
    expect(details.consistency).toBe("online");
    expect(details.tableRowCounts["public.companies"]).toBeGreaterThan(0);
    // Restore is maintenance-only, so prove the counts against a staging restore via the restore verifier
    // on a maintenance restart below.
    await sendCommand(supervisor, stack, { kind: "lease.release", lease });

    const writerBefore = written()!.written;
    supervisor = await restart(stack, supervisor, { mode: "maintenance" });
    expect(supervisor.appRunning).toBe(false);
    const lease2 = await acquireLease(supervisor, stack);
    const restored = await sendCommand(supervisor, stack, { kind: "snapshot.restore", args: { snapshotId: details.snapshotId }, lease: lease2 });
    expect(restored.status).toBe(200);
    expect(await countCompanies(supervisor)).toBe(details.tableRowCounts["public.companies"]);
    expect(writerBefore).toBeGreaterThanOrEqual(details.tableRowCounts["public.companies"]!);
    await sendCommand(supervisor, stack, { kind: "lease.release", lease: lease2 });
    supervisor = await restart(stack, supervisor, { mode: "serving" }, {
      appCommand: [process.execPath, path.join(fixtures, "writer-app.mjs")],
      env: { WRITER_STATUS_FILE: statusFile, PATH: process.env.PATH, HOME: process.env.HOME },
      onFatal: (_code: number, reason: string) => fatal.push(reason),
    });
  }, TIMEOUT);

  it("stops app writers, recovers PostgreSQL after a crash, and relaunches the app", async () => {
    await waitFor(() => written()?.pid === supervisor.appPid(), 20_000, "writer status");
    const appPid = supervisor.appPid()!;
    const committedBefore = await countCompanies(supervisor);
    const enginePid = supervisor.enginePid()!;
    const systemIdentifier = supervisor.readiness().systemIdentifier;
    process.kill(enginePid, "SIGKILL");
    await waitFor(() => supervisor.enginePid() !== enginePid && supervisor.appRunning && supervisor.appPid() !== appPid, 60_000, "engine recovery");
    expect(() => process.kill(appPid, 0)).toThrow();
    expect(supervisor.readiness()).toMatchObject({ status: "serving", systemIdentifier });
    await waitFor(() => (written()?.pid === supervisor.appPid() && written()!.written > 3), 20_000, "relaunched writer progress");
    expect(await countCompanies(supervisor)).toBeGreaterThan(committedBefore);
    expect(fatal).toEqual([]);
  }, TIMEOUT);
});

describeEngine("managed embedded database: interrupts", () => {
  if (!support.supported) return;
  let stack: TestStack;
  let child: ChildProcess | null = null;

  beforeAll(async () => {
    stack = await createTestStack();
    const init = await buildSupervisor(stack, support);
    await init.start();
    const systemIdentifier = init.readiness().systemIdentifier!;
    await init.stop();
    stack.config = establishedConfig(stack.config, systemIdentifier);
  }, TIMEOUT);

  afterEach(() => {
    if (child?.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
    }
    child = null;
  });

  afterAll(() => stack?.cleanup());

  async function startRunner(): Promise<{ enginePid: number }> {
    child = spawn(path.join(serverRoot, "node_modules", ".bin", "tsx"), [path.join(fixtures, "run-supervisor.ts")], {
      cwd: serverRoot,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, MDB_RUNNER_OPTIONS: JSON.stringify({ config: stack.config, controlKey: stack.controlKey.toString("base64"), pgPort: stack.pgPort }) },
    });
    let output = "";
    child.stdout!.on("data", (chunk) => { output += String(chunk); });
    child.stderr!.on("data", (chunk) => { output += String(chunk); });
    const match = await waitFor(() => output.match(/READY (\d+)/), 120_000, `runner READY (${output})`);
    return { enginePid: Number(match[1]) };
  }

  function killContainer(): void {
    // Container interrupt: the supervisor and PostgreSQL die together.
    process.kill(-child!.pid!, "SIGKILL");
  }

  it("recovers committed data after the whole container is killed", async () => {
    const { enginePid } = await startRunner();
    const su = superuserSql(stack);
    const id = randomUUID();
    await su`insert into companies (id, name, issue_prefix) values (${id}, 'Committed before kill', 'KIL')`;
    await su.end();
    killContainer();
    await waitFor(() => { try { process.kill(enginePid, 0); return false; } catch { return true; } }, 10_000, "engine exit");
    expect(existsSync(path.join(managedDatabaseLayout(stack.config).dataDir, "postmaster.pid"))).toBe(true);

    if (!support.supported) throw new Error("unsupported");
    const supervisor = await buildSupervisor(stack, support);
    await supervisor.start();
    const app = appSql(supervisor);
    expect(await app`select name from companies where id = ${id}`).toEqual([{ name: "Committed before kill" }]);
    await app.end();
    await supervisor.stop();
  }, TIMEOUT);

  it("holds the stack for recovery when a migration is interrupted", async () => {
    if (!support.supported || !support.pgTools) return;
    // Make the newest migration pending, then block the migrator on its own
    // advisory lock (whatever the pending file contains) and kill mid-run.
    await startRunner();
    let su = superuserSql(stack);
    await su`delete from drizzle.__drizzle_migrations where id = (select max(id) from drizzle.__drizzle_migrations)`;
    await su.end();
    killContainer();
    await startRunner();
    const socket = managedDatabaseLayout(stack.config).controlSocket;
    const post = async (body: Record<string, unknown>) => {
      const response = await socketRequest(socket, "POST", MANAGED_DATABASE_HTTP.command, {
        "content-type": "application/json",
        [MANAGED_DATABASE_HTTP.signatureHeader]: signManagedDatabasePayload(stack.controlKey, "command", body),
      }, JSON.stringify(body));
      return JSON.parse(response.body.toString()) as ManagedDatabaseReceipt;
    };
    const leaseReceipt = await post(buildCommand(stack, { kind: "lease.acquire", args: { holder: "harness", ttlSeconds: 600 } }));
    const leaseRecord = leaseReceipt.details.lease as { id: string; epoch: number };
    const lease = { id: leaseRecord.id, epoch: leaseRecord.epoch };
    const snap = await post(buildCommand(stack, { kind: "snapshot.create", lease }));
    const snapshotId = (snap.details.snapshot as { snapshotId: string }).snapshotId;
    const statusReceipt = await post(buildCommand(stack, { kind: "status" }));
    const release = (statusReceipt.details.readiness as { release: unknown }).release;

    su = superuserSql(stack);
    const blocker = await su.reserve();
    await blocker.unsafe("select pg_advisory_lock(hashtextextended('paperclip:migrations', 0))");
    const migrate = post(buildCommand(stack, { kind: "schema.migrate", args: { snapshotId, release }, lease })).catch(() => null);
    const holdFile = managedDatabaseLayout(stack.config).holdFile;
    await waitFor(() => existsSync(holdFile), 30_000, "migration start");
    killContainer();
    await migrate;
    blocker.release();
    await su.end({ timeout: 1 }).catch(() => {});

    if (!support.supported) throw new Error("unsupported");
    const servingStack = { ...stack, config: { ...stack.config, mode: "serving" as const } };
    const serving = await buildSupervisor(servingStack, support, { appCommand: [process.execPath, "-e", "process.exit(9)"] });
    await serving.start();
    expect(serving.readiness()).toMatchObject({ status: "recovery", hold: { reason: "migration_interrupted" } });
    expect(serving.appRunning).toBe(false);
    await serving.stop();

    const maintenance = await buildSupervisor(stack, support);
    await maintenance.start();
    // The lease outlived the container; a different executor cannot take over...
    const intruder = await sendCommand(maintenance, stack, { kind: "lease.acquire", args: { holder: "other", ttlSeconds: 60 } });
    expect(intruder.receipt.code).toBe("lease_conflict");
    // ...while the original executor resumes with its lease and restores.
    const restored = await sendCommand(maintenance, stack, { kind: "snapshot.restore", args: { snapshotId }, lease });
    expect(restored.status).toBe(200);
    expect(maintenance.readiness().hold).toBeNull();
    await sendCommand(maintenance, stack, { kind: "lease.release", lease });
    await maintenance.stop();
  }, TIMEOUT);

  it("finishes or rolls back a restore swap interrupted between renames", async () => {
    if (!support.supported) return;
    const layout = managedDatabaseLayout(stack.config);
    const marker = randomUUID();
    let supervisor = await buildSupervisor(stack, support);
    await supervisor.start();
    // Crash state 1: verified staging database, first rename done, second not.
    let su = superuserSql(stack, "postgres");
    await su.unsafe("create database paperclip_restore_aaaa owner paperclip_owner template paperclip");
    await su.end();
    let tenant = superuserSql(stack, "paperclip_restore_aaaa");
    await tenant`insert into companies (id, name, issue_prefix) values (${marker}, 'From verified staging', 'STG')`;
    await tenant.end();
    su = superuserSql(stack, "postgres");
    await su.unsafe("alter database paperclip rename to paperclip_pre_restore_aaaa");
    await su.end();
    writeJsonAtomic(layout.restoreIntentFile, {
      v: 1, restoreId: "aaaa", snapshotId: "snap_x", commandId: "cmd_x",
      staging: "paperclip_restore_aaaa", retained: "paperclip_pre_restore_aaaa", phase: "verified",
    });
    // The restore was recovering a failed migration; finishing it clears that hold.
    writeJsonAtomic(layout.holdFile, { reason: "migration_failed", commandId: "cmd_migrate", detail: "boom", since: new Date().toISOString() });
    await supervisor.stop();

    supervisor = await buildSupervisor(stack, support);
    await supervisor.start();
    const app = appSql(supervisor);
    expect(await app`select name from companies where id = ${marker}`).toEqual([{ name: "From verified staging" }]);
    await app.end();
    expect(supervisor.readiness().hold).toBeNull();
    expect(existsSync(layout.restoreIntentFile)).toBe(false);

    // Crash state 2: restore interrupted before verification; previous database stays, stack is held.
    su = superuserSql(stack, "postgres");
    await su.unsafe("create database paperclip_restore_bbbb owner paperclip_owner template template0");
    await su.end();
    writeJsonAtomic(layout.restoreIntentFile, {
      v: 1, restoreId: "bbbb", snapshotId: "snap_y", commandId: "cmd_y",
      staging: "paperclip_restore_bbbb", retained: "paperclip_pre_restore_bbbb", phase: "staging",
    });
    await supervisor.stop();
    supervisor = await buildSupervisor(stack, support);
    await supervisor.start();
    expect(supervisor.readiness().hold).toMatchObject({ reason: "restore_interrupted" });
    su = superuserSql(stack, "postgres");
    const names = (await su<{ datname: string }[]>`select datname from pg_database`).map((row) => row.datname);
    await su.end();
    expect(names).toContain("paperclip");
    expect(names).not.toContain("paperclip_restore_bbbb");
    tenant = superuserSql(stack);
    expect(await tenant`select name from companies where id = ${marker}`).toEqual([{ name: "From verified staging" }]);
    await tenant.end();
    await supervisor.stop();
  }, TIMEOUT);
});
