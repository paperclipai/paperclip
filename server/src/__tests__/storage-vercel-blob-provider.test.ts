import { afterEach, describe, expect, it, vi } from "vitest";
import { createStorageService } from "../storage/service.js";
import { createVercelBlobStorageProvider } from "../storage/vercel-blob-provider.js";

const blobMock = vi.hoisted(() => ({
  put: vi.fn(),
  get: vi.fn(),
  head: vi.fn(),
  del: vi.fn(),
}));

vi.mock("@vercel/blob", () => blobMock);

async function readStreamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function makeWebStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe("vercel blob storage provider", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("round-trips bytes through storage service", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");

    blobMock.put.mockResolvedValue({
      pathname: "company-1/issues/2026/01/01/file.txt",
      contentType: "text/plain",
      contentDisposition: "attachment; filename=\"file.txt\"",
      url: "https://example.blob.vercel-storage.com/company-1/issues/2026/01/01/file.txt",
      downloadUrl: "https://example.blob.vercel-storage.com/company-1/issues/2026/01/01/file.txt?download=1",
      etag: "\"etag\"",
    });
    blobMock.get.mockResolvedValue({
      statusCode: 200,
      stream: makeWebStream("hello blob bytes"),
      headers: new Headers(),
      blob: {
        url: "https://example.blob.vercel-storage.com/company-1/issues/2026/01/01/file.txt",
        downloadUrl: "https://example.blob.vercel-storage.com/company-1/issues/2026/01/01/file.txt?download=1",
        pathname: "company-1/issues/2026/01/01/file.txt",
        contentType: "text/plain",
        contentDisposition: "attachment; filename=\"file.txt\"",
        cacheControl: "public, max-age=31536000",
        etag: "\"etag\"",
        size: 16,
        uploadedAt: now,
      },
    });
    blobMock.head.mockResolvedValue({
      pathname: "company-1/issues/2026/01/01/file.txt",
      contentType: "text/plain",
      contentDisposition: "attachment; filename=\"file.txt\"",
      url: "https://example.blob.vercel-storage.com/company-1/issues/2026/01/01/file.txt",
      downloadUrl: "https://example.blob.vercel-storage.com/company-1/issues/2026/01/01/file.txt?download=1",
      cacheControl: "public, max-age=31536000",
      etag: "\"etag\"",
      size: 16,
      uploadedAt: now,
    });

    const service = createStorageService(createVercelBlobStorageProvider("test-token"));
    const stored = await service.putFile({
      companyId: "company-1",
      namespace: "issues",
      originalFilename: "file.txt",
      contentType: "text/plain",
      body: Buffer.from("hello blob bytes", "utf8"),
    });

    expect(stored.provider).toBe("vercel_blob");
    expect(blobMock.put).toHaveBeenCalledWith(
      stored.objectKey,
      expect.any(Buffer),
      expect.objectContaining({
        access: "private",
        token: "test-token",
        contentType: "text/plain",
      }),
    );

    const fetched = await service.getObject("company-1", stored.objectKey);
    const fetchedBody = await readStreamToBuffer(fetched.stream);
    expect(fetchedBody.toString("utf8")).toBe("hello blob bytes");
    expect(fetched.contentType).toBe("text/plain");
    expect(fetched.contentLength).toBe(16);

    const head = await service.headObject("company-1", stored.objectKey);
    expect(head).toMatchObject({
      exists: true,
      contentType: "text/plain",
      contentLength: 16,
      etag: "\"etag\"",
      lastModified: now,
    });

    await service.deleteObject("company-1", stored.objectKey);
    expect(blobMock.del).toHaveBeenCalledWith(stored.objectKey, {
      token: "test-token",
    });
  });

  it("requires a Vercel Blob token", () => {
    expect(() => createVercelBlobStorageProvider("")).toThrow("Vercel Blob storage requires a token");
  });
});
