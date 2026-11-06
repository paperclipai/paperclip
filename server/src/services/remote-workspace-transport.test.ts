import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import {
  captureRemoteWorkspaceArchive,
  cleanupRemoteWorkspaceArchive,
  hasRemoteRecoveryAttachment,
  prepareRemoteRepository,
  prepareRemoteWorkspaceDirectory,
  remoteWorkspaceFailureCause,
  restoreRemoteWorkspaceDirectory,
  type RemoteWorkspaceTarget,
} from "./remote-workspace-transport.js";
import { classifyNativeWorkspaceFailure } from "./native-runtime/native-workspace-failure.js";
import { restoreRemoteWorkspaceArchive } from "./remote-workspace-snapshot-archive.js";
import { readWorkspaceInventory, readonlyWorkspaceInventoryScript } from "./remote-workspace-readonly-inventory.js";

const exec = promisify(execFile);

describe("remote workspace transport safety with real sandbox commands", () => {
  let scratch: string;
  let workspace: string;
  beforeEach(async () => {
    scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "remote-workspace-transport-")));
    workspace = path.join(scratch, "workspace");
    await fs.mkdir(workspace);
  });
  afterEach(async () => { await fs.rm(scratch, { recursive: true, force: true }); });

  it.each(["missing", "present", "foreign", "proof_symlink", "proof_hardlink", "directory_symlink"])(
    "checks existing recovery attachment provenance without changing files: %s", async state => {
    const operationId = randomUUID(), parent = path.join(workspace, ".paperclip-recovered");
    const directory = path.join(parent, operationId), provenance = JSON.stringify({ operationId, sourceRunId: randomUUID() });
    if (state !== "missing") {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, "user.txt"), "preserved user edit\n");
      await fs.writeFile(path.join(directory, "provenance.json"), state === "foreign" ? "foreign proof" : provenance);
    }
    if (state === "proof_symlink" || state === "proof_hardlink") {
      const proof = path.join(directory, "provenance.json"), outside = path.join(scratch, "outside-proof");
      await fs.rename(proof, outside);
      if (state === "proof_symlink") await fs.symlink(outside, proof); else await fs.link(outside, proof);
    }
    if (state === "directory_symlink") {
      const outside = path.join(scratch, "outside-attachment");
      await fs.rename(directory, outside); await fs.symlink(outside, directory);
    }
    const probe = hasRemoteRecoveryAttachment({ target: target().remote, remoteCwd: workspace, operationId, provenance });
    if (state === "missing" || state === "present") await expect(probe).resolves.toBe(state === "present");
    else await expect(probe).rejects.toThrow("remote_workspace_operation_failed");
    if (state !== "missing") expect(await fs.readFile(path.join(directory, "user.txt"), "utf8")).toBe("preserved user edit\n");
  });

  async function git(cwd: string, ...args: string[]) {
    return exec("git", ["-C", cwd, "-c", "user.name=Synthetic fixture", "-c", "user.email=fixture@example.invalid",
      "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
      env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    });
  }

  async function repository(options: { filter?: boolean; revisions?: boolean } = {}) {
    const root = path.join(scratch, "origin");
    await fs.mkdir(root);
    await git(root, "init", "--initial-branch=main");
    if (options.filter) await fs.writeFile(path.join(root, ".gitattributes"), "*.txt filter=synthetic-probe\n");
    await fs.writeFile(path.join(root, "source.txt"), "initial synthetic source\n");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "Initial synthetic source");
    if (options.revisions) {
      await fs.writeFile(path.join(root, "source.txt"), "later synthetic source\n");
      await git(root, "commit", "-am", "Later synthetic source");
    }
    return root;
  }

  function target(ambientEnv: Record<string, string> = {}, outputMode: "split" | "one-shot" = "split") {
    // Daytona one-shot execution returns the child streams together in stdout.
    // Run the real helper first, then apply that provider response contract.
    const streams = (stdout: string, stderr: string) => outputMode === "one-shot"
      ? { stdout: stdout + stderr, stderr: "" } : { stdout, stderr };
    const execute = vi.fn<CommandManagedRuntimeRunner["execute"]>(async input => {
      try {
        const result = await exec(input.command, input.args ?? [], {
          cwd: input.cwd ?? workspace, timeout: input.timeoutMs, maxBuffer: 4 * 1024 * 1024,
          // Carry only generated fixture values across this execution boundary.
          env: { PATH: process.env.PATH, ...ambientEnv, ...input.env },
        });
        return { ...streams(result.stdout, result.stderr), exitCode: 0, timedOut: false, signal: null,
          pid: process.pid, startedAt: new Date().toISOString() };
      } catch (error) {
        const failure = error as { code?: number; stdout?: string; stderr?: string; signal?: string };
        return { exitCode: typeof failure.code === "number" ? failure.code : 1,
          ...streams(failure.stdout ?? "", failure.stderr ?? ""), timedOut: false, signal: failure.signal ?? null,
          pid: process.pid, startedAt: new Date().toISOString() };
      }
    });
    const transfer: NonNullable<CommandManagedRuntimeRunner["syncOut"]> = async operations => {
      const results = [];
      for (const operation of operations) {
        let bytesTransferred = 0;
        for (const file of operation.files) {
          await fs.mkdir(path.dirname(file.targetPath), { recursive: true });
          await fs.cp(file.sourcePath, file.targetPath, { recursive: file.kind === "directory" });
          if (file.kind === "file") bytesTransferred += (await fs.stat(file.targetPath)).size;
        }
        results.push({ operationId: operation.operationId, filesTransferred: operation.files.length, bytesTransferred });
      }
      return { operations: results };
    };
    const runner: CommandManagedRuntimeRunner = { execute, syncOut: transfer, syncIn: transfer };
    return { remote: { kind: "remote", transport: "sandbox", remoteCwd: workspace, runner } as RemoteWorkspaceTarget, execute };
  }

  it("rejects a repository ancestor symlink before writing outside the workspace", async () => {
    const origin = await repository();
    const outside = path.join(scratch, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "sentinel"), "untouched\n");
    await fs.symlink(outside, path.join(workspace, "repos"));
    const { remote } = target();
    await expect(prepareRemoteRepository({ target: remote, remoteCwd: path.join(workspace, "repos", "clone"),
      repoUrl: origin, ref: "HEAD", resolveGitAuth: async () => null })).rejects.toThrow();
    expect(await fs.readdir(outside)).toEqual(["sentinel"]);
    expect(await fs.readFile(path.join(outside, "sentinel"), "utf8")).toBe("untouched\n");
  });

  it.each(["existing", "create"] as const)("selects the %s remote branch without confusing its tip with the base ref", async branchMode => {
    const origin = await repository();
    await git(origin, "checkout", "-b", "feature/diverged");
    await fs.writeFile(path.join(origin, "source.txt"), "existing feature work\n");
    await git(origin, "commit", "-am", "Existing feature work");
    const featureTip = (await git(origin, "rev-parse", "HEAD")).stdout.trim();
    await git(origin, "checkout", "main");
    await fs.writeFile(path.join(origin, "source.txt"), "new main work\n");
    await git(origin, "commit", "-am", "New main work");
    const mainTip = (await git(origin, "rev-parse", "HEAD")).stdout.trim();
    expect(featureTip).not.toBe(mainTip);
    const { remote } = target(), root = path.join(workspace, "selected-branch");
    await prepareRemoteWorkspaceDirectory({ target: remote, remoteCwd: root,
      preparationIdentity: createHash("sha256").update(`synthetic-${branchMode}-branch`).digest("hex"),
      source: { kind: "git", repoUrl: origin, ref: "main", branchName: "feature/diverged", branchMode },
      resolveGitAuth: async () => null });
    expect((await git(root, "rev-parse", "HEAD")).stdout.trim()).toBe(branchMode === "existing" ? featureTip : mainTip);
    expect((await git(root, "symbolic-ref", "--short", "HEAD")).stdout.trim()).toBe("feature/diverged");
    expect((await git(origin, "rev-parse", "refs/heads/feature/diverged")).stdout.trim()).toBe(featureTip);
  });

  it("rejects a missing existing remote branch without publishing a task folder", async () => {
    const origin = await repository(), { remote } = target(), root = path.join(workspace, "missing-branch");
    await expect(prepareRemoteWorkspaceDirectory({ target: remote, remoteCwd: root,
      preparationIdentity: createHash("sha256").update("synthetic-missing-existing-branch").digest("hex"),
      source: { kind: "git", repoUrl: origin, ref: "main", branchName: "feature/missing", branchMode: "existing" },
      resolveGitAuth: async () => null })).rejects.toThrow();
    expect(await fs.lstat(root).catch(() => null)).toBeNull();
  });

  it("adopts an atomic restored folder after a lost reply without overwriting later edits", async () => {
    await fs.writeFile(path.join(workspace, "saved.txt"), "saved synthetic files\n");
    const { remote, execute } = target();
    const captured = await captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId: randomUUID() });
    try {
      const root = path.join(scratch, "restored");
      const original = execute.getMockImplementation()!;
      let lost = false;
      execute.mockImplementation(async input => {
        const result = await original(input);
        if (!lost && input.args?.[0] === "-e" && input.args[1]?.includes("workspace-restored.json") && result.exitCode === 0) {
          lost = true; throw new Error("synthetic lost restore reply");
        }
        return result;
      });
      const input = { target: remote, remoteCwd: root, archivePath: captured.archivePath,
        manifestDigest: captured.manifestDigest, restorationIdentity: "a".repeat(64) };
      await expect(restoreRemoteWorkspaceDirectory(input)).rejects.toThrow("synthetic lost restore reply");
      await fs.writeFile(path.join(root, "newer.txt"), "retain later edits\n");
      const restored = await restoreRemoteWorkspaceDirectory(input);
      expect(restored.cleanupPending).toBe(true);
      await cleanupRemoteWorkspaceArchive({ target: remote, remoteCwd: restored.stagingRoot, operationId: restored.operationId });
      expect(await fs.readFile(path.join(root, "saved.txt"), "utf8")).toBe("saved synthetic files\n");
      expect(await fs.readFile(path.join(root, "newer.txt"), "utf8")).toBe("retain later edits\n");
      expect(await fs.readdir(path.join(scratch, ".paperclip-runtime", "workspace-snapshots"))).toEqual([]);
      await expect(restoreRemoteWorkspaceDirectory({ ...input, restorationIdentity: "b".repeat(64) })).rejects.toThrow();
      expect(await fs.readFile(path.join(root, "newer.txt"), "utf8")).toBe("retain later edits\n");
    } finally { await captured.cleanup(); }
  });

  it.each(["owned", "changed", "unrelated", "symlink", "interrupted"])("preserves only verified allocation files during a migrated restore: %s", async scenario => {
    await fs.writeFile(path.join(workspace, "saved.txt"), "retained user work");
    const { remote, execute } = target();
    const captured = await captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId: randomUUID() });
    try {
      const root = path.join(scratch, "allocated"), relativePath = ".paperclip-runtime/reusable-sandbox-lease.json";
      const bytes = JSON.stringify({ version: 1, token: "exact-allocation-token", provider: "daytona" });
      await fs.mkdir(path.join(root, ".paperclip-runtime"), { recursive: true });
      const sentinel = path.join(root, relativePath);
      await fs.writeFile(sentinel, bytes);
      const input = { target: remote, remoteCwd: root, archivePath: captured.archivePath, manifestDigest: captured.manifestDigest,
        restorationIdentity: "d".repeat(64), allowEmptyRoot: true,
        allocationFiles: [{ relativePath, sha256: createHash("sha256").update(bytes).digest("hex") }] };
      if (scenario === "changed") await fs.writeFile(sentinel, "foreign marker");
      if (scenario === "unrelated") await fs.writeFile(path.join(root, ".paperclip-runtime", "unrelated.txt"), "keep");
      if (scenario === "symlink") {
        const outside = path.join(scratch, "outside-marker"); await fs.writeFile(outside, bytes);
        await fs.unlink(sentinel); await fs.symlink(outside, sentinel);
      }
      if (["changed", "unrelated", "symlink"].includes(scenario)) {
        await expect(restoreRemoteWorkspaceDirectory(input)).rejects.toThrow();
        expect(await fs.readFile(sentinel, "utf8")).toBe(scenario === "changed" ? "foreign marker" : bytes);
        expect(await fs.lstat(path.join(root, "saved.txt")).catch(() => null)).toBeNull();
        return;
      }
      if (scenario === "interrupted") {
        const run = execute.getMockImplementation()!; let interrupt = true;
        execute.mockImplementation(async command => {
          if (interrupt && command.args?.[1]?.includes("remote_workspace_restore_failed")) {
            interrupt = false;
            return run({ ...command, args: command.args.map((arg, index) => index === 1
              ? arg.replace("try{await fs.rename(staged,root);}", "throw Error('interrupted');try{await fs.rename(staged,root);}") : arg) });
          }
          return run(command);
        });
        await expect(restoreRemoteWorkspaceDirectory(input)).rejects.toThrow();
        expect(await fs.readFile(path.join(root + ".allocation-" + input.restorationIdentity, relativePath), "utf8")).toBe(bytes);
      }
      await restoreRemoteWorkspaceDirectory(input);
      expect(await fs.readFile(sentinel, "utf8")).toBe(bytes);
      expect(await fs.readFile(path.join(root, "saved.txt"), "utf8")).toBe("retained user work");
      await fs.writeFile(path.join(root, "saved.txt"), "later user edits");
      await restoreRemoteWorkspaceDirectory(input);
      expect(await fs.readFile(path.join(root, "saved.txt"), "utf8")).toBe("later user edits");
    } finally { await captured.cleanup(); }
  });

  it.each(["once", "interrupted"] as const)("replaces a retired root that the sandbox's overlay cannot rename (%s)", async scenario => {
    await fs.writeFile(path.join(workspace, "saved.txt"), "newer saved work\n");
    const lower = path.join(scratch, "lower-layer.json"), preload = path.join(scratch, "overlay-lower-layer.cjs");
    await fs.writeFile(preload, `const fs=require('node:fs'),lower=new Set(JSON.parse(fs.readFileSync(${JSON.stringify(lower)},'utf8')));
const rename=fs.promises.rename;fs.promises.rename=async(from,to)=>{const s=await fs.promises.lstat(from).catch(()=>null);
if(s?.isDirectory()&&lower.has(String(s.ino)))throw Object.assign(new Error('EXDEV: cross-device link not permitted, rename'),{code:'EXDEV',errno:-18,syscall:'rename'});
return rename.call(fs.promises,from,to)};`);
    const { remote, execute } = target();
    const captured = await captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId: randomUUID() });
    try {
      const root = path.join(scratch, "retired"), runtime = path.join(root, ".paperclip-runtime");
      const session = path.join(runtime, "paperclip-runner", "sessions", "parent", "runner");
      await fs.mkdir(session, { recursive: true });
      await fs.writeFile(path.join(session, "runner-state.json"), "{\"lifecycle\":\"suspended\"}");
      await fs.writeFile(path.join(runtime, "workspace-ready.json"), JSON.stringify({ preparationIdentity: "f".repeat(64) }));
      await fs.mkdir(path.join(runtime, "workspace-snapshots", "old-export"), { recursive: true });
      await fs.writeFile(path.join(root, "stale.md"), "old\n");
      await fs.mkdir(path.join(root, "locked", "inner"), { recursive: true });
      await fs.writeFile(path.join(root, "locked", "inner", "file.txt"), "old\n");
      await fs.chmod(path.join(root, "locked", "inner"), 0o555); await fs.chmod(path.join(root, "locked"), 0o555);
      const directories: string[] = [];
      const walk = async (directory: string): Promise<void> => {
        directories.push(String((await fs.lstat(directory)).ino));
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) await walk(path.join(directory, entry.name));
      };
      await walk(root);
      await fs.writeFile(lower, JSON.stringify(directories));
      const input = { target: remote, remoteCwd: root, archivePath: captured.archivePath, manifestDigest: captured.manifestDigest,
        restorationIdentity: "9".repeat(64), replaceRetiredRoot: true };
      const run = execute.getMockImplementation()!; let interrupt = scenario === "interrupted";
      execute.mockImplementation(async command => {
        if (!command.args?.[1]?.includes("remote_workspace_restore_failed")) return run(command);
        const args = interrupt ? command.args.map((arg, index) => index === 1
          ? arg.replace("await fs.rename(path.join(staged,'.paperclip-runtime','workspace-restored.json')", "throw Error('interrupted');await fs.rename(path.join(staged,'.paperclip-runtime','workspace-restored.json')") : arg) : command.args;
        interrupt = false;
        return run({ ...command, args: ["--require", preload, ...args] });
      });
      if (scenario === "interrupted") {
        await expect(restoreRemoteWorkspaceDirectory(input)).rejects.toThrow(/stage=replace_in_place reason=interrupted$/);
        expect(JSON.parse(await fs.readFile(path.join(runtime, "workspace-ready.json"), "utf8"))).toEqual({ preparationIdentity: "f".repeat(64) });
        expect(await fs.lstat(path.join(runtime, "workspace-restored.json")).catch(() => null)).toBeNull();
      }
      await restoreRemoteWorkspaceDirectory(input);
      expect(await fs.readFile(path.join(root, "saved.txt"), "utf8")).toBe("newer saved work\n");
      expect(await fs.lstat(path.join(root, "stale.md")).catch(() => null)).toBeNull();
      expect(await fs.lstat(path.join(root, "locked")).catch(() => null)).toBeNull();
      expect(await fs.readFile(path.join(session, "runner-state.json"), "utf8")).toBe("{\"lifecycle\":\"suspended\"}");
      expect(await fs.readdir(runtime)).toEqual(expect.arrayContaining(["paperclip-runner", "workspace-restored.json"]));
      expect(await fs.lstat(path.join(runtime, "workspace-ready.json")).catch(() => null)).toBeNull();
      expect(await fs.lstat(path.join(runtime, "workspace-snapshots")).catch(() => null)).toBeNull();
      expect((await fs.readdir(scratch)).filter(name => name.startsWith("retired"))).toEqual(["retired"]);
    } finally {
      await captured.cleanup();
      await exec("chmod", ["-R", "u+w", scratch]).catch(() => undefined);
    }
  });

  it("keeps a completed restore available when the staging cleanup reply is lost", async () => {
    await fs.writeFile(path.join(workspace, "saved.txt"), "durable synthetic files\n");
    const { remote, execute } = target();
    const captured = await captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId: randomUUID() });
    try {
      const actual = execute.getMockImplementation()!;
      let loseCleanup = true;
      execute.mockImplementation(async input => {
        const result = await actual(input);
        if (loseCleanup && input.args?.[1]?.includes("remote_workspace_export_cleanup_failed") && result.exitCode === 0) {
          throw new Error("synthetic lost cleanup reply");
        }
        return result;
      });
      const root = path.join(scratch, "restored-after-cleanup-failure");
      const input = { target: remote, remoteCwd: root, archivePath: captured.archivePath,
        manifestDigest: captured.manifestDigest, restorationIdentity: "c".repeat(64) };
      const restored = await restoreRemoteWorkspaceDirectory(input);
      expect(restored.cleanupPending).toBe(true);
      expect(await fs.readFile(path.join(root, "saved.txt"), "utf8")).toBe("durable synthetic files\n");
      await expect(cleanupRemoteWorkspaceArchive({ target: remote, remoteCwd: restored.stagingRoot,
        operationId: restored.operationId })).rejects.toThrow("synthetic lost cleanup reply");
      await fs.writeFile(path.join(root, "later.txt"), "keep later work\n");
      loseCleanup = false;
      const retried = await restoreRemoteWorkspaceDirectory(input);
      await cleanupRemoteWorkspaceArchive({ target: remote, remoteCwd: retried.stagingRoot, operationId: retried.operationId });
      expect(await fs.readFile(path.join(root, "later.txt"), "utf8")).toBe("keep later work\n");
    } finally { await captured.cleanup(); }
  });

  it("names the restore step that refused an occupied folder without touching its files", async () => {
    await fs.writeFile(path.join(workspace, "saved.txt"), "saved synthetic work\n");
    const { remote } = target();
    const captured = await captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId: randomUUID() });
    try {
      const root = path.join(scratch, "occupied-secret-folder");
      await fs.mkdir(root); await fs.writeFile(path.join(root, "later.txt"), "unsaved later work\n");
      const failure = await restoreRemoteWorkspaceDirectory({ target: remote, remoteCwd: root, archivePath: captured.archivePath,
        manifestDigest: captured.manifestDigest, restorationIdentity: "e".repeat(64) }).then(() => null, (error: unknown) => error as Error);
      if (!failure) throw new Error("restore unexpectedly succeeded");
      expect(failure.message).toBe("remote_workspace_operation_failed: operation=restore exit=1; "
        + "remote_workspace_restore_failed: stage=inspect_root reason=occupied_root");
      expect(remoteWorkspaceFailureCause(failure)).toBe(failure.message);
      expect(await fs.readdir(root)).toEqual(["later.txt"]);
    } finally { await captured.cleanup(); }
  });

  it("names a rejected archive during restore by its closed archive reason", async () => {
    await fs.writeFile(path.join(workspace, "saved.txt"), "saved synthetic work\n");
    const { remote } = target();
    const captured = await captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId: randomUUID() });
    try {
      const root = path.join(scratch, "restored-with-wrong-digest");
      await expect(restoreRemoteWorkspaceDirectory({ target: remote, remoteCwd: root, archivePath: captured.archivePath,
        manifestDigest: "f".repeat(64), restorationIdentity: "e".repeat(64) }))
        .rejects.toThrow(/^remote_workspace_operation_failed: operation=restore exit=1; remote_workspace_restore_failed: stage=extract archive=manifest_mismatch exit=1$/);
      expect(await fs.lstat(root).catch(() => null)).toBeNull();
    } finally { await captured.cleanup(); }
  });

  it("names the preparation step that could not select a missing branch", async () => {
    const origin = await repository(), { remote } = target(), root = path.join(workspace, "missing-branch-cause");
    await expect(prepareRemoteWorkspaceDirectory({ target: remote, remoteCwd: root,
      preparationIdentity: createHash("sha256").update("synthetic-missing-branch-cause").digest("hex"),
      source: { kind: "git", repoUrl: origin, ref: "main", branchName: "feature/missing", branchMode: "existing" },
      resolveGitAuth: async () => null }))
      .rejects.toThrow(/^remote_workspace_operation_failed: operation=prepare exit=1; remote_workspace_prepare_failed: stage=checkout_branch exit=1 program=git$/);
  });

  it("names the repository step that found a changed origin", async () => {
    const origin = await repository(), { remote } = target(), root = path.join(workspace, "repos", "changed-origin");
    await prepareRemoteRepository({ target: remote, remoteCwd: root, repoUrl: origin, ref: "HEAD", resolveGitAuth: async () => null });
    await expect(prepareRemoteRepository({ target: remote, remoteCwd: root, repoUrl: `${origin}-moved`, ref: "HEAD",
      resolveGitAuth: async () => null }))
      .rejects.toThrow(/^remote_workspace_operation_failed: operation=repository exit=1; remote_workspace_repository_failed: stage=verify_origin reason=repository_origin_changed$/);
  });

  it.each(["prepare", "repository", "restore"] as const)("drops %s output that is outside the closed cause grammar", async operation => {
    const { remote, execute } = target();
    const forged = `remote_workspace_${operation}_failed: stage=extract reason=/home/secret`;
    if (operation === "restore") execute.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "", timedOut: false,
      signal: null, pid: process.pid, startedAt: new Date().toISOString() });
    execute.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: forged, timedOut: false,
      signal: null, pid: process.pid, startedAt: new Date().toISOString() });
    const request = operation === "prepare"
      ? prepareRemoteWorkspaceDirectory({ target: remote, remoteCwd: workspace, source: { kind: "empty" },
        preparationIdentity: "a".repeat(64), resolveGitAuth: async () => null })
      : operation === "repository"
        ? prepareRemoteRepository({ target: remote, remoteCwd: workspace, repoUrl: "https://example.invalid/fixture.git", ref: null, resolveGitAuth: async () => null })
        : (async () => {
          const archivePath = path.join(scratch, "forged.pcws"); await fs.writeFile(archivePath, "synthetic archive");
          return restoreRemoteWorkspaceDirectory({ target: remote, remoteCwd: path.join(scratch, "forged"), archivePath,
            manifestDigest: "a".repeat(64), restorationIdentity: "b".repeat(64) });
        })();
    await expect(request).rejects.toThrow(new RegExp(`^remote_workspace_operation_failed: operation=${operation} exit=1$`));
  });

  it("publishes one complete capture pair when the same operation starts simultaneously", async () => {
    await fs.writeFile(path.join(workspace, "saved.txt"), "simultaneously captured work\n");
    const barrier = path.join(scratch, "capture-start-barrier"); await fs.mkdir(barrier);
    const { remote, execute } = target(), run = execute.getMockImplementation()!;
    execute.mockImplementation(async input => {
      const args = input.args ?? [];
      if (args[4]?.endsWith("archive.cjs") && args[5]) {
        // Hold the actual codec subprocesses until both captures have started.
        // The codec and all archive writes still run unchanged on real files.
        const body = Buffer.from(args[5], "base64").toString("utf8");
        const controlled = `const barrierFs=require('node:fs/promises');(async()=>{
          const barrier=${JSON.stringify(barrier)};await barrierFs.writeFile(barrier+'/'+process.pid,'ready');
          const until=Date.now()+10000;while((await barrierFs.readdir(barrier)).length<2){
            if(Date.now()>until)throw Error('capture barrier timed out');await new Promise(resolve=>setTimeout(resolve,5));}
          ${body}
        })().catch(error=>{process.stderr.write(error.message);process.exitCode=1});`;
        return run({ ...input, args: [...args.slice(0, 5), Buffer.from(controlled).toString("base64")] });
      }
      return run(input);
    });
    const operationId = randomUUID();
    const outcomes = await Promise.allSettled([0, 1].map(() => captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId })));
    const completed = outcomes.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
    try {
      expect(outcomes.map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(await fs.readdir(barrier)).toHaveLength(2);
      expect(completed[0]!.manifestDigest).toBe(completed[1]!.manifestDigest);
      expect(completed[0]!.sha256).toBe(completed[1]!.sha256);
      for (const saved of completed) expect(createHash("sha256").update(await fs.readFile(saved.archivePath)).digest("hex")).toBe(saved.sha256);
      const directory = path.join(workspace, ".paperclip-runtime", "workspace-snapshots", operationId);
      expect((await fs.readdir(directory)).filter(name => name.startsWith("capture-"))).toEqual([]);
      await fs.writeFile(path.join(workspace, "saved.txt"), "later work must not replace a completed capture\n");
      const replay = await captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId });
      try { expect(replay.sha256).toBe(completed[0]!.sha256); }
      finally { await replay.cleanup(); }
    } finally { await Promise.all(completed.map(saved => saved.cleanup())); }
  }, 15_000);

  it("recaptures after an abandoned partial attempt without unlinking unknown staging", async () => {
    await fs.writeFile(path.join(workspace, "saved.txt"), "work after interrupted capture\n");
    const operationId = randomUUID(), directory = path.join(workspace, ".paperclip-runtime", "workspace-snapshots", operationId);
    const abandoned = path.join(directory, "capture-abandoned"); await fs.mkdir(abandoned, { recursive: true });
    const legacy = path.join(directory, "workspace.pcws"), partial = path.join(abandoned, "workspace.pcws");
    await fs.writeFile(legacy, "unknown old in-progress archive\n"); await fs.writeFile(partial, "abandoned partial archive\n");
    const { remote } = target();
    const captured = await captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId });
    try {
      expect(await fs.readFile(legacy, "utf8")).toBe("unknown old in-progress archive\n");
      expect(await fs.readFile(partial, "utf8")).toBe("abandoned partial archive\n");
      expect((await fs.readdir(directory)).filter(name => name.startsWith("capture-"))).toEqual(["capture-abandoned"]);
      await fs.writeFile(path.join(workspace, "saved.txt"), "newer work\n");
      const replay = await captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId });
      try { expect(replay.sha256).toBe(captured.sha256); }
      finally { await replay.cleanup(); }
    } finally { await captured.cleanup(); }
  });

  it("prefers the canonical capture and reads a completed legacy pair without replacing it", async () => {
    await fs.writeFile(path.join(workspace, "saved.txt"), "immutable completed capture\n");
    const operationId = randomUUID(), directory = path.join(workspace, ".paperclip-runtime", "workspace-snapshots", operationId);
    const { remote } = target();
    const captured = await captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId });
    try {
      const canonical = path.join(directory, "captured"), archive = path.join(directory, "workspace.pcws"), receipt = path.join(directory, "receipt.json");
      const legacyReceipt = { ...JSON.parse(await fs.readFile(path.join(canonical, "receipt.json"), "utf8")),
        layout: "untrusted-layout", archivePath: path.join(scratch, "untrusted-source") };
      await fs.writeFile(receipt, JSON.stringify(legacyReceipt));
      await fs.writeFile(archive, "corrupt legacy bytes ignored when canonical exists\n");
      const canonicalReplay = await captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId });
      try { expect(canonicalReplay.sha256).toBe(captured.sha256); }
      finally { await canonicalReplay.cleanup(); }
      await fs.copyFile(path.join(canonical, "workspace.pcws"), archive);
      await fs.rm(canonical, { recursive: true });
      await fs.writeFile(path.join(workspace, "saved.txt"), "later uncaptured work\n");
      const fallback = await captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId });
      try { expect(fallback.sha256).toBe(captured.sha256); }
      finally { await fallback.cleanup(); }
      expect(await fs.readFile(receipt, "utf8")).toBe(JSON.stringify(legacyReceipt));
      expect(createHash("sha256").update(await fs.readFile(archive)).digest("hex")).toBe(captured.sha256);
      expect(await fs.lstat(canonical).catch(() => null)).toBeNull();
      await fs.writeFile(receipt, "invalid completed receipt\n");
      await expect(captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId }))
        .rejects.toThrow("remote_workspace_operation_failed");
      expect(await fs.readFile(receipt, "utf8")).toBe("invalid completed receipt\n");
      expect(createHash("sha256").update(await fs.readFile(archive)).digest("hex")).toBe(captured.sha256);
      expect(await fs.lstat(canonical).catch(() => null)).toBeNull();
    } finally { await captured.cleanup(); }
  });

  it("rejects a preexisting canonical capture symlink without touching its target", async () => {
    const operationId = randomUUID(), directory = path.join(workspace, ".paperclip-runtime", "workspace-snapshots", operationId);
    const outside = path.join(scratch, "outside-capture"); await fs.mkdir(outside); await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(outside, "workspace.pcws"), "outside archive sentinel\n");
    await fs.symlink(outside, path.join(directory, "captured"));
    const { remote } = target();
    await expect(captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId }))
      .rejects.toThrow("remote_workspace_operation_failed");
    expect(await fs.readFile(path.join(outside, "workspace.pcws"), "utf8")).toBe("outside archive sentinel\n");
    expect(await fs.readdir(outside)).toEqual(["workspace.pcws"]);
  });

  it.each(["split", "one-shot"] as const)("retains a closed capture validation failure with %s output", async outputMode => {
    const privateName = "SYNTHETIC_PRIVATE_FILENAME", outside = path.join(scratch, privateName);
    await fs.writeFile(outside, "outside source bytes\n");
    await fs.writeFile(path.join(workspace, "saved.txt"), "retained source bytes\n");
    await fs.symlink(`../${privateName}`, path.join(workspace, "link"));
    const { remote, execute } = target({}, outputMode), operationId = randomUUID();
    await expect(captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId }))
      .rejects.toThrow(/^remote_workspace_archive_unsafe_symlink$/);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(outside, "utf8")).toBe("outside source bytes\n");
    expect(await fs.readFile(path.join(workspace, "saved.txt"), "utf8")).toBe("retained source bytes\n");
    expect(await fs.readlink(path.join(workspace, "link"))).toBe(`../${privateName}`);
    const directory = path.join(workspace, ".paperclip-runtime", "workspace-snapshots", operationId);
    expect(await fs.readdir(directory)).toEqual(["archive.cjs"]);
  });

  it.each(["split", "one-shot"] as const)("retains a closed filesystem failure for a missing canonical archive with %s output", async outputMode => {
    const operationId = randomUUID(), canonical = path.join(workspace, ".paperclip-runtime", "workspace-snapshots", operationId, "captured");
    await fs.mkdir(canonical, { recursive: true });
    const receipt = '{"SYNTHETIC_PRIVATE_METADATA":"retained receipt"}';
    await fs.writeFile(path.join(canonical, "receipt.json"), receipt);
    await fs.writeFile(path.join(workspace, "saved.txt"), "retained unsaved source bytes\n");
    const { remote, execute } = target({}, outputMode);
    await expect(captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId }))
      .rejects.toThrow(/^remote_workspace_archive_fs_enoent$/);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(path.join(canonical, "receipt.json"), "utf8")).toBe(receipt);
    expect(await fs.readdir(canonical)).toEqual(["receipt.json"]);
    expect(await fs.readFile(path.join(workspace, "saved.txt"), "utf8")).toBe("retained unsaved source bytes\n");
  });

  it.each(["split", "one-shot"] as const)("preserves only the fixed unfinished Git operation diagnostic with %s output", async outputMode => {
    await git(workspace, "init", "--initial-branch=main");
    await fs.writeFile(path.join(workspace, "work.txt"), "base\n"); await git(workspace, "add", "."); await git(workspace, "commit", "-m", "base");
    await git(workspace, "checkout", "-b", "feature");
    await fs.writeFile(path.join(workspace, "work.txt"), "feature\n"); await git(workspace, "commit", "-am", "feature");
    await git(workspace, "checkout", "main");
    await fs.writeFile(path.join(workspace, "work.txt"), "main\n"); await git(workspace, "commit", "-am", "main");
    await expect(git(workspace, "merge", "--no-edit", "feature")).rejects.toThrow();
    const mergeHead = await fs.readFile(path.join(workspace, ".git", "MERGE_HEAD"), "utf8");
    const conflictedWork = await fs.readFile(path.join(workspace, "work.txt"), "utf8");
    const { remote, execute } = target({}, outputMode);
    const gitOperation = "remote_workspace_archive_git_operation_in_progress: finish or abort the Git operation before saving the workspace";
    const operationId = randomUUID();
    await expect(captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId })).rejects.toThrow(gitOperation);
    expect(await fs.readFile(path.join(workspace, ".git", "MERGE_HEAD"), "utf8")).toBe(mergeHead);
    expect(await fs.readFile(path.join(workspace, "work.txt"), "utf8")).toBe(conflictedWork);
    const directory = path.join(workspace, ".paperclip-runtime", "workspace-snapshots", operationId);
    for (const name of ["workspace.pcws", "receipt.json"]) await expect(fs.access(path.join(directory, name))).rejects.toMatchObject({ code: "ENOENT" });
    const failure = { exitCode: 1, stdout: "", stderr: `${gitOperation}\nSYNTHETIC_PRIVATE_PATH_OR_CREDENTIAL`,
      timedOut: false, signal: null, pid: process.pid, startedAt: new Date().toISOString() };
    execute.mockResolvedValueOnce(failure);
    await expect(captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId: randomUUID() }))
      .rejects.toThrow(/^remote_workspace_operation_failed: operation=[a-z_]+ exit=1$/);
    execute.mockResolvedValueOnce({ ...failure, timedOut: true, stderr: gitOperation });
    await expect(captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId: randomUUID() }))
      .rejects.toThrow(/^remote_workspace_operation_timed_out: archive_helper \(configured timeout 300000ms\)$/);
  });

  it.each(["helper", "archive"])("saves a full sandbox through read-only transfer when the %s cannot write", async failureStage => {
    await git(workspace, "init", "--initial-branch=main");
    await fs.writeFile(path.join(workspace, "result.txt"), "committed result\n");
    await git(workspace, "add", "."); await git(workspace, "commit", "-m", "Saved work");
    const head = (await git(workspace, "rev-parse", "HEAD")).stdout;
    await fs.writeFile(path.join(workspace, "result.txt"), "staged result\n");
    await git(workspace, "add", "result.txt");
    await fs.writeFile(path.join(workspace, "notes.txt"), "untracked result\n");
    await fs.symlink("notes.txt", path.join(workspace, "notes-link"));
    const preload = path.join(scratch, "full-sandbox.cjs");
    const failing = failureStage === "helper" ? String.raw`/archive\.cjs\.[^/]+\.tmp$/` : String.raw`/workspace\.pcws$/`;
    await fs.writeFile(preload, String.raw`const fs=require('node:fs/promises'),failing=${failing};
      const fail=()=>{throw Object.assign(new Error('No space left on device'),{code:'ENOSPC'});};
      const writeFile=fs.writeFile,open=fs.open;fs.writeFile=async(file,...args)=>{
        if(failing.test(String(file)))fail();return writeFile(file,...args);};
      fs.open=async(file,...args)=>{const handle=await open(file,...args);if(failing.test(String(file)))handle.writeFile=async()=>fail();return handle;};
      require('node:module').syncBuiltinESMExports();`);
    const { remote, execute } = target();
    const run = execute.getMockImplementation()!;
    execute.mockImplementation(input => run({ ...input, env: { ...input.env, NODE_OPTIONS: `--require ${preload}` } }));
    const transfer = remote.runner!.syncOut!;
    remote.runner!.syncOut = async (operations, options) => {
      for (const operation of operations) for (const file of operation.files) {
        if (file.kind === "directory") {
          expect(file.followSymlinks).toBe(false);
          expect(file.exclude).toContain(".paperclip-runtime");
          await fs.cp(file.sourcePath, file.targetPath, { recursive: true, verbatimSymlinks: true,
            filter: source => !file.exclude!.some(excluded => {
              const relative = path.relative(file.sourcePath, source).split(path.sep).join("/");
              return relative === excluded || relative.startsWith(`${excluded}/`);
            }) });
        } else return transfer(operations, options);
      }
      return { operations: operations.map(operation => ({ operationId: operation.operationId,
        filesTransferred: operation.files.length, bytesTransferred: 0 })) };
    };
    const saved = await captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId: randomUUID() });
    try {
      expect(await fs.readFile(path.join(workspace, "result.txt"), "utf8")).toBe("staged result\n");
      expect(await fs.readFile(path.join(workspace, "notes.txt"), "utf8")).toBe("untracked result\n");
      await fs.rm(workspace, { recursive: true });
      const restored = path.join(scratch, "restored");
      await restoreRemoteWorkspaceArchive({ archivePath: saved.archivePath, targetDir: restored,
        expectedManifestDigest: saved.manifestDigest });
      expect((await git(restored, "rev-parse", "HEAD")).stdout).toBe(head);
      expect((await git(restored, "show", ":result.txt")).stdout).toBe("staged result\n");
      expect(await fs.readFile(path.join(restored, "notes.txt"), "utf8")).toBe("untracked result\n");
      expect(await fs.readlink(path.join(restored, "notes-link"))).toBe("notes.txt");
      await git(restored, "fsck", "--full");
    } finally { await saved.cleanup(); }
  });

  it.each([
    { step: "helper install", failing: String.raw`/archive\.cjs\.[^/]+\.tmp$/`, outputMode: "split" as const },
    { step: "archive write", failing: String.raw`/workspace\.pcws$/`, outputMode: "split" as const },
    { step: "helper install", failing: String.raw`/archive\.cjs\.[^/]+\.tmp$/`, outputMode: "one-shot" as const },
    { step: "archive write", failing: String.raw`/workspace\.pcws$/`, outputMode: "one-shot" as const },
  ])("names a full sandbox disk when the $step runs out of space with $outputMode output", async ({ failing, outputMode }) => {
    await fs.writeFile(path.join(workspace, "result.txt"), "synthetic saved result\n");
    // Every sandbox Node process inherits this preload. A matching write keeps
    // one byte and then fails with ENOSPC, as a real full disk does.
    const preload = path.join(scratch, "enospc.cjs");
    await fs.writeFile(preload, String.raw`const fs=require('node:fs/promises'),failing=${failing};
      const enospc=file=>Object.assign(new Error("ENOSPC: no space left on device, write '"+file+"'"),{code:'ENOSPC',errno:-28,syscall:'write'});
      const writeFile=fs.writeFile,open=fs.open;
      fs.writeFile=async(file,data,...rest)=>{if(!failing.test(String(file)))return writeFile(file,data,...rest);
        await writeFile(file,Buffer.from(data).subarray(0,1),...rest);throw enospc(file);};
      fs.open=async(file,...rest)=>{const handle=await open(file,...rest);if(failing.test(String(file))){const write=handle.writeFile.bind(handle);
        handle.writeFile=async data=>{await write(Buffer.from(data).subarray(0,1));throw enospc(file);};}return handle;};
      require('node:module').syncBuiltinESMExports();`);
    const { remote, execute } = target({}, outputMode);
    const run = execute.getMockImplementation()!;
    execute.mockImplementation(input => run({ ...input, env: { ...input.env, NODE_OPTIONS: `--require ${preload}` } }));
    remote.runner!.syncOut = async () => { throw new Error("synthetic transfer unavailable"); };
    const operationId = randomUUID();
    await expect(captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId }))
      .rejects.toThrow(/^remote_workspace_sandbox_disk_full: the sandbox disk is full; free space in the sandbox before saving the workspace$/);
    const directory = path.join(workspace, ".paperclip-runtime", "workspace-snapshots", operationId);
    const leftovers = await fs.readdir(directory).catch(() => []);
    expect(leftovers.filter(name => name !== "archive.cjs")).toEqual([]);
    expect(await fs.readFile(path.join(workspace, "result.txt"), "utf8")).toBe("synthetic saved result\n");
  });

  it("preserves work beside a socket and records its exclusion during full-disk recovery", async () => {
    await fs.writeFile(path.join(workspace, "saved.txt"), "retained work\n");
    const socket = path.join(workspace, "ipc"), server = net.createServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
    let saved: Awaited<ReturnType<typeof captureRemoteWorkspaceArchive>> | undefined;
    try {
      const { remote, execute } = target();
      execute.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "remote_workspace_sandbox_disk_full: the sandbox disk is full; free space in the sandbox before saving the workspace",
        timedOut: false, signal: null, pid: process.pid, startedAt: new Date().toISOString() });
      remote.runner!.syncOut = async operations => {
        const mapping = operations[0]!.files[0]!;
        await fs.cp(mapping.sourcePath, mapping.targetPath, { recursive: true, verbatimSymlinks: true,
          filter: file => !mapping.exclude!.includes(path.relative(mapping.sourcePath, file)) });
        return { operations: [] };
      };
      saved = await captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId: randomUUID() });
      const bytes = await fs.readFile(saved.archivePath), length = bytes.readUInt32BE(6);
      expect(JSON.parse(bytes.subarray(10, 10 + length).toString()).excluded).toContain("ipc");
      const restored = path.join(scratch, "restored");
      await restoreRemoteWorkspaceArchive({ archivePath: saved.archivePath, targetDir: restored, expectedManifestDigest: saved.manifestDigest });
      expect(await fs.readdir(restored)).toEqual(["saved.txt"]);
      expect((await fs.lstat(socket)).isSocket()).toBe(true);
    } finally {
      await saved?.cleanup();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it.each(["source changed", "copy changed", "extra file"])("rejects a read-only fallback when %s", async fault => {
    await fs.writeFile(path.join(workspace, "saved.txt"), "retained work\n");
    const { remote, execute } = target();
    execute.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "remote_workspace_sandbox_disk_full: the sandbox disk is full; free space in the sandbox before saving the workspace",
      timedOut: false, signal: null, pid: process.pid, startedAt: new Date().toISOString() });
    let copiedRoot: string | undefined;
    remote.runner!.syncOut = async operations => {
      const file = operations[0]!.files[0]!; copiedRoot = path.dirname(file.targetPath);
      await fs.cp(file.sourcePath, file.targetPath, { recursive: true, verbatimSymlinks: true });
      if (fault === "source changed") await fs.writeFile(path.join(workspace, "saved.txt"), "newer work\n");
      else await fs.writeFile(path.join(file.targetPath, fault === "extra file" ? "extra.txt" : "saved.txt"), "wrong copy\n");
      return { operations: [] };
    };
    await expect(captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId: randomUUID() }))
      .rejects.toMatchObject({ message: "remote_workspace_sandbox_disk_full: the sandbox disk is full; free space in the sandbox before saving the workspace",
        cause: { message: "remote_workspace_readonly_capture_failed: stage=verify reason=source_changed transport=provider_error" } });
    expect(await fs.readFile(path.join(workspace, "saved.txt"), "utf8")).toBe(fault === "source changed" ? "newer work\n" : "retained work\n");
    expect(copiedRoot).toBeDefined();
    await expect(fs.access(copiedRoot!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["python", "node"])("recovers a full sandbox without copying an untracked %s environment", async kind => {
    await git(workspace, "init", "--initial-branch=main");
    await fs.writeFile(path.join(workspace, "saved.txt"), "retained work\n");
    await git(workspace, "add", "saved.txt"); await git(workspace, "commit", "-m", "Saved work");
    const dependency = kind === "python" ? ".venv" : "node_modules";
    await fs.mkdir(path.join(workspace, dependency, "bin"), { recursive: true });
    await fs.writeFile(path.join(workspace, kind === "python" ? ".venv/pyvenv.cfg" : "package.json"), kind === "python" ? "home = /usr/bin\n" : "{}\n");
    await fs.symlink(process.execPath, path.join(workspace, dependency, "bin", "runtime"));
    const { remote, execute } = target();
    execute.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "remote_workspace_sandbox_disk_full: the sandbox disk is full; free space in the sandbox before saving the workspace",
      timedOut: false, signal: null, pid: process.pid, startedAt: new Date().toISOString() });
    remote.runner!.syncOut = async operations => {
      const mapping = operations[0]!.files[0]!;
      expect(mapping.exclude).toContain(dependency);
      await fs.cp(mapping.sourcePath, mapping.targetPath, { recursive: true, verbatimSymlinks: true,
        filter: file => !(mapping.exclude ?? []).some(excluded => {
          const relative = path.relative(mapping.sourcePath, file).split(path.sep).join("/");
          return relative === excluded || relative.startsWith(`${excluded}/`);
        }) });
      return { operations: [] };
    };
    const saved = await captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId: randomUUID() });
    try {
      const restored = path.join(scratch, "restored");
      await restoreRemoteWorkspaceArchive({ archivePath: saved.archivePath, targetDir: restored, expectedManifestDigest: saved.manifestDigest });
      expect(await fs.readFile(path.join(restored, "saved.txt"), "utf8")).toBe("retained work\n");
      await expect(fs.access(path.join(restored, dependency))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readlink(path.join(workspace, dependency, "bin", "runtime"))).toBe(process.execPath);
    } finally { await saved.cleanup(); }
  });

  it("never excludes Git history because its metadata contains a virtualenv marker", async () => {
    await git(workspace, "init", "--initial-branch=main");
    await fs.writeFile(path.join(workspace, "saved.txt"), "retained work\n");
    await git(workspace, "add", "saved.txt"); await git(workspace, "commit", "-m", "Saved work");
    const commit = (await git(workspace, "rev-parse", "HEAD")).stdout;
    await fs.writeFile(path.join(workspace, ".git", "pyvenv.cfg"), "home = /usr/bin\n");
    const { remote, execute } = target();
    execute.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "remote_workspace_sandbox_disk_full: the sandbox disk is full; free space in the sandbox before saving the workspace",
      timedOut: false, signal: null, pid: process.pid, startedAt: new Date().toISOString() });
    remote.runner!.syncOut = async operations => {
      const mapping = operations[0]!.files[0]!;
      expect(mapping.exclude).not.toContain(".git");
      await fs.cp(mapping.sourcePath, mapping.targetPath, { recursive: true, verbatimSymlinks: true });
      return { operations: [] };
    };
    const saved = await captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId: randomUUID() });
    try {
      const restored = path.join(scratch, "restored");
      await restoreRemoteWorkspaceArchive({ archivePath: saved.archivePath, targetDir: restored, expectedManifestDigest: saved.manifestDigest });
      expect((await git(restored, "rev-parse", "HEAD")).stdout).toBe(commit);
      expect(await fs.readFile(path.join(restored, "saved.txt"), "utf8")).toBe("retained work\n");
    } finally { await saved.cleanup(); }
  });

  it("rejects excessive Git roots before parsing controller configuration", async () => {
    for (let index = 0; index < 65; index++) {
      const directory = path.join(workspace, `repo-${index}`, ".git"); await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, "config"), "");
    }
    const bin = path.join(scratch, "bin"), invoked = path.join(scratch, "git-invoked"); await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, "git"), `#!/bin/sh\nprintf invoked > '${invoked}'\nexit 1\n`, { mode: 0o700 });
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);
    try {
      await expect(readWorkspaceInventory(workspace, true)).rejects.toThrow("remote_workspace_readonly_capture_budget");
      await expect(fs.access(invoked)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { vi.unstubAllEnvs(); }
  });

  it("bounds refspec work before controller normalization", async () => {
    await git(workspace, "init", "--initial-branch=main");
    await fs.appendFile(path.join(workspace, ".git", "config"), `[remote "origin"]\n${"fetch = +refs/heads/*:refs/remotes/origin/*\n".repeat(257)}`);
    await expect(readWorkspaceInventory(workspace, true)).rejects.toThrow("remote_workspace_readonly_capture_budget");
  });

  it("cancels controller inventory before reading its source", async () => {
    const reason = new Error("verification deadline");
    await expect(readWorkspaceInventory(path.join(scratch, "missing"), true, AbortSignal.abort(reason))).rejects.toBe(reason);
  });

  it("retains tracked environment files during full-disk recovery", async () => {
    await git(workspace, "init", "--initial-branch=main");
    await fs.mkdir(path.join(workspace, ".venv"));
    await fs.writeFile(path.join(workspace, ".venv", "pyvenv.cfg"), "tracked user data\n");
    await fs.writeFile(path.join(workspace, ".venv", "result.txt"), "must survive\n");
    await git(workspace, "add", ".venv"); await git(workspace, "commit", "-m", "Tracked environment data");
    const { remote, execute } = target();
    execute.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "remote_workspace_sandbox_disk_full: the sandbox disk is full; free space in the sandbox before saving the workspace",
      timedOut: false, signal: null, pid: process.pid, startedAt: new Date().toISOString() });
    const saved = await captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId: randomUUID() });
    try {
      const restored = path.join(scratch, "restored");
      await restoreRemoteWorkspaceArchive({ archivePath: saved.archivePath, targetDir: restored, expectedManifestDigest: saved.manifestDigest });
      expect(await fs.readFile(path.join(restored, ".venv", "result.txt"), "utf8")).toBe("must survive\n");
    } finally { await saved.cleanup(); }
  });

  it.skipIf(process.platform === "win32")("rejects a file replaced by a FIFO before inventory open without blocking", async () => {
    const file = path.join(workspace, "saved.txt"), fifo = path.join(scratch, "fifo"), preload = path.join(scratch, "replace-with-fifo.cjs");
    await fs.writeFile(file, "retained work\n"); await exec("mkfifo", [fifo]);
    await fs.writeFile(preload, `const fs=require('node:fs/promises');const lstat=fs.lstat;let replaced=false;
      fs.lstat=async(file,...rest)=>{const stat=await lstat(file,...rest);
        if(!replaced&&String(file)===${JSON.stringify(file)}&&stat.isFile()){replaced=true;
          await fs.rename(file,file+'.retained');await fs.rename(${JSON.stringify(fifo)},file);}return stat;};
      require('node:module').syncBuiltinESMExports();`);
    await expect(exec(process.execPath, ["--require", preload, "-e", readonlyWorkspaceInventoryScript(), workspace], { timeout: 3000 }))
      .rejects.toMatchObject({ code: 1, stderr: "remote_workspace_readonly_capture_unsafe" });
    expect(await fs.readFile(`${file}.retained`, "utf8")).toBe("retained work\n");
  });

  it("rejects internal Git config symlinks before controller normalization can follow an include", async () => {
    await fs.mkdir(path.join(workspace, ".git"));
    const outside = path.join(scratch, "outside-config");
    await fs.writeFile(outside, "[user]\nname = outside\n");
    await fs.writeFile(path.join(workspace, "payload-config"), `[include]\npath = ${outside}\n`);
    await fs.symlink("../payload-config", path.join(workspace, ".git", "config"));
    await expect(readWorkspaceInventory(workspace, true)).rejects.toThrow("remote_workspace_readonly_capture_unsafe");
    expect(await fs.readFile(outside, "utf8")).toBe("[user]\nname = outside\n");
  });

  it("saves read-only directories and removes only the private controller copy", async () => {
    const source = path.join(workspace, "readonly"), restored = path.join(scratch, "restored");
    await fs.mkdir(source); await fs.writeFile(path.join(source, "saved.txt"), "read-only work\n"); await fs.chmod(source, 0o555);
    const { remote, execute } = target();
    execute.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "remote_workspace_sandbox_disk_full: the sandbox disk is full; free space in the sandbox before saving the workspace",
      timedOut: false, signal: null, pid: process.pid, startedAt: new Date().toISOString() });
    const transfer = remote.runner!.syncOut!; let copy: string | undefined;
    remote.runner!.syncOut = (operations, options) => { copy = operations[0]!.files[0]!.targetPath; return transfer(operations, options); };
    let saved: Awaited<ReturnType<typeof captureRemoteWorkspaceArchive>> | undefined;
    try {
      saved = await captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId: randomUUID() });
      expect((await fs.stat(source)).mode & 0o777).toBe(0o555);
      expect(await fs.readFile(path.join(source, "saved.txt"), "utf8")).toBe("read-only work\n");
      await expect(fs.access(copy!)).rejects.toMatchObject({ code: "ENOENT" });
      await restoreRemoteWorkspaceArchive({ archivePath: saved.archivePath, targetDir: restored, expectedManifestDigest: saved.manifestDigest });
      expect((await fs.stat(path.join(restored, "readonly"))).mode & 0o777).toBe(0o555);
      expect(await fs.readFile(path.join(restored, "readonly", "saved.txt"), "utf8")).toBe("read-only work\n");
    } finally {
      for (const directory of [source, path.join(restored, "readonly"), ...(copy ? [path.join(copy, "readonly")] : [])]) {
        await fs.chmod(directory, 0o700).catch(() => undefined);
      }
      await saved?.cleanup();
      if (copy) await fs.rm(path.dirname(copy), { recursive: true, force: true });
    }
  });

  it("retains initialized submodule workspaces when a full sandbox cannot normalize their Git pointers", async () => {
    const origin = await repository();
    await git(workspace, "init", "--initial-branch=main");
    await fs.writeFile(path.join(workspace, "result.txt"), "retain parent work\n");
    await git(workspace, "add", "result.txt"); await git(workspace, "commit", "-m", "Parent");
    await git(workspace, "-c", "protocol.file.allow=always", "submodule", "add", "--", origin, "sub");
    const before = (await git(workspace, "status", "--porcelain")).stdout;
    const { remote, execute } = target();
    execute.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "remote_workspace_sandbox_disk_full: the sandbox disk is full; free space in the sandbox before saving the workspace",
      timedOut: false, signal: null, pid: process.pid, startedAt: new Date().toISOString() });
    const syncOut = vi.fn(remote.runner!.syncOut!); remote.runner!.syncOut = syncOut;
    await expect(captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId: randomUUID() }))
      .rejects.toThrow(/^remote_workspace_sandbox_disk_full:/);
    expect(syncOut).not.toHaveBeenCalled();
    expect((await git(workspace, "status", "--porcelain")).stdout).toBe(before);
    expect(await fs.readFile(path.join(workspace, "sub", "source.txt"), "utf8")).toBe("initial synthetic source\n");
  });

  it.each(["Config", "objects/info/Alternates"])("rejects case aliases of Git administration paths before controller Git reads: %s", async relative => {
    await git(workspace, "init", "--initial-branch=main");
    const outside = path.join(scratch, "outside"); await fs.mkdir(outside);
    if (relative === "Config") {
      await fs.rename(path.join(workspace, ".git", "config"), path.join(workspace, ".git", "Config"));
      await fs.writeFile(path.join(workspace, ".git", "Config"), `[include]\npath = ${path.join(outside, "config")}\n`);
    } else await fs.writeFile(path.join(workspace, ".git", relative), `${outside}\n`);
    await expect(readWorkspaceInventory(workspace, true)).rejects.toThrow("remote_workspace_readonly_capture_unsafe");
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("rejects nonportable Git config before Git can read a controller attributes file", async () => {
    await git(workspace, "init", "--initial-branch=main");
    await git(workspace, "config", "core.attributesFile", path.join(scratch, "outside-attributes"));
    await expect(readWorkspaceInventory(workspace, true)).rejects.toThrow("remote_workspace_readonly_capture_unsafe");
  });

  it.each(["worktree pointer", "alternate store", "config include", "core worktree"])("retains a full sandbox with a %s instead of resolving controller paths", async fault => {
    const outside = path.join(scratch, "outside"); await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "sentinel"), "must stay outside\n");
    await fs.writeFile(path.join(workspace, "saved.txt"), "retained work\n");
    if (fault === "worktree pointer") await fs.writeFile(path.join(workspace, ".git"), `gitdir: ${outside}\n`);
    else {
      await git(workspace, "init", "--initial-branch=main");
      if (fault === "alternate store") await fs.writeFile(path.join(workspace, ".git", "objects", "info", "alternates"), `${outside}\n`);
      if (fault === "config include") await git(workspace, "config", "include.path", path.join(outside, "sentinel"));
      if (fault === "core worktree") await git(workspace, "config", "core.worktree", outside);
    }
    const { remote, execute } = target();
    execute.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "remote_workspace_sandbox_disk_full: the sandbox disk is full; free space in the sandbox before saving the workspace",
      timedOut: false, signal: null, pid: process.pid, startedAt: new Date().toISOString() });
    const transfer = remote.runner!.syncOut!;
    const syncOut = vi.fn(transfer); remote.runner!.syncOut = syncOut;
    await expect(captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId: randomUUID() }))
      .rejects.toThrow(/^remote_workspace_sandbox_disk_full:/);
    if (["worktree pointer", "alternate store"].includes(fault)) expect(syncOut).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(workspace, "saved.txt"), "utf8")).toBe("retained work\n");
    expect(await fs.readdir(outside)).toEqual(["sentinel"]);
    expect(await fs.readFile(path.join(outside, "sentinel"), "utf8")).toBe("must stay outside\n");
  });

  it("keeps the full-disk diagnostic exact", async () => {
    const { remote, execute } = target();
    execute.mockResolvedValueOnce({ exitCode: 1, stdout: "", timedOut: false, signal: null, pid: process.pid,
      startedAt: new Date().toISOString(),
      stderr: "remote_workspace_sandbox_disk_full: the sandbox disk is full; free space in the sandbox before saving the workspace\nSYNTHETIC_PRIVATE_PATH" });
    await expect(captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId: randomUUID() }))
      .rejects.toThrow(/^remote_workspace_operation_failed: operation=[a-z_]+ exit=1$/);
  });

  it.each(["split", "one-shot"] as const)("preserves a Git child disk failure with %s output when read-only download is unavailable", async outputMode => {
    await git(workspace, "init", "--initial-branch=main");
    await fs.writeFile(path.join(workspace, "saved.txt"), "retained source bytes\n");
    const bin = path.join(scratch, "controlled-bin"); await fs.mkdir(bin);
    const gitWrapper = path.join(bin, "git");
    await fs.writeFile(gitWrapper, "#!/bin/sh\nprintf '%s' 'No space left on device: SYNTHETIC_PRIVATE_GIT_PATH' >&2\nexit 2\n", { mode: 0o700 });
    const { remote } = target({ PATH: `${bin}${path.delimiter}${process.env.PATH}` }, outputMode);
    remote.runner!.syncOut = async () => { throw new Error("synthetic transfer unavailable"); };
    await expect(captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId: randomUUID() }))
      .rejects.toThrow(/^remote_workspace_sandbox_disk_full: the sandbox disk is full; free space in the sandbox before saving the workspace$/);
    expect(await fs.readFile(path.join(workspace, "saved.txt"), "utf8")).toBe("retained source bytes\n");
  });

  it.each([
    { label: "private stdout", stdout: "SYNTHETIC_PRIVATE_STDOUT", stderr: "" },
    { label: "private stderr", stdout: "", stderr: "SYNTHETIC_PRIVATE_STDERR" },
    { label: "suffixed stdout diagnostic", stdout: "remote_workspace_sandbox_disk_full: the sandbox disk is full; free space in the sandbox before saving the workspace\nSYNTHETIC_PRIVATE_PATH", stderr: "" },
    { label: "prefixed stdout diagnostic", stdout: "SYNTHETIC_PRIVATE_PATH\nremote_workspace_sandbox_disk_full: the sandbox disk is full; free space in the sandbox before saving the workspace", stderr: "" },
    { label: "unrelated helper diagnostic", stdout: "remote_workspace_capture_failed", stderr: "" },
    { label: "diagnostic split between streams", stdout: "remote_workspace_sandbox_", stderr: "disk_full: the sandbox disk is full; free space in the sandbox before saving the workspace" },
    { label: "suffixed capture validation", stdout: "", stderr: "remote_workspace_archive_unsafe_symlink\nSYNTHETIC_PRIVATE_FILENAME" },
    { label: "prefixed capture filesystem failure", stdout: "SYNTHETIC_PRIVATE_PATH\nremote_workspace_archive_fs_enoent", stderr: "" },
    { label: "unknown capture filesystem code", stdout: "remote_workspace_archive_fs_eintr", stderr: "" },
    { label: "unknown capture validation", stdout: "", stderr: "remote_workspace_archive_Synthetic_PRIVATE" },
    { label: "capture failure split between streams", stdout: "remote_workspace_archive_", stderr: "unsafe_symlink" },
  ])("keeps $label private", async ({ stdout, stderr }) => {
    const { remote, execute } = target();
    execute.mockResolvedValueOnce({ exitCode: 1, stdout, stderr, timedOut: false, signal: null,
      pid: process.pid, startedAt: new Date().toISOString() });
    await expect(captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId: randomUUID() }))
      .rejects.toThrow(/^remote_workspace_operation_failed: operation=[a-z_]+ exit=1$/);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each(["prepare", "repository", "restore", "cleanup"] as const)("keeps new capture diagnostics private during %s", async operation => {
    const { remote, execute } = target();
    const failed = { exitCode: 1, stdout: "remote_workspace_archive_fs_enoent", stderr: "", timedOut: false,
      signal: null, pid: process.pid, startedAt: new Date().toISOString() };
    if (operation === "restore") execute.mockResolvedValueOnce({ ...failed, exitCode: 0, stdout: "" });
    execute.mockResolvedValueOnce(failed);
    const request = operation === "prepare"
      ? prepareRemoteWorkspaceDirectory({ target: remote, remoteCwd: workspace, source: { kind: "empty" },
        preparationIdentity: "a".repeat(64), resolveGitAuth: async () => null })
      : operation === "repository"
        ? prepareRemoteRepository({ target: remote, remoteCwd: workspace, repoUrl: "https://example.invalid/fixture.git", ref: null, resolveGitAuth: async () => null })
        : operation === "cleanup"
          ? cleanupRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId: randomUUID() })
          : (async () => {
            const archivePath = path.join(scratch, "restore.pcws"); await fs.writeFile(archivePath, "synthetic archive");
            return restoreRemoteWorkspaceDirectory({ target: remote, remoteCwd: path.join(scratch, "restored"), archivePath,
              manifestDigest: "a".repeat(64), restorationIdentity: "b".repeat(64) });
          })();
    await expect(request).rejects.toThrow(/^remote_workspace_operation_failed: operation=[a-z_]+ exit=1$/);
    expect(execute).toHaveBeenCalledTimes(operation === "restore" ? 2 : 1);
  });

  it("keeps the existing disk diagnostic ahead of a new capture diagnostic", async () => {
    const { remote, execute } = target();
    const diskFull = "remote_workspace_sandbox_disk_full: the sandbox disk is full; free space in the sandbox before saving the workspace";
    execute.mockResolvedValueOnce({ exitCode: 1, stdout: diskFull, stderr: "remote_workspace_archive_fs_enoent",
      timedOut: false, signal: null, pid: process.pid, startedAt: new Date().toISOString() });
    remote.runner!.syncOut = async () => { throw new Error("synthetic transfer unavailable"); };
    await expect(captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId: randomUUID() }))
      .rejects.toThrow(diskFull);
  });

  it("keeps the existing safe stderr diagnostic when stdout reports another safe failure", async () => {
    const { remote, execute } = target();
    const diskFull = "remote_workspace_sandbox_disk_full: the sandbox disk is full; free space in the sandbox before saving the workspace";
    execute.mockResolvedValueOnce({ exitCode: 1, stdout: diskFull,
      stderr: "remote_workspace_archive_git_operation_in_progress: finish or abort the Git operation before saving the workspace",
      timedOut: false, signal: null, pid: process.pid, startedAt: new Date().toISOString() });
    await expect(captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId: randomUUID() }))
      .rejects.toThrow(/^remote_workspace_archive_git_operation_in_progress: finish or abort the Git operation before saving the workspace$/);
  });

  it.each(["split", "one-shot"] as const)("names the failing capture step without its private text with %s output", async outputMode => {
    await git(workspace, "init", "--initial-branch=main");
    await fs.writeFile(path.join(workspace, "saved.txt"), "retained source bytes\n");
    const bin = path.join(scratch, "controlled-bin"); await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, "git"),
      "#!/bin/sh\nprintf '%s' 'fatal: SYNTHETIC_PRIVATE_GIT_PATH/secret.txt' >&2\nexit 128\n", { mode: 0o700 });
    const { remote } = target({ PATH: `${bin}${path.delimiter}${process.env.PATH}` }, outputMode);
    const failure = await captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId: randomUUID() })
      .then(() => null, (error: Error) => error);
    expect(failure?.message).toBe("remote_workspace_operation_failed: operation=capture exit=1; "
      + "remote_workspace_capture_failed: stage=archive exit=128 program=git helper_exit=1");
    expect(failure?.message).not.toContain("SYNTHETIC");
    expect(await fs.readFile(path.join(workspace, "saved.txt"), "utf8")).toBe("retained source bytes\n");
  });

  it("names a remote command that ended by signal", async () => {
    const { remote, execute } = target();
    execute.mockResolvedValueOnce({ exitCode: null as unknown as number, stdout: "", stderr: "", timedOut: false, signal: "SIGKILL",
      pid: process.pid, startedAt: new Date().toISOString() });
    await expect(captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId: randomUUID() }))
      .rejects.toThrow(/^remote_workspace_operation_failed: operation=archive_helper signal=SIGKILL$/);
  });

  it.each([
    ["Daytona sandbox lease SYNTHETIC-sandbox-id is no longer active.", undefined, "transport=sandbox_lease_inactive"],
    ["daytona_sandbox_not_found: /home/SYNTHETIC/private", undefined, "transport=daytona_sandbox_not_found"],
    ["connect to /SYNTHETIC/private failed", "ECONNRESET", "transport=transport_closed code=ECONNRESET"],
    ["SYNTHETIC_PRIVATE provider response", undefined, "transport=provider_error"],
  ])("names a copy-back command the provider refused without its text: %j", async (message, code, named) => {
    const { remote, execute } = target();
    execute.mockRejectedValueOnce(Object.assign(new Error(message), code ? { code } : {}));
    const failure = await captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId: randomUUID() })
      .then(() => null, (error: unknown) => error as Error);
    // The thrown error is unchanged for existing callers; only the recorded cause is redacted.
    expect(failure?.message).toBe(message);
    expect(remoteWorkspaceFailureCause(failure)).toBe(`remote_workspace_operation_failed: operation=archive_helper ${named}`);
    expect(remoteWorkspaceFailureCause(failure)).not.toMatch(/SYNTHETIC|private/);
    // The sandbox-loss classification that stops retries still sees its code.
    expect(classifyNativeWorkspaceFailure(failure).code).toBe(message.startsWith("daytona_sandbox_not_found")
      ? "workspace_sync_out_unrecoverable" : "workspace_sync_out_failed");
  });

  it("names a failed archive download without the provider text", async () => {
    await fs.writeFile(path.join(workspace, "saved.txt"), "saved synthetic bytes\n");
    const { remote } = target();
    remote.runner!.syncOut = vi.fn(async () => { throw new Error("Daytona download of /SYNTHETIC/private timed out"); });
    const failure = await captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId: randomUUID() })
      .then(() => null, (error: unknown) => error as Error);
    expect(remoteWorkspaceFailureCause(failure)).toBe("remote_workspace_operation_failed: operation=download transport=transport_timeout");
  });

  it("names a permission-denied archive download without its path", async () => {
    await fs.writeFile(path.join(workspace, "saved.txt"), "saved synthetic bytes\n");
    const { remote } = target();
    remote.runner!.syncOut = vi.fn(async () => {
      throw Object.assign(new Error("EACCES: permission denied, open '/SYNTHETIC/private'"), { code: "EACCES" });
    });
    const failure = await captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId: randomUUID() })
      .then(() => null, (error: unknown) => error as Error);
    expect(remoteWorkspaceFailureCause(failure))
      .toBe("remote_workspace_operation_failed: operation=download transport=permission_denied code=EACCES");
  });

  it("keeps an archive-safety refusal exact for its own retry policy", async () => {
    await fs.writeFile(path.join(workspace, "saved.txt"), "saved synthetic bytes\n");
    const { remote } = target();
    const refusal = "Daytona syncOut refusing tarball member that escapes the extraction dir: ../private";
    remote.runner!.syncOut = vi.fn(async () => { throw new Error(refusal); });
    const failure = await captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId: randomUUID() })
      .then(() => null, (error: unknown) => error as Error);
    expect(failure?.message).toBe(refusal);
    expect(remoteWorkspaceFailureCause(failure)).toBeNull();
  });

  it("does not label a provider error that did not come from a copy-back command", () => {
    expect(remoteWorkspaceFailureCause(new Error("Daytona sandbox lease SYNTHETIC is no longer active."))).toBeNull();
  });

  it.each([
    "remote_workspace_capture_failed: stage=archive reason=SYNTHETIC/private/path",
    "remote_workspace_capture_failed: stage=archive exit=128\nSYNTHETIC_PRIVATE",
    "remote_workspace_capture_failed: stage=archive token=SYNTHETIC_PRIVATE",
    "SYNTHETIC_PRIVATE remote_workspace_capture_failed: stage=archive exit=1",
  ])("drops a sandbox cause outside the fixed grammar: %j", async stderr => {
    const { remote, execute } = target();
    execute.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr, timedOut: false, signal: null,
      pid: process.pid, startedAt: new Date().toISOString() });
    await expect(captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId: randomUUID() }))
      .rejects.toThrow(/^remote_workspace_operation_failed: operation=archive_helper exit=1$/);
  });

  it("captures and restores verified bytes with one-shot combined output", async () => {
    await fs.writeFile(path.join(workspace, "saved.txt"), "saved synthetic one-shot bytes\n");
    const { remote, execute } = target({}, "one-shot");
    const captured = await captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId: randomUUID() });
    try {
      expect(createHash("sha256").update(await fs.readFile(captured.archivePath)).digest("hex")).toBe(captured.sha256);
      const restoredRoot = path.join(scratch, "restored-one-shot");
      const restored = await restoreRemoteWorkspaceDirectory({ target: remote, remoteCwd: restoredRoot,
        archivePath: captured.archivePath, manifestDigest: captured.manifestDigest, restorationIdentity: "c".repeat(64) });
      expect(await fs.readFile(path.join(restoredRoot, "saved.txt"), "utf8")).toBe("saved synthetic one-shot bytes\n");
      expect(await fs.readFile(path.join(workspace, "saved.txt"), "utf8")).toBe("saved synthetic one-shot bytes\n");
      await cleanupRemoteWorkspaceArchive({ target: remote, remoteCwd: restored.stagingRoot, operationId: restored.operationId });
      expect(execute.mock.calls.every(([input]) => input.bypassSession === true)).toBe(true);
    } finally { await captured.cleanup(); }
  });

  it.each(["full", "shallow", "partial", "partial-sparse"] as const)("restores offline %s Git state through the archive reader", async kind => {
    const origin = await repository({ revisions: true });
    for (const name of ["selected", "omitted"]) {
      await fs.mkdir(path.join(origin, name));
      await fs.writeFile(path.join(origin, name, "file.txt"), `${name} committed work\n`);
    }
    await git(origin, "add", "."); await git(origin, "commit", "-qm", "Add sparse paths");
    await git(origin, "config", "uploadpack.allowFilter", "true");
    const repo = path.join(workspace, "repository");
    const shallow = ["shallow", "partial-sparse"].includes(kind), partial = kind.startsWith("partial");
    await git(scratch, "clone", "-q", ...(shallow ? ["--depth=1"] : []),
      ...(partial ? ["--filter=blob:none"] : []), ...(kind === "partial-sparse" ? ["--sparse"] : []), pathToFileURL(origin).href, repo);
    if (kind === "partial-sparse") await git(repo, "sparse-checkout", "set", "selected");
    await git(repo, "remote", "set-url", "origin", "https://example.invalid/source.git");
    const missing = async (directory: string) => (await git(directory, "rev-list", "--objects", "--all", "--missing=print"))
      .stdout.split("\n").filter(line => line.startsWith("?")).sort();
    const missingBefore = await missing(repo);
    if (partial) expect(missingBefore.length).toBeGreaterThan(0);
    else expect(missingBefore).toEqual([]);
    await fs.writeFile(path.join(repo, "selected", "file.txt"), "staged accepted work\n");
    await git(repo, "add", "selected/file.txt");
    await fs.writeFile(path.join(repo, "selected", "file.txt"), "dirty accepted work\n");
    await fs.writeFile(path.join(repo, "untracked.txt"), "untracked accepted work\n");
    const beforeStatus = (await git(repo, "status", "--porcelain=v2")).stdout;
    const beforeHead = (await git(repo, "rev-parse", "HEAD")).stdout;
    await fs.rm(origin, { recursive: true });
    const template = path.join(scratch, "unrelated-template"); await fs.mkdir(path.join(template, "hooks"), { recursive: true });
    await fs.writeFile(path.join(template, "config"), "[credential]\n helper = SYNTHETIC_PRIVATE_TEMPLATE\n[http]\n extraHeader = SYNTHETIC_PRIVATE_TEMPLATE\n");
    await fs.writeFile(path.join(template, "hooks", "template-hook"), "SYNTHETIC_PRIVATE_TEMPLATE\n", { mode: 0o700 });
    // Only local file transport is permitted. Capture must not fetch promised
    // blobs or replace the original partial checkout with extra remote history.
    const { remote } = target({ GIT_ALLOW_PROTOCOL: "file", GIT_INDEX_FILE: path.join(scratch, "unrelated-index"), GIT_TEMPLATE_DIR: template }, "one-shot");
    const captured = await captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId: randomUUID() });
    try {
      expect(await missing(repo)).toEqual(missingBefore);
      expect(await fs.readFile(path.join(repo, "selected", "file.txt"), "utf8")).toBe("dirty accepted work\n");
      await fs.rm(workspace, { recursive: true }); remote.remoteCwd = scratch;
      const restoredRoot = path.join(scratch, "offline-restored"), restoredRepo = path.join(restoredRoot, "repository");
      await restoreRemoteWorkspaceDirectory({ target: remote, remoteCwd: restoredRoot, archivePath: captured.archivePath,
        manifestDigest: captured.manifestDigest, restorationIdentity: "d".repeat(64) });
      expect(await fs.readFile(path.join(restoredRepo, "selected", "file.txt"), "utf8")).toBe("dirty accepted work\n");
      expect(await fs.readFile(path.join(restoredRepo, "untracked.txt"), "utf8")).toBe("untracked accepted work\n");
      expect((await git(restoredRepo, "show", ":selected/file.txt")).stdout).toBe("staged accepted work\n");
      expect((await git(restoredRepo, "rev-parse", "HEAD")).stdout).toBe(beforeHead);
      expect((await git(restoredRepo, "status", "--porcelain=v2")).stdout).toBe(beforeStatus);
      expect((await git(restoredRepo, "rev-parse", "--is-shallow-repository")).stdout.trim()).toBe(String(shallow));
      expect(await missing(restoredRepo)).toEqual(missingBefore);
      expect(await fs.readFile(path.join(restoredRepo, ".git", "config"), "utf8")).not.toContain("SYNTHETIC_PRIVATE_TEMPLATE");
      await expect(fs.access(path.join(restoredRepo, ".git", "hooks", "template-hook"))).rejects.toMatchObject({ code: "ENOENT" });
      if (partial) {
        expect((await git(restoredRepo, "config", "--get", "remote.origin.promisor")).stdout.trim()).toBe("true");
        expect((await git(restoredRepo, "config", "--get", "remote.origin.partialclonefilter")).stdout.trim()).toBe("blob:none");
      }
      if (kind === "partial-sparse") {
        expect((await git(restoredRepo, "sparse-checkout", "list")).stdout.trim()).toBe("selected");
        await expect(fs.access(path.join(restoredRepo, "omitted"))).rejects.toMatchObject({ code: "ENOENT" });
      }
      await git(restoredRepo, "fsck", "--connectivity-only", "--no-dangling");
    } finally { await captured.cleanup(); }
  });

  it.each(["ordinary", "unmarked-promisor"])("rejects missing objects in an %s repository instead of allowing corruption", async kind => {
    await git(workspace, "init", "-q", "-b", "main");
    await fs.writeFile(path.join(workspace, "saved.txt"), "accepted work remains available\n");
    await git(workspace, "add", "."); await git(workspace, "commit", "-qm", "Initial work");
    const blob = (await git(workspace, "rev-parse", "HEAD:saved.txt")).stdout.trim();
    await fs.rm(path.join(workspace, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
    if (kind === "unmarked-promisor") {
      await git(workspace, "config", "remote.origin.url", "https://example.invalid/source.git");
      await git(workspace, "config", "remote.origin.promisor", "true");
      await git(workspace, "config", "remote.origin.partialclonefilter", "blob:none");
    }
    const { remote } = target({ GIT_ALLOW_PROTOCOL: "file" }, "one-shot");
    await expect(captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId: randomUUID() })).rejects.toThrow();
    expect(await fs.readFile(path.join(workspace, "saved.txt"), "utf8")).toBe("accepted work remains available\n");
  });

  it.each(["full", "shallow", "partial"] as const)("rejects corrupt available objects in %s Git before publishing a receipt", async kind => {
    const origin = await repository({ revisions: true }); await git(origin, "config", "uploadpack.allowFilter", "true");
    const repo = path.join(workspace, "repository");
    await git(scratch, "clone", "-q", ...(kind === "shallow" ? ["--depth=1"] : []),
      ...(kind === "partial" ? ["--filter=blob:none"] : []), pathToFileURL(origin).href, repo);
    await git(repo, "remote", "set-url", "origin", "https://example.invalid/source.git");
    await fs.writeFile(path.join(repo, "staged.txt"), "accepted staged work\n"); await git(repo, "add", "staged.txt");
    const oid = (await git(repo, "rev-parse", ":staged.txt")).stdout.trim();
    const file = path.join(repo, ".git", "objects", oid.slice(0, 2), oid.slice(2)), corrupt = Buffer.from("different bytes\n");
    await fs.chmod(file, 0o600); await fs.writeFile(file, deflateSync(Buffer.concat([Buffer.from(`blob ${corrupt.length}\0`), corrupt])));
    // Valid zlib with the wrong object hash passes connectivity-only fsck.
    // A successful receipt must also establish available object integrity.
    await git(repo, "fsck", "--connectivity-only", "--no-dangling");
    await expect(git(repo, "fsck", "--full", "--no-dangling")).rejects.toThrow();
    const { remote } = target({ GIT_ALLOW_PROTOCOL: "file" }, "one-shot");
    await expect(captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId: randomUUID() })).rejects.toThrow();
    expect(await fs.readFile(path.join(repo, "staged.txt"), "utf8")).toBe("accepted staged work\n");
  });

  it.each(["unsupported-filter", "alternate-store", "object-symlink"] as const)("retains a partial source with unsupported %s state", async fault => {
    const origin = await repository(); await git(origin, "config", "uploadpack.allowFilter", "true");
    const repo = path.join(workspace, "repository");
    await git(scratch, "clone", "-q", "--filter=blob:none", "--depth=1", pathToFileURL(origin).href, repo);
    await git(repo, "remote", "set-url", "origin", "https://example.invalid/source.git");
    await fs.writeFile(path.join(repo, "saved.txt"), "retained accepted work\n");
    const outside = path.join(scratch, "SYNTHETIC_PRIVATE_OBJECT_PATH"); await fs.writeFile(outside, "outside sentinel\n");
    if (fault === "unsupported-filter") await git(repo, "config", "remote.origin.partialclonefilter", "SYNTHETIC_PRIVATE_FILTER");
    if (fault === "alternate-store") await fs.writeFile(path.join(repo, ".git", "objects", "info", "alternates"), `${scratch}\n`);
    if (fault === "object-symlink") await fs.symlink(outside, path.join(repo, ".git", "objects", "pack", "unrelated-link"));
    const { remote } = target({ GIT_ALLOW_PROTOCOL: "file" }, "one-shot");
    await expect(captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId: randomUUID() }))
      .rejects.toThrow(fault === "object-symlink" ? /^remote_workspace_archive_unsafe_git_link$/ : /^remote_workspace_archive_unsupported_git_setting$/);
    expect(await fs.readFile(path.join(repo, "saved.txt"), "utf8")).toBe("retained accepted work\n");
    expect(await fs.readFile(outside, "utf8")).toBe("outside sentinel\n");
  });

  it("identifies a timed-out preparation without exposing transport output or retrying it", async () => {
    const { remote, execute } = target();
    const resolveGitAuth = vi.fn(async () => null);
    execute.mockResolvedValueOnce({ exitCode: 0, stdout: '{"cloneRequired":true}', stderr: "",
      timedOut: false, signal: null, pid: process.pid, startedAt: new Date().toISOString() });
    execute.mockResolvedValueOnce({ exitCode: null, stdout: "SYNTHETIC_PRIVATE_STDOUT", stderr: "SYNTHETIC_PRIVATE_STDERR",
      timedOut: true, signal: null, pid: process.pid, startedAt: new Date().toISOString() });

    await expect(prepareRemoteWorkspaceDirectory({ target: remote, remoteCwd: path.join(workspace, "clone"),
      source: { kind: "git", repoUrl: "https://example.invalid/source.git", ref: null },
      preparationIdentity: "a".repeat(64), resolveGitAuth }))
      .rejects.toThrow(/^remote_workspace_operation_timed_out: prepare \(configured timeout 300000ms\)$/);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(resolveGitAuth).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(workspace)).toEqual([]);
  });

  it("reports the cleanup deadline without treating a timeout as a completed operation", async () => {
    await fs.writeFile(path.join(workspace, "saved.txt"), "preserve the workspace\n");
    const { remote, execute } = target();
    execute.mockResolvedValueOnce({ exitCode: 0, stdout: "SYNTHETIC_PRIVATE_STDOUT", stderr: "SYNTHETIC_PRIVATE_STDERR",
      timedOut: true, signal: null, pid: process.pid, startedAt: new Date().toISOString() });

    await expect(cleanupRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId: randomUUID() }))
      .rejects.toThrow(/^remote_workspace_operation_timed_out: cleanup \(configured timeout 10000ms\)$/);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(path.join(workspace, "saved.txt"), "utf8")).toBe("preserve the workspace\n");
  });

  it("never follows a preexisting snapshot receipt temporary symlink", async () => {
    await fs.writeFile(path.join(workspace, "result.txt"), "synthetic saved result\n");
    const operationId = randomUUID();
    const directory = path.join(workspace, ".paperclip-runtime", "workspace-snapshots", operationId);
    const outside = path.join(scratch, "outside-sentinel");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(outside, "untouched\n");
    const oldTemporaryPath = path.join(directory, "receipt.json.tmp");
    await fs.symlink(outside, oldTemporaryPath);
    const { remote } = target();
    const captured = await captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId });
    try {
      expect(captured.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(await fs.readFile(outside, "utf8")).toBe("untouched\n");
      expect((await fs.lstat(oldTemporaryPath)).isSymbolicLink()).toBe(true);
    } finally { await captured.cleanup(); }
  });

  it("does not run ambient checkout filters with the Git transport credential", async () => {
    const origin = await repository({ filter: true, revisions: true });
    const globalConfig = path.join(scratch, "synthetic-gitconfig");
    const sentinel = path.join(scratch, "filter-received-credential");
    await git(origin, "config", "--file", globalConfig, "filter.synthetic-probe.smudge",
      `sh -c 'printf %s "$PAPERCLIP_GIT_TOKEN" > "${sentinel}"; cat'`);
    const calibration = path.join(scratch, "filter-calibration");
    await git(scratch, "clone", "--no-hardlinks", "--", origin, calibration);
    await exec("git", ["-C", calibration, "checkout", "--detach", "HEAD~1"], {
      env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1", PAPERCLIP_GIT_TOKEN: "SYNTHETIC_ONLY" },
    });
    expect(await fs.readFile(sentinel, "utf8")).toBe("SYNTHETIC_ONLY");
    await fs.rm(sentinel);
    const { remote } = target({ GIT_CONFIG_GLOBAL: globalConfig });
    // Inject a fake credential for a local synthetic source so the real Git
    // subprocess boundary is exercised without contacting a credentialed host.
    await prepareRemoteWorkspaceDirectory({ target: remote, remoteCwd: path.join(workspace, "clone"),
      preparationIdentity: createHash("sha256").update("synthetic-filter-preparation").digest("hex"),
      source: { kind: "git", repoUrl: origin, ref: "HEAD~1" },
      resolveGitAuth: async () => ({ configArgs: [], env: { PAPERCLIP_GIT_TOKEN: "SYNTHETIC_ONLY" },
        source: "company_secret", secretName: "SYNTHETIC_FIXTURE" }) });
    expect(await fs.readFile(path.join(workspace, "clone", "source.txt"), "utf8")).toBe("initial synthetic source\n");
    expect(await fs.lstat(sentinel).catch(() => null)).toBeNull();
  });

  it("adopts only the bound completed preparation after its reply is lost", async () => {
    const origin = await repository();
    const { remote, execute } = target();
    const actualExecute = execute.getMockImplementation()!;
    let loseReply = true;
    execute.mockImplementation(async input => {
      const result = await actualExecute(input);
      if (loseReply && result.exitCode === 0 && !JSON.parse(input.args?.[3] ?? "{}").probeOnly) {
        loseReply = false; throw new Error("synthetic lost preparation reply");
      }
      return result;
    });
    const preparedRoot = path.join(workspace, "clone");
    const input = { target: remote, remoteCwd: preparedRoot,
      preparationIdentity: createHash("sha256").update(JSON.stringify({ run: "synthetic", workspace: "synthetic", epoch: 1, lease: "synthetic" })).digest("hex"),
      source: { kind: "git" as const, repoUrl: origin, ref: "unused-base-ref", branchName: "main", branchMode: "existing" as const },
      resolveGitAuth: async () => null };
    await expect(prepareRemoteWorkspaceDirectory(input)).rejects.toThrow("synthetic lost preparation reply");
    await fs.writeFile(path.join(preparedRoot, "in-flight.txt"), "preserve this unsaved work\n");
    // A second clone is now impossible; successful retry must use its durable
    // completed-preparation receipt and retain the existing folder.
    await fs.rm(origin, { recursive: true, force: true });
    const unavailableAuth = vi.fn(async () => { throw new Error("synthetic Git credential service unavailable"); });
    await expect(prepareRemoteWorkspaceDirectory({ ...input, resolveGitAuth: unavailableAuth })).resolves.toBeUndefined();
    expect(unavailableAuth).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(preparedRoot, "source.txt"), "utf8")).toBe("initial synthetic source\n");
    expect(await fs.readFile(path.join(preparedRoot, "in-flight.txt"), "utf8")).toBe("preserve this unsaved work\n");
    await expect(prepareRemoteWorkspaceDirectory({ ...input, preparationIdentity: "f".repeat(64), resolveGitAuth: unavailableAuth })).rejects.toThrow("remote_workspace_operation_failed");
    expect(unavailableAuth).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(preparedRoot, "in-flight.txt"), "utf8")).toBe("preserve this unsaved work\n");
  });

  it("verifies a saved repository without resolving unavailable transport credentials", async () => {
    const origin = await repository();
    const { remote } = target();
    const root = path.join(workspace, "saved-repository");
    const prepared = await prepareRemoteRepository({ target: remote, remoteCwd: root,
      repoUrl: origin, ref: "HEAD", resolveGitAuth: async () => null });
    await fs.writeFile(path.join(root, "unsaved.txt"), "preserve local work\n");
    await fs.rm(origin, { recursive: true, force: true });
    const resolveGitAuth = vi.fn(async () => { throw new Error("synthetic Git credential service unavailable"); });
    const input = { target: remote, remoteCwd: root, repoUrl: origin, ref: "HEAD",
      pinnedCommit: prepared.pinnedCommit, verifyOnly: true, resolveGitAuth };
    await expect(prepareRemoteRepository(input)).resolves.toEqual(prepared);
    await expect(prepareRemoteRepository({ ...input, pinnedCommit: "0".repeat(40) })).rejects.toThrow("remote_workspace_operation_failed");
    await expect(prepareRemoteRepository({ ...input, repoUrl: `${origin}-foreign` })).rejects.toThrow("remote_workspace_operation_failed");
    expect(resolveGitAuth).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(root, "unsaved.txt"), "utf8")).toBe("preserve local work\n");
  });

  it.each(["root", "secondary"] as const)("checks out a non-default remote ref in the %s repository", async kind => {
    const origin = await repository(), { remote } = target(), root = path.join(workspace, `release-${kind}`);
    await git(origin, "checkout", "-b", "release");
    await fs.writeFile(path.join(origin, "release.txt"), "release branch\n");
    await git(origin, "add", "."); await git(origin, "commit", "-m", "Release");
    const release = (await git(origin, "rev-parse", "HEAD")).stdout.trim();
    await git(origin, "checkout", "main");
    if (kind === "root") await prepareRemoteWorkspaceDirectory({ target: remote, remoteCwd: root,
      preparationIdentity: "b".repeat(64), source: { kind: "git", repoUrl: origin, ref: "release" }, resolveGitAuth: async () => null });
    else await prepareRemoteRepository({ target: remote, remoteCwd: root, repoUrl: origin, ref: "release", resolveGitAuth: async () => null });
    expect((await git(root, "rev-parse", "HEAD")).stdout.trim()).toBe(release);
    expect(await fs.readFile(path.join(root, "release.txt"), "utf8")).toBe("release branch\n");
  });

  it("does not publish a secondary checkout after its configured ref fails", async () => {
    const origin = await repository(), { remote } = target(), root = path.join(workspace, "missing-secondary-ref");
    await expect(prepareRemoteRepository({ target: remote, remoteCwd: root, repoUrl: origin,
      ref: "missing-ref", resolveGitAuth: async () => null })).rejects.toThrow("remote_workspace_operation_failed");
    await expect(fs.access(root)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(prepareRemoteRepository({ target: remote, remoteCwd: root, repoUrl: origin,
      ref: "HEAD", resolveGitAuth: async () => null })).resolves.toMatchObject({ cwd: root });
  });

  it.each(["path", "file-url"] as const)("verifies an archived secondary %s repository after its local origin disappears", async sourceKind => {
    const origin = await repository(), { remote } = target();
    const repoUrl = sourceKind === "path" ? origin : pathToFileURL(origin).href;
    const root = path.join(workspace, "secondary");
    const prepared = await prepareRemoteRepository({ target: remote, remoteCwd: root, repoUrl,
      ref: "HEAD", resolveGitAuth: async () => null });
    await fs.writeFile(path.join(root, "source.txt"), "staged imported work\n");
    await git(root, "add", "source.txt");
    await fs.writeFile(path.join(root, "source.txt"), "unstaged imported work\n");
    await fs.writeFile(path.join(root, "untracked.txt"), "untracked imported work\n");
    const status = (await git(root, "status", "--porcelain=v2")).stdout;
    const captured = await captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId: randomUUID() });
    try {
      await fs.rm(root, { recursive: true });
      await fs.rm(origin, { recursive: true });
      const restoredRoot = path.join(scratch, "saved-root");
      const restored = await restoreRemoteWorkspaceDirectory({ target: remote, remoteCwd: restoredRoot,
        archivePath: captured.archivePath, manifestDigest: captured.manifestDigest, restorationIdentity: "c".repeat(64) });
      await cleanupRemoteWorkspaceArchive({ target: remote, remoteCwd: restored.stagingRoot, operationId: restored.operationId });
      const secondary = path.join(restoredRoot, "secondary");
      expect((await git(secondary, "remote")).stdout.trim()).toBe("");
      const resolveGitAuth = vi.fn(async () => { throw new Error("original Git source is unavailable"); });
      const input = { target: remote, remoteCwd: secondary, repoUrl, ref: "HEAD",
        pinnedCommit: prepared.pinnedCommit, savedArchive: true, resolveGitAuth };
      await expect(prepareRemoteRepository(input)).resolves.toEqual({ ...prepared, cwd: secondary });
      expect((await git(secondary, "status", "--porcelain=v2")).stdout).toBe(status);
      expect(await fs.readFile(path.join(secondary, "source.txt"), "utf8")).toBe("unstaged imported work\n");
      await expect(prepareRemoteRepository({ ...input, savedArchive: false })).rejects.toThrow("remote_workspace_operation_failed");
      await expect(prepareRemoteRepository({ ...input, pinnedCommit: "0".repeat(40) })).rejects.toThrow("remote_workspace_operation_failed");
      const missing = path.join(restoredRoot, "missing");
      await expect(prepareRemoteRepository({ ...input, remoteCwd: missing })).rejects.toThrow("remote_workspace_operation_failed");
      expect(await fs.lstat(missing).catch(() => null)).toBeNull();
      await git(secondary, "remote", "add", "origin", "https://example.invalid/foreign.git");
      await expect(prepareRemoteRepository(input)).rejects.toThrow("remote_workspace_operation_failed");
      expect(resolveGitAuth).not.toHaveBeenCalled();
    } finally { await captured.cleanup(); }
  });

  it("keeps the preparation pin and later agent commits across the next admission", async () => {
    const origin = await repository(), { remote } = target(), root = path.join(workspace, "managed");
    const prepared = await prepareRemoteRepository({ target: remote, remoteCwd: root,
      repoUrl: origin, ref: "HEAD", resolveGitAuth: async () => null });
    await fs.writeFile(path.join(root, "source.txt"), "agent committed work\n");
    await git(root, "commit", "-am", "Agent progress");
    const head = (await git(root, "rev-parse", "HEAD")).stdout.trim();
    expect(head).not.toBe(prepared.pinnedCommit);
    await fs.writeFile(path.join(root, "untracked.txt"), "still in progress\n");
    await fs.rm(origin, { recursive: true, force: true });
    const resolveGitAuth = vi.fn(async () => { throw new Error("origin unavailable"); });
    expect(await prepareRemoteRepository({ target: remote, remoteCwd: root, repoUrl: origin,
      ref: "HEAD", pinnedCommit: prepared.pinnedCommit, resolveGitAuth })).toEqual(prepared);
    expect((await git(root, "rev-parse", "HEAD")).stdout.trim()).toBe(head);
    expect(await fs.readFile(path.join(root, "untracked.txt"), "utf8")).toBe("still in progress\n");
    expect(resolveGitAuth).not.toHaveBeenCalled();
  });

  it("uses trusted SSH rewrites only for clone and ignores ambient Git configuration", async () => {
    const origin = await repository({ revisions: true });
    const remoteUrl = "ssh://git@127.0.0.1:1/synthetic-repository";
    const rewrite = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${pathToFileURL(origin).href}.insteadOf`,
      GIT_CONFIG_VALUE_0: remoteUrl };
    const resolveGitAuth = async () => ({ configArgs: [], env: rewrite,
      source: "company_secret" as const, secretName: "SYNTHETIC_FIXTURE" });
    const { remote } = target({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "remote.origin.url",
      GIT_CONFIG_VALUE_0: "synthetic-wrong-ambient-origin" });
    const root = path.join(workspace, "rewritten-root");
    await prepareRemoteWorkspaceDirectory({ target: remote, remoteCwd: root,
      preparationIdentity: "a".repeat(64), source: { kind: "git", repoUrl: remoteUrl, ref: "HEAD~1" }, resolveGitAuth });
    expect(await fs.readFile(path.join(root, "source.txt"), "utf8")).toBe("initial synthetic source\n");
    const nested = path.join(workspace, "rewritten-repository");
    const receipt = await prepareRemoteRepository({ target: remote, remoteCwd: nested, repoUrl: remoteUrl,
      ref: "HEAD~1", resolveGitAuth });
    expect(await fs.readFile(path.join(nested, "source.txt"), "utf8")).toBe("initial synthetic source\n");
    expect((await git(nested, "config", "--get", "remote.origin.url")).stdout.trim()).toBe(remoteUrl);
    const unavailableAuth = vi.fn(async () => { throw new Error("unexpected credential lookup"); });
    await expect(prepareRemoteRepository({ target: remote, remoteCwd: nested, repoUrl: remoteUrl,
      ref: "HEAD~1", pinnedCommit: receipt.pinnedCommit, resolveGitAuth: unavailableAuth })).resolves.toEqual(receipt);
    expect(unavailableAuth).not.toHaveBeenCalled();
  });
});
