import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import * as archiveOwner from "./remote-workspace-snapshot-archive.js";
import { readWorkspaceInventory } from "./remote-workspace-readonly-inventory.js";
import { captureRemoteWorkspaceArchive, REMOTE_WORKSPACE_SANDBOX_DISK_FULL, type RemoteWorkspaceTarget } from "./remote-workspace-transport.js";

const exec = promisify(execFile);
let root: string;
let source: string;
async function git(cwd: string, ...args: string[]) {
  return exec("git", ["-C", cwd, "-c", "user.name=Budget fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    maxBuffer: 32 * 1024 ** 2,
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  });
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "readonly-capture-budget-")));
  source = path.join(root, "source");
  await fs.mkdir(source);
  await git(source, "init", "--initial-branch=main");
  for (let directory = 0; directory < 10; directory++) {
    const current = path.join(source, `part-${directory}`);
    await fs.mkdir(current);
    for (let file = 0; file < 40; file++) await fs.writeFile(path.join(current, `item-${file}.txt`), Buffer.alloc(4096, file));
  }
  await fs.writeFile(path.join(source, "result.bin"), Buffer.alloc(8 * 1024 ** 2, 97));
  await git(source, "add", ".");
  await git(source, "commit", "-m", "Synthetic source");
  await fs.writeFile(path.join(source, "result.bin"), Buffer.alloc(8 * 1024 ** 2, 98));
  await git(source, "add", "result.bin");
  await fs.writeFile(path.join(source, "untracked.txt"), "final dirty workspace bytes\n");
  await fs.symlink("untracked.txt", path.join(source, "result-link"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

it("seals and restores the actual standalone source within a fresh existing verification budget", async () => {
  const before = await readWorkspaceInventory(source);
  const archivePath = path.join(root, "control.pcws");
  const saved = await archiveOwner.captureRemoteWorkspaceDirectory({ cwd: source, archivePath,
    exclude: before.exclude, signal: AbortSignal.timeout(120_000) });
  const restored = path.join(root, "restored");
  await archiveOwner.restoreRemoteWorkspaceArchive({ archivePath, targetDir: restored, expectedManifestDigest: saved.manifestDigest });
  expect((await git(restored, "rev-parse", "HEAD")).stdout).toBe((await git(source, "rev-parse", "HEAD")).stdout);
  expect(createHash("sha256").update(await fs.readFile(path.join(restored, "result.bin"))).digest("hex"))
    .toBe(createHash("sha256").update(await fs.readFile(path.join(source, "result.bin"))).digest("hex"));
  expect((await git(restored, "show", ":result.bin")).stdout).toBe((await git(source, "show", ":result.bin")).stdout);
  expect(await fs.readFile(path.join(restored, "untracked.txt"), "utf8")).toBe("final dirty workspace bytes\n");
  expect(await fs.readlink(path.join(restored, "result-link"))).toBe("untracked.txt");
  await git(restored, "fsck", "--full");
  expect(await readWorkspaceInventory(source)).toEqual(before);
}, 30_000);


it.each(["separate_capture", "inventory_expired", "capture_deadline", "capture_cancelled", "final_inventory_expired"] as const)(
  "keeps read-only capture phase budgets and source safety: %s", async scenario => {
  const before = await readWorkspaceInventory(source);
  let advancedMs = 0;
  vi.spyOn(performance, "now").mockImplementation(() => advancedMs);
  const deadlines: Array<{ ms: number; controller: AbortController }> = [];
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const controller = new AbortController();
    deadlines.push({ ms, controller });
    return controller.signal;
  });
  const actualCapture = archiveOwner.captureRemoteWorkspaceDirectory;
  let archiveCompleted = false;
  const capture = vi.spyOn(archiveOwner, "captureRemoteWorkspaceDirectory").mockImplementation(async input => {
    expect(deadlines[0]!.ms).toBe(120_000);
    expect(deadlines[1]!.ms).toBe(300_000);
    expect(input.signal).toBe(deadlines[1]!.controller.signal);
    advancedMs += 5_000;
    deadlines[0]!.controller.abort(new DOMException("Metadata timeout", "TimeoutError"));
    let interruption: ReturnType<typeof setTimeout> | undefined;
    if (scenario === "capture_deadline" || scenario === "capture_cancelled") {
      interruption = setTimeout(() => {
        advancedMs += 300_000;
        deadlines[1]!.controller.abort(new DOMException("Capture interrupted",
          scenario === "capture_deadline" ? "TimeoutError" : "AbortError"));
      }, 10);
    }
    try {
      const result = await actualCapture(input);
      archiveCompleted = true;
      return result;
    } finally { if (interruption) clearTimeout(interruption); }
  });
  let inventoryCalls = 0;
  let copiedRoot = "";
  const execute: CommandManagedRuntimeRunner["execute"] = async input => {
    if (!input.args?.[1]?.includes("const inspect=")) return { exitCode: 1, stdout: "",
      stderr: REMOTE_WORKSPACE_SANDBOX_DISK_FULL, timedOut: false, signal: null,
      pid: process.pid, startedAt: new Date().toISOString() };
    const result = await exec(input.command, input.args, { cwd: input.cwd, timeout: 30_000,
      maxBuffer: 4 * 1024 ** 2, env: { PATH: process.env.PATH, ...input.env } });
    inventoryCalls++;
    if (inventoryCalls === 2) {
      advancedMs += 118_000;
      if (scenario === "inventory_expired") deadlines[0]!.controller.abort(new DOMException("Metadata timeout", "TimeoutError"));
    }
    if (inventoryCalls === 3) {
      expect(input.timeoutMs).toBe(2_000);
      if (scenario === "final_inventory_expired") {
        advancedMs += 2_000;
        deadlines[2]!.controller.abort(new DOMException("Metadata timeout", "TimeoutError"));
      }
    }
    return { ...result, exitCode: 0, timedOut: false, signal: null, pid: process.pid, startedAt: new Date().toISOString() };
  };
  const syncOut: NonNullable<CommandManagedRuntimeRunner["syncOut"]> = async operations => {
    for (const operation of operations) for (const file of operation.files) {
      copiedRoot = file.targetPath;
      await fs.cp(file.sourcePath, file.targetPath, { recursive: true, verbatimSymlinks: true,
        filter: current => !file.exclude?.some(excluded => {
          const relative = path.relative(file.sourcePath, current).split(path.sep).join("/");
          return relative === excluded || relative.startsWith(`${excluded}/`);
        }) });
    }
    return { operations: operations.map(operation => ({ operationId: operation.operationId,
      filesTransferred: operation.files.length, bytesTransferred: before.byteSize })) };
  };
  const target: RemoteWorkspaceTarget = { kind: "remote", transport: "sandbox", remoteCwd: source,
    runner: { execute, syncOut, syncIn: syncOut } };
  let failure: unknown;
  const saved = await captureRemoteWorkspaceArchive({ target, remoteCwd: source, operationId: randomUUID() })
    .catch(error => { failure = error; return null; });
  try {
    expect(await readWorkspaceInventory(source)).toEqual(before);
    if (scenario === "separate_capture") {
      expect(failure).toBeUndefined();
      expect(saved).not.toBeNull();
      expect(archiveCompleted).toBe(true);
      expect(inventoryCalls).toBe(3);
      expect(deadlines.map(item => item.ms).slice(0, 2)).toEqual([120_000, 300_000]);
      const restored = path.join(root, "restored-fallback");
      await archiveOwner.restoreRemoteWorkspaceArchive({ archivePath: saved!.archivePath,
        targetDir: restored, expectedManifestDigest: saved!.manifestDigest });
      expect(await fs.readFile(path.join(restored, "untracked.txt"), "utf8")).toBe("final dirty workspace bytes\n");
      expect(await fs.readlink(path.join(restored, "result-link"))).toBe("untracked.txt");
      expect((await git(restored, "rev-parse", "HEAD")).stdout).toBe((await git(source, "rev-parse", "HEAD")).stdout);
      expect((await git(restored, "show", ":result.bin")).stdout).toBe((await git(source, "show", ":result.bin")).stdout);
      await git(restored, "fsck", "--full");
    } else {
      expect(saved).toBeNull();
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(REMOTE_WORKSPACE_SANDBOX_DISK_FULL);
      const stage = scenario === "inventory_expired" || scenario === "final_inventory_expired" ? "verify" : "archive";
      expect((failure as Error).cause).toMatchObject({ message: expect.stringContaining(`stage=${stage} reason=operation_failed`) });
      expect(await fs.lstat(copiedRoot).catch(() => null)).toBeNull();
      if (scenario === "inventory_expired") expect(capture).not.toHaveBeenCalled();
      if (scenario === "final_inventory_expired") expect(archiveCompleted).toBe(true);
      if (scenario.startsWith("capture_")) expect(archiveCompleted).toBe(false);
    }
  } finally { await saved?.cleanup(); }
}, 30_000);
