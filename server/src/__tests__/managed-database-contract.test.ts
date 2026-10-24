import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalJson,
  MANAGED_DATABASE_MAX_COMMAND_BYTES,
  managedDatabaseCommandSchema,
  managedDatabaseUploadPreamble,
  parseManagedDatabaseConfig,
  type ManagedDatabaseConfig,
  type ManagedDatabaseReadiness,
} from "@paperclipai/shared/managed-database";
import {
  parseManagedDatabaseControlKey,
  signManagedDatabasePayload,
  signManagedDatabaseReceipt,
  verifyManagedDatabaseReceipt,
  verifyManagedDatabaseSignature,
} from "@paperclipai/shared/managed-database-server";
import { resolveManagedEmbeddedAppDatabase } from "../managed-database/app-contract.js";
import { readUploadPreamble } from "../managed-database/control-server.js";
import { managedDatabaseLayout, writeJsonAtomic } from "../managed-database/layout.js";
import { lookupOsUser, resolveProductionIdentities } from "../managed-database/main.js";
import { runManagedDatabasePreflight, type InitializationMarker } from "../managed-database/preflight.js";
import { LeaseStore } from "../managed-database/state.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempVolume(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-mdb-unit-"));
  tempDirs.push(dir);
  return dir;
}

function config(volume: string, patch: Partial<ManagedDatabaseConfig> = {}): ManagedDatabaseConfig {
  return {
    v: 1,
    provider: "embedded",
    stackId: "stk_a",
    configGeneration: 3,
    engineMajor: 18,
    mode: "serving",
    volume: { id: "vol_a", mountPath: volume },
    cluster: { state: "initialize", initializationId: "init_a" },
    root: path.join(volume, ".managed-database"),
    ...patch,
  };
}

const mounted = (target: string) => (target === "/" ? 1 : 2);

