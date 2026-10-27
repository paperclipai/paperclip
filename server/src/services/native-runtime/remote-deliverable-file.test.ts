import { createHash } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
  let runner: Pick<CommandManagedRuntimeRunner, "execute">;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "paperclip-remote-file-")));
    workspaceRoot = join(root, "workspace");
    await mkdir(workspaceRoot);
    await writeFile(join(workspaceRoot, "checklist.md"), body);
    preload = undefined;
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
          signal: null, timedOut: Boolean(error?.killed), stdout, stderr,
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
