import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, UploadPartCommand, S3Client } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { putS3Multipart } from "../storage/s3-multipart.js";

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
});
