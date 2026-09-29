import { afterEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";

async function readStreamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe("local disk storage provider", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  it("streams and syncs exact content, preserving the prior object on incomplete or corrupt upload", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-storage-"));
    tempRoots.push(root);
    const provider = createLocalDiskStorageProvider(root);
    const value = Buffer.from("streamed bytes");
    const input = { objectKey: "company/chunk", contentType: "application/octet-stream", contentLength: value.length, sha256: createHash("sha256").update(value).digest("hex") };
    await provider.putObject({ ...input, body: Readable.from([value.subarray(0, 4), value.subarray(4)]) });
    for (const bad of [Buffer.from("too short"), Buffer.alloc(value.length, 0x78), Buffer.alloc(value.length + 1)]) {
      await expect(provider.putObject({ ...input, body: Readable.from([bad]) })).rejects.toThrow("storage_object_");
      expect(await readStreamToBuffer((await provider.getObject({ objectKey: input.objectKey })).stream)).toEqual(value);
    }
    expect(await fs.readdir(path.join(root, "company"))).toEqual(["chunk"]);
  });

  it("round-trips bytes through storage service", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-storage-"));
    tempRoots.push(root);

    const service = createStorageService(createLocalDiskStorageProvider(root));
    const content = Buffer.from("hello image bytes", "utf8");
    const stored = await service.putFile({
      companyId: "company-1",
      namespace: "issues/issue-1",
      originalFilename: "demo.png",
      contentType: "image/png",
      body: content,
    });

    const fetched = await service.getObject("company-1", stored.objectKey);
    const fetchedBody = await readStreamToBuffer(fetched.stream);

    expect(fetchedBody.toString("utf8")).toBe("hello image bytes");
    expect(stored.sha256).toHaveLength(64);
  });

  it("streams only requested byte ranges", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-storage-"));
    tempRoots.push(root);

    const service = createStorageService(createLocalDiskStorageProvider(root));
    const stored = await service.putFile({
      companyId: "company-1",
      namespace: "issues/issue-1",
      originalFilename: "demo.mp4",
      contentType: "video/mp4",
      body: Buffer.from("0123456789", "utf8"),
    });

    const fetched = await service.getObject("company-1", stored.objectKey, { range: { start: 2, end: 5 } });
    const fetchedBody = await readStreamToBuffer(fetched.stream);

    expect(fetchedBody.toString("utf8")).toBe("2345");
    expect(fetched.contentLength).toBe(4);
  });

  it("blocks cross-company object access", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-storage-"));
    tempRoots.push(root);

    const service = createStorageService(createLocalDiskStorageProvider(root));
    const stored = await service.putFile({
      companyId: "company-a",
      namespace: "issues/issue-1",
      originalFilename: "demo.png",
      contentType: "image/png",
      body: Buffer.from("hello", "utf8"),
    });

    await expect(service.getObject("company-b", stored.objectKey)).rejects.toMatchObject({ status: 403 });
  });

  it("delete is idempotent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-storage-"));
    tempRoots.push(root);

    const service = createStorageService(createLocalDiskStorageProvider(root));
    const stored = await service.putFile({
      companyId: "company-1",
      namespace: "issues/issue-1",
      originalFilename: "demo.png",
      contentType: "image/png",
      body: Buffer.from("hello", "utf8"),
    });

    await service.deleteObject("company-1", stored.objectKey);
    await service.deleteObject("company-1", stored.objectKey);
    await expect(service.getObject("company-1", stored.objectKey)).rejects.toMatchObject({ status: 404 });
  });
});
