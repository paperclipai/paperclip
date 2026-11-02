import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, UploadPartCommand, DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { putS3Multipart } from "../storage/s3-multipart.js";
import { createS3StorageProvider } from "../storage/s3-provider.js";
import { createStorageService } from "../storage/service.js";
import { STORAGE_FAILURE_CLEANUP_MS } from "../storage/failure-cleanup.js";

describe("streamed S3 multipart uploads", () => {
  it("sends concurrent exact part bodies through the real S3 HTTP client", async () => {
    const received = new Map<number, string>();
    const responses = new Map<number, ServerResponse>();
    let completedParts = "";
    const server = createServer((request, response) => {
      const url = new URL(request.url!, "http://localhost");
      const digest = createHash("sha256");
      let text = "";
      request.on("data", chunk => { digest.update(chunk); if (request.method === "POST") text += chunk; });
      request.on("end", () => {
        if (request.method === "PUT") {
          const number = Number(url.searchParams.get("partNumber"));
          received.set(number, digest.digest("hex"));
          responses.set(number, response);
        } else if (url.searchParams.has("uploads")) {
          response.end('<InitiateMultipartUploadResult><UploadId>upload</UploadId></InitiateMultipartUploadResult>');
        } else {
          completedParts = text;
          response.end('<CompleteMultipartUploadResult><ETag>complete</ETag></CompleteMultipartUploadResult>');
        }
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const client = new S3Client({ region: "us-east-1", endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      forcePathStyle: true, requestChecksumCalculation: "WHEN_REQUIRED", credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" } });
    const cancellation = new AbortController();
    const body = Readable.from((async function* () {
      for (let index = 0; index < 512; index++) yield Buffer.alloc(64 * 1024, Math.floor(index / 128) + 1);
    })());
    const saving = putS3Multipart(client, "bucket", "key", { objectKey: "key", contentType: "application/octet-stream", contentLength: 32 * 1024 * 1024, body, signal: cancellation.signal }).catch(error => error);
    try {
      await expect.poll(() => received.size, { timeout: 3000 }).toBe(4);
      for (const number of [4, 2, 3, 1]) {
        expect(received.get(number)).toBe(createHash("sha256").update(Buffer.alloc(8 * 1024 * 1024, number)).digest("hex"));
        responses.get(number)!.writeHead(200, { ETag: `part-${number}` }).end();
      }
      expect(await saving).toBeUndefined();
      expect([...completedParts.matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map(match => Number(match[1]))).toEqual([1, 2, 3, 4]);
    } finally {
      cancellation.abort();
      await saving;
      client.destroy();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("overlaps slow part acknowledgements and completes exact bytes in source order", async () => {
    const client = new S3Client({ region: "us-east-1" });
    const received = new Map<number, Buffer>();
    const acknowledgements = new Map<number, () => void>();
    let completed = false;
    const send = vi.spyOn(client, "send").mockImplementation(async (command: any) => {
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: "upload" };
      if (command instanceof UploadPartCommand) {
        const chunks: Buffer[] = [];
        for await (const chunk of command.input.Body as Readable) chunks.push(chunk);
        received.set(command.input.PartNumber, Buffer.concat(chunks));
        await new Promise<void>(resolve => acknowledgements.set(command.input.PartNumber, resolve));
        return { ETag: `part-${command.input.PartNumber}` };
      }
      expect(command).toBeInstanceOf(CompleteMultipartUploadCommand);
      expect(command.input.MultipartUpload.Parts).toEqual([1, 2, 3, 4].map(PartNumber => ({ PartNumber, ETag: `part-${PartNumber}` })));
      completed = true;
      return {};
    });
    const length = 25 * 1024 * 1024;
    const body = Readable.from((async function* () {
      for (let offset = 0; offset < length; offset += 64 * 1024) yield Buffer.alloc(Math.min(64 * 1024, length - offset), offset / (64 * 1024) % 251);
    })());
    const saving = putS3Multipart(client, "bucket", "key", { objectKey: "key", contentType: "application/octet-stream", contentLength: length, body });
    try {
      await expect.poll(() => received.size, { timeout: 1000 }).toBe(4);
      expect(completed).toBe(false);
      for (const number of [4, 2, 3, 1]) acknowledgements.get(number)!();
      await saving;
      const actual = Buffer.concat([1, 2, 3, 4].map(number => received.get(number)!));
      expect(actual.length).toBe(length);
      for (let offset = 0; offset < length; offset += 64 * 1024) {
        expect(actual.subarray(offset, Math.min(length, offset + 64 * 1024)).every(byte => byte === offset / (64 * 1024) % 251)).toBe(true);
      }
      expect(completed).toBe(true);
    } finally {
      const release = setInterval(() => { for (const acknowledge of acknowledgements.values()) acknowledge(); }, 1);
      try { await saving; } finally { clearInterval(release); send.mockRestore(); client.destroy(); }
    }
  });

  it("streams exact ordered parts without buffering the full response", async () => {
    const client = new S3Client({ region: "us-east-1" });
    const lengths: number[] = [];
    const send = vi.spyOn(client, "send").mockImplementation(async (command: any) => {
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: "upload" };
      if (command instanceof UploadPartCommand) {
        expect(command.input.Body).toBeInstanceOf(Readable);
        let length = 0;
        for await (const chunk of command.input.Body as Readable) {
          expect(chunk.length).toBeLessThanOrEqual(64 * 1024);
          length += chunk.length;
        }
        expect(length).toBe(command.input.ContentLength);
        lengths.push(length);
        return { ETag: `part-${command.input.PartNumber}` };
      }
      expect(command).toBeInstanceOf(CompleteMultipartUploadCommand);
      expect(command.input.MultipartUpload.Parts).toEqual([1, 2, 3].map(PartNumber => ({ PartNumber, ETag: `part-${PartNumber}` })));
      return {};
    });
    const body = Readable.from((async function* () { for (let i = 0; i < 272; i++) yield Buffer.alloc(64 * 1024); })());
    try {
      await putS3Multipart(client, "bucket", "key", { objectKey: "key", contentType: "text/plain", contentLength: 17 * 1024 * 1024, body });
      expect(lengths).toEqual([8, 8, 1].map(mb => mb * 1024 * 1024));
    } finally { send.mockRestore(); client.destroy(); }
  });
  it("keeps source backpressure and at most four part requests while acknowledgements stall", async () => {
    const client = new S3Client({ region: "us-east-1" });
    let releaseReading!: () => void, releaseAcknowledgements!: () => void;
    const reading = new Promise<void>(resolve => { releaseReading = resolve; });
    const acknowledgements = new Promise<void>(resolve => { releaseAcknowledgements = resolve; });
    let yielded = 0, active = 0, peak = 0, received = 0;
    const send = vi.spyOn(client, "send").mockImplementation(async (command: any) => {
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: "upload" };
      if (command instanceof UploadPartCommand) {
        active++; peak = Math.max(peak, active);
        await reading;
        for await (const chunk of command.input.Body as Readable) expect(chunk.length).toBeLessThanOrEqual(64 * 1024);
        received++;
        await acknowledgements;
        active--;
        return { ETag: `part-${command.input.PartNumber}` };
      }
      expect(command).toBeInstanceOf(CompleteMultipartUploadCommand);
      return {};
    });
    const body = Readable.from((async function* () {
      for (let index = 0; index < 1600; index++) { yielded++; yield Buffer.alloc(64 * 1024); }
    })());
    const saving = putS3Multipart(client, "bucket", "key", { objectKey: "key", contentType: "application/octet-stream", contentLength: 100 * 1024 * 1024, body });
    try {
      await expect.poll(() => active).toBe(1);
      expect(yielded).toBeLessThanOrEqual(3);
      releaseReading();
      await expect.poll(() => received).toBe(4);
      expect(yielded).toBeLessThanOrEqual(4 * 128 + 3);
      expect(peak).toBe(4);
      releaseAcknowledgements();
      await saving;
      expect(received).toBe(13);
      expect(yielded).toBe(1600);
      expect(peak).toBe(4);
    } finally { releaseReading(); releaseAcknowledgements(); await saving; send.mockRestore(); client.destroy(); }
  });

  it("settles cancelled siblings before aborting a failed multipart upload", async () => {
    const client = new S3Client({ region: "us-east-1" });
    const cancellations: AbortSignal[] = [];
    let failPart!: () => void, releaseSiblings!: () => void;
    const settlement = new Promise<void>(resolve => { releaseSiblings = resolve; });
    let received = 0, settled = 0, aborted = false, completed = false;
    const send = vi.spyOn(client, "send").mockImplementation(async (command: any, options: any) => {
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: "upload" };
      if (command instanceof UploadPartCommand) {
        for await (const _chunk of command.input.Body as Readable) {}
        received++;
        if (command.input.PartNumber === 2) return new Promise((_resolve, reject) => { failPart = () => reject(new Error("second part failed")); });
        cancellations.push(options.abortSignal);
        await new Promise<void>(resolve => options.abortSignal.addEventListener("abort", () => resolve(), { once: true }));
        await settlement;
        settled++;
        throw options.abortSignal.reason;
      }
      if (command instanceof CompleteMultipartUploadCommand) { completed = true; return {}; }
      expect(command).toBeInstanceOf(AbortMultipartUploadCommand);
      expect(settled).toBe(3);
      aborted = true;
      return {};
    });
    const body = Readable.from((async function* () { for (let index = 0; index < 512; index++) yield Buffer.alloc(64 * 1024); })());
    const saving = putS3Multipart(client, "bucket", "key", { objectKey: "key", contentType: "application/octet-stream", contentLength: 32 * 1024 * 1024, body }).catch(error => error);
    try {
      await expect.poll(() => received).toBe(4);
      failPart();
      await expect.poll(() => cancellations.every(signal => signal.aborted)).toBe(true);
      expect(aborted).toBe(false);
      releaseSiblings();
      expect((await saving).message).toBe("second part failed");
      expect(aborted).toBe(true);
      expect(completed).toBe(false);
      expect(body.destroyed).toBe(true);
    } finally { failPart?.(); releaseSiblings(); await saving; send.mockRestore(); client.destroy(); }
  });

  it.each(["truncated", "excess", "source error"])("rejects %s input without publishing an object", async kind => {
    const client = new S3Client({ region: "us-east-1" });
    let aborted = false;
    const send = vi.spyOn(client, "send").mockImplementation(async (command: any) => {
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: "upload" };
      if (command instanceof UploadPartCommand) {
        for await (const _chunk of command.input.Body as Readable) {}
        return { ETag: `part-${command.input.PartNumber}` };
      }
      expect(command).toBeInstanceOf(AbortMultipartUploadCommand);
      aborted = true;
      return {};
    });
    const expected = { truncated: "S3 upload source was truncated", excess: "S3 upload source exceeds its declared size", "source error": "source unavailable" };
    const body = Readable.from((async function* () {
      for (let index = 0; index < (kind === "excess" ? 274 : 270); index++) yield Buffer.alloc(64 * 1024);
      if (kind === "source error") throw new Error("source unavailable");
    })());
    try {
      await expect(putS3Multipart(client, "bucket", "key", { objectKey: "key", contentType: "application/octet-stream", contentLength: 17 * 1024 * 1024, body })).rejects.toThrow(expected[kind]);
      expect(aborted).toBe(true);
      expect(body.destroyed).toBe(true);
    } finally { send.mockRestore(); client.destroy(); }
  });

  it("aborts an incomplete upload and closes its source on failure", async () => {
    const client = new S3Client({ region: "us-east-1" });
    const send = vi.spyOn(client, "send").mockImplementation(async (command: any) => {
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: "upload" };
      if (command instanceof UploadPartCommand) throw new Error("storage unavailable");
      expect(command).toBeInstanceOf(AbortMultipartUploadCommand);
      return {};
    });
    const body = Readable.from([Buffer.from("abc")]);
    try {
      await expect(putS3Multipart(client, "bucket", "key", { objectKey: "key", contentType: "text/plain", contentLength: 3, body })).rejects.toThrow("storage unavailable");
      expect(send).toHaveBeenCalledTimes(3);
      expect(body.destroyed).toBe(true);
    } finally { send.mockRestore(); client.destroy(); }
  });
  it("bounds stalled multipart abort and object cleanup after cancellation", async () => {
    vi.useFakeTimers();
    const cancellation = new AbortController();
    const cleanupSignals: AbortSignal[] = [];
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command: any, options: any) => {
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: "upload" };
      if (command instanceof UploadPartCommand) return new Promise((_resolve, reject) => {
        options.abortSignal.addEventListener("abort", () => reject(cancellation.signal.reason), { once: true });
      });
      if (command instanceof AbortMultipartUploadCommand || command instanceof DeleteObjectCommand) {
        cleanupSignals.push(options.abortSignal);
        return new Promise(() => {});
      }
      expect(command).toBeInstanceOf(PutObjectCommand);
      return {};
    });
    const storage = createStorageService(createS3StorageProvider({ bucket: "test", region: "us-east-1" }));
    const body = Readable.from([Buffer.alloc(17 * 1024 * 1024)]);
    try {
      const saving = storage.putFile({ companyId: "company", namespace: "skill-packages", objectKey: "company/package/archive",
        originalFilename: "archive", contentType: "application/gzip", body, byteSize: 17 * 1024 * 1024, sha256: "a".repeat(64), signal: cancellation.signal }).catch(error => error);
      await vi.advanceTimersByTimeAsync(0);
      cancellation.abort(new Error("cancelled upload"));
      await vi.advanceTimersByTimeAsync(STORAGE_FAILURE_CLEANUP_MS * 2 + 1);
      expect((await saving).message).toBe("cancelled upload");
      expect(cleanupSignals).toHaveLength(2);
      expect(cleanupSignals.every(signal => signal.aborted)).toBe(true);
      expect(body.destroyed).toBe(true);
      await expect(storage.putFile({ companyId: "company", namespace: "skill-packages", originalFilename: "next", contentType: "text/plain", body: Buffer.from("next") })).resolves.toMatchObject({ byteSize: 4 });
    } finally { send.mockRestore(); vi.useRealTimers(); }
  });

  it("bounds cancellation while an asynchronous source read is stalled", async () => {
    vi.useFakeTimers();
    const client = new S3Client({ region: "us-east-1" });
    const cancellation = new AbortController();
    let release!: () => void, waiting = false, settled = false;
    const sourceGate = new Promise<void>(resolve => { release = resolve; });
    const body = Readable.from((async function* () {
      yield Buffer.alloc(64 * 1024);
      waiting = true;
      await sourceGate;
      yield Buffer.alloc(64 * 1024);
    })());
    const send = vi.spyOn(client, "send").mockImplementation(async (command: any, options: any) => {
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: "upload" };
      if (command instanceof UploadPartCommand) {
        (command.input.Body as Readable).resume();
        return new Promise((_resolve, reject) => options.abortSignal.addEventListener("abort", () => reject(options.abortSignal.reason), { once: true }));
      }
      expect(command).toBeInstanceOf(AbortMultipartUploadCommand);
      return {};
    });
    const saving = putS3Multipart(client, "bucket", "key", { objectKey: "key", contentType: "text/plain", contentLength: 128 * 1024, body, signal: cancellation.signal })
      .catch(error => error).finally(() => { settled = true; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(waiting).toBe(true);
      cancellation.abort(new Error("cancelled during source read"));
      await vi.advanceTimersByTimeAsync(STORAGE_FAILURE_CLEANUP_MS + 1);
      expect(settled).toBe(true);
      expect((await saving).message).toBe("cancelled during source read");
      expect(body.destroyed).toBe(true);
    } finally {
      release();
      await vi.advanceTimersByTimeAsync(STORAGE_FAILURE_CLEANUP_MS + 1);
      await saving;
      send.mockRestore(); client.destroy(); vi.useRealTimers();
    }
  });
});
