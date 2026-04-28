import { describe, expect, it, vi, beforeEach } from "vitest";
import { Readable } from "node:stream";
import { createAzureBlobStorageProvider } from "../storage/azure-blob-provider.js";

// Hoisted so the store is accessible in both the mock factory and beforeEach
const store = vi.hoisted(() => new Map<string, { body: Buffer; contentType: string }>());

// Mock @azure/storage-blob so tests run without real Azure credentials
vi.mock("@azure/storage-blob", () => {
  const makeBlockBlobClient = (key: string) => ({
    upload: vi.fn(async (body: Buffer, _length: number, opts?: { blobHTTPHeaders?: { blobContentType?: string } }) => {
      store.set(key, { body, contentType: opts?.blobHTTPHeaders?.blobContentType ?? "application/octet-stream" });
    }),
    download: vi.fn(async () => {
      const entry = store.get(key);
      if (!entry) {
        const err = new Error("BlobNotFound") as Error & { statusCode: number };
        err.statusCode = 404;
        throw err;
      }
      return {
        readableStreamBody: Readable.from(entry.body),
        contentType: entry.contentType,
        contentLength: entry.body.length,
        etag: '"mock-etag"',
        lastModified: new Date("2024-01-01"),
      };
    }),
    getProperties: vi.fn(async () => {
      const entry = store.get(key);
      if (!entry) {
        const err = new Error("BlobNotFound") as Error & { statusCode: number };
        err.statusCode = 404;
        throw err;
      }
      return {
        contentType: entry.contentType,
        contentLength: entry.body.length,
        etag: '"mock-etag"',
        lastModified: new Date("2024-01-01"),
      };
    }),
    deleteIfExists: vi.fn(async () => {
      store.delete(key);
      return { succeeded: true };
    }),
  });

  const containerClient = {
    getBlockBlobClient: vi.fn((blobName: string) => makeBlockBlobClient(blobName)),
  };

  const serviceClient = {
    getContainerClient: vi.fn(() => containerClient),
  };

  // Support both BlobServiceClient.fromConnectionString(...) and new BlobServiceClient(url, credential)
  const BlobServiceClientMock = vi.fn(() => serviceClient);
  (BlobServiceClientMock as unknown as { fromConnectionString: ReturnType<typeof vi.fn> }).fromConnectionString =
    vi.fn(() => serviceClient);

  return {
    BlobServiceClient: BlobServiceClientMock,
    StorageSharedKeyCredential: vi.fn(),
  };
});

