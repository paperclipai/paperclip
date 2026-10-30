import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, chownSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MANAGED_DATABASE_HTTP, type ManagedDatabaseConfig } from "@paperclipai/shared/managed-database";
import { signManagedDatabasePayload } from "@paperclipai/shared/managed-database-server";
import { buildCommand, freePort } from "./helpers/managed-database.js";
import { resolveEngineBinaries } from "../managed-database/engine.js";
import { lookupOsUser } from "../managed-database/main.js";

/**
 * Real OS-identity isolation for the managed embedded database. Opt-in: it
 * must run as root on Linux (it creates two system users and mounts tmpfs
 * volumes), from a checkout the unprivileged users can read:
 *
 *   sudo -E env PATH="$PATH" PAPERCLIP_MANAGED_DATABASE_OS_TESTS=1 \
 *     ./node_modules/.bin/vitest run src/__tests__/managed-database-os-isolation.test.ts
 */
const requested = process.env.PAPERCLIP_MANAGED_DATABASE_OS_TESTS === "1" && process.platform === "linux" && process.getuid?.() === 0;
// The generic embedded-postgres probe refuses root, so check the engine directly.
const engineAvailable = requested ? await resolveEngineBinaries().then(() => true, () => false) : false;
const enabled = requested && engineAvailable;
const describeOs = enabled ? describe : describe.skip;

