import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, ListMultipartUploadsCommand, S3Client, UploadPartCommand } from "@aws-sdk/client-s3";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { abortInFlightMultipartUploads, putS3Multipart, putS3MultipartFile } from "../storage/s3-multipart.js";
import { createS3StorageProvider } from "../storage/s3-provider.js";
import { afterStalledShutdownStep, runBoundedShutdownStep } from "../shutdown.js";

const MIB = 1024 * 1024;

function heldPartClient() {
  const client = new S3Client({ region: "us-east-1" }), aborted: string[] = [];
  let partStarted!: () => void;
  const started = new Promise<void>(resolve => { partStarted = resolve; });
  vi.spyOn(client, "send").mockImplementation(async (command: any, options?: any) => {
    if (command instanceof CreateMultipartUploadCommand) return { UploadId: "held-upload" };
    if (command instanceof UploadPartCommand) {
      partStarted();
      const signal = options?.abortSignal as AbortSignal;
      return new Promise((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    if (command instanceof AbortMultipartUploadCommand) { aborted.push(command.input.UploadId!); return {}; }
    throw new Error(`unexpected ${command.constructor.name}`);
  });
  return { client, aborted, started };
}

describe("multipart uploads in flight at shutdown", () => {
  let root: string | null = null;
  afterEach(async () => { vi.restoreAllMocks(); if (root) await fs.rm(root, { recursive: true, force: true }); root = null; });

  it("has nothing to abort when no upload is running", async () => {
    expect(await abortInFlightMultipartUploads(new Error("server_shutdown"))).toBe(0);
  });

  it("aborts a file upload whose part the store is holding", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "pc-multipart-shutdown-"));
    const file = path.join(root, "archive.pcws");
    await fs.writeFile(file, Buffer.alloc(17 * MIB, 7));
    const { client, aborted, started } = heldPartClient();
    const saving = putS3MultipartFile(client, "bucket", "key", { objectKey: "key", contentType: "application/octet-stream",
      contentLength: 17 * MIB, body: Readable.from([]), sourceFile: file }).catch(error => error);
    await started;
    expect(await abortInFlightMultipartUploads(new Error("server_shutdown"))).toBe(1);
    expect(aborted).toEqual(["held-upload"]);
    expect(((await saving) as Error).message).toBe("server_shutdown");
    expect(await abortInFlightMultipartUploads(new Error("server_shutdown"))).toBe(0);
  });

  it("lets an upload that finishes inside the grace complete without aborting it", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "pc-multipart-shutdown-"));
    const file = path.join(root, "archive.pcws");
    await fs.writeFile(file, Buffer.alloc(17 * MIB, 7));
    const client = new S3Client({ region: "us-east-1" }), sent: string[] = [];
    let release!: () => void, partStarted!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { partStarted = resolve; });
    vi.spyOn(client, "send").mockImplementation(async (command: any) => {
      sent.push(command.constructor.name);
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: "graceful-upload" };
      if (command instanceof UploadPartCommand) { partStarted(); await released; return { ETag: `part-${command.input.PartNumber}` }; }
      if (command instanceof CompleteMultipartUploadCommand) return {};
      throw new Error(`unexpected ${command.constructor.name}`);
    });
    const saving = putS3MultipartFile(client, "bucket", "key", { objectKey: "key", contentType: "application/octet-stream",
      contentLength: 17 * MIB, body: Readable.from([]), sourceFile: file });
    await started;
    const draining = abortInFlightMultipartUploads(new Error("server_shutdown"), { graceMs: 5_000 });
    setTimeout(release, 50);
    expect(await draining).toBe(0);
    expect(await saving).toEqual({ integrity: "server_verified_md5" });
    expect(sent).toContain("CompleteMultipartUploadCommand");
    expect(sent).not.toContain("AbortMultipartUploadCommand");
  });

  it("aborts an upload still held after the grace and counts it once", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "pc-multipart-shutdown-"));
    const file = path.join(root, "archive.pcws");
    await fs.writeFile(file, Buffer.alloc(17 * MIB, 7));
    const { client, aborted, started } = heldPartClient();
    const saving = putS3MultipartFile(client, "bucket", "key", { objectKey: "key", contentType: "application/octet-stream",
      contentLength: 17 * MIB, body: Readable.from([]), sourceFile: file }).catch(error => error);
    await started;
    const begun = Date.now();
    expect(await abortInFlightMultipartUploads(new Error("server_shutdown"), { graceMs: 100 })).toBe(1);
    expect(Date.now() - begun).toBeGreaterThanOrEqual(90);
    expect(aborted).toEqual(["held-upload"]);
    expect(((await saving) as Error).message).toBe("server_shutdown");
  });

  it("aborts a streamed upload whose part the store is holding", async () => {
    const { client, aborted, started } = heldPartClient();
    const body = Readable.from((async function* () { for (let index = 0; index < 272; index++) yield Buffer.alloc(64 * 1024, 3); })());
    const saving = putS3Multipart(client, "bucket", "key", { objectKey: "key", contentType: "application/octet-stream",
      contentLength: 17 * MIB, body }).catch(error => error);
    await started;
    expect(await abortInFlightMultipartUploads(new Error("server_shutdown"))).toBe(1);
    expect(aborted).toEqual(["held-upload"]);
    expect(((await saving) as Error).message).toBe("server_shutdown");
  });
});

