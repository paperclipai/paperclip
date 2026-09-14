import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareEmbeddedPostgresNativeRuntime } from "@paperclipai/db";
import { deriveWorktreeInstanceId } from "../workspace-instance-cleanup.js";
import { captureManagedInstanceDataTarget, removeManagedInstanceData } from "./managed-instance-data-cleanup.js";

const exec = promisify(execFile), roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-managed-data-"))); roots.push(root);
  const project = path.join(root, "project"), workspacePath = path.join(root, "task"), home = path.join(root, "managed");
  await fs.mkdir(project); await exec("git", ["init", "-b", "main"], { cwd: project });
  await exec("git", ["config", "user.name", "Test"], { cwd: project }); await exec("git", ["config", "user.email", "test@example.test"], { cwd: project });
  await fs.writeFile(path.join(project, "source.txt"), "project source"); await exec("git", ["add", "."], { cwd: project }); await exec("git", ["commit", "-m", "Source"], { cwd: project });
  await exec("git", ["worktree", "add", "-b", "runtime/app", workspacePath], { cwd: project });
  const instanceId = deriveWorktreeInstanceId(workspacePath), instanceRoot = path.join(home, "instances", instanceId), dataDir = path.join(instanceRoot, "db");
  await fs.mkdir(dataDir, { recursive: true }); await fs.writeFile(path.join(instanceRoot, "app-data.json"), '{"saved":true}');
  const pointerDir = path.join(workspacePath, ".paperclip"), envPath = path.join(pointerDir, ".env"), configPath = path.join(pointerDir, "config.json");
  await fs.mkdir(pointerDir);
  const env = `PAPERCLIP_HOME=${JSON.stringify(home)}\nPAPERCLIP_INSTANCE_ID=${instanceId}\nPAPERCLIP_CONFIG=${JSON.stringify(configPath)}\nPAPERCLIP_SECRETS_MASTER_KEY=fixture-secret-never-in-receipt\n`;
  const config = { database: { mode: "embedded-postgres", embeddedPostgresDataDir: dataDir }, storage: { provider: "local_disk", localDisk: { baseDir: path.join(instanceRoot, "data", "storage") } },
    logging: { logDir: path.join(instanceRoot, "logs") }, secrets: { provider: "local_encrypted", localEncrypted: { keyFilePath: path.join(instanceRoot, "secrets", "master.key") } } };
  await fs.writeFile(envPath, env); await fs.writeFile(configPath, JSON.stringify(config));
  const row = { id: randomUUID(), companyId: randomUUID(), mode: "isolated_workspace", providerType: "git_worktree", cwd: workspacePath, providerRef: workspacePath,
    branchName: "runtime/app", metadata: { createdByRuntime: true, worktreeInstanceRoot: instanceRoot } };
  const capture = () => captureManagedInstanceDataTarget(row, { worktreesDir: home, protectedRoots: [project] });
  const remove = async (target?: Awaited<ReturnType<typeof capture>>, deletionId: string = randomUUID(), assertAuthorized = async () => {}) => removeManagedInstanceData({
    companyId: row.companyId, workspaceId: row.id, deletionId, target: (target ?? await capture())!, assertAuthorized,
  });
  return { root, project, workspacePath, home, instanceId, instanceRoot, dataDir, row, envPath, configPath, env, config, capture, remove };
}

