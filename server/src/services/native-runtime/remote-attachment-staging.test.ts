import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { createRemoteAttachmentStager } from "./remote-attachment-staging.js";

const bytes = Buffer.from("synthetic PNG input\0\u00e9");
const success = { exitCode: 0, timedOut: false, stdout: '{"dev":"1","ino":"2"}', stderr: "", signal: null, pid: null, startedAt: null };

describe("remote attachment transport", () => {
  it.each(["/", "relative", "/workspace/../elsewhere", "/workspace/./child", "/workspace\\child"])("rejects unsafe root %s before transport", async root => {
    const execute = vi.fn();
    await expect(createRemoteAttachmentStager(root, { execute })({ body: bytes })).rejects.toThrow("path_denied");
    expect(execute).not.toHaveBeenCalled();
  });

  it("uses opaque run paths, a separate stdin body, bounded independent commands, and idempotent cleanup", async () => {
    const execute = vi.fn().mockResolvedValue(success);
    const result = await createRemoteAttachmentStager("/workspace", { execute })({ body: bytes, contentType: "image/png" });
    expect(result.workspaceRelativePath).toMatch(/^\.paperclip-inbound\/remote-[0-9a-f-]+\/content\.png$/);
    await result.cleanup(); await result.cleanup();
    expect(execute).toHaveBeenCalledTimes(2);
    const [stage] = execute.mock.calls[0]!;
    expect(stage).toMatchObject({ command: "node", cwd: "/workspace", stdin: bytes.toString("base64"), bypassSession: true,
      timeoutMs: 30_000, env: { NODE_OPTIONS: "", NODE_PATH: "" } });
    expect(stage.args.join(" ")).not.toContain(bytes.toString("base64"));
    expect(JSON.parse(execute.mock.calls[1]![0].args.at(-1))).toMatchObject({ phase: "cleanup", identity: { dev: "1", ino: "2" } });
  });

  it.each([{ timedOut: true }, { exitCode: 1 }, { stdout: "partial" }, { stdout: "{}" }])("never publishes a path after failed staging: %j", async fault => {
    const execute = vi.fn().mockResolvedValueOnce({ ...success, ...fault }).mockResolvedValue(success);
    await expect(createRemoteAttachmentStager("/workspace", { execute })({ body: bytes })).rejects.toThrow("staging_failed");
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("keeps failed cleanup retryable", async () => {
    const execute = vi.fn().mockResolvedValueOnce(success).mockResolvedValueOnce({ ...success, exitCode: 1 }).mockResolvedValue(success);
    const stage = await createRemoteAttachmentStager("/workspace", { execute })({ body: bytes });
    await expect(stage.cleanup()).rejects.toThrow("staging_failed");
    await stage.cleanup();
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("retains a failed staging cleanup until the run scope closes", async () => {
    const execute = vi.fn().mockRejectedValueOnce(new Error("private transport details"))
      .mockRejectedValueOnce(new Error("cleanup transport lost")).mockResolvedValue(success);
    const stager = createRemoteAttachmentStager("/workspace", { execute });
    await expect(stager({ body: bytes })).rejects.toThrow(new Error("paperclip_runner_attachment_staging_failed"));
    await stager.close();
    expect(execute).toHaveBeenCalledTimes(3);
    await expect(stager({ body: bytes })).rejects.toThrow("scope_closed");
  });

  it("joins an in-flight write on cancellation and never returns its path", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const execute = vi.fn().mockImplementationOnce(async () => { await gate; return success; }).mockResolvedValue(success);
    const stager = createRemoteAttachmentStager("/workspace", { execute });
    const writing = stager({ body: bytes }).catch(error => error);
    const closing = stager.close();
    expect(execute).toHaveBeenCalledTimes(1);
    release();
    expect(await writing).toBeInstanceOf(Error);
    await closing;
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

describe.skipIf(process.platform !== "linux")("remote attachment Linux workspace confinement", () => {
  let root: string;
  const execute: CommandManagedRuntimeRunner["execute"] = input => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, input.args, { cwd: input.cwd, env: { ...process.env, ...input.env }, stdio: "pipe" });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr, timedOut: false, pid: child.pid ?? null, startedAt: null }));
    child.stdin.on("error", () => {}); child.stdin.end(input.stdin ?? "");
  });
  beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), "remote-attachment-"))); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("preserves exact binary bytes for the provider and clears them after the turn", async () => {
    const stager = createRemoteAttachmentStager(root, { execute });
    const first = await stager({ body: bytes });
    const second = await stager({ body: Buffer.from("second turn") });
    expect(await readFile(join(root, first.workspaceRelativePath))).toEqual(bytes);
    expect(await readFile(join(root, second.workspaceRelativePath), "utf8")).toBe("second turn");
    await first.cleanup();
    expect(await readFile(join(root, first.workspaceRelativePath))).toEqual(Buffer.alloc(0));
    expect(await readFile(join(root, second.workspaceRelativePath), "utf8")).toBe("second turn");
    await second.cleanup();
  });

  it("refuses a symlinked inbound directory without touching its target", async () => {
    await mkdir(join(root, "outside"));
    await writeFile(join(root, "outside", "keep"), "keep");
    await symlink(join(root, "outside"), join(root, ".paperclip-inbound"));
    await expect(createRemoteAttachmentStager(root, { execute })({ body: bytes })).rejects.toThrow();
    expect(await readFile(join(root, "outside", "keep"), "utf8")).toBe("keep");
  });

  it("does not truncate a replacement file or follow a replacement symlink during cleanup", async () => {
    const stage = await createRemoteAttachmentStager(root, { execute })({ body: bytes });
    const target = join(root, stage.workspaceRelativePath);
    await rename(target, target + ".saved");
    await writeFile(target, "unrelated bytes");
    await expect(stage.cleanup()).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("unrelated bytes");
    await rm(target); await symlink(target + ".saved", target);
    await expect(stage.cleanup()).rejects.toThrow();
    expect(await readFile(target + ".saved")).toEqual(bytes);
    await rm(target); await rename(target + ".saved", target); await stage.cleanup();
  });

  it("rejects altered transport bytes and clears a lost successful staging acknowledgement", async () => {
    let lost = false;
    const runner = { execute: vi.fn<CommandManagedRuntimeRunner["execute"]>(async input => {
      const result = await execute(input);
      if (input.stdin && !lost) { lost = true; throw new Error("lost reply"); }
      return result;
    }) };
    await expect(createRemoteAttachmentStager(root, runner)({ body: bytes })).rejects.toThrow();
    const input = JSON.parse(runner.execute.mock.calls[0]![0].args!.at(-1)!);
    expect(await readFile(join(root, ".paperclip-inbound", input.slot, "content"))).toEqual(Buffer.alloc(0));
    const corrupt = { execute: (input: Parameters<typeof execute>[0]) => execute({ ...input, stdin: input.stdin ? "AAAA" : undefined }) };
    await expect(createRemoteAttachmentStager(root, corrupt)({ body: bytes })).rejects.toThrow();
  });
});
