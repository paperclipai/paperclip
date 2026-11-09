import { CreateMultipartUploadCommand, UploadPartCommand, S3Client } from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { THROTTLED_PART_ATTEMPTS, putS3MultipartFile } from "../storage/s3-multipart.js";

// Record each requested wait and resolve it at once, so the schedule is
// observable without waiting for it.
const waits = vi.hoisted(() => [] as number[]);
vi.mock("node:timers/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:timers/promises")>();
  return {
    ...actual,
    setTimeout: (ms: number, value?: unknown, options?: { signal?: AbortSignal }) => {
      waits.push(ms);
      return actual.setTimeout(0, value, options);
    },
  };
});

const slowDown = () => Object.assign(new Error("Please reduce your request rate."), { name: "SlowDown", $metadata: { httpStatusCode: 503 } });

describe("file-backed S3 multipart backoff schedule", () => {
  it("doubles the jittered wait for each throttled attempt up to the 20 s ceiling", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pc-s3-backoff-"));
    const file = path.join(dir, "source.bin"), size = 3 * 8 * 1024 * 1024;
    await fs.writeFile(file, Buffer.alloc(size, 7), { mode: 0o600 });
    const client = new S3Client({ region: "us-east-1" });
    let partOneAttempts = 0;
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const send = vi.spyOn(client, "send").mockImplementation(async (command: any) => {
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: "upload" };
      if (command instanceof UploadPartCommand) {
        (command.input.Body as Readable).resume();
        if (command.input.PartNumber === 1 && ++partOneAttempts < THROTTLED_PART_ATTEMPTS) throw slowDown();
        return { ETag: `part-${command.input.PartNumber}` };
      }
      return {};
    });
    waits.length = 0;
    try {
      await expect(putS3MultipartFile(client, "bucket", "key", { objectKey: "key", contentType: "application/octet-stream",
        contentLength: size, body: Buffer.alloc(0), sourceFile: file })).resolves.toEqual({ integrity: "server_verified_md5" });
      expect(partOneAttempts).toBe(THROTTLED_PART_ATTEMPTS);
      // Half of each ceiling: 1, 2, 4, 8, 16, then 20, 20 seconds.
      expect(waits).toEqual([500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000]);
    } finally {
      random.mockRestore(); send.mockRestore(); client.destroy();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
