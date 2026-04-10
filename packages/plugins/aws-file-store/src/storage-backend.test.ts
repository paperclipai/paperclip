/**
 * Tests for the aws-file-store plugin's S3 storage backend.
 *
 * The S3 client is mocked, so no real network or MinIO container is needed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();

vi.mock("@aws-sdk/client-s3", () => {
  class FakeS3Client {
    public readonly config: unknown;
    constructor(config: unknown) {
      this.config = config;
    }
    send(command: unknown): Promise<unknown> {
      return sendMock(command);
    }
  }

  // Each command class records its constructor input on the instance so the
  // test can assert what was sent without depending on AWS SDK internals.
  function makeCommand(name: string) {
    return class {
      static commandName = name;
      public readonly input: unknown;
      constructor(input: unknown) {
        this.input = input;
      }
    };
  }

  return {
    S3Client: FakeS3Client,
    PutObjectCommand: makeCommand("PutObjectCommand"),
    GetObjectCommand: makeCommand("GetObjectCommand"),
    DeleteObjectCommand: makeCommand("DeleteObjectCommand"),
    ListObjectsV2Command: makeCommand("ListObjectsV2Command"),
    CopyObjectCommand: makeCommand("CopyObjectCommand"),
    HeadObjectCommand: makeCommand("HeadObjectCommand"),
  };
});

// Import after the mock is registered.
import { S3StorageBackend, type S3BackendConfig } from "./storage-backend.js";

type CommandLike = {
  constructor: { commandName?: string };
  input: Record<string, unknown>;
};

function lastCommand(): CommandLike {
  const calls = sendMock.mock.calls;
  if (calls.length === 0) throw new Error("expected at least one S3 command");
  return calls[calls.length - 1]?.[0] as CommandLike;
}

function commandsByName(name: string): CommandLike[] {
  return sendMock.mock.calls
    .map((call) => call[0] as CommandLike)
    .filter((cmd) => cmd?.constructor?.commandName === name);
}

const baseConfig: S3BackendConfig = {
  bucket: "test-bucket",
  region: "us-east-1",
  prefix: "file-store",
};

beforeEach(() => {
  sendMock.mockReset();
});

describe("S3StorageBackend key handling", () => {
  it("prefixes keys with the configured prefix", async () => {
    const backend = new S3StorageBackend(baseConfig);
    sendMock.mockResolvedValueOnce({});

    await backend.writeFile("knowledge-base/notes/intro.md", Buffer.from("hi"));

    const cmd = lastCommand();
    expect(cmd.constructor.commandName).toBe("PutObjectCommand");
    expect(cmd.input).toMatchObject({
      Bucket: "test-bucket",
      Key: "file-store/knowledge-base/notes/intro.md",
    });
    expect(cmd.input.Body).toBeInstanceOf(Buffer);
  });

  it("normalizes leading slashes in input paths", async () => {
    const backend = new S3StorageBackend(baseConfig);
    sendMock.mockResolvedValueOnce({});

    await backend.writeFile("/knowledge-base/foo.txt", Buffer.from("x"));

    expect(lastCommand().input).toMatchObject({
      Key: "file-store/knowledge-base/foo.txt",
    });
  });

  it("rejects path traversal", async () => {
    const backend = new S3StorageBackend(baseConfig);

    await expect(
      backend.writeFile("knowledge-base/../../etc/passwd", Buffer.from("nope")),
    ).rejects.toThrow(/path traversal/i);

    expect(sendMock).not.toHaveBeenCalled();
  });

  it("supports an empty prefix", async () => {
    const backend = new S3StorageBackend({ ...baseConfig, prefix: "" });
    sendMock.mockResolvedValueOnce({});

    await backend.writeFile("acme/income/file.bin", Buffer.from("y"));

    expect(lastCommand().input).toMatchObject({
      Key: "acme/income/file.bin",
    });
  });
});

describe("S3StorageBackend.exists / stat", () => {
  it("returns true when HeadObject succeeds", async () => {
    const backend = new S3StorageBackend(baseConfig);
    sendMock.mockResolvedValueOnce({ ContentLength: 12 });

    expect(await backend.exists("knowledge-base/x.md")).toBe(true);
    expect(lastCommand().constructor.commandName).toBe("HeadObjectCommand");
  });

  it("returns false when HeadObject throws", async () => {
    const backend = new S3StorageBackend(baseConfig);
    sendMock.mockRejectedValueOnce(new Error("404"));

    expect(await backend.exists("missing.md")).toBe(false);
  });

  it("treats a path with descendants as a directory in stat()", async () => {
    const backend = new S3StorageBackend(baseConfig);
    // First call: HeadObject for the file — fails (it's a dir).
    sendMock.mockRejectedValueOnce(new Error("not a file"));
    // Second call: ListObjectsV2 — finds children.
    sendMock.mockResolvedValueOnce({
      Contents: [{ Key: "file-store/dir/child.md", Size: 3 }],
      CommonPrefixes: [],
    });

    const result = await backend.stat("dir");
    expect(result).not.toBeNull();
    expect(result?.isDir).toBe(true);
    expect(result?.size).toBe(0);
  });

  it("returns null when stat() finds neither object nor descendants", async () => {
    const backend = new S3StorageBackend(baseConfig);
    sendMock.mockRejectedValueOnce(new Error("nope"));
    sendMock.mockResolvedValueOnce({ Contents: [], CommonPrefixes: [] });

    expect(await backend.stat("missing")).toBeNull();
  });
});

describe("S3StorageBackend.listDir", () => {
  it("returns subdirectories from CommonPrefixes and files from Contents", async () => {
    const backend = new S3StorageBackend(baseConfig);
    sendMock.mockResolvedValueOnce({
      CommonPrefixes: [
        { Prefix: "file-store/knowledge-base/originals/" },
        { Prefix: "file-store/knowledge-base/markdown/" },
      ],
      Contents: [
        { Key: "file-store/knowledge-base/README.md", Size: 42 },
      ],
    });

    const entries = await backend.listDir("knowledge-base");

    expect(entries).toEqual(
      expect.arrayContaining([
        { name: "originals", isDir: true, size: 0 },
        { name: "markdown", isDir: true, size: 0 },
        { name: "README.md", isDir: false, size: 42 },
      ]),
    );
  });

  it("filters out nested files that should belong to a subdirectory", async () => {
    const backend = new S3StorageBackend(baseConfig);
    sendMock.mockResolvedValueOnce({
      CommonPrefixes: [],
      Contents: [
        // Should be ignored at this level — belongs to a deeper dir.
        { Key: "file-store/knowledge-base/sub/deep.md", Size: 1 },
        { Key: "file-store/knowledge-base/top.md", Size: 5 },
      ],
    });

    const entries = await backend.listDir("knowledge-base");

    expect(entries).toEqual([{ name: "top.md", isDir: false, size: 5 }]);
  });
});

describe("S3StorageBackend.listRecursive", () => {
  it("paginates ListObjectsV2 calls until IsTruncated is false", async () => {
    const backend = new S3StorageBackend(baseConfig);
    sendMock
      .mockResolvedValueOnce({
        Contents: [{ Key: "file-store/dir/a.md" }],
        IsTruncated: true,
        NextContinuationToken: "token-1",
      })
      .mockResolvedValueOnce({
        Contents: [{ Key: "file-store/dir/sub/b.md" }],
        IsTruncated: false,
      });

    const result = await backend.listRecursive("dir");

    expect(result).toEqual([
      { relative: "a.md", isDir: false },
      { relative: "sub/b.md", isDir: false },
    ]);
    expect(commandsByName("ListObjectsV2Command")).toHaveLength(2);
  });
});

describe("S3StorageBackend.move", () => {
  it("copies and deletes for a single file", async () => {
    const backend = new S3StorageBackend(baseConfig);
    // stat() — HeadObject succeeds (it's a file)
    sendMock.mockResolvedValueOnce({ ContentLength: 7, LastModified: new Date() });
    // CopyObject
    sendMock.mockResolvedValueOnce({});
    // DeleteObject
    sendMock.mockResolvedValueOnce({});

    await backend.move("a.md", "b.md");

    const copies = commandsByName("CopyObjectCommand");
    const deletes = commandsByName("DeleteObjectCommand");
    expect(copies).toHaveLength(1);
    expect(deletes).toHaveLength(1);
    expect(copies[0]?.input).toMatchObject({
      Bucket: "test-bucket",
      CopySource: "test-bucket/file-store/a.md",
      Key: "file-store/b.md",
    });
    expect(deletes[0]?.input).toMatchObject({ Key: "file-store/a.md" });
  });
});

describe("S3StorageBackend.remove", () => {
  it("refuses to recursively delete a non-empty directory without recursive flag", async () => {
    const backend = new S3StorageBackend(baseConfig);
    // stat() — HeadObject fails, then List shows children → it's a dir
    sendMock.mockRejectedValueOnce(new Error("not a file"));
    sendMock.mockResolvedValueOnce({
      Contents: [{ Key: "file-store/dir/child.md", Size: 1 }],
      CommonPrefixes: [],
    });
    // listDir() inside the non-recursive branch
    sendMock.mockResolvedValueOnce({
      CommonPrefixes: [],
      Contents: [{ Key: "file-store/dir/child.md", Size: 1 }],
    });

    await expect(backend.remove("dir", false)).rejects.toThrow(/not empty/i);
    // The DeleteObject command must NOT have been issued.
    expect(commandsByName("DeleteObjectCommand")).toHaveLength(0);
  });

  it("deletes a single file without listing", async () => {
    const backend = new S3StorageBackend(baseConfig);
    // stat() — HeadObject succeeds
    sendMock.mockResolvedValueOnce({ ContentLength: 3, LastModified: new Date() });
    // DeleteObject
    sendMock.mockResolvedValueOnce({});

    await backend.remove("file.md", false);

    const deletes = commandsByName("DeleteObjectCommand");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.input).toMatchObject({ Key: "file-store/file.md" });
  });
});

describe("S3StorageBackend.healthy", () => {
  it("returns true when ListObjectsV2 succeeds", async () => {
    const backend = new S3StorageBackend(baseConfig);
    sendMock.mockResolvedValueOnce({ Contents: [] });

    expect(await backend.healthy()).toBe(true);
  });

  it("returns false when ListObjectsV2 throws", async () => {
    const backend = new S3StorageBackend(baseConfig);
    sendMock.mockRejectedValueOnce(new Error("network down"));

    expect(await backend.healthy()).toBe(false);
  });
});