const DB_USER = "pcmdb-db";
const APP_USER = "pcmdb-app";
const TIMEOUT = 240_000;
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const probe = path.join(serverRoot, "src", "__tests__", "fixtures", "managed-database", "os-probe-app.mjs");

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: "utf8", env: { ...process.env, PATH: `${process.env.PATH}:/usr/sbin:/sbin` } });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr ?? result.error}`);
  return result.stdout;
}

function ensureUser(name: string) {
  if (spawnSync("id", ["-u", name]).status === 0) return;
  // Test-only system accounts; production images create `paperclip-db` at build time.
  run("useradd", ["--system", "--no-create-home", "--home-dir", "/nonexistent", "--shell", "/usr/sbin/nologin", name]);
}

describeOs("managed embedded database: OS identity isolation (root)", () => {
  const controlKey = randomBytes(32);
  let mountPath: string;
  let resultsDir: string;
  let config: ManagedDatabaseConfig;
  let pgPort: number;
  let httpPort: number;
  let supervisor: ChildProcess | null = null;
  let output = "";

  beforeAll(async () => {
    ensureUser(DB_USER);
    ensureUser(APP_USER);
    for (const user of [DB_USER, APP_USER]) {
      const readable = spawnSync("runuser", ["-u", user, "--", "test", "-r", probe]).status === 0;
      if (!readable) throw new Error(`${user} cannot read ${probe}; run from a checkout readable by unprivileged users`);
    }
    mountPath = mkdtempSync(path.join(os.tmpdir(), "paperclip-mdb-os-vol-"));
    run("mount", ["-t", "tmpfs", "-o", "size=1g,mode=0755", "tmpfs", mountPath]);
    protectVolumeRoot();
    resultsDir = mkdtempSync(path.join(os.tmpdir(), "paperclip-mdb-os-results-"));
    chmodSync(resultsDir, 0o777);
    pgPort = await freePort();
    httpPort = await freePort();
    config = {
      v: 1,
      provider: "embedded",
      stackId: `stk_os_${randomBytes(3).toString("hex")}`,
      configGeneration: 1,
      engineMajor: 18,
      mode: "maintenance",
      volume: { id: "vol_os", mountPath, idEnvVar: "TEST_VOLUME_ID" },
      cluster: { state: "initialize", initializationId: "init_os" },
      root: path.join(mountPath, ".managed-database"),
    };
  }, TIMEOUT);

  afterAll(() => {
    if (supervisor?.exitCode === null) supervisor.kill("SIGKILL");
    if (mountPath) {
      spawnSync("umount", [mountPath]);
      rmSync(mountPath, { recursive: true, force: true });
    }
    if (resultsDir) rmSync(resultsDir, { recursive: true, force: true });
  });

  function startSupervisor(appCommand: string[] = []): ChildProcess {
    output = "";
    const child = spawn(path.join(serverRoot, "node_modules", ".bin", "tsx"), [
      path.join(serverRoot, "src", "managed-database", "main.ts"), "run", "--", ...appCommand,
    ], {
      cwd: serverRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: "/nonexistent",
        PAPERCLIP_MANAGED_DATABASE: JSON.stringify(config),
        PAPERCLIP_MANAGED_DATABASE_CONTROL_KEY: controlKey.toString("base64"),
        PAPERCLIP_MANAGED_DATABASE_DB_USER: DB_USER,
        PAPERCLIP_MANAGED_DATABASE_APP_USER: APP_USER,
        PAPERCLIP_MANAGED_DATABASE_PG_PORT: String(pgPort),
        PORT: String(httpPort),
        HOST: "127.0.0.1",
        TEST_VOLUME_ID: "vol_os",
        PROBE_MANAGED_ROOT: config.root,
        PROBE_RESULT_FILE: path.join(resultsDir, "probe.json"),
      },
    });
    child.stdout!.on("data", (chunk) => { output += String(chunk); });
    child.stderr!.on("data", (chunk) => { output += String(chunk); });
    supervisor = child;
    return child;
  }

  async function exitOf(child: ChildProcess): Promise<number | null> {
    if (child.exitCode !== null) return child.exitCode;
    return await new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  }

  async function waitFor<T>(probeFn: () => Promise<T | null | false> | T | null | false, label: string, timeoutMs = 120_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await probeFn();
      if (value) return value as T;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  async function http(method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}) {
    try {
      const response = await fetch(`http://127.0.0.1:${httpPort}${urlPath}`, {
        method,
        headers: { "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, json: await response.json() as Record<string, unknown> };
    } catch {
      return null;
    }
  }

  /** The volume root as docker-entrypoint.sh leaves it: the app's home, sticky. */
  function protectVolumeRoot() {
    chownSync(mountPath, 0, lookupOsUser(APP_USER).gid);
    chmodSync(mountPath, 0o1775);
  }

  let systemIdentifier = "";

  it("refuses to start when the app owns the managed root's parent", async () => {
    // Rename permission comes from the parent, so the root-only modes below
    // it would not stop the app from moving the supervisor's directory.
    const app = lookupOsUser(APP_USER);
    chownSync(mountPath, app.uid, app.gid);
    chmodSync(mountPath, 0o755);
    try {
      const child = startSupervisor();
      expect(await exitOf(child)).toBe(1);
      expect(output).toMatch(/untrusted_path.*can rename/);
      expect(existsSync(config.root)).toBe(false);
    } finally {
      protectVolumeRoot();
    }
  }, TIMEOUT);

  it("initializes as root, runs PostgreSQL as the database user, and serves the maintenance surface", async () => {
    const child = startSupervisor();
    const health = await waitFor(() => http("GET", "/api/health"), "maintenance health");
    expect(health.json).toEqual({ status: "maintenance" });
    const body = buildCommand({ config }, { kind: "status" });
    const status = await http("POST", MANAGED_DATABASE_HTTP.command, body, {
      [MANAGED_DATABASE_HTTP.signatureHeader]: signManagedDatabasePayload(controlKey, "command", body),
    });
    expect(status?.status).toBe(200);
    systemIdentifier = ((status!.json.details as { readiness: { systemIdentifier: string } }).readiness).systemIdentifier;
    expect(systemIdentifier).toMatch(/^\d+$/);
    expect((await http("POST", MANAGED_DATABASE_HTTP.command, body))?.status).toBe(401);

    const db = lookupOsUser(DB_USER);
    const dataStat = statSync(path.join(config.root, "data"));
    expect({ uid: dataStat.uid, mode: dataStat.mode & 0o777 }).toEqual({ uid: db.uid, mode: 0o700 });
    expect(statSync(path.join(config.root, "secrets")).uid).toBe(0);
    const postgresOwners = run("ps", ["-o", "user=", "-C", "postgres"]).trim().split(/\s+/);
    expect(new Set(postgresOwners)).toEqual(new Set([DB_USER]));

    child.kill("SIGTERM");
    expect(await exitOf(child)).toBe(0);
    expect(existsSync(path.join(config.root, "data", "postmaster.pid"))).toBe(false);
  }, TIMEOUT);

  it("confines the tenant app to its restricted connection and public files", async () => {
    config = {
      ...config,
      configGeneration: 2,
      mode: "serving",
      cluster: { state: "existing", initializationId: "init_os", systemIdentifier },
    };
    const child = startSupervisor([process.execPath, probe]);
    const resultFile = path.join(resultsDir, "probe.json");
    await waitFor(() => existsSync(resultFile), "probe results");
    const results = JSON.parse(readFileSync(resultFile, "utf8"));
    console.info(`[managed-database evidence] OS isolation probe: ${JSON.stringify(results)}`);
    const app = lookupOsUser(APP_USER);
    expect(results.uid).toBe(app.uid);
    expect(results.groups).not.toContain(0);
    expect(results.env).toEqual({ hasConfig: false, hasControlKey: false, hasMigrationUrl: false, provider: "managed-embedded", autoApply: "false" });
    expect(results.files).toMatchObject({
      listRoot: "EACCES",
      listData: "EACCES",
      readPgVersion: "EACCES",
      readSecrets: "EACCES",
      readMarker: "EACCES",
      readVolumeIdentity: "EACCES",
      readLease: "EACCES",
      listReceipts: "EACCES",
      listSnapshots: "EACCES",
      readReadiness: "allowed",
      writeReadiness: "EACCES",
      renameManagedRoot: "EPERM",
      readSupervisorEnviron: "EACCES",
    });
    // The app still owns its home: it creates entries beside the root.
    expect(results.files.createInVolumeRoot).toBe("allowed");
    expect(results.sql.appSelect).toBe("allowed");
    expect(results.sql.appDdl).toBe("42501");
    expect(results.sql.appReadServerFile).toBe("42501");
    expect(results.sql.ownerOverSocket).toMatch(/EACCES/);
    expect(results.sql.ownerOverTcp).toBe("28000");
    child.kill("SIGTERM");
    expect(await exitOf(child)).toBe(0);
  }, TIMEOUT);

  it("fails closed when the volume is missing or replaced by a blank one", async () => {
    run("umount", [mountPath]);
    let child = startSupervisor();
    expect(await exitOf(child)).toBe(1);
    expect(output).toMatch(/volume_not_mounted/);

    run("mount", ["-t", "tmpfs", "-o", "size=64m,mode=0755", "tmpfs", mountPath]);
    child = startSupervisor();
    expect(await exitOf(child)).toBe(1);
    expect(output).toMatch(/cluster_missing/);
    expect(existsSync(path.join(config.root, "data"))).toBe(false);
  }, TIMEOUT);
});
