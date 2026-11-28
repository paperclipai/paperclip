import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { removeRemoteRecoveryAttachment, type RemoteWorkspaceTarget } from "./remote-workspace-transport.js";
import { retainRemoteRecoveryAttachments } from "./remote-workspace-recovery-attachments.js";

const exec = promisify(execFile);

describe("retired recovered copies with real sandbox commands", () => {
  let scratch: string;
  let workspace: string;
  beforeEach(async () => {
    scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "remote-recovery-attachments-")));
    workspace = path.join(scratch, "workspace");
    await fs.mkdir(workspace);
  });
  afterEach(async () => { await fs.rm(scratch, { recursive: true, force: true }); });

  function target() {
    const execute = vi.fn<CommandManagedRuntimeRunner["execute"]>(async input => {
      try {
        const result = await exec(input.command, input.args ?? [], {
          cwd: input.cwd ?? workspace, timeout: input.timeoutMs, env: { PATH: process.env.PATH, ...input.env } });
        return { stdout: result.stdout, stderr: result.stderr, exitCode: 0, timedOut: false, signal: null,
          pid: process.pid, startedAt: new Date().toISOString() };
      } catch (error) {
        const failure = error as { code?: number; stdout?: string; stderr?: string; signal?: string };
        return { exitCode: typeof failure.code === "number" ? failure.code : 1, stdout: failure.stdout ?? "",
          stderr: failure.stderr ?? "", timedOut: false, signal: failure.signal ?? null,
          pid: process.pid, startedAt: new Date().toISOString() };
      }
    });
    const transfer: NonNullable<CommandManagedRuntimeRunner["syncOut"]> = async () => ({ operations: [] });
    const runner: CommandManagedRuntimeRunner = { execute, syncOut: transfer, syncIn: transfer };
    return { remote: { kind: "remote", transport: "sandbox", remoteCwd: workspace, runner } as RemoteWorkspaceTarget, execute };
  }

  async function retiredCopy(state: "foreign" | "directory_symlink" | "present") {
    const operationId = randomUUID(), sourceRunId = randomUUID();
    const directory = path.join(workspace, ".paperclip-recovered", operationId);
    const provenance = JSON.stringify({ operationId, sourceRunId });
    await fs.mkdir(path.join(directory, "files"), { recursive: true });
    await fs.writeFile(path.join(directory, "files", "kept.txt"), "kept\n");
    await fs.writeFile(path.join(directory, "provenance.json"), state === "foreign" ? "foreign proof" : provenance);
    let outside = "";
    if (state === "directory_symlink") {
      outside = path.join(scratch, "outside-attachment");
      await fs.rename(directory, outside); await fs.symlink(outside, directory);
    }
    return { operationId, sourceRunId, directory, provenance, outside };
  }

  it.each([["foreign", "attachment_proof_changed"], ["directory_symlink", "unsafe_attachment"]] as const)(
    "names the closed reason a sandbox refused a removal for: %s", async (state, reason) => {
    const { operationId, provenance } = await retiredCopy(state);
    // The cause carries no sandbox path or file text.
    await expect(removeRemoteRecoveryAttachment({ target: target().remote, remoteCwd: workspace, operationId, provenance }))
      .rejects.toThrow(new RegExp(`^remote_workspace_operation_failed: operation=recovery_attachment exit=1; `
        + `remote_workspace_recovery_attachment_invalid: reason=${reason}$`));
  });

  it.each(["foreign", "directory_symlink", "present"] as const)(
    "continues preparation when a retired recovered copy cannot be removed: %s", async state => {
    const { operationId, sourceRunId, directory, provenance, outside } = await retiredCopy(state);
    const recoveredFiles: Parameters<typeof retainRemoteRecoveryAttachments>[0]["recoveredFiles"] = [];
    const item = { operationId, sourceRunId, path: `.paperclip-recovered/${operationId}`, provenance };
    // A recorded proof needs no database read; only the sandbox command runs.
    await expect(retainRemoteRecoveryAttachments({ db: {} as never, runId: randomUUID(), remoteRoot: workspace,
      target: target().remote, recoveredFiles, retiredOperationIds: new Set([operationId]),
      workspace: { id: randomUUID(), companyId: randomUUID(), sourceIssueId: null,
        metadata: { remoteWorkspaceRecoveredFiles: [{ ...item, retired: true }] } } })).resolves.toBeUndefined();
    // The copy stays retired, so it is never shown again, and is removed only with its exact proof.
    expect(recoveredFiles).toEqual([{ ...item, retired: true }]);
    if (state === "present") expect(await fs.lstat(directory).catch(() => null)).toBeNull();
    else expect(await fs.readFile(path.join(outside || directory, "files", "kept.txt"), "utf8")).toBe("kept\n");
  });

  it("does not hide a provider failure while removing a retired recovered copy", async () => {
    const operationId = randomUUID(), sourceRunId = randomUUID();
    const item = { operationId, sourceRunId, path: `.paperclip-recovered/${operationId}`, provenance: "{}", retired: true };
    const { remote, execute } = target();
    execute.mockRejectedValueOnce(new Error("sandbox connection reset"));
    await expect(retainRemoteRecoveryAttachments({ db: {} as never, runId: randomUUID(), remoteRoot: workspace,
      target: remote, recoveredFiles: [], retiredOperationIds: new Set([operationId]),
      workspace: { id: randomUUID(), companyId: randomUUID(), sourceIssueId: null,
        metadata: { remoteWorkspaceRecoveredFiles: [item] } } })).rejects.toThrow("sandbox connection reset");
  });
});