describe("owned managed instance data cleanup primitive", () => {
  it("deletes only the captured instance data and leaves its checkout, configuration and Git history", async () => {
    const f = await fixture(), target = await f.capture(), deletionId = randomUUID();
    expect(target).toMatchObject({ companyId: f.row.companyId, workspaceId: f.row.id, instanceId: f.instanceId });
    expect(JSON.stringify(target)).not.toContain("fixture-secret-never-in-receipt");
    expect(await f.remove(target, deletionId)).toEqual({ state: "deleted", instanceId: f.instanceId });
    await expect(fs.stat(f.instanceRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(f.workspacePath, "source.txt"), "utf8")).toBe("project source");
    expect(await fs.readFile(f.envPath, "utf8")).toBe(f.env);
    expect((await exec("git", ["rev-parse", "runtime/app"], { cwd: f.project })).stdout).toBe((await exec("git", ["rev-parse", "main"], { cwd: f.project })).stdout);
    await expect(f.remove(target, deletionId)).resolves.toMatchObject({ state: "deleted" });
  });
  it("requires persisted ownership, an isolated Git workspace and the exact configured instance identity", async () => {
    const f = await fixture();
    for (const row of [{ ...f.row, metadata: {} }, { ...f.row, mode: "shared_workspace" }, { ...f.row, providerType: "local_fs" }, { ...f.row, metadata: { worktreeInstanceRoot: f.home } }]) {
      await expect(captureManagedInstanceDataTarget(row, { worktreesDir: f.home, protectedRoots: [f.project] })).rejects.toThrow(/ownership|configuration/);
    }
    await fs.writeFile(f.envPath, f.env.replace(f.instanceId, "sibling")); await expect(f.capture()).rejects.toThrow(/ownership|configuration/);
    expect(await fs.readFile(path.join(f.instanceRoot, "app-data.json"), "utf8")).toContain("saved");
  });
  it("refuses current-instance data and configured paths outside the owned instance", async () => {
    const f = await fixture();
    vi.stubEnv("PAPERCLIP_HOME", f.home); vi.stubEnv("PAPERCLIP_INSTANCE_ID", f.instanceId);
    await expect(f.capture()).rejects.toThrow(/ownership|configuration/); vi.unstubAllEnvs();
    for (const config of [
      { ...f.config, database: { mode: "external", connectionString: "postgres://not-a-real-server" } },
      { ...f.config, database: { ...f.config.database, embeddedPostgresDataDir: f.project } },
      { ...f.config, storage: { provider: "s3" } },
      { ...f.config, storage: { provider: "local_disk", localDisk: { baseDir: f.project } } },
      { ...f.config, logging: { logDir: f.project } },
      { ...f.config, secrets: { localEncrypted: { keyFilePath: path.join(f.project, "source.txt") } } },
    ]) { await fs.writeFile(f.configPath, JSON.stringify(config)); await expect(f.capture()).rejects.toThrow(/ownership|configuration/); }
    await fs.writeFile(f.configPath, JSON.stringify(f.config));
    for (const override of ["DATABASE_URL=postgres://not-a-real-server", `PAPERCLIP_STORAGE_LOCAL_DIR=${f.project}`, `PAPERCLIP_DB_BACKUP_DIR=${f.project}`]) {
      await fs.writeFile(f.envPath, `${f.env}${override}\n`); await expect(f.capture()).rejects.toThrow(/ownership|configuration/);
    }
  });
  it.each(["pointer", "config", "instances", "database", "storage"])("refuses a %s symlink instead of adopting its target", async (kind) => {
    const f = await fixture();
    const candidate = kind === "pointer" ? f.envPath : kind === "config" ? f.configPath : kind === "instances" ? path.dirname(f.instanceRoot) : kind === "database" ? f.dataDir : path.join(f.instanceRoot, "data");
    if (kind === "storage") { await fs.mkdir(candidate); }
    const relocated = `${candidate}-original`; await fs.rename(candidate, relocated); await fs.symlink(relocated, candidate);
    await expect(f.capture()).rejects.toThrow(); expect(await fs.lstat(candidate)).toBeDefined();
  });
  it("rechecks authorization and pointer/config identities before touching data", async () => {
    const f = await fixture(), target = await f.capture();
    await expect(f.remove(target, randomUUID(), async () => { throw new Error("Another task depends on this instance"); })).rejects.toThrow("Another task");
    for (const file of [f.envPath, f.configPath]) {
      const original = await fs.readFile(file, "utf8"); await fs.appendFile(file, "\n"); await expect(f.remove(target)).rejects.toThrow(/ownership|configuration/); await fs.writeFile(file, original);
    }
    expect(await fs.readFile(path.join(f.instanceRoot, "app-data.json"), "utf8")).toContain("saved");
    await expect(removeManagedInstanceData({ companyId: randomUUID(), workspaceId: f.row.id, deletionId: randomUUID(), target: target!, assertAuthorized: async () => {} })).rejects.toThrow();
    await expect(f.remove(target, "../../outside")).rejects.toThrow();
  });
  it("preserves replaced instance and database directories", async () => {
    const f = await fixture(), target = await f.capture();
    for (const directory of [f.instanceRoot, f.dataDir]) {
      const moved = `${directory}-original`; await fs.rename(directory, moved); await fs.mkdir(directory); await fs.writeFile(path.join(directory, "replacement"), "keep");
      await expect(f.remove(target)).rejects.toThrow(/ownership|configuration/); expect(await fs.readFile(path.join(directory, "replacement"), "utf8")).toBe("keep");
      await fs.rename(directory, `${directory}-replacement`); await fs.rename(moved, directory);
    }
    await f.remove(target);
  });
  it("resumes a quarantined instance after interruption and partial file removal", async () => {
    const f = await fixture(), target = await f.capture(), id = randomUUID();
    const quarantine = path.join(path.dirname(f.instanceRoot), ".paperclip-service-deletions", id, f.row.id);
    const rename = fs.rename.bind(fs); let interrupted = false;
    vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      await rename(source, destination);
      if (source === f.instanceRoot && !interrupted) { interrupted = true; throw new Error("Controller interrupted after rename"); }
    });
    await expect(f.remove(target, id)).rejects.toThrow("Controller interrupted"); vi.restoreAllMocks();
    expect(await fs.readFile(path.join(quarantine, "app-data.json"), "utf8")).toContain("saved");
    await fs.rm(path.join(quarantine, "db"), { recursive: true });
    await expect(f.remove(target, id)).resolves.toMatchObject({ state: "deleted" });
    await expect(fs.stat(quarantine)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("recovers the serialized receipt after its cleanup process is killed in quarantine", async () => {
    const f = await fixture(), target = await f.capture(), id = randomUUID();
    const quarantine = path.join(path.dirname(f.instanceRoot), ".paperclip-service-deletions", id, f.row.id);
    const root = fileURLToPath(new URL("../../../../", import.meta.url));
    const script = path.join(f.root, "cleanup.mjs");
    await fs.writeFile(script, `
      import fs from 'node:fs/promises';
      import { removeManagedInstanceData } from ${JSON.stringify(pathToFileURL(path.join(root, "server/src/services/runtime-services/managed-instance-data-cleanup.ts")).href)};
      const input = ${JSON.stringify({ companyId: f.row.companyId, workspaceId: f.row.id, deletionId: id, target })};
      const rename = fs.rename.bind(fs);
      fs.rename = async (source, destination) => {
        await rename(source, destination);
        if (source === input.target.filesystem.root.path) {
          process.send({ state: 'quarantined' });
          await new Promise(() => { setInterval(() => {}, 1000); });
        }
      };
      await removeManagedInstanceData({ ...input, assertAuthorized: async () => {} });
    `);
    const child = spawn(process.execPath, ["--import", path.join(root, "cli/node_modules/tsx/dist/loader.mjs"), script],
      { cwd: root, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = ""; child.stderr!.on("data", (data) => { stderr += data; });
    const exited = once(child, "exit");
    try {
      const message = await Promise.race([once(child, "message", { signal: AbortSignal.timeout(20_000) }),
        exited.then(() => { throw new Error(`Cleanup exited before quarantine: ${stderr}`); })]);
      expect(message[0]).toEqual({ state: "quarantined" });
      expect(await fs.readFile(path.join(quarantine, "app-data.json"), "utf8")).toContain("saved");
    } finally { child.kill("SIGKILL"); await exited; }
    expect(child.signalCode).toBe("SIGKILL");
    await expect(f.remove(JSON.parse(JSON.stringify(target)), id)).resolves.toMatchObject({ state: "deleted" });
    await expect(fs.stat(quarantine)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(f.instanceRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(f.envPath, "utf8")).toBe(f.env);
    expect(await fs.readFile(path.join(f.project, "source.txt"), "utf8")).toBe("project source");
  }, 30_000);
  it("does not signal a live unrelated process named in a database receipt", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.dataDir, "postmaster.pid"), `${process.pid}\n${f.dataDir}\n`);
    const target = await f.capture(); await expect(f.remove(target)).rejects.toThrow(/not the expected/);
    expect(process.kill(process.pid, 0)).toBe(true); expect(await fs.readFile(path.join(f.instanceRoot, "app-data.json"), "utf8")).toContain("saved");
  });
  it("accepts a stale process receipt only when that exact process is gone", async () => {
    const f = await fixture(), child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" }); await once(child, "exit");
    await fs.writeFile(path.join(f.dataDir, "postmaster.pid"), `${child.pid}\n${f.dataDir}\n`);
    await expect(f.remove()).resolves.toMatchObject({ state: "deleted" });
  });
  it("stops an actual owned PostgreSQL cluster before removing its instance data", async () => {
    const f = await fixture(); await prepareEmbeddedPostgresNativeRuntime();
    const reservation = net.createServer(); await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const port = (reservation.address() as net.AddressInfo).port; await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
    const logs: string[] = [], postgres = new EmbeddedPostgres({ databaseDir: f.dataDir, user: "paperclip", password: "paperclip", port, persistent: true,
      initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"], onLog: (message) => { logs.push(String(message)); }, onError: (message) => { logs.push(String(message)); } });
    try {
      await postgres.initialise(); await postgres.start();
      const client = postgres.getPgClient("postgres", "127.0.0.1"); await client.connect();
      try { await client.query("create table app_data (body text)"); await client.query("insert into app_data values ('reviewed application data')"); expect((await client.query("select body from app_data")).rows).toHaveLength(1); }
      finally { await client.end(); }
      const pid = Number((await fs.readFile(path.join(f.dataDir, "postmaster.pid"), "utf8")).split("\n")[0]);
      await expect(f.remove()).resolves.toMatchObject({ state: "deleted" });
      expect(() => process.kill(pid, 0)).toThrow();
      await expect(fs.stat(f.instanceRoot)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(path.join(f.project, "source.txt"), "utf8")).toBe("project source");
    } catch (error) { throw new Error(`${error instanceof Error ? error.message : error}\n${logs.slice(-15).join("\n")}`); }
    finally {
      // This dependency's stop() waits for a future exit event, even if its
      // child already exited. A failed assertion after cleanup must not hang.
      const child = (postgres as unknown as { process?: ChildProcess }).process;
      if (child && child.exitCode === null && child.signalCode === null) await postgres.stop();
    }
  }, 30_000);
});