describe("aborting a key's incomplete multipart uploads", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it("aborts every upload of the exact key across listing pages and leaves neighboring keys alone", async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "synthetic-access-key");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "synthetic-secret-key");
    const aborted: string[] = [], listed: Array<{ Prefix?: string; KeyMarker?: string; UploadIdMarker?: string }> = [];
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command: any) => {
      if (command instanceof ListMultipartUploadsCommand) {
        listed.push(command.input);
        if (!command.input.KeyMarker) return { IsTruncated: true, NextKeyMarker: "p/c/a.pcws", NextUploadIdMarker: "u2",
          Uploads: [{ Key: "p/c/a.pcws", UploadId: "u1" }, { Key: "p/c/a.pcws", UploadId: "u2" }] };
        return { IsTruncated: false, Uploads: [{ Key: "p/c/a.pcws.next", UploadId: "u3" }, { Key: "p/c/a.pcws", UploadId: "u4" }] };
      }
      if (command instanceof AbortMultipartUploadCommand) {
        if (command.input.UploadId === "u4") throw Object.assign(new Error("gone"), { name: "NoSuchUpload" });
        aborted.push(`${command.input.Key}#${command.input.UploadId}`); return {};
      }
      throw new Error(`unexpected ${command.constructor.name}`);
    });
    const provider = createS3StorageProvider({ bucket: "bucket", region: "us-east-1", endpoint: "http://127.0.0.1:9", prefix: "p" });
    expect(await provider.abortIncompleteUploads!({ objectKey: "c/a.pcws" })).toBe(2);
    expect(listed.map(input => [input.Prefix, input.KeyMarker, input.UploadIdMarker]))
      .toEqual([["p/c/a.pcws", undefined, undefined], ["p/c/a.pcws", "p/c/a.pcws", "u2"]]);
    expect(aborted).toEqual(["p/c/a.pcws#u1", "p/c/a.pcws#u2"]);
    send.mockRestore();
  });
});

describe("shutdown steps that stall on a held upload", () => {
  const log = { info: () => {}, error: () => {} };

  it("aborts in-flight uploads after a step that timed out or failed, and not after one that completed", async () => {
    const onStalled = vi.fn(async () => {});
    const held = new Promise<void>(() => {});
    await afterStalledShutdownStep(await runBoundedShutdownStep({ step: "workspace_recovery_stop", signal: "SIGTERM", timeoutMs: 5, run: () => held, log }), onStalled);
    expect(onStalled).toHaveBeenCalledTimes(1);
    await afterStalledShutdownStep(await runBoundedShutdownStep({ step: "workspace_recovery_stop", signal: "SIGTERM", timeoutMs: 5,
      run: async () => { throw new Error("stop failed"); }, log }), onStalled);
    expect(onStalled).toHaveBeenCalledTimes(2);
    await afterStalledShutdownStep(await runBoundedShutdownStep({ step: "workspace_recovery_stop", signal: "SIGTERM", timeoutMs: 1000, run: async () => {}, log }), onStalled);
    expect(onStalled).toHaveBeenCalledTimes(2);
  });
});