async function readStreamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe("azure blob storage provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
  });

  it("throws when no credentials are provided", () => {
    expect(() =>
      createAzureBlobStorageProvider({ containerName: "paperclip" }),
    ).toThrow();
  });

  it("throws when container name is empty", () => {
    expect(() =>
      createAzureBlobStorageProvider({
        connectionString: "DefaultEndpointsProtocol=https;AccountName=test;AccountKey=dGVzdA==;EndpointSuffix=core.windows.net",
        containerName: "  ",
      }),
    ).toThrow();
  });

  it("round-trips bytes through put/get", async () => {
    const provider = createAzureBlobStorageProvider({
      connectionString: "DefaultEndpointsProtocol=https;AccountName=test;AccountKey=dGVzdA==;EndpointSuffix=core.windows.net",
      containerName: "paperclip",
    });

    const content = Buffer.from("hello azure bytes", "utf8");
    await provider.putObject({
      objectKey: "company-1/test/file.txt",
      body: content,
      contentType: "text/plain",
      contentLength: content.length,
    });

    const result = await provider.getObject({ objectKey: "company-1/test/file.txt" });
    const fetched = await readStreamToBuffer(result.stream);
    expect(fetched.toString("utf8")).toBe("hello azure bytes");
    expect(result.contentType).toBe("text/plain");
  });

  it("headObject returns exists:true for existing blob", async () => {
    const provider = createAzureBlobStorageProvider({
      connectionString: "DefaultEndpointsProtocol=https;AccountName=test;AccountKey=dGVzdA==;EndpointSuffix=core.windows.net",
      containerName: "paperclip",
    });

    const content = Buffer.from("data", "utf8");
    await provider.putObject({
      objectKey: "company-1/head-test.txt",
      body: content,
      contentType: "text/plain",
      contentLength: content.length,
    });

    const head = await provider.headObject({ objectKey: "company-1/head-test.txt" });
    expect(head.exists).toBe(true);
    expect(head.contentLength).toBe(content.length);
  });

  it("headObject returns exists:false for missing blob", async () => {
    const provider = createAzureBlobStorageProvider({
      connectionString: "DefaultEndpointsProtocol=https;AccountName=test;AccountKey=dGVzdA==;EndpointSuffix=core.windows.net",
      containerName: "paperclip",
    });

    const head = await provider.headObject({ objectKey: "nonexistent/file.txt" });
    expect(head.exists).toBe(false);
  });

  it("getObject throws 404 for missing blob", async () => {
    const provider = createAzureBlobStorageProvider({
      connectionString: "DefaultEndpointsProtocol=https;AccountName=test;AccountKey=dGVzdA==;EndpointSuffix=core.windows.net",
      containerName: "paperclip",
    });

    await expect(provider.getObject({ objectKey: "nonexistent/file.txt" })).rejects.toMatchObject({
      status: 404,
    });
  });

  it("deleteObject is idempotent (deleteIfExists)", async () => {
    const provider = createAzureBlobStorageProvider({
      connectionString: "DefaultEndpointsProtocol=https;AccountName=test;AccountKey=dGVzdA==;EndpointSuffix=core.windows.net",
      containerName: "paperclip",
    });

    const content = Buffer.from("to delete", "utf8");
    await provider.putObject({
      objectKey: "company-1/delete-me.txt",
      body: content,
      contentType: "text/plain",
      contentLength: content.length,
    });

    await provider.deleteObject({ objectKey: "company-1/delete-me.txt" });
    await provider.deleteObject({ objectKey: "company-1/delete-me.txt" });

    const head = await provider.headObject({ objectKey: "company-1/delete-me.txt" });
    expect(head.exists).toBe(false);
  });

  it("applies prefix to object keys", async () => {
    const { BlobServiceClient } = await import("@azure/storage-blob");
    const provider = createAzureBlobStorageProvider({
      connectionString: "DefaultEndpointsProtocol=https;AccountName=test;AccountKey=dGVzdA==;EndpointSuffix=core.windows.net",
      containerName: "paperclip",
      prefix: "myprefix",
    });

    const content = Buffer.from("prefixed", "utf8");
    await provider.putObject({
      objectKey: "file.txt",
      body: content,
      contentType: "text/plain",
      contentLength: content.length,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockService = (BlobServiceClient.fromConnectionString as any).mock.results[0].value;
    const containerClient = mockService.getContainerClient.mock.results[0].value;
    expect(containerClient.getBlockBlobClient).toHaveBeenCalledWith("myprefix/file.txt");
  });

  it("creates provider using accountName and accountKey auth", async () => {
    const { BlobServiceClient, StorageSharedKeyCredential } = await import("@azure/storage-blob");
    const provider = createAzureBlobStorageProvider({
      accountName: "myaccount",
      accountKey: "bXlhY2NvdW50a2V5",
      containerName: "paperclip",
    });

    const content = Buffer.from("key auth bytes", "utf8");
    await provider.putObject({
      objectKey: "key-auth/file.txt",
      body: content,
      contentType: "text/plain",
      contentLength: content.length,
    });

    expect(StorageSharedKeyCredential).toHaveBeenCalledWith("myaccount", "bXlhY2NvdW50a2V5");
    expect(BlobServiceClient).toHaveBeenCalledWith(
      "https://myaccount.blob.core.windows.net",
      expect.any(Object),
    );

    const result = await provider.getObject({ objectKey: "key-auth/file.txt" });
    const fetched = await readStreamToBuffer(result.stream);
    expect(fetched.toString("utf8")).toBe("key auth bytes");
  });
});
