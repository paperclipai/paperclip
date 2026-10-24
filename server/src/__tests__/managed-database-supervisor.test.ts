import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import express from "express";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, pluginMigrations, plugins } from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  canonicalJson,
  MANAGED_DATABASE_HTTP,
  type ManagedDatabaseConfig,
  type ManagedDatabaseReceipt,
} from "@paperclipai/shared/managed-database";
import {
  sha256HexOf,
  signManagedDatabasePayload,
  verifyManagedDatabaseReceipt,
} from "@paperclipai/shared/managed-database-server";
import { derivePluginDatabaseNamespace, pluginDatabaseService } from "../services/plugin-database.js";
import { and, eq } from "drizzle-orm";
import {
  acquireLease,
  appSql,
  buildCommand,
  buildSupervisor,
  createTestStack,
  establishedConfig,
  getManagedDatabaseTestSupport,
  sendCommand,
  type TestStack,
} from "./helpers/managed-database.js";
import type { ManagedDatabaseSupervisor } from "../managed-database/supervisor.js";
import {
  closeServer,
  createControlServer,
  listenTcp,
  listenUnix,
  readUploadPreamble,
  type ControlServerLimits,
} from "../managed-database/control-server.js";
import { managedDatabaseRelay } from "../managed-database/relay.js";
import { managedDatabaseLayout } from "../managed-database/layout.js";