describe("managed database config contract", () => {
  it("treats absent as absent and blank or malformed as invalid", () => {
    expect(parseManagedDatabaseConfig(undefined)).toEqual({ status: "absent" });
    expect(parseManagedDatabaseConfig("  ").status).toBe("invalid");
    expect(parseManagedDatabaseConfig("{not json").status).toBe("invalid");
    expect(parseManagedDatabaseConfig(JSON.stringify({ v: 1 })).status).toBe("invalid");
  });

  it("accepts a valid config and rejects a root outside the volume", () => {
    const valid = config("/paperclip");
    expect(parseManagedDatabaseConfig(JSON.stringify(valid))).toEqual({ status: "valid", config: valid });
    const outside = { ...valid, root: "/var/lib/paperclip-db" };
    expect(parseManagedDatabaseConfig(JSON.stringify(outside))).toMatchObject({ status: "invalid" });
    for (const root of ["/paperclip/../etc", "/paperclip//db", "/paperclip/db/", "/paperclip/./db"]) {
      expect(parseManagedDatabaseConfig(JSON.stringify({ ...valid, root }))).toMatchObject({ status: "invalid" });
    }
  });

  it("requires a system identifier for an existing cluster", () => {
    const missing = { ...config("/paperclip"), cluster: { state: "existing", initializationId: "init_a" } };
    expect(parseManagedDatabaseConfig(JSON.stringify(missing)).status).toBe("invalid");
  });

  it("encodes canonical JSON independent of key order", () => {
    expect(canonicalJson({ b: 1, a: [true, null, { d: "x", c: 2 }], u: undefined })).toBe('{"a":[true,null,{"c":2,"d":"x"}],"b":1}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it("requires a lease on mutating commands", () => {
    const base = { v: 1, stackId: "stk_a", configGeneration: 1, commandId: "cmd_1", issuedAt: new Date().toISOString() };
    expect(managedDatabaseCommandSchema.safeParse({ ...base, kind: "status", args: {} }).success).toBe(true);
    expect(managedDatabaseCommandSchema.safeParse({ ...base, kind: "snapshot.create", args: {} }).success).toBe(false);
    expect(managedDatabaseCommandSchema.safeParse({ ...base, kind: "snapshot.create", args: {}, lease: { id: "lease_1", epoch: 1 } }).success).toBe(true);
    expect(managedDatabaseCommandSchema.safeParse({ ...base, kind: "shell", args: { cmd: "id" } }).success).toBe(false);
  });

  it("binds a receipt lookup to a command id and request hash", () => {
    const base = { v: 1, stackId: "stk_a", configGeneration: 1, commandId: "cmd_2", issuedAt: new Date().toISOString(), kind: "receipt.get" };
    expect(managedDatabaseCommandSchema.safeParse({ ...base, args: { commandId: "cmd_1", requestSha256: "a".repeat(64) } }).success).toBe(true);
    expect(managedDatabaseCommandSchema.safeParse({ ...base, args: { commandId: "cmd_1" } }).success).toBe(false);
    expect(managedDatabaseCommandSchema.safeParse({ ...base, args: { commandId: "../x", requestSha256: "a".repeat(64) } }).success).toBe(false);
  });
});

describe("managed database archive upload framing", () => {
  async function collect(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  it("splits the command line from archive bytes across any chunking", async () => {
    // Larger than a default HTTP header block, like a receipt with many tables.
    const command = { kind: "snapshot.upload", padding: "t".repeat(40_000) };
    const archive = randomBytes(70_000);
    archive[0] = 0x0a; // archive bytes may contain newlines
    const body = Buffer.concat([Buffer.from(managedDatabaseUploadPreamble(command)), archive]);
    const chunks = [body.subarray(0, 7), body.subarray(7, 40_003), body.subarray(40_003, 40_100), body.subarray(40_100)];
    const parsed = await readUploadPreamble(Readable.from(chunks));
    expect(parsed.command).toEqual(command);
    expect((await collect(parsed.archive)).equals(archive)).toBe(true);
  });

  it("refuses a body without a bounded command line", async () => {
    await expect(readUploadPreamble(Readable.from([Buffer.from('{"kind":"snapshot.upload"}')]))).rejects.toThrow(/ended before/);
    const oversized = Buffer.alloc(MANAGED_DATABASE_MAX_COMMAND_BYTES + 2, 0x20);
    await expect(readUploadPreamble(Readable.from([oversized, Buffer.from("\n")]))).rejects.toThrow(/too large/);
    await expect(readUploadPreamble(Readable.from([Buffer.from("not json\n")]))).rejects.toThrow();
  });
});

describe("managed database signatures", () => {
  const key = randomBytes(32);

  it("parses only strong base64 control keys", () => {
    expect(parseManagedDatabaseControlKey(key.toString("base64")).equals(key)).toBe(true);
    expect(() => parseManagedDatabaseControlKey(undefined)).toThrow(/missing/);
    expect(() => parseManagedDatabaseControlKey(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
    expect(() => parseManagedDatabaseControlKey("not base64!")).toThrow(/base64/);
  });

  it("binds command signatures to key, purpose and body", () => {
    const body = { kind: "status", stackId: "stk_a" };
    const signature = signManagedDatabasePayload(key, "command", body);
    expect(verifyManagedDatabaseSignature(key, "command", { stackId: "stk_a", kind: "status" }, signature)).toBe(true);
    expect(verifyManagedDatabaseSignature(key, "receipt", body, signature)).toBe(false);
    expect(verifyManagedDatabaseSignature(randomBytes(32), "command", body, signature)).toBe(false);
    expect(verifyManagedDatabaseSignature(key, "command", { ...body, stackId: "stk_b" }, signature)).toBe(false);
    expect(verifyManagedDatabaseSignature(key, "command", body, undefined)).toBe(false);
  });

  it("verifies receipts and detects tampering", () => {
    const receipt = signManagedDatabaseReceipt(key, {
      v: 1, commandId: "cmd_1", kind: "snapshot.create", stackId: "stk_a", configGeneration: 1, lease: null,
      outcome: "succeeded", code: null, error: null, details: { a: 1 }, requestSha256: "0".repeat(64),
      startedAt: "2026-10-09T00:00:00.000Z", finishedAt: "2026-10-09T00:00:01.000Z",
    });
    expect(verifyManagedDatabaseReceipt(key, receipt)).not.toBeNull();
    expect(verifyManagedDatabaseReceipt(key, { ...receipt, stackId: "stk_b" })).toBeNull();
    expect(verifyManagedDatabaseReceipt(randomBytes(32), receipt)).toBeNull();
  });
});

describe("managed database preflight (fail closed before writes)", () => {
  function setup(patch: Partial<ManagedDatabaseConfig> = {}) {
    const volume = tempVolume();
    const cfg = config(volume, patch);
    const layout = managedDatabaseLayout(cfg);
    return { volume, cfg, layout };
  }

  function writeReadyCluster(layout: ReturnType<typeof managedDatabaseLayout>, cfg: ManagedDatabaseConfig, marker: Partial<InitializationMarker> = {}) {
    mkdirSync(layout.dataDir, { recursive: true });
    writeFileSync(path.join(layout.dataDir, "PG_VERSION"), "18\n");
    writeJsonAtomic(layout.volumeIdentityFile, { v: 1, stackId: cfg.stackId, volumeId: cfg.volume.id, createdAt: "x" });
    writeJsonAtomic(layout.markerFile, {
      v: 1, status: "ready", stackId: cfg.stackId, volumeId: cfg.volume.id, initializationId: cfg.cluster.initializationId,
      engineMajor: 18, systemIdentifier: "7400000000000000001", createdAt: "x", readyAt: "y", ...marker,
    } satisfies InitializationMarker);
  }

  const run = (cfg: ManagedDatabaseConfig, env: NodeJS.ProcessEnv = {}, engineMajor = 18, deviceOf = mounted) =>
    runManagedDatabasePreflight({ config: cfg, layout: managedDatabaseLayout(cfg), env, engineMajor, deviceOf });

  it("authorizes a first initialization on an empty volume", () => {
    const { cfg } = setup();
    expect(run(cfg)).toEqual({ action: "initialize" });
  });

  it("refuses conflicting external database settings", () => {
    const { cfg } = setup();
    expect(() => run(cfg, { DATABASE_URL: "postgres://neon/db" })).toThrow(/conflicting_external_database/);
    expect(() => run(cfg, { DATABASE_MIGRATION_URL: "postgres://neon/db" })).toThrow(/conflicting_external_database/);
  });

  it("refuses an unsupported engine major and an image/engine mismatch", () => {
    const { cfg } = setup({ engineMajor: 17 });
    expect(() => run(cfg)).toThrow(/unsupported_engine_major/);
    const { cfg: pinned } = setup();
    expect(() => run(pinned, {}, 19)).toThrow(/engine_mismatch/);
  });

  it("refuses a volume that is not mounted or does not match the platform id", () => {
    const { cfg } = setup();
    expect(() => run(cfg, {}, 18, () => 1)).toThrow(/volume_not_mounted/);
    const { cfg: withId } = setup({ volume: { id: "vol_a", mountPath: tempVolume(), idEnvVar: "RAILWAY_VOLUME_ID" } });
    const fixed = { ...withId, root: path.join(withId.volume.mountPath, ".managed-database") };
    expect(() => run(fixed, {})).toThrow(/volume_id_unavailable/);
    expect(() => run(fixed, { RAILWAY_VOLUME_ID: "vol_other" })).toThrow(/volume_mismatch/);
    expect(run(fixed, { RAILWAY_VOLUME_ID: "vol_a" })).toEqual({ action: "initialize" });
  });

  it("refuses an established stack whose cluster is missing", () => {
    const { cfg } = setup({ cluster: { state: "existing", initializationId: "init_a", systemIdentifier: "7400000000000000001" } });
    expect(() => run(cfg)).toThrow(/cluster_missing/);
  });

  it("refuses data without a marker even when initialization is authorized", () => {
    const { cfg, layout } = setup();
    mkdirSync(layout.dataDir, { recursive: true });
    writeFileSync(path.join(layout.dataDir, "PG_VERSION"), "18\n");
    expect(() => run(cfg)).toThrow(/unexpected_data/);
  });

  it("refuses another stack's volume", () => {
    const { cfg, layout } = setup();
    writeReadyCluster(layout, { ...cfg, stackId: "stk_other" });
    expect(() => run(cfg)).toThrow(/volume_mismatch/);
  });

  it("refuses a different initialization and a different cluster identity", () => {
    const { cfg, layout } = setup();
    writeReadyCluster(layout, cfg);
    expect(() => run({ ...cfg, cluster: { state: "initialize", initializationId: "init_other" } })).toThrow(/initialization_mismatch/);
    expect(() => run({ ...cfg, cluster: { state: "existing", initializationId: "init_a", systemIdentifier: "7400000000000000999" } })).toThrow(/system_identifier_mismatch/);
  });

  it("accepts the established cluster and refuses missing or mismatched PG_VERSION", () => {
    const { cfg, layout } = setup();
    writeReadyCluster(layout, cfg);
    const established = { ...cfg, cluster: { state: "existing" as const, initializationId: "init_a", systemIdentifier: "7400000000000000001" } };
    expect(run(established).action).toBe("existing");
    writeFileSync(path.join(layout.dataDir, "PG_VERSION"), "17\n");
    expect(() => run(established)).toThrow(/engine_mismatch/);
    rmSync(path.join(layout.dataDir, "PG_VERSION"));
    expect(() => run(established)).toThrow(/cluster_missing/);
  });

  it("resumes only an interrupted first initialization", () => {
    const { cfg, layout } = setup();
    writeReadyCluster(layout, cfg, { status: "initializing", systemIdentifier: null });
    expect(run(cfg).action).toBe("resume-initialize");
    expect(() => run({ ...cfg, cluster: { state: "existing", initializationId: "init_a", systemIdentifier: "7400000000000000001" } })).toThrow(/initialization_incomplete/);
  });

  it("refuses supervisor state that is a symlink or owned by another user", () => {
    const { cfg, layout } = setup();
    writeReadyCluster(layout, cfg);
    expect(() => runManagedDatabasePreflight({ config: cfg, layout, env: {}, engineMajor: 18, deviceOf: mounted, ownerUid: 4242 })).toThrow(/untrusted_path/);
    const elsewhere = tempVolume();
    rmSync(layout.markerFile);
    symlinkSync(path.join(elsewhere, "marker.json"), layout.markerFile);
    expect(() => run(cfg)).toThrow(/untrusted_path/);
  });

  // Rename permission comes from the parent: the image's volume root was
  // node:node 0755, so the app could move the root-only directory aside.
  it.skipIf(process.getuid?.() === 0)("refuses a root whose parent another user owns", () => {
    const { cfg, layout } = setup();
    const appUid = process.getuid!() + 1;
    expect(() => runManagedDatabasePreflight({ config: cfg, layout, env: {}, engineMajor: 18, deviceOf: mounted, ownerUid: appUid }))
      .toThrow(/untrusted_path.*can rename/);
  });

  it("refuses a root below a directory others can write without the sticky bit", () => {
    const { volume, cfg } = setup();
    chmodSync(volume, 0o775);
    expect(() => run(cfg)).toThrow(/untrusted_path.*writable by other users/);

    const nested = { ...cfg, root: path.join(volume, "system", ".managed-database") };
    chmodSync(volume, 0o755);
    mkdirSync(path.join(volume, "system"), { mode: 0o777 });
    chmodSync(path.join(volume, "system"), 0o777);
    expect(() => run(nested)).toThrow(/untrusted_path.*system is writable/);

    // A symbolic link is followed: its target's ancestors count too.
    const elsewhere = tempVolume();
    chmodSync(elsewhere, 0o777);
    rmSync(path.join(volume, "system"), { recursive: true });
    symlinkSync(elsewhere, path.join(volume, "system"));
    expect(() => run(nested)).toThrow(/untrusted_path/);
  });

  it("accepts a root below the sticky, group-writable volume root the entrypoint prepares", () => {
    const { volume, cfg } = setup();
    chmodSync(volume, 0o1775);
    expect(run(cfg)).toEqual({ action: "initialize" });
  });

  it("refuses a missing volume identity beside a marker", () => {
    const { cfg, layout } = setup();
    writeReadyCluster(layout, cfg);
    rmSync(layout.volumeIdentityFile);
    expect(() => run(cfg)).toThrow(/volume_identity_missing/);
  });
});

describe("managed database lease store", () => {
  it("fences stale holders with a persisted, monotonic epoch", () => {
    const volume = tempVolume();
    const layout = managedDatabaseLayout(config(volume));
    mkdirSync(layout.stateDir, { recursive: true });
    let now = 1_000_000;
    const store = new LeaseStore(layout, () => now);

    const first = store.acquire("harness-a", 60);
    if (!first.ok) throw new Error("expected grant");
    expect(store.acquire("harness-b", 60)).toMatchObject({ ok: false, code: "lease_conflict" });

    now += 61_000; // first lease expires
    expect(store.check(first.lease)).toEqual({ ok: false, code: "lease_stale" });
    const second = new LeaseStore(layout, () => now).acquire("harness-b", 60);
    if (!second.ok) throw new Error("expected grant");
    expect(second.lease.epoch).toBe(first.lease.epoch + 1);
    // A restarted store (supervisor restart) still rejects the superseded grant.
    expect(new LeaseStore(layout, () => now).check(first.lease)).toEqual({ ok: false, code: "lease_stale" });
    expect(new LeaseStore(layout, () => now).check(second.lease).ok).toBe(true);
  });
});

describe("managed embedded app contract", () => {
  function readinessFixture(patch: Partial<ManagedDatabaseReadiness> = {}): ManagedDatabaseReadiness {
    return {
      v: 1, stackId: "stk_a", configGeneration: 3, mode: "serving", status: "serving", volumeId: "vol_a",
      initializationId: "init_a", systemIdentifier: "1", engineVersion: "18.1", engineMajor: 18,
      release: { migrationsDigest: "a".repeat(64), latestMigration: "0001.sql", migrationCount: 1, version: "1", commit: null },
      schema: { state: "current", appliedCount: 1, latestApplied: "0001.sql" }, hold: null, appRunning: false,
      updatedAt: "x", ...patch,
    };
  }
  const env = (patch: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    PAPERCLIP_DATABASE_PROVIDER: "managed-embedded",
    DATABASE_URL: "postgres://paperclip_app:pw@127.0.0.1:54329/paperclip",
    PAPERCLIP_PLUGIN_MIGRATION_DATABASE_URL: "postgres://paperclip_plugin:pw@127.0.0.1:54329/paperclip",
    PAPERCLIP_MANAGED_DATABASE_READINESS_FILE: "/readiness.json",
    PAPERCLIP_MANAGED_DATABASE_CONTROL_SOCKET: "/control.sock",
    PAPERCLIP_MANAGED_DATABASE_STACK_ID: "stk_a",
    PAPERCLIP_MANAGED_DATABASE_CONFIG_GENERATION: "3",
    PAPERCLIP_MIGRATION_AUTO_APPLY: "false",
    ...patch,
  });
  const read = (readiness: ManagedDatabaseReadiness) => () => JSON.stringify(readiness);

  it("leaves non-managed deployments to the existing DATABASE_URL rules", () => {
    expect(resolveManagedEmbeddedAppDatabase({ DATABASE_URL: "postgres://neon/db" })).toBeNull();
    expect(resolveManagedEmbeddedAppDatabase({})).toBeNull();
  });

  it("refuses supervisor-only inputs reaching the app directly", () => {
    expect(() => resolveManagedEmbeddedAppDatabase({ PAPERCLIP_MANAGED_DATABASE: "{}" })).toThrow(/not started by the managed database supervisor/);
    expect(() => resolveManagedEmbeddedAppDatabase({ PAPERCLIP_MANAGED_DATABASE_CONTROL_KEY: "x" })).toThrow(/not started by the managed database supervisor/);
  });

  it("accepts a consistent supervisor launch", () => {
    const resolved = resolveManagedEmbeddedAppDatabase(env(), read(readinessFixture()));
    expect(resolved?.pluginMigrationUrl).toContain("paperclip_plugin");
  });

  it("refuses privileged, remote, or migrating configurations", () => {
    expect(() => resolveManagedEmbeddedAppDatabase(env({ DATABASE_URL: "postgres://paperclip_owner:pw@127.0.0.1:1/paperclip" }), read(readinessFixture()))).toThrow(/paperclip_app/);
    expect(() => resolveManagedEmbeddedAppDatabase(env({ DATABASE_URL: "postgres://paperclip_app:pw@db.example.com:1/paperclip" }), read(readinessFixture()))).toThrow(/loopback/);
    expect(() => resolveManagedEmbeddedAppDatabase(env({ DATABASE_MIGRATION_URL: "postgres://x" }), read(readinessFixture()))).toThrow(/DATABASE_MIGRATION_URL/);
    expect(() => resolveManagedEmbeddedAppDatabase(env({ PAPERCLIP_MIGRATION_AUTO_APPLY: "true" }), read(readinessFixture()))).toThrow(/AUTO_APPLY/);
    expect(() => resolveManagedEmbeddedAppDatabase(env({ PAPERCLIP_DATABASE_PROVIDER: "other" }))).toThrow(/unknown/);
  });

  it("refuses a readiness identity that is stale, not serving, or not current", () => {
    expect(() => resolveManagedEmbeddedAppDatabase(env(), read(readinessFixture({ configGeneration: 2 })))).toThrow(/identity/);
    expect(() => resolveManagedEmbeddedAppDatabase(env(), read(readinessFixture({ status: "maintenance" })))).toThrow(/maintenance/);
    expect(() => resolveManagedEmbeddedAppDatabase(env(), read(readinessFixture({ schema: { state: "pending", appliedCount: 0, latestApplied: null } })))).toThrow(/pending/);
    expect(() => resolveManagedEmbeddedAppDatabase(env(), () => { throw new Error("ENOENT"); })).toThrow(/unreadable/);
  });
});

describe("managed database production identities", () => {
  const passwd = "root:x:0:0::/root:/bin/sh\nnode:x:1000:1000::/home/node:/bin/sh\npaperclip-db:x:999:999::/nonexistent:/usr/sbin/nologin\n";

  it("parses /etc/passwd entries", () => {
    expect(lookupOsUser("paperclip-db", passwd)).toEqual({ uid: 999, gid: 999 });
    expect(() => lookupOsUser("missing", passwd)).toThrow(/does not exist/);
  });

  it("requires root so the database and app identities can be separated", () => {
    expect(() => resolveProductionIdentities({}, () => 1000)).toThrow(/must start as root/);
  });
});
