import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createS3StorageProvider } from "../storage/s3-provider.js";
import { createStorageService } from "../storage/service.js";

type Seen = { method: string; body: Buffer };
const seen: Seen[] = [];
let respond: (req: IncomingMessage, res: ServerResponse, index: number) => void = (_req, res) => res.end();

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", chunk => chunks.push(chunk as Buffer));
  req.on("end", () => {
    seen.push({ method: req.method ?? "", body: Buffer.concat(chunks) });
    respond(req, res, seen.length - 1);
  });
});
let endpoint = "";
const savedEnv = { ...process.env };

beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.AWS_ACCESS_KEY_ID = "fixture-access-key";
  process.env.AWS_SECRET_ACCESS_KEY = "fixture-secret-key";
  delete process.env.AWS_SESSION_TOKEN;
  delete process.env.AWS_PROFILE;
});

afterAll(async () => {
  process.env = savedEnv;
  await new Promise<void>(resolve => server.close(() => resolve()));
});

// Zero jitter keeps both the SDK's and the upload's backoff instant.
beforeEach(() => { seen.length = 0; vi.spyOn(Math, "random").mockReturnValue(0); });
afterEach(() => { vi.restoreAllMocks(); });

const SLOW_DOWN = `<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>SlowDown</Code><Message>Please reduce your request rate.</Message><RequestId>req-503</RequestId></Error>`;

function throttleFirstPuts(count: number) {
  respond = (req, res, index) => {
    if (req.method === "PUT" && index < count) {
      res.writeHead(503, { "content-type": "application/xml" });
      res.end(SLOW_DOWN);
      return;
    }
    res.writeHead(200, { etag: '"saved"' });
    res.end();
  };
}

function storage() {
  return createStorageService(createS3StorageProvider({ bucket: "bucket", region: "us-east-1", endpoint, forcePathStyle: true }));
}

const sha256 = "0".repeat(64);

describe("S3 throttling of small uploads without a source file", () => {
  it("resends a small streamed upload after SlowDown", async () => {
    const content = Buffer.from("skill package archive bytes");
    throttleFirstPuts(1);

    await expect(storage().putFile({ companyId: "company", namespace: "skill-packages", objectKey: "company/skill-packages/files.tar.gz",
      originalFilename: "files.tar.gz", contentType: "application/gzip", body: Readable.from([content]),
      byteSize: content.length, sha256 })).resolves.toMatchObject({ byteSize: content.length });

    expect(seen.map(entry => entry.method)).toEqual(["PUT", "PUT"]);
    expect(seen[1]!.body.equals(content)).toBe(true);
  });

  it("keeps backing off a small buffered upload after the SDK's own attempts are throttled", async () => {
    const content = Buffer.from('{"files":[]}');
    throttleFirstPuts(3);

    await expect(storage().putFile({ companyId: "company", namespace: "skill-packages", objectKey: "company/skill-packages/manifest.json",
      originalFilename: "manifest.json", contentType: "application/json", body: content }))
      .resolves.toMatchObject({ byteSize: content.length });

    expect(seen.map(entry => entry.method)).toEqual(["PUT", "PUT", "PUT", "PUT"]);
    expect(seen[3]!.body.equals(content)).toBe(true);
  });

  it("rejects a streamed upload that ends before its declared size without sending it", async () => {
    throttleFirstPuts(0);

    await expect(storage().putFile({ companyId: "company", namespace: "skill-packages", objectKey: "company/skill-packages/files.tar.gz",
      originalFilename: "files.tar.gz", contentType: "application/gzip", body: Readable.from([Buffer.from("short")]),
      byteSize: 10, sha256 })).rejects.toThrow("S3 upload source was truncated");
    expect(seen.filter(entry => entry.method === "PUT")).toEqual([]);
  });

  it("does not resend a small upload the store refused for good", async () => {
    respond = (_req, res) => {
      res.writeHead(403, { "content-type": "application/xml" });
      res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>denied</Message></Error>`);
    };

    await expect(storage().putFile({ companyId: "company", namespace: "skill-packages", objectKey: "company/skill-packages/files.tar.gz",
      originalFilename: "files.tar.gz", contentType: "application/gzip", body: Readable.from([Buffer.from("bytes")]),
      byteSize: 5, sha256 })).rejects.toMatchObject({ name: "AccessDenied" });
    expect(seen.filter(entry => entry.method === "PUT")).toHaveLength(1);
  });
});
