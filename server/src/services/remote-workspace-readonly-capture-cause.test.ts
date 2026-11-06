import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { readWorkspaceFailureCause } from "./native-runtime/native-run-finalizer.js";
import { readonlyWorkspaceInventoryScript } from "./remote-workspace-readonly-inventory.js";
import { captureRemoteWorkspaceArchive, remoteWorkspaceFailureCause, type RemoteWorkspaceTarget } from "./remote-workspace-transport.js";
import { remoteWorkspaceSaveFailure } from "./remote-workspaces.js";

const exec = promisify(execFile);
const DISK_FULL = "remote_workspace_sandbox_disk_full: the sandbox disk is full; free space in the sandbox before saving the workspace";

describe("recorded cause of a failed full-disk read-only capture", () => {
  let scratch: string;
  let workspace: string;
  beforeEach(async () => {
    scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "remote-workspace-readonly-cause-")));
    workspace = path.join(scratch, "workspace");
    await fs.mkdir(workspace);
  });
  afterEach(async () => { await fs.rm(scratch, { recursive: true, force: true }); });

  // Real sandbox commands, except that the normal capture reports a full disk.
  function target(syncOut?: CommandManagedRuntimeRunner["syncOut"]) {
    const execute = vi.fn<CommandManagedRuntimeRunner["execute"]>(async input => {
      const result = await exec(input.command, input.args ?? [], {
        cwd: input.cwd ?? workspace, timeout: input.timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { PATH: process.env.PATH, ...input.env },
      }).then(output => ({ ...output, exitCode: 0 }), (error: { code?: number; stdout?: string; stderr?: string }) =>
        ({ stdout: error.stdout ?? "", stderr: error.stderr ?? "", exitCode: typeof error.code === "number" ? error.code : 1 }));
      return { ...result, timedOut: false, signal: null, pid: process.pid, startedAt: new Date().toISOString() };
    });
    execute.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: DISK_FULL, timedOut: false, signal: null,
      pid: process.pid, startedAt: new Date().toISOString() });
    const copy: NonNullable<CommandManagedRuntimeRunner["syncOut"]> = syncOut ?? (async operations => {
      const file = operations[0]!.files[0]!;
      await fs.cp(file.sourcePath, file.targetPath, { recursive: true, verbatimSymlinks: true });
      return { operations: [] };
    });
    const runner: CommandManagedRuntimeRunner = { execute, syncOut: vi.fn(copy), syncIn: copy };
    return { kind: "remote", transport: "sandbox", remoteCwd: workspace, runner } as RemoteWorkspaceTarget;
  }

  const capture = (remote: RemoteWorkspaceTarget) =>
    captureRemoteWorkspaceArchive({ target: remote, remoteCwd: workspace, operationId: randomUUID() }).then(
      () => { throw new Error("expected the capture to fail"); }, (error: Error) => error);

  it("names where the fallback stopped and keeps the disk-full code", async () => {
    await fs.writeFile(path.join(workspace, "saved.txt"), "retained work\n");
    const failure = await capture(target(async operations => {
      const file = operations[0]!.files[0]!;
      await fs.cp(file.sourcePath, file.targetPath, { recursive: true, verbatimSymlinks: true });
      await fs.writeFile(path.join(workspace, "saved.txt"), "newer work\n");
      return { operations: [] };
    }));
    expect(failure.message).toBe(DISK_FULL);
    const cause = remoteWorkspaceFailureCause(failure);
    expect(cause).toBe(`${DISK_FULL}; remote_workspace_readonly_capture_failed: stage=verify reason=source_changed transport=provider_error`);
    expect(remoteWorkspaceSaveFailure(failure)).toEqual({ code: "remote_workspace_sandbox_disk_full", cause });
    expect(readWorkspaceFailureCause(cause)).toBe(cause);
  });

  it("names a linked worktree refusal from the sandbox inventory before any transfer", async () => {
    await fs.writeFile(path.join(workspace, ".git"), "gitdir: /elsewhere/.git/worktrees/task\n");
    await fs.writeFile(path.join(workspace, "saved.txt"), "retained work\n");
    const remote = target();
    const failure = await capture(remote);
    expect(remoteWorkspaceFailureCause(failure))
      .toBe(`${DISK_FULL}; remote_workspace_readonly_capture_failed: stage=inspect reason=unsafe_source transport=provider_error`);
    expect(remote.runner!.syncOut).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("names an unreadable source file by errno only", async () => {
    const secret = path.join(workspace, "SYNTHETIC_PRIVATE_NAME.txt");
    await fs.writeFile(secret, "retained work\n"); await fs.chmod(secret, 0o000);
    try {
      await expect(exec(process.execPath, ["-e", readonlyWorkspaceInventoryScript(), workspace], { timeout: 3000 }))
        .rejects.toMatchObject({ code: 1, stderr: "remote_workspace_readonly_capture_fs_eacces" });
      const cause = remoteWorkspaceFailureCause(await capture(target()));
      expect(cause).toMatch(/^remote_workspace_sandbox_disk_full: .*; remote_workspace_readonly_capture_failed: stage=inspect reason=fs_eacces transport=[a-z_]+$/);
      expect(cause).not.toMatch(/SYNTHETIC|PRIVATE/);
    } finally { await fs.chmod(secret, 0o600); }
  });

  it("does not attach a cause outside the fallback grammar", () => {
    const failure = new Error(DISK_FULL, { cause: new Error("remote_workspace_readonly_capture_failed: stage=inspect reason=x /private/path") });
    expect(remoteWorkspaceFailureCause(failure)).toBe(DISK_FULL);
  });
});