const support = await getManagedDatabaseTestSupport();
const describeEngine = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping managed database engine tests: ${support.reason}`);

const TIMEOUT = 180_000;

async function expectSqlError(sql: ReturnType<typeof postgres>, statement: string, pattern: RegExp) {
  await expect(sql.unsafe(statement)).rejects.toThrow(pattern);
}

describeEngine("managed embedded database: lifecycle and refusals", () => {
  if (!support.supported) return;
  let stack: TestStack;
  let supervisor: ManagedDatabaseSupervisor;
  let systemIdentifier: string;

  beforeAll(async () => {
    stack = await createTestStack();
    supervisor = await buildSupervisor(stack, support);
    await supervisor.start();
    systemIdentifier = supervisor.readiness().systemIdentifier!;
  }, TIMEOUT);

  afterAll(async () => {
    await supervisor?.stop();
    stack?.cleanup();
  });

  it("initializes explicitly, binds the marker to the stack, and reports readiness", () => {
    const readiness = supervisor.readiness();
    expect(readiness).toMatchObject({
      stackId: stack.config.stackId,
      status: "maintenance",
      engineMajor: 18,
      schema: { state: "current" },
      hold: null,
    });
    expect(systemIdentifier).toMatch(/^\d+$/);
    const layout = managedDatabaseLayout(stack.config);
    const marker = JSON.parse(readFileSync(layout.markerFile, "utf8"));
    expect(marker).toMatchObject({ status: "ready", stackId: stack.config.stackId, volumeId: stack.config.volume.id, systemIdentifier });
    expect(JSON.parse(readFileSync(layout.volumeIdentityFile, "utf8"))).toMatchObject({ stackId: stack.config.stackId });
    expect(statSync(layout.dataDir).mode & 0o777).toBe(0o700);
    expect(statSync(layout.secretsDir).mode & 0o777).toBe(0o700);
    expect(statSync(layout.root).mode & 0o777).toBe(0o711);
    expect(JSON.parse(readFileSync(layout.readinessFile, "utf8")).systemIdentifier).toBe(systemIdentifier);
  });

  it("persists data across a restart on the established config", async () => {
    const companyId = randomUUID();
    const app = appSql(supervisor);
    await app`insert into companies (id, name, issue_prefix) values (${companyId}, 'Persisted Co', 'PER')`;
    await app.end();
    await supervisor.stop();

    stack.config = establishedConfig(stack.config, systemIdentifier);
    supervisor = await buildSupervisor(stack, support);
    await supervisor.start();
    expect(supervisor.readiness()).toMatchObject({ systemIdentifier, configGeneration: 2, schema: { state: "current" } });
    const again = appSql(supervisor);
    const rows = await again`select name from companies where id = ${companyId}`;
    await again.end();
    expect(rows).toEqual([{ name: "Persisted Co" }]);
  }, TIMEOUT);

  it("refuses another stack's config on this volume before touching the cluster", async () => {
    await supervisor.stop();
    const layout = managedDatabaseLayout(stack.config);
    const markerBefore = readFileSync(layout.markerFile, "utf8");
    const intruder = await buildSupervisor({ ...stack, config: { ...stack.config, stackId: "stk_intruder" } }, support);
    await expect(intruder.start()).rejects.toThrow(/volume_mismatch/);
    const wrongCluster = await buildSupervisor({
      ...stack,
      config: { ...stack.config, cluster: { state: "existing", initializationId: stack.config.cluster.initializationId, systemIdentifier: "1" } },
    }, support);
    await expect(wrongCluster.start()).rejects.toThrow(/system_identifier_mismatch/);
    expect(readFileSync(layout.markerFile, "utf8")).toBe(markerBefore);
    expect(existsSync(path.join(layout.dataDir, "postmaster.pid"))).toBe(false);
  }, TIMEOUT);

  it("refuses an engine mismatch before PostgreSQL starts", async () => {
    const layout = managedDatabaseLayout(stack.config);
    const wrongImage = await buildSupervisor(stack, { ...support, engine: { ...support.engine, major: 17, version: "17.6" } });
    await expect(wrongImage.start()).rejects.toThrow(/engine_mismatch/);
    writeFileSync(path.join(layout.dataDir, "PG_VERSION"), "17\n");
    try {
      const tampered = await buildSupervisor(stack, support);
      await expect(tampered.start()).rejects.toThrow(/engine_mismatch/);
      expect(existsSync(path.join(layout.dataDir, "postmaster.pid"))).toBe(false);
    } finally {
      writeFileSync(path.join(layout.dataDir, "PG_VERSION"), "18\n");
    }
  }, TIMEOUT);

  it("refuses to create an empty database when an established stack lost its data or volume", async () => {
    const layout = managedDatabaseLayout(stack.config);
    const unmounted = await buildSupervisor(stack, support, { deviceOf: () => 1 });
    await expect(unmounted.start()).rejects.toThrow(/volume_not_mounted/);

    // A fresh, empty volume attached in place of the real one.
    const blank = mkdtempSync(path.join(os.tmpdir(), "paperclip-mdb-blank-"));
    try {
      const swapped: ManagedDatabaseConfig = { ...stack.config, volume: { ...stack.config.volume, mountPath: blank }, root: path.join(blank, ".managed-database") };
      const onBlank = await buildSupervisor({ ...stack, config: swapped }, support);
      await expect(onBlank.start()).rejects.toThrow(/cluster_missing/);
      expect(existsSync(path.join(blank, ".managed-database", "data"))).toBe(false);
    } finally {
      rmSync(blank, { recursive: true, force: true });
    }

    const pgVersion = readFileSync(path.join(layout.dataDir, "PG_VERSION"), "utf8");
    rmSync(path.join(layout.dataDir, "PG_VERSION"));
    try {
      const lost = await buildSupervisor(stack, support);
      await expect(lost.start()).rejects.toThrow(/cluster_missing/);
    } finally {
      writeFileSync(path.join(layout.dataDir, "PG_VERSION"), pgVersion);
    }

    supervisor = await buildSupervisor(stack, support);
    await supervisor.start();
    expect(supervisor.readiness().systemIdentifier).toBe(systemIdentifier);
  }, TIMEOUT);
});

describeEngine("managed embedded database: runtime privilege isolation", () => {
  if (!support.supported) return;
  let stack: TestStack;
  let supervisor: ManagedDatabaseSupervisor;
  let app: ReturnType<typeof postgres>;
  let plugin: ReturnType<typeof postgres>;
  const packageRoots: string[] = [];

  beforeAll(async () => {
    stack = await createTestStack();
    supervisor = await buildSupervisor(stack, support);
    await supervisor.start();
    app = appSql(supervisor, "app");
    plugin = appSql(supervisor, "plugin");
  }, TIMEOUT);

  afterAll(async () => {
    await app?.end();
    await plugin?.end();
    await supervisor?.stop();
    stack?.cleanup();
    for (const root of packageRoots) rmSync(root, { recursive: true, force: true });
  });

  it("gives the app role DML only", async () => {
    const id = randomUUID();
    await app`insert into companies (id, name, issue_prefix) values (${id}, 'DML Co', 'DML')`;
    await app`update companies set name = 'DML Co 2' where id = ${id}`;
    expect(await app`select name from companies where id = ${id}`).toEqual([{ name: "DML Co 2" }]);
    await app`delete from companies where id = ${id}`;

    await expectSqlError(app, "create table public.evil (id int)", /permission denied/);
    await expectSqlError(app, "create schema evil", /permission denied/);
    await expectSqlError(app, "alter table companies add column evil int", /must be owner/);
    await expectSqlError(app, "drop table companies", /must be owner/);
    await expectSqlError(app, "truncate companies", /permission denied/);
    await expectSqlError(app, "create temp table t (id int)", /permission denied/);
    await expectSqlError(app, "create function public.f() returns int language sql as 'select 1'", /permission denied/);
    await expectSqlError(app, "insert into drizzle.__drizzle_migrations (hash, created_at) values ('x', 1)", /permission denied/);
    await expectSqlError(app, "select pg_read_file('PG_VERSION')", /permission denied/);
    await expectSqlError(app, "copy companies to '/tmp/paperclip-mdb-exfil.csv'", /permission denied|must be superuser|pg_write_server_files/);
    await expectSqlError(app, "set role paperclip_owner", /permission denied/);
    await expectSqlError(app, "alter role paperclip_app superuser", /permission denied/);
    expect((await app`select count(*)::int as n from drizzle.__drizzle_migrations`)[0]!.n).toBeGreaterThan(300);
  });

  it("rejects the app credential outside the tenant database and privileged roles over TCP", async () => {
    const env = supervisor.appEnvironment();
    const url = new URL(env.DATABASE_URL!);
    const other = postgres({ host: "127.0.0.1", port: Number(url.port), user: "paperclip_app", password: decodeURIComponent(url.password), database: "postgres", max: 1, connect_timeout: 5 });
    await expect(other`select 1`).rejects.toThrow(/pg_hba|rejects connection|no pg_hba/);
    await other.end();
    const owner = postgres({ host: "127.0.0.1", port: Number(url.port), user: "paperclip_owner", password: "guess", database: "paperclip", max: 1, connect_timeout: 5 });
    await expect(owner`select 1`).rejects.toThrow(/pg_hba|rejects connection|no pg_hba/);
    await owner.end();
    const superuser = postgres({ host: "127.0.0.1", port: Number(url.port), user: "paperclip_supervisor", password: "guess", database: "postgres", max: 1, connect_timeout: 5 });
    await expect(superuser`select 1`).rejects.toThrow(/pg_hba|rejects connection|no pg_hba/);
    await superuser.end();
  });

  it("keeps supervisor-only material out of the app environment", () => {
    const env = { ...supervisor.appEnvironment() };
    expect(env.PAPERCLIP_MANAGED_DATABASE).toBeUndefined();
    expect(env.PAPERCLIP_MANAGED_DATABASE_CONTROL_KEY).toBeUndefined();
    expect(env.DATABASE_MIGRATION_URL).toBeUndefined();
    expect(env.PAPERCLIP_MIGRATION_AUTO_APPLY).toBe("false");
    const secrets = readFileSync(managedDatabaseLayout(stack.config).secretsFile, "utf8");
    const { ownerPassword, supervisorPassword } = JSON.parse(secrets);
    expect(JSON.stringify(env)).not.toContain(ownerPassword);
    expect(JSON.stringify(env)).not.toContain(supervisorPassword);
  });

  it("lets the plugin role create only plugin_* namespaces", async () => {
    await plugin.unsafe("create schema plugin_isolation_check");
    await plugin.unsafe("create table plugin_isolation_check.rows (id int primary key)");
    await app.unsafe("insert into plugin_isolation_check.rows values (1)");
    expect(await app.unsafe("select id from plugin_isolation_check.rows")).toEqual([{ id: 1 }]);
    await expectSqlError(plugin, "create schema evil_plugin", /may only create plugin_\* schemas/);
    await expectSqlError(plugin, "create table public.evil (id int)", /permission denied/);
    await expectSqlError(plugin, "alter table companies add column evil int", /must be owner/);
    await expectSqlError(plugin, "drop event trigger paperclip_plugin_ddl_guard", /must be owner|permission denied/);
  });

  it("applies real plugin migrations through the production plugin database service", async () => {
    const manifest: PaperclipPluginManifestV1 = {
      id: "paperclipai.plugin-llm-wiki",
      apiVersion: 1,
      version: "0.1.0",
      displayName: "LLM Wiki",
      description: "Local-file LLM Wiki plugin.",
      author: "Paperclip",
      categories: ["automation", "ui"],
      capabilities: ["database.namespace.migrate", "database.namespace.read", "database.namespace.write"],
      entrypoints: { worker: "./dist/worker.js" },
      database: { namespaceSlug: "llm_wiki", migrationsDir: "migrations", coreReadTables: ["companies", "issues", "projects", "agents"] },
    };
    const repoRoot = path.basename(process.cwd()) === "server" ? path.resolve(process.cwd(), "..") : process.cwd();
    const packageRoot = path.join(repoRoot, "packages", "plugins", "plugin-llm-wiki");
    const env = supervisor.appEnvironment();
    const runtimeDb = createDb(env.DATABASE_URL!);
    const migrationDb = createDb(env.PAPERCLIP_PLUGIN_MIGRATION_DATABASE_URL!);
    try {
      const pluginId = randomUUID();
      await runtimeDb.insert(plugins).values({
        id: pluginId, pluginKey: manifest.id, packageName: manifest.id, version: manifest.version,
        apiVersion: manifest.apiVersion, categories: manifest.categories, manifestJson: manifest, status: "installed", installOrder: 1,
      });
      await pluginDatabaseService(migrationDb).applyMigrations(pluginId, manifest, packageRoot);
      const applied = await runtimeDb.select().from(pluginMigrations)
        .where(and(eq(pluginMigrations.pluginId, pluginId), eq(pluginMigrations.status, "applied")));
      expect(applied.length).toBeGreaterThan(0);

      // The runtime (app) role reads and writes the plugin's tables.
      const namespace = derivePluginDatabaseNamespace(manifest.id, manifest.database?.namespaceSlug);
      const tables = await app<{ table_name: string }[]>`select table_name from information_schema.tables where table_schema = ${namespace}`;
      expect(tables.length).toBeGreaterThan(0);
      await app.unsafe(`select count(*) from "${namespace}"."${tables[0]!.table_name}"`);
      // ...but cannot change its schema.
      await expectSqlError(app, `alter table "${namespace}"."${tables[0]!.table_name}" add column evil int`, /must be owner/);
    } finally {
      await runtimeDb.$client.end();
      await migrationDb.$client.end();
    }
  }, TIMEOUT);
});

describeEngine("managed embedded database: authenticated, lease-fenced commands", () => {
  if (!support.supported) return;
  let stack: TestStack;
  let supervisor: ManagedDatabaseSupervisor;
  let clock = Date.now();

  beforeAll(async () => {
    stack = await createTestStack();
    supervisor = await buildSupervisor(stack, support, { now: () => clock });
    await supervisor.start();
  }, TIMEOUT);

  afterAll(async () => {
    await supervisor?.stop();
    stack?.cleanup();
  });

  const issued = () => ({ issuedAt: new Date(clock).toISOString() });

  it("rejects unsigned, foreign, stale, and skewed commands", async () => {
    const body = buildCommand(stack, { kind: "status" }, issued());
    expect((await supervisor.handleCommand(body, undefined)).status).toBe(401);
    expect((await supervisor.handleCommand(body, signManagedDatabasePayload(Buffer.alloc(32, 7), "command", body))).status).toBe(401);
    const wrongStack = await sendCommand(supervisor, stack, { kind: "status" }, { ...issued(), stackId: "stk_other" });
    expect(wrongStack).toMatchObject({ status: 403, receipt: { outcome: "rejected", code: "wrong_stack" } });
    const stale = await sendCommand(supervisor, stack, { kind: "status" }, { ...issued(), configGeneration: 99 });
    expect(stale.receipt.code).toBe("stale_generation");
    const skewed = await sendCommand(supervisor, stack, { kind: "status" }, { issuedAt: new Date(clock - 10 * 60_000).toISOString() });
    expect(skewed.receipt.code).toBe("clock_skew");
    const shell = await sendCommand(supervisor, stack, { kind: "shell" as never, args: { cmd: "id" } }, issued());
    expect(shell.status).toBe(400);
  });

  it("refuses an unsigned upload without reading it, and survives the client disconnecting", async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on("uncaughtException", onUncaught);
    try {
      const request = new PassThrough();
      request.write("{}\n");
      const upload = await readUploadPreamble(request);
      const refused = await supervisor.handleArchiveUpload(upload.command, undefined, upload.archive);
      expect(refused).toMatchObject({ status: 401, closeConnection: true });
      // Never resumed: the HTTP layer drops the connection instead of draining.
      expect(upload.archive.readableFlowing).not.toBe(true);
      request.destroy(Object.assign(new Error("aborted"), { code: "ECONNRESET" }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
    expect((await sendCommand(supervisor, stack, { kind: "status" }, issued())).status).toBe(200);
  });

  it("returns a signed readiness identity", async () => {
    const { status, receipt } = await sendCommand(supervisor, stack, { kind: "status" }, issued());
    expect(status).toBe(200);
    expect(receipt.signature).toMatch(/^v1=/);
    expect(receipt.details).toMatchObject({ readiness: { stackId: stack.config.stackId, schema: { state: "current" } } });
  });

  it("requires maintenance mode for restore and migrate", async () => {
    const servingStack = { ...stack, config: { ...stack.config, mode: "serving" as const } };
    // Same volume and key, serving config; the gate runs before any lease or engine work.
    const serving = await buildSupervisor(servingStack, support, { now: () => clock });
    const restore = await sendCommand(serving, servingStack, { kind: "snapshot.restore", args: { snapshotId: "snap_x" }, lease: { id: "lease_x", epoch: 1 } }, issued());
    expect(restore.receipt.code).toBe("mode_forbidden");
    const body = buildCommand(servingStack, { kind: "schema.migrate", args: { snapshotId: "snap_x", release: supervisor.readiness().release }, lease: { id: "lease_x", epoch: 1 } }, issued());
    const migrate = await serving.handleCommand(body, signManagedDatabasePayload(stack.controlKey, "command", body));
    expect((migrate.body as { code: string }).code).toBe("mode_forbidden");
  });

  it("excludes a stale executor after its lease expires and another is granted", async () => {
    const first = await acquireLease(supervisor, stack, 30);
    const conflict = await sendCommand(supervisor, stack, { kind: "lease.acquire", args: { holder: "b", ttlSeconds: 30 } }, issued());
    expect(conflict.receipt.code).toBe("lease_conflict");

    clock += 31_000; // executor A stalls past its lease
    const second = await acquireLease(supervisor, stack, 600);
    expect(second.epoch).toBe(first.epoch + 1);

    const staleWrite = await sendCommand(supervisor, stack, { kind: "snapshot.restore", args: { snapshotId: "snap_any" }, lease: first }, issued());
    expect(staleWrite.receipt).toMatchObject({ outcome: "rejected", code: "lease_stale" });
    const staleMigrate = await sendCommand(supervisor, stack, { kind: "schema.migrate", args: { snapshotId: "snap_any", release: supervisor.readiness().release }, lease: first }, issued());
    expect(staleMigrate.receipt.code).toBe("lease_stale");
    const staleRenew = await sendCommand(supervisor, stack, { kind: "lease.renew", args: { ttlSeconds: 60 }, lease: first }, issued());
    expect(staleRenew.receipt.code).toBe("lease_stale");

    // The epoch survives a supervisor restart.
    await supervisor.stop();
    stack.config = establishedConfig(stack.config, supervisor.readiness().systemIdentifier!);
    supervisor = await buildSupervisor(stack, support, { now: () => clock });
    await supervisor.start();
    const afterRestart = await sendCommand(supervisor, stack, { kind: "snapshot.delete", args: { snapshotId: "snap_any" }, lease: first }, issued());
    expect(afterRestart.receipt.code).toBe("lease_stale");
    const released = await sendCommand(supervisor, stack, { kind: "lease.release", lease: second }, issued());
    expect(released.status).toBe(200);
  }, TIMEOUT);

  it("replays a commandId with its stored receipt and rejects reuse for another request", async () => {
    const lease = await acquireLease(supervisor, stack, 600);
    const body = buildCommand(stack, { kind: "lease.renew", args: { ttlSeconds: 120 }, lease }, issued());
    const signature = signManagedDatabasePayload(stack.controlKey, "command", body);
    const first = await supervisor.handleCommand(body, signature);
    const replay = await supervisor.handleCommand(body, signature);
    expect(replay.body).toEqual(first.body);
    const reused = { ...body, args: { ttlSeconds: 300 } };
    const conflict = await supervisor.handleCommand(reused, signManagedDatabasePayload(stack.controlKey, "command", reused));
    expect((conflict.body as { code: string }).code).toBe("command_id_conflict");
    await sendCommand(supervisor, stack, { kind: "lease.release", lease }, issued());
  });
});

describeEngine("managed embedded database: receipt reconciliation after a lost response", () => {
  if (!support.supported) return;
  let stack: TestStack;
  let supervisor: ManagedDatabaseSupervisor;
  let clock = Date.now();

  // The harness durably saved this command, sent it, and lost the response.
  let lost: ReturnType<typeof buildCommand>;
  let lostSignature: string;
  let lostReceipt: ManagedDatabaseReceipt;

  beforeAll(async () => {
    stack = await createTestStack();
    supervisor = await buildSupervisor(stack, support, { now: () => clock });
    await supervisor.start();
    lost = buildCommand(stack, { kind: "lease.acquire", args: { holder: "harness-a", ttlSeconds: 3600 } }, issued());
    lostSignature = signManagedDatabasePayload(stack.controlKey, "command", lost);
    const response = await supervisor.handleCommand(lost, lostSignature);
    expect(response.status).toBe(200);
    lostReceipt = response.body as ManagedDatabaseReceipt;
  }, TIMEOUT);

  afterAll(async () => {
    await supervisor?.stop();
    stack?.cleanup();
  });

  function issued() {
    return { issuedAt: new Date(clock).toISOString() };
  }

  async function currentLease() {
    const { receipt } = await sendCommand(supervisor, stack, { kind: "status" }, issued());
    return receipt.details.lease as { id: string; epoch: number } | null;
  }

  function lookup(commandId: string, requestSha256: string, overrides: Record<string, unknown> = {}) {
    return sendCommand(supervisor, stack, { kind: "receipt.get", args: { commandId, requestSha256 } }, { ...issued(), ...overrides });
  }

  const lostSha = () => sha256HexOf(canonicalJson(lost));
  const leaseOf = (receipt: ManagedDatabaseReceipt) => receipt.details.lease as { id: string; epoch: number };

  it("returns the stored receipt for an exact replay after the replay window, without executing again", async () => {
    clock += 6 * 60_000; // the harness restarted for longer than the window
    const replay = await supervisor.handleCommand(lost, lostSignature);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(lostReceipt);
    expect(verifyManagedDatabaseReceipt(stack.controlKey, replay.body)).not.toBeNull();
    expect(lostReceipt).toMatchObject({ requestSha256: lostSha(), configGeneration: 1, stackId: stack.config.stackId });
    expect(await currentLease()).toMatchObject(leaseOf(lostReceipt));

    // Re-signing the same id with a fresh timestamp is a different request.
    const refreshed = { ...lost, issuedAt: new Date(clock).toISOString() };
    const conflict = await supervisor.handleCommand(refreshed, signManagedDatabasePayload(stack.controlKey, "command", refreshed));
    expect(conflict.body).toMatchObject({ outcome: "rejected", code: "command_id_conflict" });

    // An old command that was never recorded still cannot act.
    // An id that shares the stored receipt's file name cannot act either.
    const colliding = { ...lost, commandId: lost.commandId.replace("cmd_", "cmd:"), issuedAt: new Date(clock).toISOString() };
    const collision = await supervisor.handleCommand(colliding, signManagedDatabasePayload(stack.controlKey, "command", colliding));
    expect(collision.body).toMatchObject({ outcome: "rejected", code: "command_id_conflict" });

    const unrecorded = { ...lost, commandId: `cmd_${randomUUID()}` };
    const stale = await supervisor.handleCommand(unrecorded, signManagedDatabasePayload(stack.controlKey, "command", unrecorded));
    expect(stale.body).toMatchObject({ outcome: "rejected", code: "clock_skew" });
    expect(await currentLease()).toMatchObject(leaseOf(lostReceipt));
  });

  it("looks up the receipt by id and request hash", async () => {
    const found = await lookup(lost.commandId, lostSha());
    expect(found.status).toBe(200);
    expect(found.receipt.details).toEqual({ state: "found", commandId: lost.commandId, receipt: lostReceipt, hold: null });

    // Lookups are read-only answers, never recorded under their own id.
    expect(existsSync(path.join(managedDatabaseLayout(stack.config).receiptsDir, `${found.receipt.commandId}.json`))).toBe(false);
  });

  it("answers unknown ids without authorizing anything", async () => {
    const unknownId = `cmd_${randomUUID()}`;
    const unknown = await lookup(unknownId, "0".repeat(64));
    expect(unknown.status).toBe(200);
    expect(unknown.receipt.details).toEqual({ state: "unknown", commandId: unknownId, receipt: null, hold: null });
    expect(await currentLease()).toMatchObject(leaseOf(lostReceipt));
  });

  it("binds a lookup to the original request, this stack, and a fresh timestamp", async () => {
    const mismatch = await lookup(lost.commandId, "f".repeat(64));
    expect(mismatch).toMatchObject({ status: 409, receipt: { outcome: "rejected", code: "command_id_conflict" } });

    const wrongStack = await lookup(lost.commandId, lostSha(), { stackId: "stk_other" });
    expect(wrongStack).toMatchObject({ status: 403, receipt: { outcome: "rejected", code: "wrong_stack" } });

    const foreignKey = buildCommand(stack, { kind: "receipt.get", args: { commandId: lost.commandId, requestSha256: lostSha() } }, issued());
    const forged = await supervisor.handleCommand(foreignKey, signManagedDatabasePayload(Buffer.alloc(32, 9), "command", foreignKey));
    expect(forged.status).toBe(401);
    expect(forged.body).not.toHaveProperty("details");

    const skewed = await lookup(lost.commandId, lostSha(), { issuedAt: new Date(clock - 10 * 60_000).toISOString() });
    expect(skewed.receipt.code).toBe("clock_skew");
  });

  it("recovers the outcome across a configuration generation change", async () => {
    await supervisor.stop();
    stack.config = establishedConfig(stack.config, supervisor.readiness().systemIdentifier!);
    supervisor = await buildSupervisor(stack, support, { now: () => clock });
    await supervisor.start();
    expect(stack.config.configGeneration).toBe(2);

    const replay = await supervisor.handleCommand(lost, lostSignature);
    expect(replay).toEqual({ status: 200, body: lostReceipt });

    const found = await lookup(lost.commandId, lostSha());
    expect(found.receipt).toMatchObject({ configGeneration: 2, details: { state: "found", receipt: { configGeneration: 1 } } });

    const previousGeneration = await lookup(lost.commandId, lostSha(), { configGeneration: 1 });
    expect(previousGeneration.receipt.code).toBe("stale_generation");

    // A fresh command for the old generation that was never recorded cannot act.
    const unrecorded = buildCommand(stack, { kind: "lease.acquire", args: { holder: "harness-b", ttlSeconds: 60 } }, { ...issued(), configGeneration: 1 });
    const stale = await supervisor.handleCommand(unrecorded, signManagedDatabasePayload(stack.controlKey, "command", unrecorded));
    expect(stale.body).toMatchObject({ outcome: "rejected", code: "stale_generation" });
    expect(await currentLease()).toMatchObject(leaseOf(lostReceipt));
  }, TIMEOUT);

  it("never returns a stored receipt that fails verification", async () => {
    const file = path.join(managedDatabaseLayout(stack.config).receiptsDir, `${lost.commandId}.json`);
    const original = readFileSync(file, "utf8");
    try {
      writeFileSync(file, JSON.stringify({ ...JSON.parse(original), outcome: "failed" }));
      const replay = await supervisor.handleCommand(lost, lostSignature);
      expect(replay.body).toMatchObject({ outcome: "rejected", code: "precondition_failed" });
      const found = await lookup(lost.commandId, lostSha());
      expect(found.receipt.code).toBe("precondition_failed");
    } finally {
      writeFileSync(file, original);
    }
    expect(await currentLease()).toMatchObject(leaseOf(lostReceipt));
  });
});

describeEngine("managed embedded database: unauthenticated upload limits", () => {
  if (!support.supported) return;
  let stack: TestStack;
  let supervisor: ManagedDatabaseSupervisor;
  const servers: Server[] = [];

  beforeAll(async () => {
    stack = await createTestStack();
    supervisor = await buildSupervisor(stack, support);
    await supervisor.start();
  }, TIMEOUT);

  afterAll(async () => {
    for (const server of servers) await closeServer(server);
    await supervisor?.stop();
    stack?.cleanup();
  });

  async function controlSocket(limits: ControlServerLimits = {}): Promise<string> {
    const server = createControlServer(supervisor, () => false, limits);
    servers.push(server);
    const socketPath = path.join(stack.volume, `control-${randomUUID().slice(0, 8)}.sock`);
    await listenUnix(server, socketPath);
    return socketPath;
  }

  type Outcome = { closed: boolean; sentBytes: number; response: string };

  /**
   * An unsigned PUT whose body never ends. `stream: false` sends only the
   * start of the body and then waits. Resolves when the server drops the
   * connection, or after 5 seconds if it never does.
   */
  function hostileUpload(connect: () => net.Socket, preamble: string, stream = true): Promise<Outcome> {
    return new Promise((resolve) => {
      const socket = connect();
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      let sentBytes = 0;
      let response = "";
      const writeChunk = (data: Buffer) => {
        socket.write(`${data.length.toString(16)}\r\n`);
        socket.write(data);
        socket.write("\r\n");
      };
      // Respect backpressure and stop once answered, so the client reads the
      // response instead of failing a write into a closed connection.
      const pump = setInterval(() => {
        if (!stream || !socket.writable || socket.writableLength > 0 || response !== "") return;
        writeChunk(chunk);
        sentBytes += chunk.length;
      }, 5);
      let gaveUp = false;
      const giveUp = setTimeout(() => {
        gaveUp = true;
        socket.destroy();
      }, 5_000);
      socket.on("error", () => {});
      socket.on("data", (data: Buffer) => { response += data.toString("latin1"); });
      socket.on("connect", () => {
        socket.write(`PUT ${MANAGED_DATABASE_HTTP.archive} HTTP/1.1\r\nhost: localhost\r\ncontent-type: application/octet-stream\r\ntransfer-encoding: chunked\r\n\r\n`);
        writeChunk(Buffer.from(preamble));
      });
      socket.on("close", () => {
        clearInterval(pump);
        clearTimeout(giveUp);
        resolve({ closed: !gaveUp, sentBytes, response });
      });
    });
  }

  // Closing a connection with unread inbound bytes resets it, so a caller
  // that keeps sending may not see the response. Flooding tests only require
  // that the connection is dropped; the response itself is checked with a
  // caller that stops after its command line.
  const droppedOrAnswered = (outcome: Outcome, status: number) =>
    outcome.response === "" || outcome.response.startsWith(`HTTP/1.1 ${status}`);

  it("answers an unsigned upload and closes the connection", async () => {
    const socketPath = await controlSocket();
    const outcome = await hostileUpload(() => net.connect({ path: socketPath }), "{}\n", false);
    expect(outcome.closed).toBe(true);
    expect(outcome.response).toMatch(/^HTTP\/1\.1 401/);
    expect(outcome.response.toLowerCase()).toContain("connection: close");
    expect(outcome.response).toContain('"code":"bad_signature"');
  });

  it("drops an unsigned upload after its command line instead of draining the body", async () => {
    const socketPath = await controlSocket();
    const outcome = await hostileUpload(() => net.connect({ path: socketPath }), "{}\n");
    expect(outcome.closed).toBe(true);
    expect(droppedOrAnswered(outcome, 401)).toBe(true);
  });

  it("drops an unsigned upload relayed through the serving app", async () => {
    const socketPath = await controlSocket();
    const app = express();
    app.use(MANAGED_DATABASE_HTTP.prefix, managedDatabaseRelay(socketPath));
    const appServer = createServer(app);
    servers.push(appServer);
    await listenTcp(appServer, 0, "127.0.0.1");
    const { port } = appServer.address() as net.AddressInfo;
    const answered = await hostileUpload(() => net.connect({ port, host: "127.0.0.1" }), "{}\n", false);
    expect(answered.closed).toBe(true);
    expect(answered.response).toMatch(/^HTTP\/1\.1 401/);
    const flooded = await hostileUpload(() => net.connect({ port, host: "127.0.0.1" }), "{}\n");
    expect(flooded.closed).toBe(true);
    expect(droppedOrAnswered(flooded, 401)).toBe(true);
  });

  it("drops an upload whose command line does not arrive in time", async () => {
    const socketPath = await controlSocket({ uploadPreambleTimeoutMs: 200 });
    const outcome = await hostileUpload(() => net.connect({ path: socketPath }), "{", false);
    expect(outcome.closed).toBe(true);
    expect(outcome.response).toBe("");
  });

  it("refuses more pending uploads than the limit", async () => {
    const socketPath = await controlSocket({ maxPendingUploads: 1, uploadPreambleTimeoutMs: 10_000 });
    const holder = net.connect({ path: socketPath });
    holder.on("error", () => {});
    await new Promise<void>((resolve) => holder.on("connect", () => resolve()));
    holder.write(`PUT ${MANAGED_DATABASE_HTTP.archive} HTTP/1.1\r\nhost: localhost\r\ntransfer-encoding: chunked\r\n\r\n1\r\n{\r\n`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      const outcome = await hostileUpload(() => net.connect({ path: socketPath }), "{}\n", false);
      expect(outcome.closed).toBe(true);
      expect(outcome.response).toMatch(/^HTTP\/1\.1 503/);
      expect(outcome.response).toContain('"code":"busy"');
    } finally {
      holder.destroy();
    }
  });
});
