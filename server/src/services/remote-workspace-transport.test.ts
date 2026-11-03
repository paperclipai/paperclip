import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import {
  captureRemoteWorkspaceArchive,
  cleanupRemoteWorkspaceArchive,
  prepareRemoteRepository,
  prepareRemoteWorkspaceDirectory,
  restoreRemoteWorkspaceDirectory,
  type RemoteWorkspaceTarget,
} from "./remote-workspace-transport.js";

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

  function target(ambientEnv: Record<string, string> = {}) {
    const execute = vi.fn<CommandManagedRuntimeRunner["execute"]>(async input => {
      try {
        const result = await exec(input.command, input.args ?? [], {
          cwd: input.cwd ?? workspace, timeout: input.timeoutMs, maxBuffer: 4 * 1024 * 1024,
          // Carry only generated fixture values across this execution boundary.
          env: { PATH: process.env.PATH, ...ambientEnv, ...input.env },
        });
        return { ...result, exitCode: 0, timedOut: false, signal: null, pid: process.pid, startedAt: new Date().toISOString() };
      } catch (error) {
        const failure = error as { code?: number; stdout?: string; stderr?: string; signal?: string };
        return { exitCode: typeof failure.code === "number" ? failure.code : 1, stdout: failure.stdout ?? "",
          stderr: failure.stderr ?? "", timedOut: false, signal: failure.signal ?? null,
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

  it("preserves only the fixed unfinished Git operation diagnostic across capture commands", async () => {
    await git(workspace, "init", "--initial-branch=main");
    await fs.writeFile(path.join(workspace, "work.txt"), "base\n"); await git(workspace, "add", "."); await git(workspace, "commit", "-m", "base");
    await git(workspace, "checkout", "-b", "feature");
    await fs.writeFile(path.join(workspace, "work.txt"), "feature\n"); await git(workspace, "commit", "-am", "feature");
    await git(workspace, "checkout", "main");
    await fs.writeFile(path.join(workspace, "work.txt"), "main\n"); await git(workspace, "commit", "-am", "main");
    await expect(git(workspace, "merge", "--no-edit", "feature")).rejects.toThrow();
    const { remote, execute } = target();
    const gitOperation = "remote_workspace_archive_git_operation_in_progress: finish or abort the Git operation before saving the workspace";
    const operationId = randomUUID();
    await expect(captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId })).rejects.toThrow(gitOperation);
    const directory = path.join(workspace, ".paperclip-runtime", "workspace-snapshots", operationId);
    for (const name of ["workspace.pcws", "receipt.json"]) await expect(fs.access(path.join(directory, name))).rejects.toMatchObject({ code: "ENOENT" });
    const failure = { exitCode: 1, stdout: "", stderr: `${gitOperation}\nSYNTHETIC_PRIVATE_PATH_OR_CREDENTIAL`,
      timedOut: false, signal: null, pid: process.pid, startedAt: new Date().toISOString() };
    execute.mockResolvedValueOnce(failure);
    await expect(captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId: randomUUID() }))
      .rejects.toThrow(/^remote_workspace_operation_failed$/);
    execute.mockResolvedValueOnce({ ...failure, timedOut: true, stderr: gitOperation });
    await expect(captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId: randomUUID() }))
      .rejects.toThrow(/^remote_workspace_operation_failed$/);
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
