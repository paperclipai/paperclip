import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, UploadPartCommand, DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { putS3Multipart } from "../storage/s3-multipart.js";
import { createS3StorageProvider } from "../storage/s3-provider.js";
import { createStorageService } from "../storage/service.js";
import { STORAGE_FAILURE_CLEANUP_MS } from "../storage/failure-cleanup.js";

describe("streamed S3 multipart uploads", () => {
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
});
