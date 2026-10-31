import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { createArtifactInstaller } from "./artifact-transfer.js";

type Runner = Pick<CommandManagedRuntimeRunner, "execute">;
// Executes the actual wire command on a real Linux filesystem. This simulates
// only the provider transport, not the installer or its verification result.
const execute: Runner["execute"] = input => new Promise((resolve, reject) => {
  const child = spawn(input.command, input.args, { cwd: input.cwd, env: { ...process.env, ...input.env }, stdio: "pipe" });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
  child.on("error", reject); child.on("close", (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr, timedOut: false, pid: child.pid ?? null, startedAt: null }));
  child.stdin.on("error", () => {}); child.stdin.end(input.stdin ?? "");
});

describe.skipIf(process.platform !== "linux")("artifact filesystem installation", () => {
  let root: string;
  const bytes = Buffer.from('Synthetic only: 🧭é"\\\n\u0000\n'.repeat(15000));
  const identity = { byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  const request = () => ({ bytes, ...identity, destination: "result.bin", authorize: vi.fn(async () => {}) });
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "artifact-install-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("uses the lease-owned runner, no shell credentials, and independently verified files", async () => {
    const runner = { execute: vi.fn(execute) };
    const install = createArtifactInstaller(root, runner);
    await install(request());
    expect((await readFile(join(root, "result.bin"))).equals(bytes)).toBe(true);
    expect(await readdir(root)).toEqual(["result.bin"]);
    for (const [call] of runner.execute.mock.calls) {
      expect(call.command).toBe("node"); expect(call.bypassSession).toBe(true);
      expect(call.args!.join(" ")).not.toContain(bytes.toString("base64"));
      expect(call.env).toEqual({ NODE_OPTIONS: "", NODE_PATH: "" });
    }
  });

  it.each(["../escape", "/tmp/escape", "a/../escape", "a//escape", "a\\escape", ".paperclip/state", ".git/config", ".paperclip-artifact-owned"])("rejects destination %s before dispatch", async destination => {
    const runner = { execute: vi.fn(execute) };
    await expect(createArtifactInstaller(root, runner)({ ...request(), destination })).rejects.toThrow("path_denied");
    expect(runner.execute).not.toHaveBeenCalled();
  });

  it("rejects parent and destination symlinks and preserves their targets", async () => {
    await mkdir(join(root, "safe")); await symlink("safe", join(root, "alias"));
    const install = createArtifactInstaller(root);
    await expect(install({ ...request(), destination: "alias/result.bin" })).rejects.toThrow();
    await writeFile(join(root, "safe", "keep.bin"), "keep");
    await symlink("safe/keep.bin", join(root, "result.bin"));
    await expect(install(request())).rejects.toThrow();
    expect(await readFile(join(root, "safe", "keep.bin"), "utf8")).toBe("keep");
  });

  it("never overwrites a conflicting destination", async () => {
    await writeFile(join(root, "result.bin"), "keep");
    await expect(createArtifactInstaller(root)(request())).rejects.toThrow();
    expect(await readFile(join(root, "result.bin"), "utf8")).toBe("keep");
    expect(await readdir(root)).toEqual(["result.bin"]);
  });

  it("rejects an incorrect identity before touching the filesystem", async () => {
    await expect(createArtifactInstaller(root)({ ...request(), sha256: "0".repeat(64) })).rejects.toThrow("identity_mismatch");
    expect(await readdir(root)).toEqual([]);
  });

  it.each(["truncate", "corrupt"])("rejects %s in the transport without publishing a destination", async fault => {
    const runner = { execute: vi.fn<Runner["execute"]>(input => execute({ ...input, stdin: input.stdin ? (fault === "truncate" ? input.stdin.slice(0, -4) : "A" + input.stdin.slice(1)) : input.stdin })) };
    await expect(createArtifactInstaller(root, runner)(request())).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });

  it("reauthorizes before promotion and removes staged content on revocation", async () => {
    let checks = 0;
    await expect(createArtifactInstaller(root)({ ...request(), authorize: async () => { if (++checks === 2) throw new Error("revoked"); } })).rejects.toThrow("revoked");
    expect(await readdir(root)).toEqual([]);
  });

  it("recovers an unknown commit acknowledgement only by verifying the same identity", async () => {
    let lost = false;
    const runner = { execute: vi.fn<Runner["execute"]>(async input => {
      const result = await execute(input);
      if (!lost && input.args?.at(-1)?.includes('"phase":"commit"')) { lost = true; throw new Error("transport lost after commit"); }
      return result;
    }) };
    const install = createArtifactInstaller(root, runner);
    await expect(install(request())).rejects.toThrow("not confirmed");
    expect((await readFile(join(root, "result.bin"))).equals(bytes)).toBe(true);
    await install(request());
    expect(await readdir(root)).toEqual(["result.bin"]);
  });

  it("does not publish when the provider fails during staging, and permits a clean retry", async () => {
    let interrupted = false;
    const runner = { execute: vi.fn<Runner["execute"]>(async input => {
      if (!interrupted && input.stdin) { interrupted = true; throw new Error("interrupted"); }
      return execute(input);
    }) };
    const install = createArtifactInstaller(root, runner);
    await expect(install(request())).rejects.toThrow("artifact_install_failed");
    expect(await readdir(root)).toEqual([]);
    await install(request());
    expect((await readFile(join(root, "result.bin"))).equals(bytes)).toBe(true);
  });
});
