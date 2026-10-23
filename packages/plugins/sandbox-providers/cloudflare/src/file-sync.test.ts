import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareBridgeError } from "./bridge-client.js";
import {
  buildRemoteExtractCommand,
  buildRemoteTarCommand,
  performSyncIn,
  performSyncOut,
  UPLOAD_PART_BYTES,
  type FileSyncBridge,
  type FileSyncContext,
} from "./file-sync.js";

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function okExec() {
  return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
}

let tmp: string;

function context(bridge: Partial<FileSyncBridge>): FileSyncContext {
  return {
    bridge: {
      downloadFile: vi.fn(),
      uploadFile: vi.fn(),
      execute: vi.fn().mockResolvedValue(okExec()),
      ...bridge,
    } as FileSyncBridge,
    providerLeaseId: "pc-run-1-abcd1234",
    commandCwd: "/",
    timeoutMs: 60_000,
    sessionStrategy: "named",
    sessionId: "paperclip-bridge",
    sleep: async () => undefined,
  };
}

describe("Cloudflare native file sync", () => {
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cf-sync-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("streams a sandbox file to the host target with the requested mode", async () => {
    const bytes = new Uint8Array([0, 1, 2, 0, 255]);
    const downloadFile = vi.fn(async (input: { consume: (body: ReadableStream<Uint8Array>) => Promise<void> }) => {
      await input.consume(streamOf(bytes));
    });
    const target = path.join(tmp, "out", "bundle.git");

    const result = await performSyncOut(context({ downloadFile }), [
      {
        operationId: "op-1",
        files: [{ sourcePath: "/workspace/.paperclip-runtime/bundle.git", targetPath: target, kind: "file", mode: 0o600 }],
      },
    ]);

    expect(result).toEqual({ operations: [{ operationId: "op-1", filesTransferred: 1, bytesTransferred: 5 }] });
    expect(new Uint8Array(await fs.readFile(target))).toEqual(bytes);
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
    expect(downloadFile).toHaveBeenCalledWith(
      expect.objectContaining({ providerLeaseId: "pc-run-1-abcd1234", path: "/workspace/.paperclip-runtime/bundle.git" }),
    );
    expect((await fs.readdir(path.dirname(target))).filter((name) => name.includes("paperclip-download"))).toEqual([]);
  });

  it("archives a sandbox directory, streams it once, and extracts it on the host", async () => {
    const fixture = path.join(tmp, "fixture");
    await fs.mkdir(path.join(fixture, "src"), { recursive: true });
    await fs.writeFile(path.join(fixture, "src", "a.txt"), "hello");
    await fs.writeFile(path.join(fixture, ".hidden"), "dot");
    const archive = path.join(tmp, "fixture.tar");
    execFileSync("tar", ["-cf", archive, "-C", fixture, "src", ".hidden"]);
    const archiveBytes = new Uint8Array(await fs.readFile(archive));

    const execute = vi.fn().mockResolvedValue(okExec());
    const downloadFile = vi.fn(async (input: { path: string; consume: (body: ReadableStream<Uint8Array>) => Promise<void> }) => {
      await input.consume(streamOf(archiveBytes));
    });
    const target = path.join(tmp, "restored");

    const result = await performSyncOut(context({ downloadFile, execute }), [
      {
        operationId: "op-dir",
        files: [{ sourcePath: "/workspace/paperclip", targetPath: target, kind: "directory", exclude: ["node_modules"] }],
      },
    ]);

    expect(result.operations[0]).toMatchObject({ operationId: "op-dir", filesTransferred: 1, bytesTransferred: archiveBytes.byteLength });
    expect(await fs.readFile(path.join(target, "src", "a.txt"), "utf8")).toBe("hello");
    expect(await fs.readFile(path.join(target, ".hidden"), "utf8")).toBe("dot");
    expect(downloadFile).toHaveBeenCalledTimes(1);
    const tarScript = (execute.mock.calls[0]?.[0] as { args: string[] }).args[1]!;
    expect(tarScript).toContain("cd '/workspace/paperclip'");
    expect(tarScript).toContain("--exclude 'node_modules'");
    const remoteArchive = (downloadFile.mock.calls[0]?.[0] as { path: string }).path;
    expect(remoteArchive).toMatch(/^\/tmp\/\.paperclip-sync-out-[0-9a-f-]+\.tar$/);
    const cleanup = (execute.mock.calls.at(-1)?.[0] as { args: string[] }).args[1]!;
    expect(cleanup).toContain(remoteArchive);
  });

  it("retries a transient download failure and then succeeds", async () => {
    let calls = 0;
    const downloadFile = vi.fn(async (input: { consume: (body: ReadableStream<Uint8Array>) => Promise<void> }) => {
      calls += 1;
      if (calls === 1) {
        throw new CloudflareBridgeError({ status: 503, message: "Durable Object is overloaded. Requests queued for too long." });
      }
      await input.consume(streamOf(new Uint8Array([9, 9])));
    });
    const target = path.join(tmp, "retry.bin");

    await performSyncOut(context({ downloadFile }), [
      { operationId: "op", files: [{ sourcePath: "/tmp/x", targetPath: target, kind: "file" }] },
    ]);

    expect(downloadFile).toHaveBeenCalledTimes(2);
    expect(new Uint8Array(await fs.readFile(target))).toEqual(new Uint8Array([9, 9]));
  });

  it("does not retry a missing sandbox file", async () => {
    const downloadFile = vi.fn().mockRejectedValue(new CloudflareBridgeError({ status: 404, message: "No sandbox file" }));
    await expect(
      performSyncOut(context({ downloadFile }), [
        { operationId: "op", files: [{ sourcePath: "/tmp/x", targetPath: path.join(tmp, "x"), kind: "file" }] },
      ]),
    ).rejects.toThrow("No sandbox file");
    expect(downloadFile).toHaveBeenCalledTimes(1);
  });

  it("uploads a host file, applies its mode, then runs post-upload commands in order", async () => {
    const source = path.join(tmp, "workspace.tar");
    await fs.writeFile(source, Buffer.from([1, 2, 3, 0]));
    const uploadFile = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn().mockResolvedValue(okExec());

    const result = await performSyncIn(context({ uploadFile, execute }), [
      {
        operationId: "op-in",
        files: [{ sourcePath: source, targetPath: "/workspace/.paperclip-runtime/workspace.tar", kind: "file", mode: 0o600 }],
        postUploadCommands: [
          { command: "tar -xf /workspace/.paperclip-runtime/workspace.tar" },
          { command: "rm -f /workspace/.paperclip-runtime/workspace.tar", cwd: "/workspace/.paperclip-runtime", timeoutMs: 5_000 },
        ],
      },
    ]);

    expect(result.operations[0]).toEqual({ operationId: "op-in", filesTransferred: 1, bytesTransferred: 4 });
    const staged = (uploadFile.mock.calls[0]?.[0] as { path: string }).path;
    expect(staged).toMatch(/^\/workspace\/\.paperclip-runtime\/workspace\.tar\.paperclip-upload\.[0-9a-f-]+$/);
    const scripts = execute.mock.calls.map((call) => (call[0] as { args: string[] }).args[1]);
    expect(scripts).toEqual([
      `mv -f '${staged}' '/workspace/.paperclip-runtime/workspace.tar'`,
      "chmod 600 '/workspace/.paperclip-runtime/workspace.tar'",
      "tar -xf /workspace/.paperclip-runtime/workspace.tar",
      "rm -f /workspace/.paperclip-runtime/workspace.tar",
    ]);
    expect(execute.mock.calls[3]?.[0]).toMatchObject({ cwd: "/workspace/.paperclip-runtime", timeoutMs: 5_000 });
    expect(execute.mock.calls[2]?.[0]).toMatchObject({ cwd: "/", sessionId: "paperclip-bridge" });
  });

  it("stops at the first failing post-upload command", async () => {
    const source = path.join(tmp, "f");
    await fs.writeFile(source, "x");
    const execute = vi
      .fn()
      .mockResolvedValueOnce(okExec())
      .mockResolvedValueOnce({ ...okExec(), exitCode: 2, stderr: "tar: broken" })
      .mockResolvedValue(okExec());

    await expect(
      performSyncIn(context({ uploadFile: vi.fn().mockResolvedValue(undefined), execute }), [
        {
          operationId: "op",
          files: [{ sourcePath: source, targetPath: "/tmp/f", kind: "file" }],
          postUploadCommands: [{ command: "false-one" }, { command: "never-runs" }],
        },
      ]),
    ).rejects.toThrow(/post-upload command failed \(exit 2\): tar: broken/);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("splits uploads larger than one part and assembles them in the sandbox", async () => {
    const source = path.join(tmp, "big.bin");
    const size = UPLOAD_PART_BYTES * 2 + 10;
    const handle = await fs.open(source, "w");
    await handle.truncate(size);
    await handle.close();
    const uploads: Array<{ path: string; length: number }> = [];
    const uploadFile = vi.fn(async (input: { path: string; bytes: Uint8Array }) => {
      uploads.push({ path: input.path, length: input.bytes.byteLength });
    });
    const execute = vi.fn().mockResolvedValue(okExec());

    const result = await performSyncIn(context({ uploadFile, execute }), [
      { operationId: "op", files: [{ sourcePath: source, targetPath: "/workspace/big.bin", kind: "file" }] },
    ]);

    expect(result.operations[0]?.bytesTransferred).toBe(size);
    expect(uploads.map((upload) => upload.length)).toEqual([UPLOAD_PART_BYTES, UPLOAD_PART_BYTES, 10]);
    expect(uploads.every((upload) => upload.path.startsWith("/workspace/big.bin.paperclip-part."))).toBe(true);
    const assemble = (execute.mock.calls[0]?.[0] as { args: string[] }).args[1]!;
    expect(assemble).toMatch(/^cat '.*\.0' '.*\.1' '.*\.2' > '\/workspace\/big\.bin\.paperclip-upload\.[0-9a-f-]+' && mv -f /);
    const cleanup = (execute.mock.calls.at(-1)?.[0] as { args: string[] }).args[1]!;
    expect(cleanup.startsWith("rm -f -- ")).toBe(true);
  }, 30_000);

  it("uploads a host directory as one archive and extracts it in place", async () => {
    const dir = path.join(tmp, "assets");
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "a.txt"), "a");
    const uploadFile = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn().mockResolvedValue(okExec());

    await performSyncIn(context({ uploadFile, execute }), [
      { operationId: "op", files: [{ sourcePath: dir, targetPath: "/workspace/assets", kind: "directory" }] },
    ]);

    const staged = (uploadFile.mock.calls[0]?.[0] as { path: string }).path;
    expect(staged).toMatch(/^\/workspace\/assets\.paperclip-syncin\.tar\.[0-9a-f-]+\.paperclip-upload\.[0-9a-f-]+$/);
    const archive = staged.replace(/\.paperclip-upload\.[0-9a-f-]+$/, "");
    const extract = (execute.mock.calls[1]?.[0] as { args: string[] }).args[1]!;
    expect(extract).toBe(buildRemoteExtractCommand({ archivePath: archive, targetDir: "/workspace/assets" }));
  });

  it("stages a small upload and leaves the target untouched when the upload fails", async () => {
    const source = path.join(tmp, "small.bin");
    await fs.writeFile(source, "abc");
    const uploadFile = vi.fn().mockRejectedValue(new CloudflareBridgeError({ status: 400, message: "bad request" }));
    const execute = vi.fn().mockResolvedValue(okExec());

    await expect(
      performSyncIn(context({ uploadFile, execute }), [
        { operationId: "op", files: [{ sourcePath: source, targetPath: "/workspace/keep.bin", kind: "file" }] },
      ]),
    ).rejects.toThrow("bad request");

    const staged = (uploadFile.mock.calls[0]?.[0] as { path: string }).path;
    expect(staged).not.toBe("/workspace/keep.bin");
    const scripts = execute.mock.calls.map((call) => (call[0] as { args: string[] }).args[1]);
    expect(scripts.some((script) => script.includes("mv -f"))).toBe(false);
    expect(scripts).toContain(`rm -f -- '${staged}'`);
  });

  it("retries a repeatable sandbox command after a transient bridge overload", async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new CloudflareBridgeError({ status: 503, message: "Durable Object is overloaded." }))
      .mockResolvedValue(okExec());
    const downloadFile = vi.fn(async (input: { consume: (body: ReadableStream<Uint8Array>) => Promise<void> }) => {
      const dir = path.join(tmp, "src");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "a.txt"), "a");
      const archive = path.join(tmp, "a.tar");
      execFileSync("tar", ["-cf", archive, "-C", dir, "a.txt"]);
      await input.consume(streamOf(new Uint8Array(await fs.readFile(archive))));
    });

    await performSyncOut(context({ execute, downloadFile }), [
      { operationId: "op", files: [{ sourcePath: "/workspace/paperclip", targetPath: path.join(tmp, "out"), kind: "directory" }] },
    ]);

    const archiveCalls = execute.mock.calls.filter((call) => (call[0] as { args: string[] }).args[1]!.startsWith("cd "));
    expect(archiveCalls).toHaveLength(2);
    expect(await fs.readFile(path.join(tmp, "out", "a.txt"), "utf8")).toBe("a");
  });

  it("does not retry a post-upload command after a transient bridge error", async () => {
    const source = path.join(tmp, "f2");
    await fs.writeFile(source, "x");
    const execute = vi
      .fn()
      .mockResolvedValueOnce(okExec())
      .mockRejectedValueOnce(new CloudflareBridgeError({ status: 503, message: "Durable Object is overloaded." }))
      .mockResolvedValue(okExec());

    await expect(
      performSyncIn(context({ uploadFile: vi.fn().mockResolvedValue(undefined), execute }), [
        {
          operationId: "op",
          files: [{ sourcePath: source, targetPath: "/tmp/f2", kind: "file" }],
          postUploadCommands: [{ command: "not-repeatable" }],
        },
      ]),
    ).rejects.toThrow("overloaded");
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("rejects unconfined paths before any transfer", async () => {
    const downloadFile = vi.fn();
    const uploadFile = vi.fn();
    await expect(
      performSyncOut(context({ downloadFile }), [
        { operationId: "op", files: [{ sourcePath: "/workspace/../etc/shadow", targetPath: path.join(tmp, "x"), kind: "file" }] },
      ]),
    ).rejects.toThrow(/not a confined absolute sandbox path/);
    await expect(
      performSyncIn(context({ uploadFile }), [
        { operationId: "op", files: [{ sourcePath: "relative.txt", targetPath: "/tmp/x", kind: "file" }] },
      ]),
    ).rejects.toThrow(/not an absolute host path/);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it("builds the sandbox archive command with the host's tar conventions", () => {
    expect(
      buildRemoteTarCommand({ sourceDir: "/w s", archivePath: "/tmp/a.tar", exclude: ["it's"], followSymlinks: true }),
    ).toBe(
      "cd '/w s' && find . -mindepth 1 -maxdepth 1 -print0 > '/tmp/a.tar.entries' && " +
        "tar -c --no-xattrs -h -f '/tmp/a.tar' --exclude '._*' --exclude 'it'\"'\"'s' --null -T '/tmp/a.tar.entries' && " +
        "rm -f -- '/tmp/a.tar.entries'",
    );
  });
});
