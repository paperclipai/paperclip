import { createHash } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { copyFile, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { MAX_REMOTE_DELIVERABLE_BYTES, readVerifiedRemoteWorkspaceFile } from "./remote-deliverable-file.js";

const digest = (body: Buffer) => createHash("sha256").update(body).digest("hex");
const image = "node:24-bookworm-slim";
const hasLinuxNode = process.platform === "linux" || spawnSync("docker", ["image", "inspect", image], { stdio: "ignore", timeout: 2_000 }).status === 0;
const body = Buffer.from("newsletter checklist\n");
const request = { workspaceRoot: "/workspace", contentRef: "checklist.md", byteSize: body.length, sha256: digest(body) };
const success = { pid: null, startedAt: "2026-09-12T00:00:00Z", exitCode: 0, signal: null, timedOut: false, stdout: body.toString("base64"), stderr: "" };

describe("remote deliverable admission", () => {
  it.each([
    { contentRef: "../secret" }, { contentRef: "/etc/passwd" }, { contentRef: "file:///etc/passwd" },
    { contentRef: "..\\secret" }, { contentRef: "." }, { contentRef: "x\0y" },
    { workspaceRoot: "relative" }, { byteSize: 0 }, { byteSize: MAX_REMOTE_DELIVERABLE_BYTES + 1 },
    { byteSize: 1.5 }, { sha256: "invalid" },
  ])("rejects invalid input before dispatch: %j", async (override) => {
    const execute = vi.fn();
    await expect(readVerifiedRemoteWorkspaceFile({ ...request, ...override, runner: { execute } })).rejects.toThrow(/paperclip_runner_file_handoff_/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("sanitizes a rejected remote transport error", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("/private/provider/details"));
    await expect(readVerifiedRemoteWorkspaceFile({ ...request, runner: { execute } }))
      .rejects.toThrow("paperclip_runner_file_handoff_remote_read_failed");
  });

  it.each(["path_denied", "symlink_denied", "file_changed", "hash_mismatch"])("preserves the safe %s error from either output stream", async (suffix) => {
    const code = `paperclip_runner_file_handoff_${suffix}`;
    for (const stream of ["stdout", "stderr"]) {
      const execute = vi.fn().mockResolvedValue({ ...success, exitCode: 1, stdout: "", stderr: "", [stream]: ` ${code}\n` });
      await expect(readVerifiedRemoteWorkspaceFile({ ...request, runner: { execute } })).rejects.toThrow(new Error(code));
    }
  });

  it("explains a missing task workspace file from either output stream without exposing paths", async () => {
    const code = "paperclip_runner_file_handoff_workspace_file_missing";
    for (const stream of ["stdout", "stderr"]) {
      const execute = vi.fn().mockResolvedValue({ ...success, exitCode: 1, stdout: "", stderr: "", [stream]: code });
      await expect(readVerifiedRemoteWorkspaceFile({ ...request, runner: { execute } })).rejects.toThrow(new Error(
        `${code}: Create or copy the file into get_workspace.cwd, then retry with a workspace-relative contentRef. AGENT_HOME is for personal instructions and memory.`,
      ));
    }
  });

  it.each([
    "/private/provider/details",
    "paperclip_runner_file_handoff_unknown_failure",
    "paperclip_runner_file_handoff_workspace_file_missing\n/private/provider/details",
    "warning: paperclip_runner_file_handoff_hash_mismatch",
    "paperclip_runner_file_handoff_hash_mismatch extra",
    "paperclip_runner_file_handoff_hash_mismatch\n/private/provider/details",
    "paperclip_runner_file_handoff_hash_mismatch\nAPI_KEY=private-value",
    '{"error":"paperclip_runner_file_handoff_hash_mismatch"}',
    "\u001b[31mpaperclip_runner_file_handoff_hash_mismatch\u001b[0m",
    "paperclip_runner_file_handoff_hash_mismatch\u0000",
  ])("does not expose unrecognized remote output: %j", async (output) => {
    for (const stream of ["stdout", "stderr"]) {
      const execute = vi.fn().mockResolvedValue({ ...success, exitCode: 1, stdout: "", stderr: "", [stream]: output });
      await expect(readVerifiedRemoteWorkspaceFile({ ...request, runner: { execute } }))
        .rejects.toThrow(new Error("paperclip_runner_file_handoff_remote_read_failed"));
    }
  });

  it.each([
    { stdout: "" }, { stdout: success.stdout + "\n" }, { stdout: "?".repeat(success.stdout.length) },
    { stdout: Buffer.alloc(body.length, 65).toString("base64") }, { timedOut: true }, { exitCode: 1, stderr: "/private/provider/details" },
  ])("rejects truncated, corrupt, or failed provider output: %j", async (override) => {
    const execute = vi.fn().mockResolvedValue({ ...success, ...override });
    await expect(readVerifiedRemoteWorkspaceFile({ ...request, runner: { execute } })).rejects.toThrow(/paperclip_runner_file_handoff_/);
  });
});

describe.skipIf(!hasLinuxNode)("remote deliverable real Linux descriptor reads", () => {
  let root: string;
  let workspaceRoot: string;
  let preload: string | undefined;
  let mergedOutput: boolean;
  let runner: Pick<CommandManagedRuntimeRunner, "execute">;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "paperclip-remote-file-")));
    workspaceRoot = join(root, "workspace");
    await mkdir(workspaceRoot);
    await writeFile(join(workspaceRoot, "checklist.md"), body);
    preload = undefined;
    mergedOutput = false;
    runner = { execute: vi.fn(async (input) => {
      const nodeArgs = [...(preload ? ["--require", preload] : []), ...(input.args ?? [])];
      const command = process.platform === "linux" ? process.execPath : "docker";
      const args = process.platform === "linux" ? nodeArgs : [
        "run", "--rm", "--platform", "linux/amd64", "--network", "none", "--read-only", "--cap-drop", "ALL",
        "-v", `${root}:${root}`, image, "node", ...nodeArgs,
      ];
      return await new Promise<Awaited<ReturnType<CommandManagedRuntimeRunner["execute"]>>>((resolve) => {
        execFile(command, args, { encoding: "utf8", timeout: input.timeoutMs, maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" } }, (error, stdout, stderr) => resolve({
          pid: null, startedAt: new Date().toISOString(), exitCode: error ? 1 : 0,
          signal: null, timedOut: Boolean(error?.killed),
          stdout: mergedOutput ? stdout + stderr : stdout, stderr: mergedOutput ? "" : stderr,
        }));
      });
    }) };
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("reads verified remote bytes without touching controller paths", async () => {
    const result = await readVerifiedRemoteWorkspaceFile({ ...request, workspaceRoot, runner });
    expect(result).toEqual(body);
    expect(runner.execute).toHaveBeenCalledWith(expect.objectContaining({
      command: "node", timeoutMs: 10_000, bypassSession: true,
      env: { NODE_OPTIONS: "", NODE_PATH: "" },
    }));
    expect(await readFile(join(workspaceRoot, "checklist.md"))).toEqual(body);
  });

  it("reads a 155-byte proof and preserves a real hash error through merged output", async () => {
    const proof = Buffer.from(JSON.stringify({
      nonce: "abcdefghijklmnopqrstuvwx", count: 7, total: 271391, sha256: "d".repeat(64),
    }, null, 2) + "\n");
    expect(proof.length).toBe(155);
    await writeFile(join(workspaceRoot, "connection-proof.json"), proof);
    mergedOutput = true;
    const input = { runner, workspaceRoot, contentRef: "connection-proof.json", byteSize: proof.length, sha256: digest(proof) };
    await expect(readVerifiedRemoteWorkspaceFile(input)).resolves.toEqual(proof);
    await expect(readVerifiedRemoteWorkspaceFile({ ...input, sha256: "0".repeat(64) }))
      .rejects.toThrow(new Error("paperclip_runner_file_handoff_hash_mismatch"));
  });

  it("requires an agent-home deliverable to be copied into the task workspace before registration", async () => {
    const proof = Buffer.from(JSON.stringify({
      nonce: "abcdefghijklmnopqrstuvwx", count: 7, total: 271391, sha256: "d".repeat(64),
    }, null, 2) + "\n");
    expect(proof.length).toBe(155);
    const agentHome = join(workspaceRoot, ".paperclip-runtime", "agent-files", "agent", "origin");
    await mkdir(agentHome, { recursive: true });
    await writeFile(join(agentHome, "connection-proof.json"), proof);
    mergedOutput = true;
    const input = { runner, workspaceRoot, contentRef: "connection-proof.json", byteSize: proof.length, sha256: digest(proof) };
    await expect(readVerifiedRemoteWorkspaceFile(input)).rejects.toThrow("paperclip_runner_file_handoff_workspace_file_missing");
    await expect(readFile(join(workspaceRoot, "connection-proof.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(agentHome, "connection-proof.json"))).toEqual(proof);
    await copyFile(join(agentHome, "connection-proof.json"), join(workspaceRoot, "connection-proof.json"));
    await expect(readVerifiedRemoteWorkspaceFile(input)).resolves.toEqual(proof);
    expect(await readFile(join(agentHome, "connection-proof.json"))).toEqual(proof);
  });

  it("does not classify an unavailable workspace root as a missing deliverable", async () => {
    await expect(readVerifiedRemoteWorkspaceFile({ ...request, workspaceRoot: join(root, "missing-workspace"), runner }))
      .rejects.toThrow(new Error("paperclip_runner_file_handoff_remote_read_failed"));
  });

  it("passes metacharacters as data, never shell syntax", async () => {
    const contentRef = "draft ' $(touch SHOULD_NOT_EXIST).md";
    await writeFile(join(workspaceRoot, contentRef), body);
    await expect(readVerifiedRemoteWorkspaceFile({ ...request, workspaceRoot, contentRef, runner })).resolves.toEqual(body);
    await expect(readFile(join(workspaceRoot, "SHOULD_NOT_EXIST"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["symlink", "parent symlink", "hardlink", "directory", "wrong size", "wrong hash"])("rejects %s without returning file bytes", async (scenario) => {
    let contentRef = "checklist.md";
    const values = { byteSize: body.length, sha256: digest(body) };
    await writeFile(join(root, "outside.md"), body);
    if (scenario === "symlink") { contentRef = "linked.md"; await symlink(join(root, "outside.md"), join(workspaceRoot, contentRef)); }
    if (scenario === "parent symlink") { await symlink(root, join(workspaceRoot, "linked")); contentRef = "linked/outside.md"; }
    if (scenario === "hardlink") { contentRef = "hard.md"; await link(join(root, "outside.md"), join(workspaceRoot, contentRef)); }
    if (scenario === "directory") { contentRef = "directory"; await mkdir(join(workspaceRoot, contentRef)); }
    if (scenario === "wrong size") values.byteSize++;
    if (scenario === "wrong hash") values.sha256 = "0".repeat(64);
    await expect(readVerifiedRemoteWorkspaceFile({ ...request, workspaceRoot, contentRef, runner, ...values })).rejects.toThrow(/paperclip_runner_file_handoff_/);
  });

  it.each(["replace", "grow", "hardlink"])("detects a %s during the descriptor read", async (mutation) => {
    preload = join(root, "mutate.cjs");
    await writeFile(preload, `
      const fs = require('node:fs/promises');
      const originalOpen = fs.open;
      fs.open = async (...args) => {
        const handle = await originalOpen(...args);
        const originalRead = handle.read.bind(handle);
        let changed = false;
        handle.read = async (...readArgs) => {
          const result = await originalRead(...readArgs);
          if (!changed) {
            changed = true;
            const file = args[0];
            if (${JSON.stringify(mutation)} === 'replace') { await fs.rename(file, file + '.old'); await fs.writeFile(file, Buffer.from(${JSON.stringify(body.toString("base64"))}, 'base64')); }
            if (${JSON.stringify(mutation)} === 'grow') await fs.appendFile(file, 'more');
            if (${JSON.stringify(mutation)} === 'hardlink') await fs.link(file, file + '.link');
          }
          return result;
        };
        return handle;
      };
    `);
    await expect(readVerifiedRemoteWorkspaceFile({ ...request, workspaceRoot, runner })).rejects.toThrow(/paperclip_runner_file_handoff_file_changed/);
  });

  it("accepts the 10 MiB limit with exact bytes and hash", async () => {
    const maximum = Buffer.alloc(MAX_REMOTE_DELIVERABLE_BYTES, 37);
    await writeFile(join(workspaceRoot, "maximum.bin"), maximum);
    const result = await readVerifiedRemoteWorkspaceFile({ runner, workspaceRoot, contentRef: "maximum.bin", byteSize: maximum.length, sha256: digest(maximum) });
    expect(result.equals(maximum)).toBe(true);
  }, 20_000);
});
