import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRuns, projects, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { environmentService } from "../environments.js";
import { resolveEnvironmentExecutionTarget } from "../environment-execution-target.js";
import { inspectNativeWorkspaceSyncHost, nativeWorkspaceSyncInternals, prepareNativeWorkspaceSync, readNativeWorkspaceSyncReference, restoreNativeWorkspaceSyncHost, resumeNativeWorkspaceSync } from "../native-runtime/native-workspace-sync.js";
import { inspectNativeHostWorkspaceReceipt } from "../native-runtime/native-host-workspace-receipt.js";

// Real archive commands and real controller persistence. The two directories
// model host/provider storage; this fixture does not rent a Daytona sandbox.
function filesystemRunner(): CommandManagedRuntimeRunner {
  return { execute: async (input) => new Promise((resolve, reject) => {
    const startedAt = new Date().toISOString();
    const child = spawn(input.command, input.args ?? [], { cwd: input.cwd, env: { ...process.env, ...input.env } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => { stderr += data.toString(); });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => resolve({ exitCode, signal, timedOut: false, stdout, stderr, startedAt, pid: child.pid ?? null }));
    child.stdin.on("error", reject);
    child.stdin.end(input.stdin);
  }) };
}

const exec = promisify(execFile);
async function git(cwd: string, args: string[]) {
  return (await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
    cwd, env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@localhost",
      GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@localhost" },
  })).stdout.trim();
}

