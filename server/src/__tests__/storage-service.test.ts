import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createStorageService } from "../storage/service.js";

function createFakeProvider(id: "local_disk" | "s3", body: string) {
  return {
    id,
    putObject: vi.fn().mockResolvedValue(undefined),
    getObject: vi.fn().mockResolvedValue({
      stream: Readable.from(Buffer.from(body, "utf8")),
      contentType: "text/plain",
      contentLength: body.length,
    }),
    headObject: vi.fn().mockResolvedValue({
      exists: true,
      contentType: "text/plain",
      contentLength: body.length,
    }),
    deleteObject: vi.fn().mockResolvedValue(undefined),
  };
}

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

describe("createStorageService", () => {
  it("routes reads through the row-level provider override instead of the active provider", async () => {
    const activeS3 = createFakeProvider("s3", "from-s3");
    const localDisk = createFakeProvider("local_disk", "from-local-disk");
    const service = createStorageService({
      activeProvider: activeS3,
      providers: {
        s3: activeS3,
        local_disk: localDisk,
      },
    });

    const object = await service.getObject(
      "company-1",
      "company-1/assets/2026/04/29/demo.txt",
      "local_disk",
    );

    expect(await readStream(object.stream)).toBe("from-local-disk");
    expect(localDisk.getObject).toHaveBeenCalledTimes(1);
    expect(activeS3.getObject).not.toHaveBeenCalled();
  });
});