describe("native retained-service file recovery", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const roots: string[] = [];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-native-service-recovery-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); });
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    vi.unstubAllEnvs();
  });

  async function fixture(gitKind?: "embedded" | "external") {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-native-service-files-"));
    roots.push(root);
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "native-service-recovery");
    const local = path.join(root, "host"), remote = path.join(root, "sandbox");
    await mkdir(local); await mkdir(remote);
    await writeFile(path.join(local, "app.txt"), "initial app");
    let sharedGit: string | null = null;
    if (gitKind) {
      await writeFile(path.join(local, ".gitignore"), "node_modules/\nignored.txt\n");
      await writeFile(path.join(local, "deleted.txt"), "tracked file removed before launch");
      await git(local, ["init", "-b", "app"]);
      await git(local, ["add", "."]); await git(local, ["commit", "-m", "Initial app"]);
      if (gitKind === "external") {
        sharedGit = path.join(root, "project");
        await fs.rename(local, sharedGit);
        await git(sharedGit, ["worktree", "add", "-b", "task", local]);
      }
      await fs.unlink(path.join(local, "deleted.txt"));
      await fs.symlink("app.txt", path.join(local, "app-link"));
      await fs.mkdir(path.join(local, "nested"));
      await fs.writeFile(path.join(local, "nested", "dirty.txt"), "uncommitted file");
      await fs.writeFile(path.join(local, "ignored.txt"), "host-only ignored file");
    }
    const companyId = randomUUID(), providerLeaseId = randomUUID(), allocationId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Native file recovery", issuePrefix: `F${companyId.slice(0, 6)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Developer" }).returning();
    const [project] = await db.insert(projects).values({ companyId, name: "App" }).returning();
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, projectId: project!.id, name: "App", mode: "adapter_managed", strategyType: "adapter_managed", cwd: local }).returning();
    const [environment] = await db.insert(environments).values({ name: `Daytona file fixture ${companyId}`, driver: "sandbox", config: { provider: "daytona" } }).returning();
    const envs = environmentService(db);
    const runner = filesystemRunner(), originalExecute = runner.execute;
    const execute = vi.spyOn(runner, "execute");
    const targetFor = async (leaseId: string) => {
      const lease = (await envs.getLeaseById(leaseId))!;
      const resolved = await resolveEnvironmentExecutionTarget({ db, companyId, adapterType: "paperclip_runner", environment: environment!, lease, leaseId, leaseMetadata: lease.metadata });
      if (resolved?.kind !== "remote" || resolved.transport !== "sandbox") throw new Error("Missing sandbox target");
      return { ...resolved, runner };
    };
    const nextRun = async (priorLeaseId?: string) => {
      const prior = priorLeaseId ? (await envs.getLeaseById(priorLeaseId))! : null;
      const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id, status: "running" }).returning();
      const [leaseRow] = await db.insert(environmentLeases).values({ companyId, environmentId: environment!.id,
        executionWorkspaceId: workspace!.id, heartbeatRunId: run!.id, provider: "daytona", providerLeaseId,
        metadata: { ...prior?.metadata, remoteCwd: remote, ...(prior ? { runtimeServiceAttachment: {
          version: 1, companyId, executionWorkspaceId: workspace!.id, allocationId, providerLeaseId, remoteCwd: remote,
        } } : {}) },
      }).returning();
      const lease = (await envs.getLeaseById(leaseRow!.id))!;
      const target = await targetFor(lease.id);
      const input = { db, companyId, runId: run!.id, workspaceId: workspace!.id, workspaceLocalDir: local, lease, target };
      const prepared = await prepareNativeWorkspaceSync(input);
      if (!prepared) throw new Error("Missing native synchronization");
      const { descriptor } = await nativeWorkspaceSyncInternals.readDescriptor({ runId: run!.id, reference: prepared.reference });
      expect(await inspectNativeHostWorkspaceReceipt(descriptor.hostWorkspace, local)).toBe("present");
      return { run: run!, lease, target, prepared, input };
    };
    const first = await nextRun();
    await writeFile(path.join(remote, "app.txt"), "first agent edit");
    await writeFile(path.join(remote, "database.json"), '{"visits":1}');
    await first.prepared.restoreWorkspace();
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, first.run.id));
    await writeFile(path.join(remote, "database.json"), '{"visits":2}');
    await mkdir(path.join(remote, "node_modules"));
    await writeFile(path.join(remote, "node_modules", "installed.txt"), "retained dependencies");
    const second = await nextRun(first.lease.id);
    expect(second.prepared.mode).toBe("adopt_remote");
    expect(await readFile(path.join(remote, "database.json"), "utf8")).toBe('{"visits":2}');
    execute.mockClear();
    const reference = async () => {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, second.run.id));
      return readNativeWorkspaceSyncReference(run?.runnerProfileJson?.nativeWorkspaceSync);
    };
    const recover = async (mode: string) => {
      const target = await targetFor(second.lease.id);
      if (mode === "finalization") return resumeNativeWorkspaceSync({ db, runId: second.run.id, target });
      const runtime = await prepareNativeWorkspaceSync({ ...second.input, target, sameRunRecovery: true });
      if (!runtime) throw new Error("Missing recovered synchronization");
      await runtime.restoreWorkspace();
      return true;
    };
    return { root, local, remote, sharedGit, envs, execute, originalExecute, targetFor, nextRun, second, reference, recover };
  }

  it.each(["plain", "embedded", "external"] as const)("rebuilds a missing %s launch mirror and reconciles edits from the same surviving allocation", async kind => {
    const gitKind = kind === "plain" ? undefined : kind;
    const f = await fixture(gitKind);
    const original = (await f.reference())!;
    const oldGit = gitKind ? await git(f.local, ["rev-parse", "--git-common-dir"]) : null;
    const projectHead = f.sharedGit ? await git(f.sharedGit, ["rev-parse", "HEAD"]) : null;
    await writeFile(path.join(f.remote, "app.txt"), "sandbox edit while controller was down");
    await writeFile(path.join(f.remote, "database.json"), '{"visits":17}');
    if (gitKind) {
      await git(f.remote, ["add", "app.txt"]); await git(f.remote, ["commit", "-m", "Remote commit"]);
      await writeFile(path.join(f.remote, "untracked.txt"), "remote uncommitted source");
    }
    await rm(f.local, { recursive: true });
    expect((await inspectNativeWorkspaceSyncHost({ runId: f.second.run.id, reference: original })).hostState).toBe("missing");
    const assertAuthorized = vi.fn(async () => {});
    const restored = await restoreNativeWorkspaceSyncHost({ runId: f.second.run.id, reference: original, assertAuthorized });
    expect(assertAuthorized).toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled(); // No remote source upload or reset.
    expect(restored.descriptorSha256).not.toBe(original.descriptorSha256);
    expect(await readFile(path.join(f.local, "app.txt"), "utf8")).toBe("first agent edit");
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.second.run.id));
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...run!.runnerProfileJson, nativeWorkspaceSync: restored } }).where(eq(heartbeatRuns.id, run!.id));
    expect((await inspectNativeWorkspaceSyncHost({ runId: run!.id, reference: restored })).hostState).toBe("present");
    if (gitKind) {
      expect(await git(f.local, ["rev-parse", "--git-common-dir"])).toBe(oldGit);
      expect(await fs.readlink(path.join(f.local, "app-link"))).toBe("app.txt");
      await expect(fs.access(path.join(f.local, "deleted.txt"))).rejects.toThrow();
      await expect(fs.access(path.join(f.local, "ignored.txt"))).rejects.toThrow();
    }
    await f.recover("run admission");
    expect(await readFile(path.join(f.local, "app.txt"), "utf8")).toBe("sandbox edit while controller was down");
    expect(await readFile(path.join(f.local, "database.json"), "utf8")).toBe('{"visits":17}');
    expect(await readFile(path.join(f.remote, "node_modules", "installed.txt"), "utf8")).toBe("retained dependencies");
    if (gitKind) {
      expect(await git(f.local, ["rev-parse", "HEAD"])).toBe(await git(f.remote, ["rev-parse", "HEAD"]));
      expect(await readFile(path.join(f.local, "untracked.txt"), "utf8")).toBe("remote uncommitted source");
      if (f.sharedGit) expect(await git(f.sharedGit, ["rev-parse", "HEAD"])).toBe(projectHead);
    }
    expect((await f.reference())?.state).toBe("finalized");
  });

  it.each(["resume", "operator_edit", "replaced_root", "controller_changed"] as const)("handles an interrupted mirror copy with %s without overwriting another working copy", async outcome => {
    const f = await fixture();
    const reference = (await f.reference())!;
    const canonicalLocal = await fs.realpath(f.local);
    await rm(f.local, { recursive: true });
    const originalLink = fs.link.bind(fs);
    const link = vi.spyOn(fs, "link").mockImplementation(async (source, target) => {
      if (target === path.join(canonicalLocal, "database.json")) throw new Error("fixture: controller lost during mirror publication");
      return originalLink(source, target);
    });
    const restore = (assertAuthorized = async () => {}) => restoreNativeWorkspaceSyncHost({ runId: f.second.run.id, reference, assertAuthorized });
    try { await expect(restore()).rejects.toThrow(/controller lost/); }
    finally { link.mockRestore(); }
    expect(await readFile(path.join(f.local, "app.txt"), "utf8")).toBe("first agent edit");
    if (outcome === "operator_edit") await writeFile(path.join(f.local, "app.txt"), "operator edit must stay");
    if (outcome === "replaced_root") {
      await fs.rename(f.local, f.local + "-held"); await mkdir(f.local);
      await writeFile(path.join(f.local, "app.txt"), "replacement must stay");
    }
    if (outcome === "resume") {
      expect((await inspectNativeWorkspaceSyncHost({ runId: f.second.run.id, reference })).hostState).toBe("recovering");
      const next = await restore();
      expect((await inspectNativeWorkspaceSyncHost({ runId: f.second.run.id, reference: next })).hostState).toBe("present");
      expect(await readFile(path.join(f.local, "database.json"), "utf8")).toBe('{"visits":1}');
    } else {
      await expect(restore(outcome === "controller_changed" ? async () => { throw new Error("controller changed"); } : undefined)).rejects.toThrow();
      expect(await readFile(path.join(f.local, "app.txt"), "utf8")).toBe(outcome === "operator_edit" ? "operator edit must stay"
        : outcome === "replaced_root" ? "replacement must stay" : "first agent edit");
    }
    expect(f.execute).not.toHaveBeenCalled();
    expect(await f.reference()).toEqual(reference);
  });

  it.each(["workspace", "git"] as const)("holds a missing mirror when the %s seed is corrupted", async seed => {
    const f = await fixture(seed === "git" ? "external" : undefined);
    const reference = (await f.reference())!;
    const paths = nativeWorkspaceSyncInternals.durableSeedPaths(f.second.run.id);
    await fs.appendFile(seed === "git" ? paths.gitArchivePath : paths.workspaceArchivePath, "corrupt");
    await rm(f.local, { recursive: true });
    await expect(restoreNativeWorkspaceSyncHost({ runId: f.second.run.id, reference, assertAuthorized: async () => {} })).rejects.toThrow(/unrecoverable/);
    await expect(fs.access(f.local)).rejects.toThrow();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it.each(["resume", "replaced_staging"] as const)("recovers SIGKILL during publication with %s and protects other directories during staging cleanup", async outcome => {
    const f = await fixture("external");
    const reference = (await f.reference())!;
    const canonical = await fs.realpath(f.local);
    await rm(f.local, { recursive: true });
    const child = spawn(process.execPath, ["--import", fileURLToPath(new URL("../../../../cli/node_modules/tsx/dist/loader.mjs", import.meta.url)),
      "--input-type=module", "-e", [
        "import fs from 'node:fs/promises';",
        "process.on('message', () => {});",
        "const { restoreNativeWorkspaceSyncHost } = await import(process.argv[1]);",
        "const input = JSON.parse(process.argv[2]); const originalLink = fs.link.bind(fs);",
        "fs.link = async (source, target) => { if (target === input.crashPath) { process.send({ type: 'paused' }); await new Promise(() => {}); } return originalLink(source, target); };",
        "await restoreNativeWorkspaceSyncHost({ runId: input.runId, reference: input.reference, assertAuthorized: async () => {} });",
      ].join("\n"),
      new URL("../native-runtime/native-workspace-sync.ts", import.meta.url).href,
      JSON.stringify({ runId: f.second.run.id, reference, crashPath: path.join(canonical, "database.json") })],
      { cwd: fileURLToPath(new URL("../../../../", import.meta.url)), env: { ...process.env }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let stderr = "";
    child.stderr!.on("data", data => { stderr += data.toString(); });
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Crash fixture did not reach publication: " + stderr)), 10_000);
        child.once("error", error => { clearTimeout(timeout); reject(error); });
        child.once("exit", () => { clearTimeout(timeout); reject(new Error("Crash fixture exited early: " + stderr)); });
        child.once("message", message => {
          clearTimeout(timeout);
          if ((message as { type?: string }).type === "paused") resolve(); else reject(new Error("Unexpected fixture message"));
        });
      });
      child.kill("SIGKILL"); await exited;
      expect(child.signalCode).toBe("SIGKILL");
      expect(await readFile(path.join(f.local, "app.txt"), "utf8")).toBe("first agent edit");
      const stages = (await fs.readdir(f.root)).filter(name => name.startsWith(".paperclip-mirror-"));
      expect(stages).toHaveLength(1);
      if (outcome === "replaced_staging") {
        const staged = path.join(f.root, stages[0]!);
        await fs.rename(staged, staged + "-original"); await fs.mkdir(staged);
        await fs.writeFile(path.join(staged, "unrelated.txt"), "Do not delete");
        await expect(restoreNativeWorkspaceSyncHost({ runId: f.second.run.id, reference, assertAuthorized: async () => {} })).rejects.toThrow();
        expect(await fs.readFile(path.join(staged, "unrelated.txt"), "utf8")).toBe("Do not delete");
        expect(await fs.readFile(path.join(f.local, "app.txt"), "utf8")).toBe("first agent edit");
        expect(f.execute).not.toHaveBeenCalled();
        return;
      }
      const restored = await restoreNativeWorkspaceSyncHost({ runId: f.second.run.id, reference, assertAuthorized: async () => {} });
      expect((await inspectNativeWorkspaceSyncHost({ runId: f.second.run.id, reference: restored })).hostState).toBe("present");
      expect((await fs.readdir(f.root)).filter(name => name.startsWith(".paperclip-mirror-"))).toHaveLength(0);
      expect(await readFile(path.join(f.local, "database.json"), "utf8")).toBe('{"visits":1}');
      expect(await git(f.local, ["rev-parse", "--git-common-dir"])).toBe(await fs.realpath(path.join(f.sharedGit!, ".git")));
      expect(f.execute).not.toHaveBeenCalled();
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; }
  });

  it("keeps a real HTTP service on the same process and URL while its host mirror is rebuilt", async () => {
    const f = await fixture();
    const reference = (await f.reference())!;
    const child = spawn(process.execPath, ["--input-type=module", "-e",
      "import http from 'node:http'; import fs from 'node:fs/promises'; const server = http.createServer(async (req, res) => { res.end(await fs.readFile('app.txt')); }); server.listen(0, '127.0.0.1', () => console.log('http://127.0.0.1:' + server.address().port));"],
      { cwd: f.remote, stdio: ["ignore", "pipe", "pipe"] });
    const exit = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", () => resolve()); });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("HTTP fixture did not start")), 5_000);
        child.once("error", error => { clearTimeout(timeout); reject(error); });
        child.stdout.once("data", data => { clearTimeout(timeout); resolve(data.toString().trim()); });
      });
      const pid = child.pid;
      expect(await (await fetch(url)).text()).toBe("first agent edit");
      await rm(f.local, { recursive: true });
      await writeFile(path.join(f.remote, "app.txt"), "the app is still running");
      expect(await (await fetch(url)).text()).toBe("the app is still running");
      const restored = await restoreNativeWorkspaceSyncHost({ runId: f.second.run.id, reference, assertAuthorized: async () => {} });
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.second.run.id));
      await db.update(heartbeatRuns).set({ runnerProfileJson: { ...run!.runnerProfileJson, nativeWorkspaceSync: restored } }).where(eq(heartbeatRuns.id, run!.id));
      expect(f.execute).not.toHaveBeenCalled();
      await f.recover("run admission");
      expect(await readFile(path.join(f.local, "app.txt"), "utf8")).toBe("the app is still running");
      expect(await (await fetch(url)).text()).toBe("the app is still running");
      expect(child.pid).toBe(pid); expect(child.exitCode).toBeNull(); expect(child.signalCode).toBeNull();
    } finally { child.kill("SIGTERM"); await exit; }
  });

  it.each(["finalization", "run admission"])("rejects host edits during %s recovery before any provider command", async (mode) => {
    const f = await fixture();
    await writeFile(path.join(f.local, "app.txt"), "operator edit during controller downtime");
    await writeFile(path.join(f.remote, "app.txt"), "remote app edit");
    await expect(f.recover(mode)).rejects.toThrow(/host working tree changed/);
    expect(f.execute).not.toHaveBeenCalled();
    expect((await f.reference())?.state).toBe("prepared");
    expect(await readFile(path.join(f.local, "app.txt"), "utf8")).toBe("operator edit during controller downtime");
    expect(await readFile(path.join(f.remote, "app.txt"), "utf8")).toBe("remote app edit");
  });

  it.each(["finalization", "run admission"])("requires the service receipt even with a valid native %s descriptor", async (mode) => {
    const f = await fixture();
    await f.envs.updateLeaseMetadata(f.second.lease.id, { ...f.second.lease.metadata, runtimeServiceWorkspaceSync: null });
    await expect(f.recover(mode)).rejects.toThrow(/no completed file-sync receipt/);
    expect(f.execute).not.toHaveBeenCalled();
    expect((await f.reference())?.state).toBe("prepared");
  });

  it.each(["finalization", "run admission"])("recovers through %s after file sync and starts another run from the new receipt", async (mode) => {
    const f = await fixture();
    let interrupted = false;
    f.execute.mockImplementation(async (input) => {
      if (!interrupted && input.args?.some((arg) => arg.includes("workspace-sync-v1.json.tmp"))) {
        interrupted = true;
        throw new Error("fixture: controller lost before finalization stamp");
      }
      return f.originalExecute(input);
    });
    await writeFile(path.join(f.remote, "app.txt"), "second agent edit");
    await expect(f.second.prepared.restoreWorkspace()).rejects.toThrow(/controller lost/);
    expect(interrupted).toBe(true);
    expect(await readFile(path.join(f.local, "app.txt"), "utf8")).toBe("second agent edit");
    expect((await f.reference())?.state).toBe("prepared");
    const target = await f.targetFor(f.second.lease.id);
    expect(target.retainedServiceWorkspace?.hostBaseline?.sha256).not.toBe(f.second.target.retainedServiceWorkspace?.hostBaseline?.sha256);
    expect(await f.recover(mode)).toBe(true);
    expect((await f.reference())?.state).toBe("finalized");
    // Finalization replay is idempotent and a later task run adopts the remote
    // data written after sync, rather than uploading the older host mirror.
    expect(await resumeNativeWorkspaceSync({ db, runId: f.second.run.id, target: await f.targetFor(f.second.lease.id) })).toBe(true);
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.second.run.id));
    await writeFile(path.join(f.remote, "database.json"), '{"visits":3}');
    const third = await f.nextRun(f.second.lease.id);
    expect(third.prepared.mode).toBe("adopt_remote");
    expect(await readFile(path.join(f.remote, "database.json"), "utf8")).toBe('{"visits":3}');
    expect(await readFile(path.join(f.remote, "node_modules", "installed.txt"), "utf8")).toBe("retained dependencies");
    await writeFile(path.join(f.remote, "app.txt"), "third agent edit");
    await third.prepared.restoreWorkspace();
    expect(await readFile(path.join(f.local, "app.txt"), "utf8")).toBe("third agent edit");
    expect(await readFile(path.join(f.local, "database.json"), "utf8")).toBe('{"visits":3}');
  });
});
